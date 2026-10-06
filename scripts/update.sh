#!/usr/bin/env bash
# Update the Vantage stack(s) on this machine to the newest release.
#
#   make update          check keys, move to the newest release tag, rebuild
#   make update-check    only check keys and .env (changes nothing)
#
# Options (environment):
#   STACK=outpost|prime|prod   which stack(s) to update, comma-separated.
#                              Default: whatever this machine runs.
#   TAG=v1.4.10                a specific release instead of the newest
#                              (also how you roll back).
#   ENV_FILE=.env              where the keys are read from.
#   FORCE=1                    update a checkout that's on a branch, or
#                              rebuild even when already up to date.
#
# Meant for deployment checkouts (a clone sitting on a release tag). It
# refuses a development checkout on a branch, so it can't move work in
# progress, and refuses local changes to tracked files.
set -euo pipefail

cd "$(dirname "$0")/.."

MODE=update
[ "${1:-}" = "--check-only" ] && MODE=check
ENV_FILE=${ENV_FILE:-.env}

if [ -t 1 ]; then
  RED=$'\e[31m' YEL=$'\e[33m' GRN=$'\e[32m' DIM=$'\e[2m' OFF=$'\e[0m'
else
  RED='' YEL='' GRN='' DIM='' OFF=''
fi
info() { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$GRN" "$OFF" "$*"; }
warn() { printf '%s! %s%s\n' "$YEL" "$*" "$OFF"; }
err()  { printf '%s✗ %s%s\n' "$RED" "$*" "$OFF"; }
die()  { err "$*"; exit 1; }

# --- which stacks run here ---------------------------------------------------

# Each compose file has its own project name; containers carry it as a label,
# stopped ones included.
detect_stacks() {
  local found=() s
  for s in prod prime outpost; do
    if [ -n "$(docker ps -a -q --filter "label=com.docker.compose.project=vantage-$s" 2>/dev/null)" ]; then
      found+=("$s")
    fi
  done
  # prod already contains an outpost.
  if [[ " ${found[*]-} " == *" prod "* ]]; then found=(prod); fi
  echo "${found[*]-}"
}

if [ -n "${STACK:-}" ]; then
  STACKS=${STACK//,/ }
else
  STACKS=$(detect_stacks)
fi
[ -n "$STACKS" ] || die "No Vantage containers found on this machine. Say which stack to update, e.g. STACK=outpost make update (or prime / prod)."
for s in $STACKS; do
  case $s in outpost | prime | prod) ;; *) die "Unknown stack '$s' (use outpost, prime or prod)." ;; esac
done
info "Stack(s): $STACKS"

# --- keys --------------------------------------------------------------------

# A key's value: the environment wins (docker compose does the same), then the
# last KEY= line in $ENV_FILE, without surrounding quotes.
env_get() {
  local k=$1 v
  v=${!k-}
  if [ -z "$v" ] && [ -f "$ENV_FILE" ]; then
    v=$(grep -E "^[[:space:]]*$k=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)
    v=${v%$'\r'}
    v=${v#\"}; v=${v%\"}; v=${v#\'}; v=${v%\'}
  fi
  printf '%s' "$v"
}

ERRORS=0
WARNINGS=0
fail_key() { err "$1"; info "    fix: add to $ENV_FILE  ${DIM}$2${OFF}"; ERRORS=$((ERRORS + 1)); }
warn_key() { warn "$1"; [ -n "${2:-}" ] && info "    fix: ${DIM}$2${OFF}"; WARNINGS=$((WARNINGS + 1)); }

# required <KEY> <how to generate> <why>
required() {
  local v; v=$(env_get "$1")
  if [ -z "$v" ]; then
    fail_key "$1 is missing: $3" "$1=\$($2)"
  else
    ok "$1 is set"
  fi
}

# Key must be base64 that decodes to exactly 32 bytes (AES-256).
check_32() {
  local k=$1 v n; v=$(env_get "$k")
  [ -n "$v" ] || return 0
  if ! n=$(printf '%s' "$v" | base64 -d 2>/dev/null | wc -c); then n=0; fi
  if [ "$n" -ne 32 ]; then
    fail_key "$k must be base64 that decodes to 32 bytes (got $n): the service won't start with it" "$k=\$(openssl rand -base64 32)"
  fi
}

min_len() { # min_len <KEY> <n>
  local v; v=$(env_get "$1")
  if [ -n "$v" ] && [ "${#v}" -lt "$2" ]; then
    warn_key "$1 is only ${#v} characters; use a random value of at least $2" "$1=\$(openssl rand -hex 32)"
  fi
}

check_keys() {
  info ""
  info "Checking keys in $ENV_FILE…"
  if [ ! -f "$ENV_FILE" ]; then
    warn "$ENV_FILE not found; only the shell environment will be checked"
  else
    local mode; mode=$(stat -c %a "$ENV_FILE" 2>/dev/null || echo 600)
    if [ $((8#$mode & 8#077)) -ne 0 ]; then
      warn_key "$ENV_FILE is readable by other users (mode $mode); it holds secrets" "chmod 600 $ENV_FILE"
    fi
  fi
  local s needs_outpost=0 needs_prime=0
  for s in $STACKS; do
    case $s in
      outpost) needs_outpost=1 ;;
      prime) needs_prime=1 ;;
      prod) needs_outpost=1; needs_prime=1 ;;
    esac
  done
  if [ $needs_outpost = 1 ]; then
    required VANTAGE_OUTPOST_TOKEN "openssl rand -hex 32" "the outpost refuses to start without it"
    min_len VANTAGE_OUTPOST_TOKEN 32
    if [ -z "$(env_get VANTAGE_ENCRYPTION_KEY)" ]; then
      warn_key "VANTAGE_ENCRYPTION_KEY is not set: stored secrets (e.g. the Cloudflare token) use a key derived from the hostname, which anyone with the settings file can rebuild" \
        "add to $ENV_FILE  VANTAGE_ENCRYPTION_KEY=\$(openssl rand -base64 32), then re-enter the Cloudflare token in Settings"
    else
      ok "VANTAGE_ENCRYPTION_KEY is set"
      check_32 VANTAGE_ENCRYPTION_KEY
    fi
  fi
  if [ $needs_prime = 1 ]; then
    required BETTER_AUTH_SECRET "openssl rand -base64 32" "gate signs sessions with it and won't start without it"
    min_len BETTER_AUTH_SECRET 32
    required VANTAGE_REGISTRY_KEY "openssl rand -base64 32" "gate encrypts the stored outpost tokens with it"
    check_32 VANTAGE_REGISTRY_KEY
  fi
  info ""
  if [ $ERRORS -gt 0 ]; then
    die "$ERRORS required key problem(s); nothing was changed. Fix $ENV_FILE and run again."
  fi
  if [ $WARNINGS -gt 0 ]; then warn "$WARNINGS warning(s) (see above); continuing"; else ok "keys look good"; fi
}

check_keys
[ "$MODE" = check ] && exit 0

# Containers of each stack, and whether they all run a given version.
containers_of() {
  case $1 in
    outpost) echo vantage-outpost ;;
    prime) echo "vantage-gate vantage-prime" ;;
    prod) echo "vantage-gate-prod vantage-outpost vantage-prime" ;;
  esac
}

running_version() { # running_version <version>: all containers up on it?
  local s c state
  for s in $STACKS; do
    for c in $(containers_of "$s"); do
      state=$(docker inspect -f '{{.State.Running}} {{.Config.Image}}' "$c" 2>/dev/null || true)
      [[ "$state" == "true "*":$1" ]] || return 1
    done
  done
}

# --- code --------------------------------------------------------------------

git rev-parse --git-dir >/dev/null 2>&1 || die "Not a git checkout; can't update the code."
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  die "Local changes to tracked files (see 'git status'); commit or discard them first."
fi
BRANCH=$(git symbolic-ref -q --short HEAD || true)
if [ -n "$BRANCH" ] && [ "${FORCE:-}" != 1 ]; then
  die "This checkout is on branch '$BRANCH' (a development copy?). make update moves deployment checkouts between release tags; use FORCE=1 to do it anyway."
fi

info ""
info "Fetching releases…"
git fetch --tags --quiet origin || die "git fetch failed (no network, or no access to the repo?)."
PREV=$(git describe --tags --exact-match 2>/dev/null || git rev-parse --short HEAD)
TARGET=${TAG:-$(git tag -l 'v[0-9]*' --sort=-v:refname | head -n1)}
[ -n "$TARGET" ] || die "No release tags (v*) found."
git rev-parse -q --verify "refs/tags/$TARGET" >/dev/null || die "Release $TARGET doesn't exist."

TARGET_VERSION=$(git show "$TARGET:VERSION" 2>/dev/null || echo "$TARGET")
# Up to date only if the checkout is on the release AND the containers run
# it (a checkout moved by hand still needs its rebuild).
if [ "$PREV" = "$TARGET" ] && [ "${FORCE:-}" != 1 ] && running_version "$TARGET_VERSION"; then
  ok "Already on $TARGET and running it: up to date. (FORCE=1 make update rebuilds anyway.)"
  exit 0
fi

if [ "$PREV" = "$TARGET" ]; then
  info "Checkout is on $TARGET but the containers aren't running it: rebuilding"
else
  info "Updating $PREV → $TARGET"
fi
git -c advice.detachedHead=false checkout --quiet "$TARGET"
VERSION=$(cat VERSION 2>/dev/null || echo "$TARGET")

# --- rebuild + verify --------------------------------------------------------

for s in $STACKS; do
  info ""
  info "Rebuilding $s…"
  make "$s-up"
done

info ""
FAILED=0
for s in $STACKS; do
  for c in $(containers_of "$s"); do
    state=""
    for _ in $(seq 1 30); do
      state=$(docker inspect -f '{{.State.Running}} {{.Config.Image}}' "$c" 2>/dev/null || true)
      [[ "$state" == "true "* ]] && break
      sleep 2
    done
    if [[ "$state" == "true "*":$VERSION" ]]; then
      ok "$c running $VERSION"
    else
      err "$c is not running $VERSION (state: ${state:-missing}); check: docker logs $c"
      FAILED=1
    fi
  done
done

info ""
if [ $FAILED = 1 ]; then
  err "Update to $TARGET finished with problems."
  info "Roll back: TAG=$PREV make update"
  exit 1
fi
ok "Updated to $TARGET."
info "Roll back if needed: TAG=$PREV make update"
