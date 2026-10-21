#!/usr/bin/env bash
# verify.sh IMAGE — cheap smoke test of the batteries image (ADR-013 P0).
#
# Runs every battery's version command inside ONE throwaway container started
# with the run hardening baseline (ADR-013 "Hardening baseline"): no network,
# no capabilities, no-new-privileges, read-only rootfs, --init, and writable
# HOME, /opt/flutter and /tmp only. Checks the pinned versions and that the
# image carries no per-run policy.
# Exit 0 = every check passed; 1 = at least one failed; 2 = usage/docker error.
#
#   deploy/images/batteries/verify.sh automata-batteries:dev
#   deploy/images/batteries/verify.sh ghcr.io/be-automata/automata-batteries@sha256:<digest>
#
# Prints one line per check. Never needs a credential.
set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "usage: $0 IMAGE" >&2
  exit 2
fi
image="$1"

if ! command -v docker >/dev/null 2>&1; then
  echo "verify: docker not found" >&2
  exit 2
fi

# The anonymous volumes (-v PATH) are populated from the image and removed
# with the container (--rm): the same writable set a run gets.
docker run --rm -i --platform linux/amd64 --network none \
  --cap-drop ALL --security-opt no-new-privileges --init \
  --read-only --tmpfs /tmp -v /home/agent -v /opt/flutter \
  --entrypoint /bin/bash "$image" -s <<'IN_CONTAINER'
set -uo pipefail
fail=0

ok() { printf 'ok   %-22s %s\n' "$1" "$2"; }
bad() { printf 'FAIL %-22s %s\n' "$1" "$2"; fail=1; }

# check NAME EXPECTED COMMAND...: run COMMAND, pass when its output contains
# EXPECTED (an empty EXPECTED only requires exit 0).
check() {
  local name="$1" expected="$2" out status
  shift 2
  out="$("$@" 2>&1)"
  status=$?
  if [ "$status" -ne 0 ]; then
    bad "$name" "exit $status: $(printf '%s' "$out" | head -n 1)"
  elif [ -n "$expected" ] && ! printf '%s' "$out" | grep -qF -- "$expected"; then
    bad "$name" "want \"$expected\", got: $(printf '%s' "$out" | head -n 1)"
  else
    ok "$name" "$(printf '%s' "$out" | head -n 1)"
  fi
}

# assert NAME DETAIL COMMAND...: pass when COMMAND exits 0.
assert() {
  local name="$1" detail="$2"
  shift 2
  if "$@" >/dev/null 2>&1; then ok "$name" "$detail"; else bad "$name" "$detail"; fi
}

# ── the run sandbox as the image sees it ────────────────────────────────────
assert runtime-user "$(id -un) uid=$(id -u), not root" test "$(id -u)" != 0
assert no-capabilities "CapEff is zero" grep -q '^CapEff:[[:space:]]*0000000000000000$' /proc/self/status
assert no-new-privs "NoNewPrivs is set" grep -q '^NoNewPrivs:[[:space:]]*1$' /proc/self/status
# /workspace is the agent's own dir in the image (a run bind-mounts its clone
# there); unmounted, only the read-only rootfs can make it unwritable.
assert readonly-rootfs "agent-owned /workspace is not writable" test ! -w /workspace
assert writable-home "$HOME is writable" touch "$HOME/.probe"

# ── no per-run policy baked in (ADR-013 I1) ─────────────────────────────────
assert no-settings "no ~/.claude/settings.json" test ! -e "$HOME/.claude/settings.json"
assert no-claude-json "no ~/.claude.json" test ! -e "$HOME/.claude.json"
assert batteries-hooks "settings.batteries.json present" test -s "$HOME/.claude/settings.batteries.json"

# ── batteries, against the pins the image records from its own ARG lines ───
# shellcheck disable=SC1091 # inside the image
. /opt/automata/pins.env
check node             "v${NODE_VERSION}" node --version
check npm              ""              npm --version
check pnpm             "${PNPM_VERSION}" pnpm --version
check claude           "${CLAUDE_CODE_VERSION}" claude --version
check gh               "${GH_VERSION}" gh --version
check git              "git version"   git --version
check ruflo            "${RUFLO_VERSION}" ruflo --version
check gsd-core         ""              node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" current-timestamp
check gstack-browse    ""              "$HOME/.claude/skills/gstack/browse/dist/browse" --help
check chromium         "${CHROMIUM_VERSION}" "/opt/ms-playwright/chromium-${CHROMIUM_REVISION}/chrome-linux64/chrome" --headless --no-sandbox --version
check bun              "${BUN_VERSION}" bun --version
check flutter          "${FLUTTER_VERSION}" flutter --version
check dart             "Dart SDK version" dart --version
assert one-dart "dart is /opt/flutter/bin/dart" test "$(command -v dart)" = /opt/flutter/bin/dart
assert no-dart-sdk "no standalone /opt/dart-sdk" test ! -e /opt/dart-sdk
check somnio           "${SOMNIO_VERSION_LINE}" somnio --version
check actionlint       "${ACTIONLINT_VERSION}" actionlint -version
check gitleaks         "${GITLEAKS_VERSION}" gitleaks version
check shellcheck       "${SHELLCHECK_VERSION}" shellcheck --version

# Every Somnio catalog skill is installed globally for Claude (25 at the pin).
n="$(find "$HOME/.claude/skills" -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l)"
if [ "$n" -ge 25 ]; then
  ok claude-skills "$n SKILL.md files under ~/.claude/skills"
else
  bad claude-skills "only $n SKILL.md files under ~/.claude/skills"
fi

# The per-run Somnio agent-rules step (ADR-013 "Run path") against a checkout
# that tracks its own CLAUDE.md: install, restore what the repo tracks, exclude
# the rest. The checkout must end up clean.
repo="$(mktemp -d)"
if (
  set -e
  cd "$repo"
  git init -q .
  printf '# repo\n' >CLAUDE.md
  git add CLAUDE.md
  git -c user.name=v -c user.email=v@v commit -qm init
  somnio -q rules install --agent claude --project --stacks typescript </dev/null >/dev/null 2>&1
  git diff --name-only -z | xargs -0r git checkout --
  git ls-files --others --exclude-standard | sed 's|^|/|' >>.git/info/exclude
  test -s .claude/rules/typescript/best-practices.md
  test -z "$(git status --porcelain)"
) >/dev/null 2>&1; then
  ok somnio-rules "installed, tracked files restored, checkout clean"
else
  bad somnio-rules "per-run rules install left the checkout dirty or wrote nothing"
fi
rm -rf "$repo"

exit "$fail"
IN_CONTAINER
