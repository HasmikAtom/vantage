/**
 * Cross-outpost file transfer orchestrator.
 *
 * Lives in the auth service because that's the only process that holds
 * (server URL, encrypted token) tuples for a given user — outposts and
 * the local backend never know about each other directly, by design.
 *
 * Pipeline:
 *
 *   SPA ──POST /api/transfer──► auth (this file)
 *                                 │
 *                                 ├─► GET  /api/servers/<src>/fs/stat (size)
 *                                 │
 *                                 ├─► GET  /api/servers/<src>/fs/download   ─┐
 *                                 │                                          │ piped, no buffer
 *                                 ├─► POST /api/servers/<dst>/fs/receive   ◄─┘
 *                                 │
 *                                 └─► DELETE /api/servers/<src>/fs/entry (only when mode=move)
 *
 * Progress is reported via SSE; the SPA opens GET /api/transfer/:id/stream
 * and receives JSON events {bytesDone, status, error} until the transfer
 * terminates. Cancellation routes through an AbortController held on the
 * server side and tripped by DELETE /api/transfer/:id.
 *
 * State is in-memory only; an auth-service restart cancels all in-flight
 * transfers. This is acceptable for a personal dashboard — losing partial
 * progress is annoying, not corrupting (the destination file may exist
 * empty, which is exactly the same as a network drop mid-upload).
 */

import { randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import { getServerToken } from './registry.js';
import { assertSafeURL, isBlockedIP, resolveHostnamesToIPs, validateAndResolve } from './net-policy.js';

export type TransferMode = 'move' | 'copy';

export type TransferStatus =
  | 'pending'    // record created, worker not yet started
  | 'running'    // bytes flowing
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface TransferState {
  id: string;
  userId: string;
  userRole: string;
  srcServer: string;
  srcPath: string;
  dstServer: string;
  dstPath: string;
  mode: TransferMode;
  overwrite: boolean;
  // When true, after the receive succeeds we issue chmod + chown on the
  // destination to match the source's mode/uid/gid. Off by default
  // because UID spaces can diverge across hosts. Requires admin role
  // (chmod/chown on the destination are admin-gated).
  preserveSourceOwnership: boolean;
  // Captured during the pre-flight stat so we can re-apply on success.
  srcMode: number;
  srcUid: number;
  srcGid: number;
  bytesTotal: number;        // -1 if unknown
  bytesDone: number;
  // ms epoch of the last bytesDone advance. The streaming watchdog
  // aborts the transfer if this falls more than PROGRESS_STALL_MS
  // behind real time, catching backends that connect-but-stall mid-pipe.
  lastProgressMs: number;
  status: TransferStatus;
  error: string | null;
  startedAt: number;         // ms epoch
  endedAt: number | null;
  abort: AbortController;
}

// ----- resource bounds ----------------------------------------------------
// Per-stage timeouts. The streaming download+receive is NOT bounded by a
// fixed deadline (a 100GB transfer over a slow link is legitimate);
// instead, a progress watchdog (PROGRESS_STALL_MS) aborts when bytesDone
// stops advancing — that's what catches a connected-but-stalled backend.
const STAT_TIMEOUT_MS = 30_000;
const CHMOD_TIMEOUT_MS = 30_000;
const CHOWN_TIMEOUT_MS = 30_000;
const DELETE_TIMEOUT_MS = 60_000;
const PROGRESS_STALL_MS = 60_000;
const PROGRESS_WATCHDOG_TICK_MS = 5_000;

// Cap on concurrent (pending|running) transfers per user. Prevents a
// single user from pinning unbounded memory by queueing transfers
// against a wedged backend. The handler surfaces this as a 429.
export const MAX_CONCURRENT_TRANSFERS_PER_USER = 8;

/**
 * Combine multiple AbortSignals into one. Prefers the stdlib
 * `AbortSignal.any` (Node >= 20) for correct teardown; falls back to a
 * manual controller that listens to each input. The fallback never
 * runs in this project (Node >= 22) but keeps the function safe to
 * lift into older Node environments.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  // Fast path: stdlib (Node 20+). Documented to detach listeners when
  // the returned signal aborts, so no manual cleanup is needed.
  const any = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === 'function') return any(signals);
  // Fallback: manual fan-in. Each input signal's 'abort' event aborts
  // the controller exactly once; we propagate the reason from whichever
  // input fired first. Listeners leak until GC of the controller — fine
  // for short-lived stage fetches.
  const controller = new AbortController();
  const onAbort = (ev: Event): void => {
    const target = ev.target as AbortSignal;
    if (!controller.signal.aborted) controller.abort(target.reason);
  };
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      return controller.signal;
    }
    s.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
}

// In-memory store of active and recently-finished transfers. We retain
// finished entries for STALE_MS so a SPA tab can still load progress
// after a brief disconnect; older entries are swept lazily.
const transfers = new Map<string, TransferState>();
const STALE_MS = 5 * 60 * 1000; // 5 minutes

function sweep(): void {
  const cutoff = Date.now() - STALE_MS;
  for (const [id, t] of transfers) {
    if (t.endedAt !== null && t.endedAt < cutoff) {
      transfers.delete(id);
    }
  }
}

// SSE subscriber sinks. Each subscriber is a per-request function that
// receives a serialised event line. We notify all of them on every state
// mutation; producers don't care about the consumer's pacing.
const subscribers = new Map<string, Set<(event: string) => void>>();

function notify(state: TransferState): void {
  const subs = subscribers.get(state.id);
  if (!subs || subs.size === 0) return;
  const payload = JSON.stringify({
    id: state.id,
    bytesTotal: state.bytesTotal,
    bytesDone: state.bytesDone,
    status: state.status,
    error: state.error,
  });
  const line = `data: ${payload}\n\n`;
  for (const send of subs) {
    try {
      send(line);
    } catch {
      // sink is closed; the SSE handler is responsible for unregistering.
    }
  }
}

function newId(): string {
  // crypto.randomBytes — Math.random is not security-suitable. The
  // transfer ID is the sole entropy preventing cross-user enumeration
  // of in-flight transfers (combined with the userId check on every
  // state lookup), so it has to be unguessable.
  return randomBytes(16).toString('hex');
}

// ----- worker --------------------------------------------------------------

/**
 * Resolves the validated IP pinned to a registered server. The proxy /
 * registration path caches `resolvedIp` on the row; if it's missing
 * (legacy row) we re-validate-and-resolve here and refuse if anything
 * has shifted into a blocked range. Returns null on failure so callers
 * can fail the transfer with a tidy error.
 */
async function pinnedIpFor(
  target: { url: string; resolvedIp: string | null },
): Promise<string | null> {
  try {
    assertSafeURL(target.url);
  } catch {
    return null;
  }
  if (target.resolvedIp) {
    return isBlockedIP(target.resolvedIp) ? null : target.resolvedIp;
  }
  try {
    const v = await validateAndResolve(target.url);
    return v.ip;
  } catch {
    return null;
  }
}

/**
 * Builds the connect URL + Host header for a fetch against a registered
 * backend. For http we connect by IP literal and force the Host header
 * to the original hostname. For https we keep the URL hostname (so SNI
 * + cert validation work) and re-check live DNS to catch a rebind
 * between registration and now.
 */
async function buildPinnedRequest(
  target: { url: string },
  pinnedIp: string,
  upstreamURL: string,
): Promise<{ connectURL: string; hostHeader: string | null }> {
  const u = new URL(upstreamURL);
  const orig = new URL(target.url);
  if (u.protocol === 'http:') {
    const port = u.port || '80';
    const connectURL = `${u.protocol}//${pinnedIp}:${port}${u.pathname}${u.search}`;
    const defaultPort = '80';
    const hostHeader =
      orig.port && orig.port !== defaultPort ? `${orig.hostname}:${orig.port}` : orig.hostname;
    return { connectURL, hostHeader };
  }
  const ips = await resolveHostnamesToIPs(orig.hostname);
  for (const r of ips) {
    if (isBlockedIP(r)) {
      throw new Error(`hostname ${orig.hostname} now resolves to a blocked IP ${r}`);
    }
  }
  return { connectURL: upstreamURL, hostHeader: null };
}

/**
 * Run the actual byte-pumping pipeline for one transfer. The function
 * returns when the worker terminates (success or failure); callers
 * should NOT await it from the request handler — the handler returns the
 * id immediately and the worker pushes progress over SSE.
 */
async function runTransfer(state: TransferState): Promise<void> {
  try {
  const src = getServerToken(state.userId, state.srcServer);
  const dst = getServerToken(state.userId, state.dstServer);
  if (!src || !dst) {
    failed(state, 'unknown source or destination server');
    return;
  }

  // SSRF defence: connect via the pinned IPs captured at registration.
  // Refuse the whole transfer if either side now resolves into a blocked
  // range or fails URL parsing.
  const srcIp = await pinnedIpFor(src);
  const dstIp = await pinnedIpFor(dst);
  if (!srcIp) {
    failed(state, 'source server URL failed SSRF validation');
    return;
  }
  if (!dstIp) {
    failed(state, 'destination server URL failed SSRF validation');
    return;
  }

  // Pre-flight stat so we have bytesTotal for progress reporting. Also
  // a clean failure point if the source path is denied / doesn't exist
  // BEFORE we touch the destination.
  try {
    const statURL = `${src.url.replace(/\/$/, '')}/api/fs/stat?path=${encodeURIComponent(state.srcPath)}`;
    const { connectURL, hostHeader } = await buildPinnedRequest(src, srcIp, statURL);
    const statSignal = anySignal([state.abort.signal, AbortSignal.timeout(STAT_TIMEOUT_MS)]);
    const statResp = await fetch(connectURL, {
      headers: {
        ...backendHeaders(src.token, state.userRole),
        ...(hostHeader ? { Host: hostHeader } : {}),
      },
      signal: statSignal,
      redirect: 'manual',
    });
    if (!statResp.ok) {
      const body = (await statResp.json().catch(() => null)) as { error?: string } | null;
      failed(state, `source stat: ${body?.error || statResp.status}`);
      return;
    }
    const entry = (await statResp.json()) as {
      type: string;
      size: number;
      mode: number;
      uid: number;
      gid: number;
    };
    if (entry.type === 'dir') {
      failed(state, 'directory transfer not supported in this version');
      return;
    }
    if (entry.type !== 'file') {
      failed(state, `source is a ${entry.type}, only files are supported`);
      return;
    }
    state.bytesTotal = entry.size;
    state.srcMode = entry.mode;
    state.srcUid = entry.uid;
    state.srcGid = entry.gid;
    notify(state);
  } catch (err) {
    if (state.abort.signal.aborted) return; // cancelled() will run from outside
    failed(state, `source stat: ${(err as Error).message}`);
    return;
  }

  // Streaming download + receive share a single progress watchdog.
  // There is no fixed-deadline cap on this stage — a legitimate 100GB
  // transfer over a slow link can take hours — but if bytesDone hasn't
  // advanced in PROGRESS_STALL_MS, we abort with a "stalled" error.
  // This catches a backend that opened the socket but stopped feeding
  // bytes (or a destination that stopped consuming them).
  const stallController = new AbortController();
  state.lastProgressMs = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - state.lastProgressMs > PROGRESS_STALL_MS) {
      // Aborting with an Error reason lets fetch surface it as `reason`
      // on the rejected promise; we map it back to a user-readable
      // message in the catch arms below.
      stallController.abort(
        new Error(`transfer stalled: no progress for ${PROGRESS_STALL_MS}ms`),
      );
    }
  }, PROGRESS_WATCHDOG_TICK_MS);

  try {
    // Open the source stream. We don't buffer the response body — the
    // ReadableStream wrapper below piggybacks a byte counter on each
    // chunk and the destination POST consumes the wrapper directly.
    let srcResp: Response;
    try {
      const downloadURL = `${src.url.replace(/\/$/, '')}/api/fs/download?path=${encodeURIComponent(state.srcPath)}`;
      const { connectURL, hostHeader } = await buildPinnedRequest(src, srcIp, downloadURL);
      const downloadSignal = anySignal([state.abort.signal, stallController.signal]);
      srcResp = await fetch(connectURL, {
        headers: {
          ...backendHeaders(src.token, state.userRole),
          ...(hostHeader ? { Host: hostHeader } : {}),
        },
        signal: downloadSignal,
        redirect: 'manual',
      });
      if (!srcResp.ok || !srcResp.body) {
        failed(state, `source download: ${srcResp.status}`);
        return;
      }
    } catch (err) {
      if (state.abort.signal.aborted) return;
      if (stallController.signal.aborted) {
        failed(state, `source download: ${(stallController.signal.reason as Error)?.message ?? 'stalled'}`);
        return;
      }
      failed(state, `source download: ${(err as Error).message}`);
      return;
    }

    state.status = 'running';
    notify(state);

    // Wrap the source stream so each chunk increments bytesDone and
    // refreshes the watchdog timestamp. We tick the SSE notifier at
    // most every 200ms to avoid overwhelming the pipe on fast LAN
    // transfers, but lastProgressMs updates on every chunk so the
    // watchdog sees fine-grained activity.
    const reader = srcResp.body.getReader();
    let lastTick = 0;
    const counter = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          state.bytesDone += value.byteLength;
          state.lastProgressMs = Date.now();
          if (state.lastProgressMs - lastTick > 200) {
            lastTick = state.lastProgressMs;
            notify(state);
          }
          controller.enqueue(value);
        } catch (err) {
          controller.error(err);
        }
      },
      cancel(reason) {
        reader.cancel(reason).catch(() => {});
      },
    });

    // POST the wrapped stream to the destination's receive endpoint.
    // The `duplex: 'half'` field is required by the fetch spec when the
    // body is a stream; Node's undici implements it.
    try {
      const overwriteFlag = state.overwrite ? '&overwrite=true' : '';
      const receiveURL = `${dst.url.replace(/\/$/, '')}/api/fs/receive?path=${encodeURIComponent(state.dstPath)}${overwriteFlag}`;
      const { connectURL, hostHeader } = await buildPinnedRequest(dst, dstIp, receiveURL);
      const receiveSignal = anySignal([state.abort.signal, stallController.signal]);
      const recvResp = await fetch(connectURL, {
        method: 'POST',
        headers: {
          ...backendHeaders(dst.token, state.userRole),
          ...(hostHeader ? { Host: hostHeader } : {}),
          'Content-Type': 'application/octet-stream',
        },
        body: counter,
        signal: receiveSignal,
        redirect: 'manual',
        // duplex is required by the WHATWG fetch spec when body is a stream;
        // Node's undici implements it. Cast for environments whose lib.dom
        // types don't include it yet.
        ...({ duplex: 'half' } as object),
      });
      if (!recvResp.ok) {
        const body = (await recvResp.json().catch(() => null)) as { error?: string } | null;
        failed(state, `destination upload: ${body?.error || recvResp.status}`);
        return;
      }
    } catch (err) {
      if (state.abort.signal.aborted) return;
      if (stallController.signal.aborted) {
        failed(state, `destination upload: ${(stallController.signal.reason as Error)?.message ?? 'stalled'}`);
        return;
      }
      failed(state, `destination upload: ${(err as Error).message}`);
      return;
    }
  } finally {
    clearInterval(watchdog);
  }

  // Optionally apply source ownership + mode to the destination. We do
  // this BEFORE the move-mode delete so a chmod/chown failure surfaces
  // before we drop the source — the user can recover. Requires admin
  // role because chmod/chown on the backend are admin-only; we don't
  // pre-check on this end because the backend's role gate will reject
  // cleanly with a clear error if the caller isn't admin.
  if (state.preserveSourceOwnership) {
    try {
      const chmodURL = `${dst.url.replace(/\/$/, '')}/api/fs/chmod`;
      const chmodReq = await buildPinnedRequest(dst, dstIp, chmodURL);
      const chmodSignal = anySignal([state.abort.signal, AbortSignal.timeout(CHMOD_TIMEOUT_MS)]);
      const chmodResp = await fetch(chmodReq.connectURL, {
        method: 'POST',
        headers: {
          ...backendHeaders(dst.token, state.userRole),
          ...(chmodReq.hostHeader ? { Host: chmodReq.hostHeader } : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ path: state.dstPath, mode: state.srcMode }),
        signal: chmodSignal,
        redirect: 'manual',
      });
      if (!chmodResp.ok) {
        const body = (await chmodResp.json().catch(() => null)) as { error?: string } | null;
        failed(state, `preserve mode failed: ${body?.error || chmodResp.status}`);
        return;
      }
      const chownURL = `${dst.url.replace(/\/$/, '')}/api/fs/chown`;
      const chownReq = await buildPinnedRequest(dst, dstIp, chownURL);
      const chownSignal = anySignal([state.abort.signal, AbortSignal.timeout(CHOWN_TIMEOUT_MS)]);
      const chownResp = await fetch(chownReq.connectURL, {
        method: 'POST',
        headers: {
          ...backendHeaders(dst.token, state.userRole),
          ...(chownReq.hostHeader ? { Host: chownReq.hostHeader } : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path: state.dstPath,
          owner: String(state.srcUid),
          group: String(state.srcGid),
        }),
        signal: chownSignal,
        redirect: 'manual',
      });
      if (!chownResp.ok) {
        const body = (await chownResp.json().catch(() => null)) as { error?: string } | null;
        failed(state, `preserve ownership failed: ${body?.error || chownResp.status}`);
        return;
      }
    } catch (err) {
      if (state.abort.signal.aborted) return;
      failed(state, `preserve ownership: ${(err as Error).message}`);
      return;
    }
  }

  // Move: delete source. Failure here is non-fatal in terms of the bytes
  // already on the destination, but we still surface it to the user so
  // they know to clean up manually.
  if (state.mode === 'move') {
    try {
      const delURL = `${src.url.replace(/\/$/, '')}/api/fs/entry?path=${encodeURIComponent(state.srcPath)}`;
      const delReq = await buildPinnedRequest(src, srcIp, delURL);
      const delSignal = anySignal([state.abort.signal, AbortSignal.timeout(DELETE_TIMEOUT_MS)]);
      const delResp = await fetch(delReq.connectURL, {
        method: 'DELETE',
        headers: {
          ...backendHeaders(src.token, state.userRole),
          ...(delReq.hostHeader ? { Host: delReq.hostHeader } : {}),
        },
        signal: delSignal,
        redirect: 'manual',
      });
      if (!delResp.ok) {
        const body = (await delResp.json().catch(() => null)) as { error?: string } | null;
        failed(state, `copied but source delete failed: ${body?.error || delResp.status}`);
        return;
      }
    } catch (err) {
      if (state.abort.signal.aborted) return;
      failed(state, `copied but source delete failed: ${(err as Error).message}`);
      return;
    }
  }

  state.status = 'completed';
  state.endedAt = Date.now();
  // Force a final notify so subscribers don't miss the last byte tick
  // before the 200ms throttle ends.
  state.bytesDone = state.bytesTotal >= 0 ? state.bytesTotal : state.bytesDone;
  notify(state);
  } finally {
    // Guarantee endedAt is set on every code path so the sweep() at the
    // top of createTransfer can purge the entry after STALE_MS, even if
    // an unexpected throw bypassed failed()/the success branch.
    // Using ??= preserves the precise timestamp set by failed() or the
    // success path; only an untyped escape lands here without one.
    state.endedAt ??= Date.now();
  }
}

function failed(state: TransferState, msg: string): void {
  state.status = 'failed';
  state.error = msg;
  state.endedAt = Date.now();
  notify(state);
}

function backendHeaders(token: string, role: string): Record<string, string> {
  return {
    'X-Vantage-Backend-Token': token,
    'X-Vantage-Role': role,
  };
}

// ----- HTTP handlers (registered by server.ts) -----------------------------

interface AuthedUser {
  id: string;
  email: string;
  role: string;
}

interface CreateBody {
  srcServer: unknown;
  srcPath: unknown;
  dstServer: unknown;
  dstPath: unknown;
  mode: unknown;
  overwrite?: unknown;
  preserveSourceOwnership?: unknown;
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

export async function createTransfer(c: Context, user: AuthedUser): Promise<Response> {
  sweep();
  const body = (await c.req.json().catch(() => null)) as CreateBody | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);
  const { srcServer, srcPath, dstServer, dstPath, mode } = body;
  const overwrite = body.overwrite === true;
  const preserveSourceOwnership = body.preserveSourceOwnership === true;
  if (!isString(srcServer) || !isString(srcPath) || !isString(dstServer) || !isString(dstPath)) {
    return c.json({ error: 'srcServer/srcPath/dstServer/dstPath required' }, 400);
  }
  if (mode !== 'move' && mode !== 'copy') {
    return c.json({ error: 'mode must be "move" or "copy"' }, 400);
  }
  if (srcServer === dstServer && srcPath === dstPath) {
    return c.json({ error: 'source and destination are identical' }, 400);
  }
  // Role gate — same bar the proxy enforces for write paths on the
  // backend. We re-check here so a viewer can't kick off a transfer.
  if (user.role === 'viewer') {
    return c.json({ error: 'operator role required' }, 403);
  }
  // Validate both servers belong to this user (registry is per-user).
  if (!getServerToken(user.id, srcServer) || !getServerToken(user.id, dstServer)) {
    return c.json({ error: 'unknown source or destination server' }, 404);
  }
  // Per-user concurrency cap. A single user with N tabs (or a script)
  // could otherwise accumulate unbounded in-flight entries against a
  // wedged backend. Each entry holds an AbortController + a piece of
  // the source ReadableStream, so the cap also bounds worst-case RAM.
  let activeForUser = 0;
  for (const t of transfers.values()) {
    if (t.userId === user.id && (t.status === 'pending' || t.status === 'running')) {
      activeForUser += 1;
    }
  }
  if (activeForUser >= MAX_CONCURRENT_TRANSFERS_PER_USER) {
    return c.json(
      {
        error: `max ${MAX_CONCURRENT_TRANSFERS_PER_USER} concurrent transfers per user; cancel an existing one first`,
      },
      429,
    );
  }
  const state: TransferState = {
    id: newId(),
    userId: user.id,
    userRole: user.role,
    srcServer,
    srcPath,
    dstServer,
    dstPath,
    mode,
    overwrite,
    preserveSourceOwnership,
    srcMode: 0,
    srcUid: 0,
    srcGid: 0,
    bytesTotal: -1,
    bytesDone: 0,
    lastProgressMs: Date.now(),
    status: 'pending',
    error: null,
    startedAt: Date.now(),
    endedAt: null,
    abort: new AbortController(),
  };
  transfers.set(state.id, state);
  // Fire and forget. Worker handles its own failure paths via notify().
  void runTransfer(state).catch((err) => {
    failed(state, `worker crashed: ${(err as Error).message}`);
  });
  return c.json({ id: state.id });
}

export function streamTransfer(c: Context, user: AuthedUser): Response {
  const id = c.req.param('id') ?? '';
  const state = transfers.get(id);
  if (!state || state.userId !== user.id) {
    return c.json({ error: 'unknown transfer' }, 404);
  }
  // Construct an SSE response. We register a sink that the notify()
  // path calls; on client disconnect we tear it down.
  let send: ((line: string) => void) | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      send = (line: string) => controller.enqueue(enc.encode(line));
      // Immediately push a snapshot so the SPA gets initial state.
      send(`data: ${JSON.stringify({
        id: state.id,
        bytesTotal: state.bytesTotal,
        bytesDone: state.bytesDone,
        status: state.status,
        error: state.error,
      })}\n\n`);
      const set = subscribers.get(id) ?? new Set();
      set.add(send);
      subscribers.set(id, set);
      // If the transfer already finished BEFORE we subscribed (race on
      // tiny files), close the stream right away.
      if (state.endedAt !== null) {
        controller.close();
      }
    },
    cancel() {
      if (send) {
        const set = subscribers.get(id);
        set?.delete(send);
        if (set && set.size === 0) subscribers.delete(id);
      }
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}

export function cancelTransfer(c: Context, user: AuthedUser): Response {
  const id = c.req.param('id') ?? '';
  const state = transfers.get(id);
  if (!state || state.userId !== user.id) {
    return c.json({ error: 'unknown transfer' }, 404);
  }
  if (state.endedAt !== null) {
    return c.json({ ok: true, alreadyEnded: true });
  }
  state.abort.abort();
  state.status = 'cancelled';
  state.error = 'cancelled by user';
  state.endedAt = Date.now();
  notify(state);
  return c.json({ ok: true });
}
