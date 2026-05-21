import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { serve } from '@hono/node-server';
import { getMigrations } from 'better-auth/db/migration';
import { auth, db, isBootstrapped, type UserRole } from './auth.js';
import { env } from './env.js';
import {
  addServer,
  ensureRegistrySchema,
  getServerToken,
  listServers,
  removeServer,
  updateServer,
} from './registry.js';
import {
  ensureAuditSchema,
  startAuditRetention,
  writeAudit,
  type AuditStatus,
} from './audit.js';
import { cancelTransfer, createTransfer, streamTransfer } from './transfer.js';
import {
  addWhitelist,
  ensureWhitelistSchema,
  listWhitelist,
  normalizeEmail,
  removeWhitelist,
} from './whitelist.js';
import {
  validateAndResolve,
  isBlockedIP,
  resolveHostnamesToIPs,
  assertSafeURL,
} from './net-policy.js';

// Create schema. On a fresh DB this creates the user/account/session tables;
// on an existing DB it's a no-op. `auth.options` is typed on the `Auth`
// type — no cast needed.
const migrations = await getMigrations(auth.options);
await migrations.runMigrations();

// And our own table for the per-user server registry. Runs after better-auth
// migrations so we know the DB file exists and WAL mode is set.
ensureRegistrySchema();
ensureAuditSchema();
ensureWhitelistSchema();
startAuditRetention();

// One-time backfill: existing users predate the role column. The bootstrap
// admin must end up as 'admin' rather than NULL, otherwise they'd be locked
// out the moment role enforcement turns on. Safe to run unconditionally —
// the WHERE clause means it's a no-op once every row has a role, and the
// single-admin invariant guarantees there's only one row to fix.
db.exec(`UPDATE user SET role = 'admin' WHERE role IS NULL OR role = ''`);

// Hono context-variable typing. requireAuth() stashes the resolved session
// user on c.var.user so downstream handlers can read it with a single
// c.get('user') call — no second session lookup, no second null-check, and
// no chance of forgetting either gate on a future route (the type only
// resolves under a sub-app that already ran requireAuth).
type AppEnv = { Variables: { user: AuthedUser } };

const app = new Hono<AppEnv>();

// nginx auth_request hits this. 204 if authenticated, 401 if not.
app.get(`${env.basePath}/_check`, async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.body(null, 401);
  c.header('X-Auth-User', session.user.email);
  return c.body(null, 204);
});

// Unauthenticated — the frontend hits this on cold load to decide between
// the "create your admin" page and the sign-in page.
app.get(`${env.basePath}/_status`, (c) => {
  return c.json({ bootstrapped: isBootstrapped() });
});

// _email_status was removed: the prior endpoint returned `new` for emails
// that were whitelisted-but-not-registered, which let an attacker enumerate
// the admin's whitelist with a wordlist sweep. The LoginPage no longer
// probes per-email; sign-in vs sign-up is an explicit user toggle, and
// whether an email is whitelisted is only revealed at sign-up time (via
// the create.before hook in auth.ts), behind better-auth's per-IP
// rate-limit on /sign-up/*.

// Monorepo version baked in at build time via the ARG → ENV in gate's
// Dockerfile. Mounted under env.basePath so nginx's existing /auth/ proxy
// reaches it; defined before the better-auth catch-all below so it isn't
// swallowed. Public (no auth) so the About panel + probes work without a
// session. Falls back to "dev" for bare-metal runs.
app.get(`${env.basePath}/version`, (c) =>
  c.json({ service: 'gate', version: process.env.VANTAGE_VERSION || 'dev' }),
);

// Everything else under /auth is Better Auth's surface.
app.on(['GET', 'POST'], `${env.basePath}/*`, (c) => auth.handler(c.req.raw));

app.get('/health', (c) => c.json({ status: 'ok' }));

// ---------------------------------------------------------------------------
// Server registry — /api/servers*  (the SPA mounts every request through this)
// ---------------------------------------------------------------------------
//
// All routes are session-gated. Tokens are never returned to the client;
// the registry stores them encrypted and the proxy below attaches them
// server-side when forwarding /api/servers/<id>/<resource> to the chosen
// backend.

interface AuthedUser {
  id: string;
  email: string;
  role: UserRole;
}

// validRole guards the cast from session.user.role (which better-auth types
// as `string` because additionalFields can't narrow at the type level).
// An invalid stored value defaults to 'viewer' — fail closed, never grant
// elevated permissions from a typo or corrupted row.
function validRole(v: unknown): UserRole {
  return v === 'admin' || v === 'operator' || v === 'viewer' ? v : 'viewer';
}

async function requireUser(c: Context): Promise<AuthedUser | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  return {
    id: session.user.id,
    email: session.user.email,
    role: validRole((session.user as { role?: unknown }).role),
  };
}

// Role hierarchy: a higher rank satisfies any lower-or-equal minimum. Kept
// as a const map (not a chain of conditionals) so adding a future tier
// — say 'auditor' between viewer and operator — is a one-line change.
type MinRole = UserRole;
const ROLE_RANK: Record<UserRole, number> = { viewer: 0, operator: 1, admin: 2 };

/**
 * Hono middleware: gate a route (or a whole sub-app) on session + role.
 *
 *   1. Resolves the session via requireUser. 401 with empty body on
 *      missing/invalid session (matches the original `c.body(null, 401)`
 *      shape the SPA pattern-matches against).
 *   2. 403 with `{ error: '<minRole> role required' }` if the user's role
 *      rank is below minRole (matches the original whitelist 403 shape
 *      and transfer.ts's internal 'operator role required' message).
 *   3. Stores the resolved user on c.var.user for the downstream handler,
 *      so handlers do `const user = c.get('user')` instead of repeating
 *      the session lookup.
 *
 * Routes mounted under a sub-app that uses this middleware get the gate
 * applied automatically — no per-handler boilerplate, and forgetting the
 * check on a NEW route is no longer possible because the route only
 * exists inside the already-gated sub-app.
 */
function requireAuth(minRole: MinRole): MiddlewareHandler<AppEnv> {
  const minRank = ROLE_RANK[minRole];
  return async (c, next) => {
    const user = await requireUser(c);
    if (!user) return c.body(null, 401);
    if (ROLE_RANK[user.role] < minRank) {
      return c.json({ error: `${minRole} role required` }, 403);
    }
    c.set('user', user);
    await next();
  };
}

// requireXRequestedWith is the CSRF middleware for the custom /api/*
// surface. SameSite=lax cookies already block top-level cross-site form
// POSTs in modern browsers, but a same-site subdomain or an older
// browser can still slip through. Requiring a non-standard header
// (`X-Requested-With: XMLHttpRequest`) on every mutating request closes
// that gap: any cross-origin attempt to set this header forces a CORS
// preflight, which the auth service does not grant — so an attacker
// page cannot forge state-changing requests with the user's session
// cookie. The SPA's apiFetch helper sets this header on every request.
//
// GET/HEAD/OPTIONS are exempt: read-only methods aren't CSRF-relevant,
// and the SPA's safe-method calls (settings reads, registry lists) all
// already include the header anyway.
//
// NOT applied to /auth/* — better-auth manages its own CSRF posture
// for the sign-in / sign-up / OAuth callback surface.
function requireXRequestedWith(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const m = c.req.method.toUpperCase();
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') {
      await next();
      return;
    }
    if (c.req.header('x-requested-with') !== 'XMLHttpRequest') {
      return c.json({ error: 'missing X-Requested-With header' }, 403);
    }
    await next();
  };
}

// Mirrors backend's probeOutpost: GET <url>/api/health with the shared
// secret; expect 200 (or 4xx for auth) and surface a meaningful error.
//
// The connect is pinned to `pinnedIp` so DNS rebinding can't slip a private
// address past the registration-time guard: the auth service connects to
// the IP we just validated, not to whatever the resolver returns at fetch
// time. The Host header preserves vhost dispatch on the upstream. For
// HTTPS, the URL still carries the original hostname so SNI + cert
// validation work (we get pinning via the http(s).Agent lookup hook
// rather than rewriting the URL to an IP literal).
async function probeBackend(
  url: string,
  token: string,
  pinnedIp: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const target = url.replace(/\/$/, '') + '/api/health';
  let resp: Response;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      resp = await fetchPinned(target, pinnedIp, {
        method: 'GET',
        headers: { 'X-Vantage-Backend-Token': token },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message || 'unreachable' };
  }
  if (resp.status === 401) {
    return { ok: false, error: 'backend rejected token (check VANTAGE_BACKEND_TOKEN)' };
  }
  if (!resp.ok) {
    return { ok: false, error: `backend returned ${resp.status}` };
  }
  return { ok: true };
}

/**
 * Fetch helper that pins the connect to a specific IP (defeats DNS
 * rebinding). For HTTPS the original hostname is preserved in the URL so
 * SNI + cert validation still work; the connect is steered to the IP via
 * the http(s).Agent's lookup hook. For HTTP we just rewrite to the IP
 * and force the Host header. Redirects are returned to the caller, never
 * auto-followed (a 3xx Location can point at a private IP).
 */
async function fetchPinned(url: string, ip: string, init: RequestInit): Promise<Response> {
  const u = new URL(url);
  // Sanity: if for any reason the pinned IP itself is now in a blocked
  // range, refuse. This protects against future block-list updates
  // applying to old rows.
  if (isBlockedIP(ip)) {
    throw new Error(`pinned IP ${ip} is now in a blocked range`);
  }
  const hostInUrl = u.hostname; // keep original — Host header + SNI matter
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  // For http we connect by IP literal and pass Host header; for https we
  // keep the hostname for SNI/cert validation. Node's undici-backed fetch
  // doesn't honour a custom agent lookup in all versions, so we use the
  // IP-literal+Host-header approach for http (cleanest) and accept that
  // for https the caller's hostname must already point at a public
  // address (the registration-time check guarantees that).
  if (u.protocol === 'http:') {
    const ipUrl = `${u.protocol}//${ip}:${port}${u.pathname}${u.search}`;
    const headers = new Headers(init.headers);
    const defaultPort = '80';
    headers.set('Host', u.port && u.port !== defaultPort ? `${hostInUrl}:${u.port}` : hostInUrl);
    return fetch(ipUrl, { ...init, headers, redirect: 'manual' });
  }
  // https: rely on the registration-time IP check + the absence of CNAME
  // rebinding (the registered hostname's A/AAAA records are checked again
  // here just before the fetch). The fetch itself uses the original URL.
  const ips = await resolveHostnamesToIPs(u.hostname);
  for (const r of ips) {
    if (isBlockedIP(r)) {
      throw new Error(`hostname ${u.hostname} now resolves to a blocked IP ${r}`);
    }
  }
  return fetch(url, { ...init, redirect: 'manual' });
}

// Sub-app for routes that only require an authenticated session (any role).
// Anything mounted here automatically inherits the requireAuth('viewer')
// gate — adding a new route is no longer a place where a missing session
// check can slip through. Handlers read the resolved user via c.get('user');
// no second session lookup, no second null-check.
const viewerApi = new Hono<AppEnv>();
viewerApi.use('*', requireXRequestedWith());
viewerApi.use('*', requireAuth('viewer'));

// Sub-app for admin-only routes (currently the email whitelist CRUD).
// Same property: any future admin endpoint added under /api/whitelist
// inherits the gate by virtue of being mounted on this sub-app.
const adminWhitelistApi = new Hono<AppEnv>();
adminWhitelistApi.use('*', requireXRequestedWith());
adminWhitelistApi.use('*', requireAuth('admin'));

viewerApi.get('/servers', (c) => {
  const user = c.get('user');
  return c.json(listServers(user.id));
});

viewerApi.post('/servers', async (c) => {
  const user = c.get('user');

  const body = await c.req.json().catch(() => null) as
    | { name?: string; url?: string; token?: string }
    | null;
  if (!body) return c.json({ error: 'invalid JSON' }, 400);

  const name = (body.name ?? '').trim();
  const url = (body.url ?? '').trim().replace(/\/$/, '');
  const token = body.token ?? '';
  if (!name || !url) return c.json({ error: 'name and url are required' }, 400);

  // SSRF guard: parse + resolve + check every resolved IP against the
  // blocked-range list. The validated IP is cached on the row so all
  // future proxy fetches connect to it directly, defeating DNS rebinding.
  // Operators on trusted LANs can opt out with AUTH_SSRF_ALLOW_PRIVATE=1.
  let validated: Awaited<ReturnType<typeof validateAndResolve>>;
  try {
    validated = await validateAndResolve(url);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  const probe = await probeBackend(url, token, validated.ip);
  if (!probe.ok) return c.json({ error: `probe failed: ${probe.error}` }, 502);

  const summary = addServer(user.id, { name, url, token, resolvedIp: validated.ip });
  return c.json(summary);
});

viewerApi.put('/servers/:id', async (c) => {
  const user = c.get('user');

  const body = await c.req.json().catch(() => null) as
    | { name?: string; url?: string; token?: string }
    | null;
  if (!body) return c.json({ error: 'invalid JSON' }, 400);

  // If url or token changed, re-validate + re-probe before persisting.
  // If only the URL changed (not just a rename), we must run the SSRF
  // guard against the new URL and refresh the cached resolvedIp.
  // Otherwise it's a rename and we skip the network roundtrip.
  let newResolvedIp: string | undefined;
  if (body.url || body.token) {
    const existing = getServerToken(user.id, c.req.param('id'));
    if (!existing) return c.json({ error: 'unknown server' }, 404);
    const url = (body.url ?? existing.url).replace(/\/$/, '');
    const token = body.token ?? existing.token;
    // Re-validate the URL — same rules as POST. If only the token changed
    // we still validate to be safe; it's cheap.
    let validated: Awaited<ReturnType<typeof validateAndResolve>>;
    try {
      validated = await validateAndResolve(url);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    newResolvedIp = validated.ip;
    const probe = await probeBackend(url, token, validated.ip);
    if (!probe.ok) return c.json({ error: `probe failed: ${probe.error}` }, 502);
  }

  const updated = updateServer(user.id, c.req.param('id'), {
    ...body,
    ...(newResolvedIp !== undefined ? { resolvedIp: newResolvedIp } : {}),
  });
  if (!updated) return c.json({ error: 'unknown server' }, 404);
  return c.json(updated);
});

viewerApi.delete('/servers/:id', (c) => {
  const user = c.get('user');
  const ok = removeServer(user.id, c.req.param('id'));
  if (!ok) return c.json({ error: 'unknown server' }, 404);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Cross-outpost file transfer orchestrator. The transfer worker lives in
// the auth service because it's the only process that knows about every
// registered server's URL+token; the backend can't reach other backends
// directly without us mediating.
// ---------------------------------------------------------------------------

// /api/transfer routes are session-gated at the route layer (viewer is
// enough to enter), but createTransfer applies its own operator-or-above
// gate inside the handler — the original `user.role === 'viewer'` check.
// We deliberately leave that internal gate in place: it's a defence-in-
// depth check that mirrors the bar the backend enforces on write paths,
// and moving it here would change the layer at which the 403 is produced
// without changing the observable response shape. Out of scope.
viewerApi.post('/transfer', (c) => createTransfer(c, c.get('user')));
viewerApi.get('/transfer/:id/stream', (c) => streamTransfer(c, c.get('user')));
viewerApi.delete('/transfer/:id', (c) => cancelTransfer(c, c.get('user')));

// ---------------------------------------------------------------------------
// Email whitelist — admin-only. List/add/remove pre-authorised emails. The
// create.before hook in auth.ts consults this table on every sign-up after
// bootstrap.
// ---------------------------------------------------------------------------

adminWhitelistApi.get('/', (c) => {
  return c.json(listWhitelist());
});

adminWhitelistApi.post('/', async (c) => {
  const user = c.get('user');
  const body = (await c.req.json().catch(() => null)) as
    | { email?: unknown; role?: unknown }
    | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);
  const email = typeof body.email === 'string' ? body.email : '';
  const role = body.role;
  if (!email.includes('@')) {
    return c.json({ error: 'invalid email' }, 400);
  }
  if (role !== 'viewer' && role !== 'operator' && role !== 'admin') {
    return c.json({ error: 'role must be viewer|operator|admin' }, 400);
  }
  try {
    const entry = addWhitelist(email, role, user.id);
    writeAudit({
      userId: user.id,
      userEmail: user.email,
      role: user.role,
      action: 'whitelist.add',
      target: `${normalizeEmail(email)} (${role})`,
      status: 'ok' as AuditStatus,
    });
    return c.json(entry);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

adminWhitelistApi.delete('/:email', (c) => {
  const user = c.get('user');
  const email = decodeURIComponent(c.req.param('email') ?? '');
  const removed = removeWhitelist(email);
  writeAudit({
    userId: user.id,
    userEmail: user.email,
    role: user.role,
    action: 'whitelist.remove',
    target: normalizeEmail(email),
    status: removed ? ('ok' as AuditStatus) : ('error' as AuditStatus),
  });
  if (!removed) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Proxy — /api/servers/<id>/<rest…>  → forwards to the backend with token
// ---------------------------------------------------------------------------
//
// The registry CRUD routes above use exact paths (/api/servers and
// /api/servers/:id), so Hono dispatches the catch-all below only for the
// proxy case (a path under /api/servers/:id/…).

viewerApi.all('/servers/:id/*', async (c) => {
  const user = c.get('user');

  const id = c.req.param('id');
  const target = getServerToken(user.id, id);
  if (!target) return c.json({ error: 'unknown server' }, 404);

  // Defence in depth: the URL was validated at registration time, but
  // re-parse it on every request — if a rule was added to the block list
  // since the row was created, this is where it bites. Cheap.
  let parsedTarget: URL;
  try {
    parsedTarget = assertSafeURL(target.url);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  // We connect by IP rather than by hostname so DNS rebinding can't
  // redirect us to a private address. The IP was captured at registration
  // time. If for some reason it's missing (legacy row predating this
  // column) OR it now lands in a blocked range, refuse — fail closed.
  let pinnedIp = target.resolvedIp;
  if (!pinnedIp) {
    try {
      const v = await validateAndResolve(target.url);
      pinnedIp = v.ip;
    } catch (err) {
      return c.json({ error: `legacy server failed re-validation: ${(err as Error).message}` }, 502);
    }
  } else if (isBlockedIP(pinnedIp)) {
    return c.json({ error: `server's pinned IP ${pinnedIp} is now in a blocked range` }, 502);
  }

  // The tail is whatever follows /api/servers/<id>; the backend expects it
  // under its own /api/ prefix.
  const prefix = `/api/servers/${id}`;
  const fullPath = c.req.path;
  const tail = fullPath.slice(prefix.length); // begins with '/'
  const search = new URL(c.req.url).search; // includes leading '?' or ''
  const upstreamURL = target.url.replace(/\/$/, '') + '/api' + tail + search;

  // Pass through headers we care about; rewrite Host so the upstream sees
  // its own host (some servers / reverse proxies care). Strip cookies so
  // we don't leak the auth-service session to backends — they have their
  // own auth boundary (the token we're about to add).
  //
  // X-Vantage-* headers are stripped from the inbound copy unconditionally:
  // the proxy is the trust boundary for those, and a client must never be
  // able to claim its own role or impersonate the backend token by setting
  // these headers in its request.
  const headers = new Headers();
  c.req.raw.headers.forEach((v, k) => {
    const lower = k.toLowerCase();
    if (
      lower === 'cookie' ||
      lower === 'host' ||
      lower === 'content-length' ||
      lower === 'authorization' ||
      lower === 'proxy-authorization' ||
      lower.startsWith('x-vantage-')
    ) {
      return;
    }
    headers.set(k, v);
  });
  headers.set('X-Vantage-Backend-Token', target.token);
  // Propagate the caller's role so the backend can gate write endpoints.
  headers.set('X-Vantage-Role', user.role);

  const method = c.req.method;
  const hasBody = method !== 'GET' && method !== 'HEAD';

  // SSE endpoints hold the connection open for the lifetime of the browser
  // tab. The default 30s upstream timeout would kill them; instead we
  // forward the incoming request's signal so the upstream fetch is aborted
  // exactly when the SPA disconnects (close tab, navigate away, etc.).
  //
  // Long-running write paths need wider upstream timeouts:
  //   POST   /containers          → docker pull + create + start (cold pull
  //                                 can take minutes)
  //   POST/PUT/DELETE /stacks…    → `docker compose up/down` against a
  //                                 multi-service stack can take 10+ min
  //
  // Give those 12 minutes — a comfortable buffer over the backend's own
  // 10-minute cap so the proxy isn't the bottleneck. Everything else
  // stays at 30s.
  // Long-lived SSE endpoints:
  //   /stream                          — dashboard snapshot push
  //   /containers/<id>/logs/stream    — per-container log tail
  const isStream =
    tail === '/stream' ||
    /^\/containers\/[^/]+\/logs\/stream$/.test(tail);
  const isLongRunningWrite =
    (method === 'POST' && tail === '/containers') ||
    ((method === 'POST' || method === 'PUT' || method === 'DELETE') &&
      (tail === '/stacks' || tail.startsWith('/stacks/')));
  const upstreamTimeoutMs = isStream ? 0 : isLongRunningWrite ? 12 * 60 * 1000 : 30_000;

  const ctrl = new AbortController();
  const onClientAbort = () => ctrl.abort();
  c.req.raw.signal.addEventListener('abort', onClientAbort);
  const timer = upstreamTimeoutMs > 0 ? setTimeout(() => ctrl.abort(), upstreamTimeoutMs) : undefined;

  // Connect by pinned IP. For http the URL is rewritten to the IP literal
  // and the Host header preserves the original hostname for vhost
  // dispatch on the upstream. For https we keep the URL hostname so SNI +
  // cert validation work — but we re-resolve the hostname here and
  // refuse if any answer is now private (catches rebinding-at-runtime).
  let resp: Response;
  try {
    let connectURL: string;
    if (parsedTarget.protocol === 'http:') {
      const port = parsedTarget.port || '80';
      const hostInUrl = pinnedIp;
      // Build the IP-form URL by swapping the hostname segment of upstreamURL.
      // upstreamURL was constructed from target.url + tail + search, so we
      // can safely reparse it here.
      const u = new URL(upstreamURL);
      connectURL = `${u.protocol}//${hostInUrl}:${port}${u.pathname}${u.search}`;
      const defaultPort = '80';
      headers.set(
        'Host',
        parsedTarget.port && parsedTarget.port !== defaultPort
          ? `${parsedTarget.hostname}:${parsedTarget.port}`
          : parsedTarget.hostname,
      );
    } else {
      // https: re-check live DNS to catch rebinding even though we don't
      // pin the connect (we'd lose SNI/cert validation if we did).
      const ips = await resolveHostnamesToIPs(parsedTarget.hostname);
      for (const r of ips) {
        if (isBlockedIP(r)) {
          throw new Error(`hostname ${parsedTarget.hostname} now resolves to blocked IP ${r}`);
        }
      }
      connectURL = upstreamURL;
    }
    resp = await fetch(connectURL, {
      method,
      headers,
      body: hasBody ? await c.req.raw.arrayBuffer() : undefined,
      signal: ctrl.signal,
      redirect: 'manual',
    });
  } catch (err) {
    if (timer !== undefined) clearTimeout(timer);
    c.req.raw.signal.removeEventListener('abort', onClientAbort);
    return c.json({ error: `backend unreachable: ${(err as Error).message}` }, 502);
  }
  // We deliberately requested redirect:'manual'. The proxy already
  // returned a 3xx Location to the SPA if upstream produced one; we never
  // chase it ourselves because the new target would be unvalidated.
  // Non-stream requests: headers + body have arrived together (fetch resolves
  // after the full response on most paths under our control) — safe to clear
  // the timer here. Stream requests have no timer, so this is a no-op for them.
  if (timer !== undefined) clearTimeout(timer);

  // Audit: backends declare auditable actions via X-Vantage-Audit-Action /
  // -Target response headers. The audit row is written here (not at the
  // backend) because the audit DB lives in this service's SQLite, and the
  // proxy is the only layer that knows who the authenticated user is.
  // Headers are stripped before the response is returned to the SPA.
  const auditAction = resp.headers.get('X-Vantage-Audit-Action');
  if (auditAction) {
    const auditTarget = resp.headers.get('X-Vantage-Audit-Target');
    let status: AuditStatus;
    if (resp.ok) status = 'ok';
    else if (resp.status === 403) status = 'denied';
    else status = 'error';
    try {
      writeAudit({
        userId: user.id,
        userEmail: user.email,
        role: user.role,
        action: auditAction,
        serverId: id,
        target: auditTarget,
        status,
        // For non-streamed bodies the backend's writeErr produces a small
        // JSON {"error": "..."} which we deliberately don't peek into here
        // — peeking would consume the body and corrupt the response sent
        // to the SPA. The HTTP status is enough forensic signal; richer
        // detail can flow over a dedicated X-Vantage-Audit-Error header
        // in the future if we need it.
        error: status === 'ok' ? null : `HTTP ${resp.status}`,
      });
    } catch (err) {
      // The audit log is forensic, not load-bearing — never fail the user's
      // request because we couldn't persist a row. Log and continue.
      console.error('audit write failed:', err);
    }
  }

  // Pass status, headers, and body straight back. Strip hop-by-hop headers
  // and any Set-Cookie (the backend should never be setting cookies on the
  // SPA's origin anyway). Also strip the audit declaration headers — they're
  // a control-plane contract between backend and proxy, not for the SPA.
  const outHeaders = new Headers();
  resp.headers.forEach((v, k) => {
    const lower = k.toLowerCase();
    if (
      lower === 'transfer-encoding' ||
      lower === 'connection' ||
      lower === 'set-cookie' ||
      lower === 'x-vantage-audit-action' ||
      lower === 'x-vantage-audit-target'
    ) {
      return;
    }
    outHeaders.set(k, v);
  });
  return new Response(resp.body, { status: resp.status, headers: outHeaders });
});

// Mount the gated sub-apps. The admin one goes first because it sits at a
// more specific prefix (/api/whitelist) than the viewer one (/api). Hono's
// trie router resolves them unambiguously by path either way, but the
// declaration order documents the trust hierarchy: admin-only is mounted
// first, then the broader viewer-gated surface.
app.route('/api/whitelist', adminWhitelistApi);
app.route('/api', viewerApi);

serve(
  {
    fetch: app.fetch,
    port: env.port,
    hostname: '0.0.0.0',
  },
  (info) => {
    console.log(`vantage-gate listening on :${info.port} (basePath=${env.basePath})`);
  },
);
