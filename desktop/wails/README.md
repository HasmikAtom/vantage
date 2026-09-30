# Vantage Desktop — Wails

Native window around the Vantage dashboard, built with [Wails 2](https://wails.io).
Iteration-1 scaffold: opens a window that redirects to `http://localhost:8088`
(override with `VANTAGE_URL`). No SPA bundled, no outpost embedded yet.

## Prerequisites

- **Go ≥ 1.22** — already a project requirement (the outpost uses it too).
- **Wails CLI**:
  ```
  go install github.com/wailsapp/wails/v2/cmd/wails@latest
  ```
  Ensure `$(go env GOPATH)/bin` is on your `$PATH`.
- **Per-OS system deps**:
  - **Linux**: `webkit2gtk-4.1`, `gtk-3`, `libnsl`, `pkg-config`.
    Debian/Ubuntu:
    ```
    sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev pkg-config build-essential
    ```
  - **macOS**: Xcode command-line tools (`xcode-select --install`).
  - **Windows**: WebView2 runtime (preinstalled on Windows ≥ 11),
    plus a C compiler (MSVC or MinGW) for cgo.
- `wails doctor` after install verifies everything is in place.

## Install & run

```bash
cd desktop/wails
go mod tidy
wails dev                  # opens the window in dev mode
```

Production build:

```bash
wails build                # outputs to build/bin/
```

Per host OS, `wails build` emits:
- **Linux**: a self-contained binary in `build/bin/vantage-desktop`. AppImage,
  `.deb`, and `.rpm` can be produced via the `nfpm` plugin once the
  packaging templates are populated.
- **macOS**: a `.app` bundle. `wails build -platform darwin/universal`
  produces a universal binary for both architectures.
- **Windows**: an `.exe` (NSIS-installable via the bundled template).

Cross-OS builds: `wails build -platform darwin/arm64,windows/amd64,linux/amd64`
in CI (the Linux host needs zig or a cross-toolchain for the non-Linux
targets; macOS targets generally need a macOS runner for signing).

## Configuration

The dashboard URL is read at startup via `VANTAGE_URL` (default
`http://localhost:8088`) — see `app.go` → `TargetURL()`. The shell HTML in
`frontend/dist/index.html` calls into that and navigates the webview.

To point at a different machine:

```bash
VANTAGE_URL=http://homelab.lan:8088 wails dev
```

## Layout

```
.
├── wails.json             # project config (commands wails runs)
├── go.mod                 # references wails/v2
├── main.go                # wails.Run() + embedded frontend/dist
├── app.go                 # App struct bound to JS; exposes TargetURL()
├── build/                 # per-OS bundle templates + icons (generated)
└── frontend/
    └── dist/
        └── index.html     # tiny shell that redirects to TargetURL()
```

(The `frontend/` directory here is a wails-framework convention for the
embedded webview assets, not vantage-prime; the React SPA lives in
`../../prime/`.)

## Iteration 2 plan

1. Build the React SPA from `../../prime` straight into `frontend/dist/`
   (replace `wails.json`'s `frontend:install` / `frontend:build` no-ops with
   `npm --prefix ../../prime ci` and `... run build -- --outDir <here>`).
2. **Import the Go outpost as a package** (`github.com/.../outpost`), call
   its `ListenAndServe()` from a goroutine in `main.go`. The SPA fetches
   `/api/*` from the same in-process server — no IPC, no sidecar.
3. Move passkey / session-auth into the Go binary too (port the Node `gate/`
   service to Go), so the whole stack collapses to one process.

## Iteration-1 limitations

- No SPA bundled — the webview just loads a remote URL.
- The Go outpost in the project root is **not** embedded; this build
  still depends on the dockerized stack (or any reachable vantage-outpost).
- No icons committed — see `build/README.md`. Defaults are used until then.
