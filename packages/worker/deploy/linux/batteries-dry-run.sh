#!/bin/bash
set -euo pipefail
#
# Developer proof for install-batteries.sh (phase 7 tools). It is NOT a box
# step: it needs network (github.com, storage.googleapis.com, pub.dev), never
# runs as root, and reads the manifest, overlays and lock from HEAD, so commit
# first. Run it under `/bin/bash --noprofile --norc` (bash 3.2 + BSD or GNU
# userland). The last line is DRY-RUN-PROOF-OK on success.
#
# Six installer runs, every one a dry run (PREFIX=<tmp> SKIP_SUDO_VERIFY=1):
#   1 fresh PREFIX D              everything INSTALLED; pack, SDK, CLI, wrapper,
#                                 version line, OFFLINE smoke, manifest.sha256
#   2 same D                      every cli, pack and tool SKIPPED
#   3 fresh PREFIX T, SDK sha256  FAIL dart-sdk + FAIL aot (sdk not at pin);
#     tampered                    nothing published for either, no manifest.sha256
#   4 T, one package content hash FAIL aot at `pub get --enforce-lockfile`
#     tampered INSIDE the lock    (throwaway worktree commit; main checkout untouched)
#   5 T, lockSha256 tampered      FAIL aot: lock overlay sha256 mismatch
#   6 D with run 5's manifest     manifest.sha256 invalidated, run 1's CLI untouched
#
# Host manifest: Linux x86_64 uses the HEAD manifest bytes unchanged (the exact
# production pins). Darwin arm64 rewrites ONLY the dart-sdk url and sha256 to
# the macos-arm64 zip of the same version, pinned below and cross-checked
# against the publisher's .sha256sum first. Any other host exits 2. Every run
# shares one BATTERIES_DOWNLOAD_CACHE: the SDK zip is downloaded once per
# network fetch and the installer re-checks its sha256 before every extraction.

DRY_RUN_MACOS_ARM64_SDK_SHA256=9dfe7d6f2558816c2a978aff6c80e8a4509c6cb726c0702a616c64d286f60e88

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(cd -P "$SCRIPT_DIR/../../../.." && pwd -P)"
INSTALLER="$SCRIPT_DIR/install-batteries.sh"
MANIFEST_PATH="packages/worker/deploy/batteries.json"
PROOF_PACK="somnio-skills"

die() {
  echo "batteries-dry-run: $*" >&2
  exit 2
}

fail() {
  echo "DRY-RUN-PROOF-FAIL: $*" >&2
  exit 1
}

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

sha256_file() {
  sha256_stdin <"$1"
}

# A content hash of every regular file under a dir (path + bytes).
tree_hash() {
  (cd "$1" && find . -type f -print | LC_ALL=C sort | while IFS= read -r f; do
    printf '%s %s\n' "$f" "$(sha256_file "$f")"
  done) | sha256_stdin
}

# Portable mode string (BSD and GNU stat differ); paths here are our own.
# shellcheck disable=SC2012 # ls -ld on one known path, not a listing
perms_of() {
  ls -ld "$1" | cut -c1-10
}

# count_in_logs <fixed text>: matching lines across every run log.
count_in_logs() {
  awk -v p="$1" 'index($0, p) { n++ } END { print n + 0 }' "$WORK"/run*.log
}

[ "$(id -u)" != "0" ] || die "refuses to run as root"
command -v jq >/dev/null 2>&1 || die "jq is required"
git -C "$REPO" diff --quiet HEAD -- packages/worker/deploy ||
  die "packages/worker/deploy has uncommitted changes; commit first (the installer reads HEAD)"
[ -z "$(git -C "$REPO" ls-files --others --exclude-standard -- packages/worker/deploy)" ] ||
  die "packages/worker/deploy has untracked files; commit first"

WORK="${TMPDIR:-/tmp}"
WORK="${WORK%/}/batteries-dry-run.$$"
mkdir -p "$WORK"
# Canonical (macOS: /var -> /private/var). The installer canonicalises a
# PREFIX only once it exists, so a non-canonical prefix would be written into
# run 1's wrapper and differ from run 2's template (a spurious reinstall).
WORK="$(cd -P "$WORK" && pwd -P)"
CACHE="$WORK/sdk-cache"
WT="$WORK/wt"
D="$WORK/prefix-d"
T="$WORK/prefix-t"
DR="$D/lib/automata-batteries"
TR="$T/lib/automata-batteries"
mkdir -p "$WORK/tmp" "$CACHE"

# shellcheck disable=SC2317,SC2329 # invoked by the EXIT trap
cleanup() {
  if [ -e "$WT" ]; then
    git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || true
  fi
  git -C "$REPO" worktree prune >/dev/null 2>&1 || true
}
trap cleanup EXIT

HEAD_SHA="$(git -C "$REPO" rev-parse --verify 'HEAD^{commit}')"
git -C "$REPO" cat-file blob "$HEAD_SHA:$MANIFEST_PATH" >"$WORK/head.json"
HOST="$(uname -s)/$(uname -m)"
case "$HOST" in
  Linux/x86_64) cp "$WORK/head.json" "$WORK/host.json" ;;
  Darwin/arm64)
    sdk_version="$(jq -r '.tools[] | select(.kind == "dart-sdk") | .version' "$WORK/head.json")"
    mac_url="https://storage.googleapis.com/dart-archive/channels/stable/release/$sdk_version/sdk/dartsdk-macos-arm64-release.zip"
    published="$(curl -fsSL --proto '=https' --tlsv1.2 --retry 3 "$mac_url.sha256sum" | awk '{print $1}')" ||
      die "cannot fetch the publisher's macos-arm64 sha256sum"
    [ "$published" = "$DRY_RUN_MACOS_ARM64_SDK_SHA256" ] ||
      die "publisher's macos-arm64 sha256 ($published) differs from the pinned $DRY_RUN_MACOS_ARM64_SDK_SHA256"
    jq --arg u "$mac_url" --arg s "$DRY_RUN_MACOS_ARM64_SDK_SHA256" \
      '(.tools[] | select(.kind == "dart-sdk")) |= (.url = $u | .sha256 = $s)' \
      "$WORK/head.json" >"$WORK/host.json"
    ;;
  *) die "no pinned dry-run SDK for this host ($HOST)" ;;
esac
echo "host $HOST, manifest $WORK/host.json, work $WORK"

# Every expected value comes from the manifest.
M="$WORK/host.json"
SDK_NAME="$(jq -r '.tools[] | select(.kind == "dart-sdk") | .name' "$M")"
SDK_VERSION="$(jq -r '.tools[] | select(.kind == "dart-sdk") | .version' "$M")"
AOT='.tools[] | select(.kind == "dart-aot")'
AOT_NAME="$(jq -r "$AOT | .name" "$M")"
AOT_VERSION="$(jq -r "$AOT | .version" "$M")"
AOT_SHA="$(jq -r "$AOT | .sha" "$M")"
PKG_DIR="$(jq -r "$AOT | .packageDir" "$M")"
WRAPPER="$(jq -r "$AOT | .wrapper" "$M")"
ROOT_ENV="$(jq -r "$AOT | .rootEnv" "$M")"
VERSION_ARGS="$(jq -r "$AOT | .versionArgs" "$M")"
VERSION_LINE="$(jq -r "$AOT | .versionLine" "$M")"
SMOKE_EXPECT="$(jq -r "$AOT | .smokeExpect" "$M")"
LOCK_OVERLAY="$(jq -r "$AOT | .lockOverlay" "$M")"
LOCK_SHA256="$(jq -r "$AOT | .lockSha256" "$M")"
SMOKE_ARGS=()
while IFS= read -r word; do
  SMOKE_ARGS+=("$word")
done < <(jq -r "$AOT | .smokeArgs[]" "$M")
PACK_SHA="$(jq -r --arg p "$PROOF_PACK" '.packs[] | select(.id == $p) | .sha' "$M")"
if [ -z "$SDK_NAME" ] || [ -z "$AOT_NAME" ] || [ -z "$PACK_SHA" ]; then
  die "the manifest lacks a dart-sdk tool, a dart-aot tool or the $PROOF_PACK pack"
fi
ITEM_COUNT="$(jq '(.clis | length) + (.packs | length) + ((.tools // []) | length)' "$M")"

RUN_STATUS=0
# run <n> <prefix> <manifest> [<repo>]
run() {
  local n="$1" prefix="$2" manifest="$3" repo="${4:-$REPO}"
  RUN_STATUS=0
  PREFIX="$prefix" SKIP_SUDO_VERIFY=1 BATTERIES_MANIFEST="$manifest" \
    BATTERIES_DOWNLOAD_CACHE="$CACHE" AUTOMATA_REPO="$repo" TMPDIR="$WORK/tmp" \
    /bin/bash "$INSTALLER" >"$WORK/run$n.log" 2>&1 || RUN_STATUS=$?
  echo "== run $n (exit $RUN_STATUS) =="
  sed -n '/^== automata batteries summary ==$/,$p' "$WORK/run$n.log"
}

has_line() {
  grep -qxF -- "$2" "$WORK/run$1.log" || fail "run $1: no line '$2'"
}

has_text() {
  grep -qF -- "$2" "$WORK/run$1.log" || fail "run $1: no '$2'"
}

expect_status() {
  [ "$RUN_STATUS" -eq "$2" ] || fail "run $1: exit $RUN_STATUS, expected $2"
}

none_under() {
  local found
  found="$(find "$1" -maxdepth 1 -name "$2" -print 2>/dev/null | head -n 1)"
  [ -z "$found" ] || fail "$3: unexpected $found"
}

manifest_with() {
  jq "$1" "$M" >"$2"
}

expected_manifest_hash() {
  {
    cat "$1"
    while IFS= read -r from; do
      git -C "$REPO" cat-file blob "$HEAD_SHA:$from"
    done < <(jq -r '.packs[] | (.overlays // [])[] | .from' "$1")
  } | sha256_stdin
}

# ── run 1: fresh install ─────────────────────────────────────────────────────
run 1 "$D" "$M"
expect_status 1 0
has_line 1 "RESULT: PASS"
has_text 1 "VERIFY SKIPPED"
has_line 1 "INSTALLED tool $SDK_NAME $SDK_VERSION"
has_line 1 "INSTALLED tool $AOT_NAME $AOT_VERSION"
has_line 1 "INSTALLED pack $PROOF_PACK $PACK_SHA"
has_text 1 "downloading $SDK_NAME $SDK_VERSION"

P="$DR/$PROOF_PACK@$PACK_SHA"
while IFS= read -r dest; do
  [ -f "$P/$dest/SKILL.md" ] || fail "pack: no $dest/SKILL.md"
  if grep -q '^allowed-tools:' "$P/$dest/SKILL.md"; then
    fail "pack: $dest/SKILL.md keeps allowed-tools"
  fi
done < <(jq -r --arg p "$PROOF_PACK" '.packs[] | select(.id == $p) | .subpaths[] | select(.dest | startswith("skills/")) | .dest' "$M")
while IFS=$'\t' read -r dest ex; do
  [ ! -e "$P/$dest/$ex" ] || fail "pack: excluded $dest/$ex is present"
done < <(jq -r --arg p "$PROOF_PACK" '.packs[] | select(.id == $p) | .subpaths[] | .dest as $d | (.exclude // [])[] | [$d, .] | @tsv' "$M")
for f in skills/dora-metrics/scripts/dora_metrics.py skills/dora-metrics/config/projects.json LICENSE; do
  [ -f "$P/$f" ] || fail "pack: $f is missing"
done
[ -z "$(find "$P" -type l -print)" ] || fail "pack: holds a symlink"
[ -z "$(find "$P" -type f ! -perm 0644 -print)" ] || fail "pack: a file is not 0644"
[ -z "$(find "$P" -type d ! -perm 0755 -print)" ] || fail "pack: a dir is not 0755"

S="$DR/$SDK_NAME@$SDK_VERSION"
[ "$(perms_of "$S")" = "drwx------" ] || fail "sdk: top dir is $(perms_of "$S"), expected drwx------"
[ "$(cat "$S/version")" = "$SDK_VERSION" ] || fail "sdk: version file is not $SDK_VERSION"
[ -x "$S/bin/dart" ] || fail "sdk: bin/dart is not executable"
[ -f "$DR/licenses/$SDK_NAME-$SDK_VERSION/LICENSE" ] || fail "sdk: license not copied"
[ ! -e "$D/bin/dart" ] || fail "sdk: a dart entry exists in the bin dir (must be build-only)"

C="$DR/$AOT_NAME@$AOT_SHA"
[ "$(perms_of "$C/bin/$WRAPPER")" = "-rwxr-xr-x" ] || fail "cli: binary is $(perms_of "$C/bin/$WRAPPER")"
while IFS= read -r dest; do
  [ -e "$C/src/$dest" ] || fail "cli: src/$dest is missing"
done < <(jq -r "$AOT | .subpaths[].dest" "$M")
[ ! -e "$C/src/$PKG_DIR/.dart_tool" ] || fail "cli: .dart_tool was left behind"
[ "$(sha256_file "$C/src/$PKG_DIR/pubspec.lock")" = "$LOCK_SHA256" ] || fail "cli: installed lock differs from lockSha256"
[ -z "$(find "$C" -type l -print)" ] || fail "cli: holds a symlink"
[ "$(perms_of "$DR/pub-cache")" = "drwx------" ] || fail "pub-cache is $(perms_of "$DR/pub-cache"), expected drwx------"

W="$D/bin/$WRAPPER"
[ "$(head -n 1 "$W")" = "#!/bin/sh" ] || fail "wrapper: no #!/bin/sh"
grep -q "^$ROOT_ENV=" "$W" || fail "wrapper: no $ROOT_ENV="
grep -q '^PUB_CACHE=' "$W" || fail "wrapper: no PUB_CACHE="
# shellcheck disable=SC2086 # versionArgs is a single shape-checked word
got="$("$W" $VERSION_ARGS | tail -n 1)"
[ "$got" = "$VERSION_LINE" ] || fail "wrapper: '$WRAPPER $VERSION_ARGS' printed '$got', expected '$VERSION_LINE'"
echo "VERSION $WRAPPER $VERSION_ARGS -> $got"

SMOKE="$(mktemp -d "$WORK/smoke.XXXXXX")"
mkdir -p "$SMOKE/home"
case "$HOST" in
  Darwin/*)
    (cd "$SMOKE" && env -i HOME="$SMOKE/home" PATH=/usr/bin:/bin \
      sandbox-exec -p '(version 1)(allow default)(deny network*)' \
      "$W" "${SMOKE_ARGS[@]}") >"$WORK/smoke.log" 2>&1 || fail "smoke: '$WRAPPER ${SMOKE_ARGS[*]}' failed offline (see $WORK/smoke.log)"
    echo "OFFLINE ENFORCED (sandbox-exec deny network*)"
    ;;
  *)
    if unshare -rn true >/dev/null 2>&1; then
      (cd "$SMOKE" && unshare -rn env -i HOME="$SMOKE/home" PATH=/usr/bin:/bin \
        "$W" "${SMOKE_ARGS[@]}") >"$WORK/smoke.log" 2>&1 || fail "smoke: '$WRAPPER ${SMOKE_ARGS[*]}' failed offline (see $WORK/smoke.log)"
      echo "OFFLINE ENFORCED (unshare -rn)"
    else
      (cd "$SMOKE" && env -i HOME="$SMOKE/home" PATH=/usr/bin:/bin \
        "$W" "${SMOKE_ARGS[@]}") >"$WORK/smoke.log" 2>&1 || fail "smoke: '$WRAPPER ${SMOKE_ARGS[*]}' failed (see $WORK/smoke.log)"
      echo "OFFLINE NOT ENFORCED (no unshare)"
    fi
    ;;
esac
[ -f "$SMOKE/$SMOKE_EXPECT" ] || fail "smoke: $SMOKE_EXPECT was not created"
echo "SMOKE $WRAPPER ${SMOKE_ARGS[*]} -> $SMOKE_EXPECT present"

[ -f "$DR/manifest.sha256" ] || fail "run 1: no manifest.sha256"
[ "$(cat "$DR/manifest.sha256")" = "$(expected_manifest_hash "$M")" ] || fail "run 1: manifest.sha256 is not the manifest + overlay hash"

CLI_TREE_BEFORE="$(tree_hash "$C")"
WRAPPER_BEFORE="$(sha256_file "$W")"

# ── run 2: idempotent re-run ─────────────────────────────────────────────────
run 2 "$D" "$M"
expect_status 2 0
has_line 2 "RESULT: PASS"
[ "$(grep -c '^INSTALLED ' "$WORK/run2.log" || true)" -eq 0 ] || fail "run 2: something was reinstalled"
skipped="$(grep -c '^SKIPPED ' "$WORK/run2.log" || true)"
[ "$skipped" -eq "$ITEM_COUNT" ] || fail "run 2: $skipped SKIPPED, expected $ITEM_COUNT"

# ── run 3: tampered SDK sha256 ───────────────────────────────────────────────
manifest_with '(.tools[] | select(.kind == "dart-sdk")).sha256 = ("0" * 64)' "$WORK/run3.json"
run 3 "$T" "$WORK/run3.json"
expect_status 3 1
has_text 3 "FAIL tool $SDK_NAME: sha256 mismatch"
has_line 3 "FAIL tool $AOT_NAME: sdk $SDK_NAME is not installed at its pin"
none_under "$TR" "$SDK_NAME@*" "run 3"
none_under "$TR" "$AOT_NAME@*" "run 3"
none_under "$TR" ".staging.*" "run 3"
[ ! -e "$T/bin/$WRAPPER" ] || fail "run 3: a wrapper was published"
[ ! -e "$TR/manifest.sha256" ] || fail "run 3: manifest.sha256 was written"

# ── run 4: a package content hash tampered inside the committed lock ─────────
git -C "$REPO" worktree add -q --detach "$WT" "$HEAD_SHA"
LOCK="$WT/$LOCK_OVERLAY"
old="$(awk '/^  yaml:$/ { f = 1; next } f && /^  [a-z0-9_]+:$/ { f = 0 } f && /^      sha256: / { gsub(/[" ]/, "", $2); print $2; exit }' "$LOCK")"
[ "${#old}" -eq 64 ] || die "cannot find the yaml sha256 in $LOCK"
first="${old:0:1}"
case "$first" in
  [0-8]) flipped="$((first + 1))" ;;
  9) flipped=0 ;;
  a) flipped=b ;;
  b) flipped=c ;;
  c) flipped=d ;;
  d) flipped=e ;;
  e) flipped=f ;;
  *) flipped=a ;;
esac
new="$flipped${old:1}"
sed "s/$old/$new/" "$LOCK" >"$LOCK.tmp" && mv -f "$LOCK.tmp" "$LOCK"
git -C "$WT" -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name=dry-run \
  -c user.email=dry-run@invalid commit -q -am "dry-run: tamper one lock content hash"
manifest_with "($AOT).lockSha256 = \"$(sha256_file "$LOCK")\"" "$WORK/run4.json"
run 4 "$T" "$WORK/run4.json" "$WT"
expect_status 4 1
has_line 4 "INSTALLED tool $SDK_NAME $SDK_VERSION"
has_text 4 "using the cached $SDK_NAME $SDK_VERSION zip"
has_text 4 "FAIL tool $AOT_NAME: pub get --enforce-lockfile failed"
none_under "$TR" "$AOT_NAME@*" "run 4"
none_under "$TR" ".staging.*" "run 4"
[ ! -e "$T/bin/$WRAPPER" ] || fail "run 4: a wrapper was published"
[ ! -e "$TR/manifest.sha256" ] || fail "run 4: manifest.sha256 was written"
git -C "$REPO" worktree remove --force "$WT"

# ── run 5: tampered lockSha256 ───────────────────────────────────────────────
manifest_with "($AOT).lockSha256 = (\"0\" * 64)" "$WORK/run5.json"
run 5 "$T" "$WORK/run5.json"
expect_status 5 1
has_text 5 "SKIPPED tool $SDK_NAME $SDK_VERSION"
has_line 5 "FAIL tool $AOT_NAME: lock overlay sha256 mismatch"
none_under "$TR" "$AOT_NAME@*" "run 5"
none_under "$TR" ".staging.*" "run 5"
[ ! -e "$TR/manifest.sha256" ] || fail "run 5: manifest.sha256 was written"

# ── run 6: invalidation on the good prefix ───────────────────────────────────
run 6 "$D" "$WORK/run5.json"
expect_status 6 1
[ ! -e "$DR/manifest.sha256" ] || fail "run 6: manifest.sha256 survived a failed run"
[ -f "$DR/manifest.sha256.invalid" ] || fail "run 6: no manifest.sha256.invalid"
[ "$(tree_hash "$C")" = "$CLI_TREE_BEFORE" ] || fail "run 6: run 1's CLI dir changed"
[ "$(sha256_file "$W")" = "$WRAPPER_BEFORE" ] || fail "run 6: run 1's wrapper changed"

downloads="$(count_in_logs "downloading $SDK_NAME $SDK_VERSION")"
cache_hits="$(count_in_logs "using the cached $SDK_NAME $SDK_VERSION zip")"
echo "SDK downloads: $downloads (runs 1 and 3), cache hits: $cache_hits"
[ "$downloads" -eq 2 ] || fail "expected the SDK to be downloaded by runs 1 and 3 only, got $downloads"

rm -rf "$D" "$T" "$CACHE" "$WORK/tmp"
echo "logs kept in $WORK"
echo "DRY-RUN-PROOF-OK"
