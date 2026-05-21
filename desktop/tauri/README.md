# Vantage Desktop — Tauri

Native window around the Vantage dashboard, built with [Tauri 2](https://v2.tauri.app/).
Iteration-1 scaffold: opens a window pointing at `http://localhost:8088`. No
SPA bundled, no backend embedded.

## Prerequisites

- **Rust toolchain** — `rustup` from <https://rustup.rs>. Tauri requires
  Rust ≥ 1.77.
- **Node + npm** — only for the Tauri CLI script wrapper; no JS build.
- **Per-OS system deps**:
  - **Linux**: `webkit2gtk-4.1`, `gtk-3`, `libayatana-appindicator3`,
    `librsvg2`, `libssl`, `build-essential`.
    Debian/Ubuntu:
    ```
    sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev \
        libayatana-appindicator3-dev librsvg2-dev libssl-dev build-essential
    ```
  - **macOS**: Xcode command-line tools (`xcode-select --install`).
  - **Windows**: MSVC build tools + WebView2 (preinstalled on Windows ≥ 11).

## Install & run

```bash
cd desktop/tauri
npm install                # pulls @tauri-apps/cli
npm run dev                # opens the window (debug build)
```

Production build:

```bash
npm run build              # produces installers in src-tauri/target/release/bundle/
```

This will emit, per host OS:
- **Linux**: `.deb`, `.rpm`, `.AppImage`
- **macOS**: `.dmg`, `.app`
- **Windows**: `.msi`, `.exe` (NSIS)

Cross-OS builds: Tauri supports cross-compilation via GitHub Actions (see
`tauri-action`). Locally, build on the matching host OS.

## Configuration

The dashboard URL is hardcoded in `src-tauri/tauri.conf.json` under
`app.windows[0].url`. Default: `http://localhost:8088`.

To point at a different machine, edit that value and rebuild. Iteration 2
will move this to a first-run config / settings panel.

## Layout

```
src-tauri/
├── Cargo.toml             # Rust deps (tauri 2)
├── tauri.conf.json        # window, bundle, identifier
├── build.rs               # tauri-build prelude
├── icons/                 # 32x32.png, 128x128.png, icon.icns, icon.ico
└── src/
    └── main.rs            # window opens; webview points at the URL above
```

## Iteration 2 plan

1. Bundle the React SPA as the `frontendDist` (build `../../frontend` first).
2. Ship the Go backend as a **sidecar** binary in `src-tauri/binaries/`,
   launched by Tauri at startup. Backend's `--addr` randomized to a free
   localhost port; the SPA picks it up via a config endpoint.
3. Drop the dependency on the dockerized stack — desktop builds become
   fully standalone.

## Iteration-1 limitations

- No auth flow (the embedded webview loads the dashboard URL "as a
  browser tab"). Relies on the remote backend's own auth.
- No icons committed — see `src-tauri/icons/README.md`. Without icons,
  `npm run dev` works; `npm run build` complains.
