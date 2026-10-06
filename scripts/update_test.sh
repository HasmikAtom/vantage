#!/usr/bin/env bash
# Tests for scripts/update.sh. Run: bash scripts/update_test.sh
# Each case builds a throwaway repo (with an "origin" holding release tags)
# and stubs `docker` and `make`, so nothing real is touched.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT="$HERE/update.sh"
PASS=0
FAIL=0
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

K32=$(head -c 32 /dev/zero | base64)          # valid 32-byte base64 key
TOK=$(printf 'a%.0s' {1..64})                  # 64-char token

# setup <name>: creates $W (work clone, detached at v1.0.0) and stubs.
setup() {
  local name=$1
  W="$TMP/$name/work"
  local origin="$TMP/$name/origin.git"
  mkdir -p "$TMP/$name/src" "$TMP/$name/bin"
  (
    cd "$TMP/$name/src" && git init -q -b main && git config user.email t@t && git config user.name t
    mkdir -p scripts && cp "$SCRIPT" scripts/update.sh
    echo 1.0.0 > VERSION && git add -A && git commit -qm one && git tag v1.0.0
    echo 1.1.0 > VERSION && git commit -qam two && git tag v1.1.0
    echo 1.2.0-dev > VERSION && git commit -qam wip   # untagged work on main
  )
  git clone -q --bare "$TMP/$name/src" "$origin"
  git clone -q "$origin" "$W" 2>/dev/null
  (cd "$W" && git config user.email t@t && git config user.name t && git checkout -q v1.0.0)
  # Always test the script under test, whatever the tag contains.
  cp "$SCRIPT" "$W/scripts/update.sh"
  (cd "$W" && git update-index --assume-unchanged scripts/update.sh)
  LOG="$TMP/$name/calls.log"; : > "$LOG"
  cat > "$TMP/$name/bin/docker" <<STUB
#!/usr/bin/env bash
echo "docker \$*" >> "$LOG"
case "\$1" in
  ps)   # docker ps -a -q --filter label=com.docker.compose.project=<p>
        for p in \${STUB_PROJECTS:-}; do [[ "\$*" == *"project=\$p"* ]] && echo cid-\$p; done ;;
  inspect)  # running + image tag of the freshly built version
        echo "true vantage-x:\$(cat VERSION 2>/dev/null)" ;;
esac
STUB
  cat > "$TMP/$name/bin/make" <<STUB
#!/usr/bin/env bash
echo "make \$*" >> "$LOG"
STUB
  chmod +x "$TMP/$name/bin/docker" "$TMP/$name/bin/make"
  PATH_STUB="$TMP/$name/bin:$PATH"
}

writeenv() { printf '%s\n' "$@" > "$W/.env"; chmod 600 "$W/.env"; }

# run <args...>: runs the script in $W; sets OUT and RC.
run() {
  OUT=$(cd "$W" && env -i HOME="$HOME" PATH="$PATH_STUB" STUB_PROJECTS="${STUB_PROJECTS:-}" ${EXTRA_ENV:-} bash scripts/update.sh "$@" 2>&1)
  RC=$?
}

check() { # check <description> <condition...>
  local desc=$1; shift
  if "$@"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $desc"; echo "$OUT" | sed 's/^/    | /'; fi
}
has()  { grep -qF -- "$1" <<<"$OUT"; }
not()  { ! "$@"; }
called() { grep -qF -- "$1" "$LOG"; }
head_tag() { (cd "$W" && git describe --tags --exact-match 2>/dev/null); }

# 1. missing required outpost token → error with the fix, nothing changed
setup missing-token; STUB_PROJECTS=vantage-outpost
writeenv "VANTAGE_ENCRYPTION_KEY=$K32"
run
check "missing token fails"            test "$RC" -ne 0
check "names the missing key"          has "VANTAGE_OUTPOST_TOKEN"
check "shows how to generate it"       has "openssl rand -hex 32"
check "does not rebuild"               not called "make"
check "does not move the checkout"     test "$(head_tag)" = v1.0.0

# 2. missing encryption key is only a warning
setup missing-enc; STUB_PROJECTS=vantage-outpost
writeenv "VANTAGE_OUTPOST_TOKEN=$TOK"
run --check-only
check "check-only passes without enc key" test "$RC" -eq 0
check "warns about the enc key"        has "VANTAGE_ENCRYPTION_KEY"

# 3. malformed registry key on the dashboard stack is an error
setup bad-registry; STUB_PROJECTS=vantage-prime
writeenv "BETTER_AUTH_SECRET=$TOK" "VANTAGE_REGISTRY_KEY=too-short"
run --check-only
check "bad registry key fails"         test "$RC" -ne 0
check "explains 32 bytes"              has "32 bytes"

# 4. world-readable .env is flagged
setup perms; STUB_PROJECTS=vantage-outpost
writeenv "VANTAGE_OUTPOST_TOKEN=$TOK" "VANTAGE_ENCRYPTION_KEY=$K32"; chmod 644 "$W/.env"
run --check-only
check "readable .env still passes"     test "$RC" -eq 0
check "suggests chmod 600"             has "chmod 600"

# 5. normal update: newest tag, rebuild the detected stack, verify
setup update; STUB_PROJECTS=vantage-outpost
writeenv "VANTAGE_OUTPOST_TOKEN=$TOK" "VANTAGE_ENCRYPTION_KEY=$K32"
run
check "update succeeds"                test "$RC" -eq 0
check "moves to the newest release"    test "$(head_tag)" = v1.1.0
check "rebuilds the outpost"           called "make outpost-up"
check "does not touch other stacks"    not called "make prime-up"
check "prints a rollback command"      has "TAG=v1.0.0 make update"

# 6. already on the newest release → nothing to do
setup current; STUB_PROJECTS=vantage-outpost
writeenv "VANTAGE_OUTPOST_TOKEN=$TOK" "VANTAGE_ENCRYPTION_KEY=$K32"
(cd "$W" && git checkout -q v1.1.0 && cp "$SCRIPT" scripts/update.sh)
run
check "up to date succeeds"            test "$RC" -eq 0
check "says it is up to date"          has "up to date"
check "no rebuild when up to date"     not called "make"

# 7. TAG pins a specific release (rollback)
setup pin; STUB_PROJECTS=vantage-outpost
writeenv "VANTAGE_OUTPOST_TOKEN=$TOK" "VANTAGE_ENCRYPTION_KEY=$K32"
(cd "$W" && git checkout -q v1.1.0 && cp "$SCRIPT" scripts/update.sh)
EXTRA_ENV="TAG=v1.0.0" run; EXTRA_ENV=
check "pin succeeds"                   test "$RC" -eq 0
check "pins to the requested tag"      test "$(head_tag)" = v1.0.0

# 8. development checkout (on a branch) is refused
setup branch; STUB_PROJECTS=vantage-outpost
writeenv "VANTAGE_OUTPOST_TOKEN=$TOK" "VANTAGE_ENCRYPTION_KEY=$K32"
(cd "$W" && git checkout -q main && cp "$SCRIPT" scripts/update.sh)
run
check "branch checkout refused"        test "$RC" -ne 0
check "explains the branch refusal"    has "branch"
check "branch: no rebuild"             not called "make"

# 9. local changes to tracked files are refused
setup dirty; STUB_PROJECTS=vantage-outpost
writeenv "VANTAGE_OUTPOST_TOKEN=$TOK" "VANTAGE_ENCRYPTION_KEY=$K32"
echo changed >> "$W/VERSION"
run
check "dirty checkout refused"         test "$RC" -ne 0
check "dirty: no rebuild"              not called "make"

# 10. nothing detected and no STACK → clear error
setup none; STUB_PROJECTS=
writeenv "VANTAGE_OUTPOST_TOKEN=$TOK"
run --check-only
check "no stack fails"                 test "$RC" -ne 0
check "suggests STACK="                has "STACK="

# 11. STACK overrides detection; prod needs every key
setup prod; STUB_PROJECTS=
writeenv "VANTAGE_OUTPOST_TOKEN=$TOK" "VANTAGE_ENCRYPTION_KEY=$K32"
EXTRA_ENV="STACK=prod" run --check-only; EXTRA_ENV=
check "prod without auth keys fails"   test "$RC" -ne 0
check "prod names BETTER_AUTH_SECRET"  has "BETTER_AUTH_SECRET"

echo "update_test: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
