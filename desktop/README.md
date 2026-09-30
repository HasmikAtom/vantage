# Desktop apps

Two parallel desktop wrappers around the Vantage dashboard, kept side by side
so we can compare in practice before committing to one for v1:

| | `tauri/` | `wails/` |
| --- | --- | --- |
| Shell language | Rust | Go |
| Webview | system (WebView2 / WebKitGTK / WKWebView) | system (WebView2 / WebKitGTK / WKWebView) |
| Bundle size | ~10 MB | ~15 MB |
| Outpost integration | sidecar process + IPC | can import the Go outpost directly (in-process) |
| Extra toolchain needed | Rust, `cargo` | `wails` CLI (`go install ...`) |
| Best for | richer plugin ecosystem, stronger security model, Tauri-mobile later | one-language story; matches the "single binary" target in `os-analysis.md` |

Both apps are **iteration-1 scaffolds**: they open a native window pointing at
an existing Vantage dashboard URL (`http://localhost:8088` by default). They do
*not* yet bundle the SPA or embed the outpost — the goal of this first cut is
to validate the cross-OS build and ergonomics on each framework.

## What this enables today
- A native window on Mac / Windows / Linux that renders the existing dashboard.
- Per-OS installers when each framework's `build` command is run on the host
  for that OS (Tauri / Wails both cross-compile within limits, but the
  cleanest matrix is to build each OS on its own machine or in CI).

## What's deliberately out of scope right now
- Bundling the React SPA inside the desktop binary.
- Embedding the Go outpost in-process (Wails) or shipping it as a sidecar
  (Tauri).
- Passkey / auth flow when there's no nginx in front. The desktop window
  loads the existing dashboard URL, so today it relies on whatever auth the
  remote outpost / gate already enforces.
- System tray, auto-start on login, auto-updater. All deferred.

See each subdir's README for build instructions and the path forward to
iteration 2 (SPA bundled + outpost embedded).

## Picking a default

If you want to settle on one and drop the other, the tiebreaker for this
project is **Wails** — single language (Go) across outpost, daemon, and
desktop shell; outpost embeds in-process without subprocess plumbing. Tauri
is the right call if you'd rather invest in its richer plugin ecosystem and
stronger security model, accepting that the outpost has to live as a
separate sidecar binary.
