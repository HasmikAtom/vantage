# Icons

Tauri expects these files at bundle time (referenced from `tauri.conf.json`):

- `32x32.png`
- `128x128.png`
- `icon.icns`   (macOS)
- `icon.ico`    (Windows)

Easiest way to generate the whole set from a single PNG (≥ 512×512 with
transparency):

    cargo install tauri-cli --version "^2"
    cd desktop/tauri
    cargo tauri icon path/to/source.png

That writes the full icon set in place. Until then, `cargo tauri build` will
fail with "icon not found"; `cargo tauri dev` runs fine without icons.
