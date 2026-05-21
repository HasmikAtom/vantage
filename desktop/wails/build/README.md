# Build assets

Wails reads platform icons and packaging templates from this directory at
`wails build` time. Generate the full set from a single ≥ 1024×1024 PNG:

    go install github.com/wailsapp/wails/v2/cmd/wails@latest
    cd desktop/wails
    wails generate icons -input path/to/source.png

That writes `appicon.png` here and per-OS templates under
`build/{darwin,windows}/`. Until you do that, `wails dev` runs without
icons; `wails build` will use the framework defaults.
