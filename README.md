# Vantage

A single-pane dashboard for self-hosted boxes. Live system metrics, container
status, disks (with SMART), services, and tunnels — pulled directly from each
host, no agents-as-a-service, no telemetry leaving your network.

Built to replace the tab-juggling between glances, scrutiny, myspeed, and
friends with one consistent view across every box you run.

## Features

- **Live metrics**: CPU, memory, sensors, per-core load, pressure stall info,
  network throughput, disk I/O — refreshed every couple of seconds.
- **Storage**: filesystem usage and SMART summaries for each physical disk.
- **Containers & services**: Docker container list with resource usage, plus
  the systemd unit overview.
- **Multi-host**: register any number of remote `vantage-outpost` instances by
  URL + shared-secret token. The gate service stores the registry per user
  (tokens encrypted at rest) and proxies API calls server-side, so the
  browser never holds outpost tokens or sees cross-origin traffic.
- **Single-admin bootstrap, whitelist-gated thereafter**: the first
  sign-up becomes admin; subsequent accounts require the admin to
  pre-authorize the email through the whitelist UI (gear icon →
  **Whitelist**). Email/password, GitHub or Google OAuth, and passkeys
  via [Better Auth](https://better-auth.com); sessions are HTTP-only
  cookies.
- **Light/dark theme**, persisted locally.

## Requirements

- **Docker + Docker Compose** for the standard deploy.
- **Linux kernel ≥ 5.6** on every host that runs `vantage-outpost`. The
  outpost uses `openat2(RESOLVE_BENEATH)` to keep file-manager operations
  contained inside the bind-mounted host root; older kernels do not
  support this syscall and the outpost will refuse to start. Linux 5.6
  was released in 2020, so any current LTS distro (Ubuntu 20.04+,
  Debian 11+, RHEL 9+) works out of the box.

## Setup

Vantage has two components — **prime** (the dashboard SPA + the `gate` auth
service that fronts it) and **outposts** (the `vantage-outpost` monitoring agent
that runs on each box you want to watch). Pick the shape that fits your
topology, then follow the matching section.

| Shape         | Command on each box                                              | Use when                                                                  |
| ------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Single-host   | `make prod`                                                      | One machine: dashboard *and* the only thing being monitored.              |
| Prime only    | `make prime`                                                     | This box is the dashboard; monitored hosts live elsewhere.                |
| Outpost only  | `make outpost-up`                                                | This box is monitored only; the dashboard lives on another machine.       |
| Multi-host    | `make prime` on the dashboard host + `make outpost-up` on each monitored host | The standard "1 dashboard, N monitored hosts" deployment.    |

`make help` lists every available target.

### 1. Project setup (one-time, every shape)

Requires Docker + Docker Compose. Clone the repo on each host that's going
to run *anything*:

```sh
git clone <this repo>
cd vantage
cp .env.example .env
```

Edit `.env` and set what your shape actually needs (other values can stay
commented):

| Variable                 | Needed for          | How to generate            |
| ------------------------ | ------------------- | -------------------------- |
| `BETTER_AUTH_SECRET`     | prime, prod         | `openssl rand -base64 32`  |
| `VANTAGE_REGISTRY_KEY`   | prime, prod         | `openssl rand -base64 32`  |
| `VANTAGE_OUTPOST_TOKEN`  | outpost, prod       | `openssl rand -hex 32`     |
| `VANTAGE_ENCRYPTION_KEY` | outpost (recommended)| `openssl rand -base64 32`  |

A monitored box and a dashboard box need different subsets — see each
section below for the exact list.

For local development with hot reload, see `make dev` (sources bind-mounted
in containers, Vite HMR + Go air reload).

### 2. Prime — dashboard host only

Use this when the machine's only job is to host the Vantage UI; the hosts
you actually want to monitor run their own outposts elsewhere.

Required in `.env`: `BETTER_AUTH_SECRET`, `VANTAGE_REGISTRY_KEY`.

```sh
make prime
```

Open `http://localhost:8088` (or `http://<host>:${VANTAGE_PROD_PORT}`):

1. Create the admin account (the first signup becomes admin; subsequent
   accounts have to be pre-authorized through gear icon → **Whitelist**).
2. The dashboard ships with zero servers registered. Add outposts later
   from gear icon → **Servers** → **Add a server** (see "Prime + outposts"
   below).

Two containers come up: `vantage-gate` (auth service) and `vantage-prime`
(nginx + SPA). No outpost, no monitoring of the prime host itself.

### 3. Outpost — monitored host only

Use this when the box exists to be monitored *from* a prime running
somewhere else. No UI, no auth, no database — just the `vantage-outpost`
daemon answering metric requests gated by a shared token.

Required in `.env`: `VANTAGE_OUTPOST_TOKEN`.
Recommended: `VANTAGE_ENCRYPTION_KEY` (encrypts Cloudflare credentials
stored locally; without it the outpost falls back to a hostname-derived
key and logs a warning at startup).

```sh
make outpost-up
```

The outpost binds host port `8095` on **all interfaces** by default
(that's the whole point — the dashboard reaches it over the network). To
pin it to a specific NIC (Tailscale, WireGuard, LAN bridge):

```sh
VANTAGE_OUTPOST_BIND=100.64.0.5 VANTAGE_OUTPOST_PORT=8095 make outpost-up
```

> ⚠ Only deploy on a trusted network (LAN, Tailscale, WireGuard, etc.).
> The shared-secret token is **not** a substitute for network isolation —
> do not expose port 8095 to the public internet.

Once the outpost is running, register it from the prime's dashboard (see
the next section).

### 4. Prime + outposts together

Two flavours, depending on whether prime and the (sole) outpost live on
the same box.

**Same host — single-machine bundle:**

Required in `.env`: `BETTER_AUTH_SECRET`, `VANTAGE_REGISTRY_KEY`,
`VANTAGE_OUTPOST_TOKEN`. Recommended: `VANTAGE_ENCRYPTION_KEY`.

```sh
make prod
```

Three containers come up: `gate` (auth service), `outpost` (`vantage-outpost`
monitoring this host), `prime` (dashboard SPA). After login, register the
local outpost:

- Name: `local`
- URL: `http://outpost:8080` (Docker DNS — gate and outpost share the prod
  network)
- Token: your `VANTAGE_OUTPOST_TOKEN`

The same outpost is also reachable from off-host at `http://<host-ip>:8095`
if you want to add it to a *different* prime later.

**Separate hosts — the standard multi-host setup:**

On the **dashboard host**, follow §2 (Prime). On **each monitored host**,
follow §3 (Outpost) — each outpost has its own `.env` with its own
`VANTAGE_OUTPOST_TOKEN`. Tokens don't have to match across outposts; you
supply the right one when you register each in the SPA.

Then in the dashboard at `http://<prime-host>:8088`:

1. Gear icon → **Servers** → **Add a server**.
2. Fill in:
   - **Name**: anything (`prod-db`, `nas`, `homelab-1`, …).
   - **URL**: `http://<outpost-host-or-vpn-ip>:8095`.
   - **Token**: that outpost's `VANTAGE_OUTPOST_TOKEN`.
3. Save. Gate probes `GET <url>/api/health` with the token before
   persisting, so bad URLs or token mismatches surface immediately as
   `probe failed: …`.

Repeat for each outpost. The header's server switcher lists every
registered outpost; each one carries its own Cloudflare tunnel
credentials, scoped to that box.

## Cloudflare tunnels (optional)

Vantage reads info about tunnels you already have running — it doesn't
create them. Point it at your Cloudflare account and the **Network** tab
will show each tunnel's public hostnames and connector status.

1. **Create an API token** at [Cloudflare → API Tokens](https://dash.cloudflare.com/profile/api-tokens):
   custom token with permission **Account → Cloudflare Tunnel → Read** (the
   only scope needed). Copy the token.
2. **Find your Account ID** — it's the 32-character hex string in the right
   sidebar of any Cloudflare dashboard page (or in the URL itself).
3. **(Optional) Tunnel ID** — only needed if you have multiple tunnels in
   that account and want to pin to one. Leave blank to pick the first.
4. **Paste into Vantage**: gear icon → **Cloudflare tunnels** panel → fill
   in token + account ID → Save. The Network tab updates within a few
   seconds.

The panel is scoped to the active server in the header switcher — each
outpost stores its own credentials encrypted at rest under
`VANTAGE_ENCRYPTION_KEY`. The token is never returned to the browser; the
UI only shows whether one is on file.

If you'd rather not use the UI, set `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, and optionally `CLOUDFLARE_TUNNEL_ID` in `.env`
before `make prod` — UI-stored values take precedence when both exist.

## Configuration

All configuration is through environment variables, loaded from `.env` by
the compose files. The full list with comments lives in `.env.example`.
Essentials:

| Variable                  | Purpose                                                |
| ------------------------- | ------------------------------------------------------ |
| `BETTER_AUTH_SECRET`      | Signs session cookies. Required.                       |
| `VANTAGE_REGISTRY_KEY`    | AES-256-GCM key for encrypting per-server outpost tokens in the registry. Required. |
| `VANTAGE_OUTPOST_TOKEN`   | Shared secret each `vantage-outpost` instance requires. **The outpost refuses to start without it.** Each outpost can have its own; you supply it when registering the server in the SPA. |
| `VANTAGE_ENCRYPTION_KEY`  | Encrypts Cloudflare credentials stored on each outpost. Recommended in production — without it the outpost falls back to a hostname-derived key and logs a warning at startup. |
| `GATE_RP_ID`              | WebAuthn relying-party ID for passkeys. Defaults to `localhost`; set to your public hostname in production or passkey registrations get bound to localhost and silently break. |
| `GATE_SSRF_ALLOW_PRIVATE` | Set to `1` to let the gate service register outposts at private addresses (`127.0.0.1`, RFC1918 ranges, `169.254.0.0/16`, etc.). Off by default — the service otherwise refuses to proxy to those ranges to prevent SSRF. Enable on trusted-LAN deployments where outposts are on the same private network as the gate service. |
| `VANTAGE_PROD_PORT`       | Host port for the dashboard. Default `8088`.           |
| `GITHUB_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET` | OAuth, optional.            |

Secrets never get committed: `.env` is gitignored, the outpost encrypts
anything saved through the Settings page at rest, and no credentials are
ever returned to the browser (the API returns `tokenSet: true/false`, not
the values themselves).

## Operating notes

A few quirks worth knowing when running this in production:

- **Browsers go through the gate proxy, never the outpost directly.** The
  outpost no longer emits CORS headers — anything other than the
  gate-service-proxied path will be blocked by the browser. CLI tools
  (curl, scripts) hitting the outpost directly are unaffected.
- **CLI / script clients hitting the gate service** must send
  `X-Requested-With: XMLHttpRequest` on mutating calls (POST/PUT/PATCH/DELETE)
  to `/api/*`. This is the dashboard's CSRF defence on top of
  SameSite=lax cookies; the SPA does it automatically, third-party
  callers need to add the header.
- **Per-user transfer cap**: each user may have at most 8 concurrent
  cross-outpost file transfers in flight. The 9th request gets `429 Too
  Many Requests` — cancel an existing transfer or wait for one to
  finish.
- **Cloudflare token rotation is admin-only.** Viewer and operator roles
  can read tunnel data and trigger a manual refresh, but only admins can
  store, change, or clear the saved API token.
- **Content-Security-Policy is pinned via SHA-256 hash** for the inline
  theme-init script in `prime/index.html`. If you edit that script
  (the IIFE that applies the dark/light class on first paint), you must
  regenerate the hash in `prime/nginx.conf.template` — the one-line
  command is in the CSP block's comment.

## Versioning

Vantage is a monorepo and ships under one Semantic Version that covers
prime, gate, and outpost together. The single source of truth is the
`VERSION` file at the repo root; the Makefile reads it into
`VANTAGE_VERSION` and exports it, and the compose files propagate it via
Docker build-args so each image's `/version` endpoint reports the exact
build it was made from.

### Where the version shows up

- **`/auth/version`** — gate's reported version (public, no session).
- **`/api/servers/<id>/version`** — that outpost's reported version
  (proxied through gate's standard registry path; token attached
  server-side).
- **About panel** — gear icon → Settings → bottom card. Lists prime,
  gate, and each registered outpost side-by-side so version drift is
  obvious.
- **Image tags** — `vantage-prime:1.0.0`, `vantage-gate:1.0.0`,
  `vantage-outpost:1.0.0`. Dev images keep the `:dev` tag for slot
  separation.

### Wire compatibility

Prime, gate, and outpost are guaranteed compatible **within the same
minor version** (e.g. any `1.0.x` prime works with any `1.0.x` outpost).
A minor bump (`1.1.0`) can change the wire protocol and requires
coordinated upgrade of every component that talks across the wire — in
practice: bump the dashboard host AND every outpost in the same window.
Patch releases (`1.0.1` → `1.0.2`) are always safe to roll independently
on a single host without touching the others. Breaking changes are
called out explicitly in `CHANGELOG.md`.

### Cutting a release

1. Edit `VERSION` to the new version (e.g. `1.0.1`).
2. Write a `CHANGELOG.md` entry under `## [1.0.1]` describing what
   changed since the previous tag; move anything from `## [Unreleased]`
   into the new section.
3. Commit and tag:
   ```sh
   git commit -am "v1.0.1"
   git tag v1.0.1
   ```
4. Rebuild on each host (`make prod`, `make prime`, or `make outpost-up`)
   — the new tag flows through automatically because compose substitutes
   `${VANTAGE_VERSION}` at build time.

## Tech stack

- **Prime** (dashboard SPA): React + Vite + TypeScript, Tailwind, served by nginx.
- **Outpost** (monitoring agent): Go (standard library only). Reads `/proc`, `/sys`, the Docker
  socket, and DBus.
- **Gate** (auth + proxy): Node + Hono + Better Auth on SQLite.

## Without Docker

```sh
cd outpost && go run .          # vantage-outpost (the monitoring agent)
cd gate    && npm install && npm run dev   # vantage-gate (auth + registry)
cd prime   && npm install && npm run dev   # vantage-prime (dashboard SPA)
```

The outpost (`outpost/`) discovers host CPU topology, memory, sensors, and
disks by reading `/proc` and `/sys` at runtime — nothing is hardcoded. When
run as a bare-metal binary the defaults are exactly `/proc` and `/sys`, so
it Just Works on whichever machine you start it on (the same binary on a
Threadripper reports 64 cores, on a Pi 4 reports 4 cores, etc.).

Inside Docker, the prod and outpost compose files bind-mount the *host's*
filesystems read-only at `/host/proc` and `/host/sys` and set
`HOST_PROC` / `HOST_SYS` env vars so the same code reads through to the
host instead of the container's namespaced view. If you build your own
image and roll your own runtime, replicate those two mounts + env vars or
the outpost will report the container's view (usually correct for CPU
counts, less so for sensors and disks).

## License

TBD.
