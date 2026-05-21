package main

import (
	"embed"
	"net/http"
	"path"
	"strings"
)

// openapiSpec is the hand-written OpenAPI 3.1 description of /api/*. Kept
// next to types.go so schema drift is at least visible in code review.
//
//go:embed openapi.json
var openapiSpec []byte

// swaggerUIAssets is the vendored swagger-ui-dist v5.17.14 bundle. The
// HTML shell below loads CSS + JS from /swaggerui/static/<file> rather
// than unpkg.com so a compromised CDN can't XSS the admin context that
// opens this page.
//
// To bump the version: replace the four files under swaggerui_assets/
// with newer ones from a trusted swagger-ui-dist release tarball, and
// update the version string in swaggerUIHTML so the page title remains
// honest.
//
//go:embed swaggerui_assets
var swaggerUIAssets embed.FS

const swaggerUIHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Vantage Dashboard API · Swagger UI</title>
<link rel="icon" type="image/png" sizes="32x32" href="/swaggerui/static/favicon-32x32.png">
<link rel="stylesheet" href="/swaggerui/static/swagger-ui.css">
<style>body{margin:0;background:#fafafa}</style>
</head>
<body>
<div id="swagger-ui"></div>
<script src="/swaggerui/static/swagger-ui-bundle.js"></script>
<script>
window.onload = () => {
  window.ui = SwaggerUIBundle({
    url: '/openapi.json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    presets: [SwaggerUIBundle.presets.apis],
    layout: 'BaseLayout',
    tryItOutEnabled: true,
  });
};
</script>
</body>
</html>`

func openapiSpecHandler(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(openapiSpec)
}

func swaggerUIHandler(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = w.Write([]byte(swaggerUIHTML))
}

// swaggerUIAssetHandler serves the vendored swagger-ui-dist files from
// the embedded FS at /swaggerui/static/<filename>. Only the four files
// we ship are reachable; any other name returns 404. The path is
// restricted to base name (no slashes, no traversal) — embed.FS would
// reject "../" walks too, but the explicit base-only constraint keeps
// the surface obviously narrow.
func swaggerUIAssetHandler(w http.ResponseWriter, r *http.Request) {
	name := path.Base(r.URL.Path)
	if name == "" || name == "." || name == "/" || strings.ContainsAny(name, "/\\") {
		http.NotFound(w, r)
		return
	}
	data, err := swaggerUIAssets.ReadFile("swaggerui_assets/" + name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	switch {
	case strings.HasSuffix(name, ".css"):
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
	case strings.HasSuffix(name, ".js"):
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	case strings.HasSuffix(name, ".png"):
		w.Header().Set("Content-Type", "image/png")
	default:
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	// Vendored, version-pinned. Safe to cache aggressively; bump the
	// version (replace the files) when you want clients to refetch.
	w.Header().Set("Cache-Control", "public, max-age=86400, immutable")
	_, _ = w.Write(data)
}
