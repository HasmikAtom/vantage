import type {
  ContainerInspect,
  CreateContainerRequest,
  CreateContainerResponse,
  FirewallRule,
  FirewallStatus,
  FsEntry,
  FsListResponse,
  FsReadResponse,
  ReclaimableContainer,
  TrashItem,
  WhitelistEntry,
  ReclaimableImage,
  ReclaimableVolume,
  ReclaimResult,
  Stack,
  StackCreateRequest,
  StackSummary,
  StackUpdateRequest,
} from './types';

const BASE = '/api';

// All per-server endpoints are nested under /api/servers/<id>/...
// Every server id was added by the user via the Settings or first-run
// form; the gate service stores the URL + encrypted token and proxies
// these calls to the matching outpost with the token attached server-side.
function serverBase(serverId: string): string {
  return `${BASE}/servers/${encodeURIComponent(serverId)}`;
}

// ---------------------------------------------------------------------------
// apiFetch — single helper that replaces ~20 fetch/error/parse boilerplates.
// ---------------------------------------------------------------------------
//
// Why a wrapper:
//   - Uniform error shape (ApiError carries status + parsed body for callers
//     that want to handle 4xx specifically, e.g. ContainerRunningError below).
//   - One place to thread future cross-cutting concerns (CSRF, auth refresh,
//     telemetry). CSRF injection lands in a follow-up; the helper exists now
//     so that change is a one-line edit instead of a 20-site rewrite.
//   - exactOptionalPropertyTypes-safe AbortSignal passing — callers can just
//     spread `{ signal }` into init without the `signal: undefined` gotcha.

type ApiInit = Omit<RequestInit, 'body'> & {
  // Pass a plain object — apiFetch JSON-encodes it and sets Content-Type.
  // For multipart / Blob / ReadableStream / no-body, use rawBody instead.
  json?: unknown;
  // Pass through to fetch as-is (FormData uploads, raw streams, etc.).
  rawBody?: BodyInit | null;
};

export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(status: number, message: string, data: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

// Extract a useful error message from a non-OK response. Tries JSON first
// (most outpost handlers return `{error: "..."}`), then falls back to raw
// text (saveCloudflareSettings historically used this), then to a generic
// `API <status>`. The parsed value (or null) is attached to ApiError.data
// so callers can do further inspection.
async function readErrorBody(res: Response): Promise<{ data: unknown; message: string }> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    return { data: null, message: `API ${res.status}` };
  }
  if (!text) return { data: null, message: `API ${res.status}` };
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-JSON body — return text directly as the message.
    return { data: text, message: text };
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.error === 'string') return { data: parsed, message: obj.error };
  }
  return { data: parsed, message: `API ${res.status}` };
}

function buildInit(init: ApiInit): RequestInit {
  const { json, rawBody, headers, ...rest } = init;
  const finalHeaders = new Headers(headers);
  let body: BodyInit | null | undefined = rawBody;
  if (json !== undefined) {
    body = JSON.stringify(json);
    if (!finalHeaders.has('Content-Type')) finalHeaders.set('Content-Type', 'application/json');
  }
  // CSRF defence on top of SameSite=lax cookies: every request from
  // this client carries a non-standard header. Any cross-origin attempt
  // (e.g. an attacker page POSTing a form to our origin to abuse the
  // user's session) cannot set this header without triggering a CORS
  // preflight, which the gate service does NOT grant. Combined with
  // the existing SameSite=lax + the gate-side CSRF middleware that
  // requires this header on mutating routes, that closes the practical
  // CSRF surface for the custom /api/* endpoints. Built-in form posts
  // and same-site iframe abuses are blocked at the browser layer.
  if (!finalHeaders.has('X-Requested-With')) {
    finalHeaders.set('X-Requested-With', 'XMLHttpRequest');
  }
  // `credentials: 'same-origin'` is the browser default but pin it
  // explicitly — a future origin split (auth on a sibling subdomain)
  // would silently drop the session cookie otherwise.
  return {
    credentials: 'same-origin',
    ...rest,
    headers: finalHeaders,
    ...(body !== undefined ? { body } : {}),
  };
}

export async function apiFetch<T = unknown>(url: string, init: ApiInit = {}): Promise<T> {
  const res = await fetch(url, buildInit(init));
  if (!res.ok) {
    const { data, message } = await readErrorBody(res);
    throw new ApiError(res.status, message, data);
  }
  // Empty-body responses (204, or any status with explicit Content-Length: 0):
  // return undefined cast as T. Callers that don't expect a body use T = void.
  if (res.status === 204 || res.headers.get('Content-Length') === '0') {
    return undefined as T;
  }
  const ct = res.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) {
    return (await res.json()) as T;
  }
  // Non-JSON success body — return text as T. Callers needing the raw
  // Response (streams, blobs) should use apiFetchRaw instead.
  return (await res.text()) as unknown as T;
}

// For streaming download / non-JSON responses where the caller needs the
// Response object itself. Not currently consumed by any helper in this file
// (downloads happen via a plain anchor against fsDownloadURL), but kept for
// future callers and parity with the design doc.
export async function apiFetchRaw(url: string, init: ApiInit = {}): Promise<Response> {
  const res = await fetch(url, buildInit(init));
  if (!res.ok) {
    const { data, message } = await readErrorBody(res);
    throw new ApiError(res.status, message, data);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Servers registry (gate service)
// ---------------------------------------------------------------------------

// ServerSummary mirrors the shape the gate service returns from
// `GET /api/servers` — the registry now lives there, encrypted per user,
// and the token is never sent back to the client.
export interface ServerSummary {
  id: string;
  name: string;
  url: string;
  createdAt: number;
}

export function fetchServers(): Promise<ServerSummary[]> {
  return apiFetch<ServerSummary[]>(`${BASE}/servers`);
}

// The gate service probes `${url}/api/health` with the supplied token before
// persisting; a 502 here means the URL/token combination isn't reachable.
export function addServer(input: {
  name: string;
  url: string;
  token: string;
}): Promise<ServerSummary> {
  return apiFetch<ServerSummary>(`${BASE}/servers`, { method: 'POST', json: input });
}

export function removeServer(id: string): Promise<void> {
  return apiFetch<void>(`${BASE}/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// Patch any subset of name / url / token. Omitting token keeps the existing
// one (registry never sends tokens out, so we can't read-modify-write
// client-side; "leave blank" === "don't change").
export function updateServer(
  id: string,
  patch: { name?: string; url?: string; token?: string },
): Promise<ServerSummary> {
  return apiFetch<ServerSummary>(`${BASE}/servers/${encodeURIComponent(id)}`, {
    method: 'PUT',
    json: patch,
  });
}

export interface SettingsView {
  cloudflareTokenSet: boolean;
  cloudflareAccountId: string;
  cloudflareTunnelId: string;
  cloudflareRefreshSecs: number;
}

export function fetchSettings(serverId: string): Promise<SettingsView> {
  return apiFetch<SettingsView>(`${serverBase(serverId)}/settings`);
}

export interface CloudflareSettingsInput {
  apiToken?: string;
  accountId?: string;
  tunnelId?: string;
  refreshSecs?: number;
}

export function saveCloudflareSettings(
  serverId: string,
  input: CloudflareSettingsInput,
): Promise<{ view: SettingsView; refresh: string }> {
  return apiFetch<{ view: SettingsView; refresh: string }>(
    `${serverBase(serverId)}/settings/cloudflare`,
    { method: 'PUT', json: input },
  );
}

export function clearCloudflareSettings(serverId: string): Promise<void> {
  return apiFetch<void>(`${serverBase(serverId)}/settings/cloudflare`, { method: 'DELETE' });
}

// refreshCloudflareTunnels triggers an immediate Cloudflare API fetch on the
// active server, bypassing the scheduled interval. The new tunnel snapshot
// is pushed to the dashboard via the SSE stream as soon as the outpost's
// snapshot version bumps.
//
// The outpost may return 200 with `{refresh: "<error msg>"}` to surface a
// soft-failure from Cloudflare itself (network blip, rate-limit) without
// failing the request — we promote that into a thrown Error so the UI's
// toast shows it.
export async function refreshCloudflareTunnels(serverId: string): Promise<void> {
  const body = await apiFetch<{ refresh?: string } | null>(
    `${serverBase(serverId)}/settings/cloudflare/refresh`,
    { method: 'POST' },
  );
  if (body && body.refresh) throw new Error(body.refresh);
}

// ---------------------------------------------------------------------------
// Container lifecycle commands
// ---------------------------------------------------------------------------
//
// These return on POST completion (202 Accepted); they do NOT carry the new
// container state. The UI reconciles from the SSE stream, which is updated
// within ~1s by the outpost's fast-poke (immediate refreshMedium after the
// command succeeds). Callers should flip an optimistic local "pending"
// state while awaiting, and remove it once the SSE update arrives — or on
// rejection.

export type ContainerAction = 'start' | 'stop' | 'restart';

function commandContainer(
  serverId: string,
  id: string,
  action: ContainerAction,
): Promise<void> {
  return apiFetch<void>(
    `${serverBase(serverId)}/containers/${encodeURIComponent(id)}/${action}`,
    { method: 'POST' },
  );
}

export function startContainer(serverId: string, id: string): Promise<void> {
  return commandContainer(serverId, id, 'start');
}
export function stopContainer(serverId: string, id: string): Promise<void> {
  return commandContainer(serverId, id, 'stop');
}
export function restartContainer(serverId: string, id: string): Promise<void> {
  return commandContainer(serverId, id, 'restart');
}

// removeContainer issues a DELETE against the container endpoint.
//
// `force=true` SIGKILLs a running container before removal — the outpost
// returns 409 if the container is running without it, which the UI uses as
// a signal to show a second confirm step rather than failing silently.
//
// `volumes=true` removes anonymous volumes attached to the container.
// Named volumes are left alone (they're independent objects that need
// explicit removal).
export class ContainerRunningError extends Error {
  constructor() {
    super('container is running');
    this.name = 'ContainerRunningError';
  }
}

// createContainer pulls the image if missing, creates, and starts a single
// container. Can take minutes on a cold image pull — the gate proxy gives
// this endpoint a 6-minute upstream timeout; callers should communicate
// that with a "Pulling…" pending state instead of treating slowness as
// failure.
export function createContainer(
  serverId: string,
  req: CreateContainerRequest,
): Promise<CreateContainerResponse> {
  return apiFetch<CreateContainerResponse>(`${serverBase(serverId)}/containers`, {
    method: 'POST',
    json: req,
  });
}

export async function removeContainer(
  serverId: string,
  id: string,
  opts: { force?: boolean; volumes?: boolean } = {},
): Promise<void> {
  const q = new URLSearchParams();
  if (opts.force) q.set('force', 'true');
  if (opts.volumes) q.set('volumes', 'true');
  const qs = q.toString();
  const url = `${serverBase(serverId)}/containers/${encodeURIComponent(id)}${qs ? '?' + qs : ''}`;
  try {
    await apiFetch<void>(url, { method: 'DELETE' });
  } catch (e) {
    // Translate 409 into the typed sentinel the UI catches to prompt for
    // force-remove. Everything else propagates unchanged.
    if (e instanceof ApiError && e.status === 409) {
      throw new ContainerRunningError();
    }
    throw e;
  }
}

// inspectContainer fetches the typed inspect view for one container. Returns
// the JSON payload directly; throws on non-2xx with the outpost's error
// message. Gated to operator+ on the outpost.
export function inspectContainer(
  serverId: string,
  id: string,
  signal?: AbortSignal,
): Promise<ContainerInspect> {
  return apiFetch<ContainerInspect>(
    `${serverBase(serverId)}/containers/${encodeURIComponent(id)}/inspect`,
    signal ? { signal } : {},
  );
}

// ---------------------------------------------------------------------------
// Stacks (docker-compose)
// ---------------------------------------------------------------------------
//
// Like createContainer, the write paths here can run long (compose up with
// cold pulls regularly takes minutes). The gate proxy gives stacks write
// endpoints a 12-minute upstream timeout — callers should show a "Pulling
// & deploying…" pending state and avoid treating slow as failure.

export function listStacks(serverId: string): Promise<StackSummary[]> {
  return apiFetch<StackSummary[]>(`${serverBase(serverId)}/stacks`);
}

export function getStack(
  serverId: string,
  name: string,
  signal?: AbortSignal,
): Promise<Stack> {
  return apiFetch<Stack>(
    `${serverBase(serverId)}/stacks/${encodeURIComponent(name)}`,
    signal ? { signal } : {},
  );
}

export function createStack(
  serverId: string,
  req: StackCreateRequest,
): Promise<{ name: string }> {
  return apiFetch<{ name: string }>(`${serverBase(serverId)}/stacks`, {
    method: 'POST',
    json: req,
  });
}

export function updateStack(
  serverId: string,
  name: string,
  req: StackUpdateRequest,
): Promise<void> {
  return apiFetch<void>(`${serverBase(serverId)}/stacks/${encodeURIComponent(name)}`, {
    method: 'PUT',
    json: req,
  });
}

// deriveStackYAML asks the outpost to reverse-engineer a fresh
// docker-compose.yml from a discovered stack's member containers
// (`docker inspect` projected into YAML). Used by the "Recreate as
// managed" flow when the original compose file is gone.
export async function deriveStackYAML(serverId: string, name: string): Promise<string> {
  const body = await apiFetch<{ yaml: string }>(
    `${serverBase(serverId)}/stacks/${encodeURIComponent(name)}/derive-yaml`,
  );
  return body.yaml;
}

export function removeStack(
  serverId: string,
  name: string,
  opts: { volumes?: boolean } = {},
): Promise<void> {
  const q = new URLSearchParams();
  if (opts.volumes) q.set('volumes', 'true');
  const qs = q.toString();
  const url = `${serverBase(serverId)}/stacks/${encodeURIComponent(name)}${qs ? '?' + qs : ''}`;
  return apiFetch<void>(url, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Reclaim — per-card list + bulk-delete + build cache prune
// ---------------------------------------------------------------------------

export function listReclaimableImages(
  serverId: string,
  signal?: AbortSignal,
): Promise<ReclaimableImage[]> {
  return apiFetch<ReclaimableImage[]>(
    `${serverBase(serverId)}/reclaim/images`,
    signal ? { signal } : {},
  );
}

export function listReclaimableContainers(
  serverId: string,
  signal?: AbortSignal,
): Promise<ReclaimableContainer[]> {
  return apiFetch<ReclaimableContainer[]>(
    `${serverBase(serverId)}/reclaim/containers`,
    signal ? { signal } : {},
  );
}

export function listReclaimableVolumes(
  serverId: string,
  signal?: AbortSignal,
): Promise<ReclaimableVolume[]> {
  return apiFetch<ReclaimableVolume[]>(
    `${serverBase(serverId)}/reclaim/volumes`,
    signal ? { signal } : {},
  );
}

function applyReclaim(
  serverId: string,
  kind: 'images' | 'containers' | 'volumes',
  ids: string[],
): Promise<ReclaimResult> {
  return apiFetch<ReclaimResult>(`${serverBase(serverId)}/reclaim/${kind}`, {
    method: 'POST',
    json: { ids },
  });
}

export function applyReclaimImages(serverId: string, ids: string[]) {
  return applyReclaim(serverId, 'images', ids);
}
export function applyReclaimContainers(serverId: string, ids: string[]) {
  return applyReclaim(serverId, 'containers', ids);
}
// Volumes are addressed by name on the docker API, but the request shape
// (and the outpost's loop) accepts the same `{ids: [...]}` body — kept as
// a separate helper so the call site reads correctly.
export function applyReclaimVolumes(serverId: string, names: string[]) {
  return applyReclaim(serverId, 'volumes', names);
}

export function pruneBuildCache(serverId: string): Promise<ReclaimResult> {
  return apiFetch<ReclaimResult>(`${serverBase(serverId)}/reclaim/build-cache`, {
    method: 'POST',
  });
}

// Firewall — host firewall rule management. The outpost abstracts over the
// installed firewall (ufw today, firewalld/nftables possible later); if
// nothing is detected on the host the status response will be
// `{available: false}` and the UI should render a placeholder rather than
// surface an error.
export function fetchFirewall(serverId: string): Promise<FirewallStatus> {
  return apiFetch<FirewallStatus>(`${serverBase(serverId)}/firewall`);
}

export function addFirewallRule(serverId: string, rule: FirewallRule): Promise<void> {
  return apiFetch<void>(`${serverBase(serverId)}/firewall/rules`, {
    method: 'POST',
    json: rule,
  });
}

// deleteFirewallRule sends the full canonical tuple in the body so the
// outpost can re-resolve the rule under its own lock. Never use a
// positional index here — ufw renumbers on every edit.
export function deleteFirewallRule(serverId: string, rule: FirewallRule): Promise<void> {
  return apiFetch<void>(`${serverBase(serverId)}/firewall/rules`, {
    method: 'DELETE',
    json: rule,
  });
}

// -- File manager --------------------------------------------------------
// All paths are HOST-relative (the outpost maps them through /hostfs
// internally). Every endpoint passes through resolveSafe on the outpost
// which gates against the denylist + role rules; the UI can call freely
// and surface server-side denials through the standard error path.

export function fsList(serverId: string, path: string): Promise<FsListResponse> {
  return apiFetch<FsListResponse>(
    `${serverBase(serverId)}/fs/list?path=${encodeURIComponent(path)}`,
  );
}

export function fsStat(serverId: string, path: string): Promise<FsEntry> {
  return apiFetch<FsEntry>(
    `${serverBase(serverId)}/fs/stat?path=${encodeURIComponent(path)}`,
  );
}

export function fsRead(serverId: string, path: string): Promise<FsReadResponse> {
  return apiFetch<FsReadResponse>(
    `${serverBase(serverId)}/fs/read?path=${encodeURIComponent(path)}`,
  );
}

export function fsWrite(serverId: string, path: string, content: string): Promise<void> {
  return apiFetch<void>(`${serverBase(serverId)}/fs/write`, {
    method: 'POST',
    json: { path, content },
  });
}

export function fsMkdir(serverId: string, path: string): Promise<void> {
  return apiFetch<void>(`${serverBase(serverId)}/fs/mkdir`, {
    method: 'POST',
    json: { path },
  });
}

export function fsRename(serverId: string, from: string, to: string): Promise<void> {
  return apiFetch<void>(`${serverBase(serverId)}/fs/rename`, {
    method: 'POST',
    json: { from, to },
  });
}

// fsCopy duplicates `from` to `to` on the same host. `to` is the full
// destination path. recursive=true is required for directory sources;
// overwrite=true replaces an existing regular-file destination.
export function fsCopy(
  serverId: string,
  from: string,
  to: string,
  opts: { overwrite?: boolean; recursive?: boolean } = {},
): Promise<void> {
  return apiFetch<void>(`${serverBase(serverId)}/fs/copy`, {
    method: 'POST',
    json: { from, to, overwrite: !!opts.overwrite, recursive: !!opts.recursive },
  });
}

// fsMove relocates `from` to `to` on the same host. Falls back to
// copy+delete on cross-filesystem moves (EXDEV). overwrite=true replaces
// an existing regular-file destination.
export function fsMove(
  serverId: string,
  from: string,
  to: string,
  opts: { overwrite?: boolean } = {},
): Promise<void> {
  return apiFetch<void>(`${serverBase(serverId)}/fs/move`, {
    method: 'POST',
    json: { from, to, overwrite: !!opts.overwrite },
  });
}

export function fsDelete(serverId: string, path: string): Promise<void> {
  return apiFetch<void>(
    `${serverBase(serverId)}/fs/entry?path=${encodeURIComponent(path)}`,
    { method: 'DELETE' },
  );
}

// fsDownloadURL returns the URL the browser should hit to stream-download
// the file via the gate proxy. Using a plain anchor or window.open
// preserves filename + Content-Disposition handling without us needing to
// re-stream through the SPA.
export function fsDownloadURL(serverId: string, path: string): string {
  return `${serverBase(serverId)}/fs/download?path=${encodeURIComponent(path)}`;
}

// fsUpload accepts a single File and POSTs it as multipart/form-data with
// the destination directory in the query. The outpost takes the filename
// from the part (override via ?name=). We pass the FormData via `rawBody`
// — apiFetch leaves Content-Type unset so the browser injects the correct
// multipart boundary.
export function fsUpload(
  serverId: string,
  destDir: string,
  file: File,
  overrideName?: string,
  opts: { overwrite?: boolean } = {},
): Promise<void> {
  const form = new FormData();
  form.append('file', file, overrideName || file.name);
  const qs = new URLSearchParams({ path: destDir });
  if (overrideName) qs.set('name', overrideName);
  if (opts.overwrite) qs.set('overwrite', 'true');
  return apiFetch<void>(`${serverBase(serverId)}/fs/upload?${qs.toString()}`, {
    method: 'POST',
    rawBody: form,
  });
}

// fsSizesURL is the SSE stream of recursive folder sizes for the
// immediate subfolders of `path` (outpost GET /fs/sizes).
export function fsSizesURL(serverId: string, path: string): string {
  return `${serverBase(serverId)}/fs/sizes?path=${encodeURIComponent(path)}`;
}

// -- Pinned folders (Files sidebar) — stored per user, per server in gate.

export interface FsPin {
  path: string;
  label: string | null;
}

export function fetchPins(serverId: string): Promise<FsPin[]> {
  return apiFetch<FsPin[]>(`${BASE}/pins/${encodeURIComponent(serverId)}`);
}

export function savePins(serverId: string, pins: FsPin[]): Promise<FsPin[]> {
  return apiFetch<FsPin[]>(`${BASE}/pins/${encodeURIComponent(serverId)}`, {
    method: 'PUT',
    json: { pins },
  });
}

// -- Cross-outpost file transfer ----------------------------------------
// Orchestrated by the gate service: it streams from the source outpost's
// download endpoint straight into the destination's receive endpoint with
// no buffering at this end. The SPA fires a POST to create, watches an
// SSE stream for progress, and can DELETE to cancel mid-flight.

export interface TransferCreateRequest {
  srcServer: string;
  srcPath: string;
  dstServer: string;
  dstPath: string;
  mode: 'move' | 'copy';
  overwrite?: boolean;
  // When true the destination file ends up with the SAME uid/gid/mode as
  // the source. Requires admin role on the destination because it
  // triggers chmod + chown there. Off by default — UID maps diverge
  // across hosts, so by default we let the destination dir's owner
  // inherit (the dashboard's standard rule).
  preserveSourceOwnership?: boolean;
}

export interface TransferProgress {
  id: string;
  bytesTotal: number;
  bytesDone: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  error: string | null;
}

export function createTransfer(req: TransferCreateRequest): Promise<{ id: string }> {
  return apiFetch<{ id: string }>(`${BASE}/transfer`, { method: 'POST', json: req });
}

export function cancelTransfer(id: string): Promise<void> {
  return apiFetch<void>(`${BASE}/transfer/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// transferStreamURL is the SSE URL the caller should subscribe to via
// EventSource. vantage-prime builds a single subscription per active
// transfer and feeds events into the global TransferStore.
export function transferStreamURL(id: string): string {
  return `${BASE}/transfer/${encodeURIComponent(id)}/stream`;
}

// One-shot status of a transfer (polling alternative to the SSE stream).
export function fetchTransferStatus(id: string): Promise<TransferProgress> {
  return apiFetch<TransferProgress>(`${BASE}/transfer/${encodeURIComponent(id)}`);
}

// -- Trash management ---------------------------------------------------

export function fsTrashList(serverId: string): Promise<TrashItem[]> {
  return apiFetch<TrashItem[]>(`${serverBase(serverId)}/fs/trash`);
}

export function fsTrashRestore(
  serverId: string,
  trashId: string,
  overwrite: boolean,
): Promise<void> {
  return apiFetch<void>(`${serverBase(serverId)}/fs/trash/restore`, {
    method: 'POST',
    json: { trashId, overwrite },
  });
}

export function fsTrashPermanentDelete(serverId: string, trashId: string): Promise<void> {
  return apiFetch<void>(
    `${serverBase(serverId)}/fs/trash/${encodeURIComponent(trashId)}`,
    { method: 'DELETE' },
  );
}

// -- Permissions / ownership (admin) ------------------------------------

export function fsChmod(serverId: string, path: string, mode: string): Promise<void> {
  return apiFetch<void>(`${serverBase(serverId)}/fs/chmod`, {
    method: 'POST',
    json: { path, mode },
  });
}

export function fsChown(
  serverId: string,
  path: string,
  owner: string,
  group: string,
  recursive: boolean,
): Promise<void> {
  return apiFetch<void>(`${serverBase(serverId)}/fs/chown`, {
    method: 'POST',
    json: { path, owner, group, recursive },
  });
}

// -- Email whitelist (admin) -------------------------------------------------
// Pre-authorize an email so a whitelisted person can hit the regular login
// form, get prompted to set a password, and land in the dashboard with the
// role the admin recorded.

export function listWhitelist(): Promise<WhitelistEntry[]> {
  return apiFetch<WhitelistEntry[]>(`${BASE}/whitelist`);
}

export function addWhitelist(
  email: string,
  role: 'viewer' | 'operator' | 'admin',
): Promise<WhitelistEntry> {
  return apiFetch<WhitelistEntry>(`${BASE}/whitelist`, {
    method: 'POST',
    json: { email, role },
  });
}

export function removeWhitelist(email: string): Promise<void> {
  return apiFetch<void>(`${BASE}/whitelist/${encodeURIComponent(email)}`, {
    method: 'DELETE',
  });
}

// ---------------------------------------------------------------------------
// Version — About panel reads gate + each-outpost version on demand
// ---------------------------------------------------------------------------

export interface VersionInfo {
  service: string;
  version: string;
}

// Gate's own version: served at /auth/version (mounted under env.basePath in
// gate so nginx's existing /auth/ proxy reaches it). Public — no session
// required.
export function fetchGateVersion(): Promise<VersionInfo> {
  return apiFetch<VersionInfo>('/auth/version');
}

// Per-outpost version: reached through the standard registry proxy, so the
// shared-secret token is attached server-side just like every other
// /api/servers/<id>/* call.
export function fetchOutpostVersion(serverId: string): Promise<VersionInfo> {
  return apiFetch<VersionInfo>(`${serverBase(serverId)}/version`);
}
