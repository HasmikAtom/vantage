#!/usr/bin/env bash
# Checks prime's nginx caching/404 behaviour against a real nginx.
#   bash prime/scripts/nginx_cache_test.sh [image]   (default: newest vantage-prime)
# Runs the given prime image with this checkout's nginx config mounted over
# it, on a random localhost port, and checks the response headers.
set -uo pipefail
cd "$(dirname "$0")/.."
IMG=${1:-$(docker images --format '{{.Repository}}:{{.Tag}}' vantage-prime | grep -v ':dev$' | head -n1)}
PORT=$((20000 + RANDOM % 20000))
mounts=(-v "$PWD/nginx.conf.template:/etc/nginx/templates/default.conf.template:ro")
[ -f nginx/security-headers.conf ] && mounts+=(-v "$PWD/nginx/security-headers.conf:/etc/nginx/snippets/security-headers.conf:ro")
CID=$(docker run -d --rm -p "127.0.0.1:$PORT:80" --add-host gate:127.0.0.1 --add-host outpost:127.0.0.1 \
  -e VANTAGE_OUTPOST_TOKEN=x "${mounts[@]}" "$IMG") || exit 1
trap 'docker stop "$CID" >/dev/null 2>&1' EXIT
for _ in $(seq 1 20); do curl -s -o /dev/null "http://127.0.0.1:$PORT/healthz" && break; sleep 0.3; done

PASS=0 FAIL=0
hdrs() { curl -s -o /dev/null -D - "http://127.0.0.1:$PORT$1" | tr -d '\r'; }
expect() { # expect <desc> <path> <grep -i pattern>
  if hdrs "$2" | grep -qiE "$3"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $1 ($2 lacks /$3/)"; fi
}
ASSET=$(docker exec "$CID" sh -c 'ls /usr/share/nginx/html/assets | grep -E "\.js$" | head -n1')

expect "page is revalidated on every load"   /                         '^cache-control: no-cache'
expect "index.html too"                      /index.html               '^cache-control: no-cache'
expect "app routes too"                      /files                    '^cache-control: no-cache'
expect "page keeps its CSP"                  /                         '^content-security-policy:'
expect "page keeps X-Frame-Options"          /                         '^x-frame-options: deny'
expect "built assets cached for a year"      "/assets/$ASSET"          '^cache-control: .*immutable'
expect "built assets served as JS"           "/assets/$ASSET"          '^content-type: application/javascript'
expect "assets keep nosniff"                 "/assets/$ASSET"          '^x-content-type-options: nosniff'
expect "a missing old chunk is a real 404"   /assets/OverviewTab-OLD.js '^HTTP/1.1 404'
expect "healthz is plain text"               /healthz                  '^content-type: text/plain'
expect "healthz keeps the security headers"  /healthz                  '^x-frame-options: deny'

echo "nginx_cache_test: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
