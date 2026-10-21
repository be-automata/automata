#!/usr/bin/env bash
# verify.sh IMAGE — cheap smoke test of the batteries image (ADR-013 P0).
#
# Runs every battery's version command inside ONE throwaway container with no
# network, as the image's own non-root user, and checks the pinned versions.
# Exit 0 = every check passed; 1 = at least one failed; 2 = usage/docker error.
#
#   deploy/images/batteries/verify.sh automata-batteries:dev
#   deploy/images/batteries/verify.sh ghcr.io/<owner>/automata-batteries@sha256:<digest>
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

# The checks run inside the container. --network none proves the tools work
# offline (nothing phones home at start), which is how a run starts them.
docker run --rm -i --network none --platform linux/amd64 \
  --cap-drop ALL --security-opt no-new-privileges \
  --entrypoint /bin/bash "$image" -s <<'IN_CONTAINER'
set -uo pipefail
fail=0

# check NAME EXPECTED COMMAND...: run COMMAND, pass when its output contains
# EXPECTED (an empty EXPECTED only requires exit 0).
check() {
  local name="$1" expected="$2" out status
  shift 2
  out="$("$@" 2>&1)"
  status=$?
  if [ "$status" -ne 0 ]; then
    printf 'FAIL %-22s exit %s: %s\n' "$name" "$status" "$(printf '%s' "$out" | head -n 1)"
    fail=1
  elif [ -n "$expected" ] && ! printf '%s' "$out" | grep -qF -- "$expected"; then
    printf 'FAIL %-22s want "%s", got: %s\n' "$name" "$expected" "$(printf '%s' "$out" | head -n 1)"
    fail=1
  else
    printf 'ok   %-22s %s\n' "$name" "$(printf '%s' "$out" | head -n 1)"
  fi
}

if [ "$(id -u)" = "0" ]; then
  echo "FAIL runtime-user           container runs as root"
  fail=1
else
  echo "ok   runtime-user           $(id -un) uid=$(id -u)"
fi

check node             "v24.21.0"      node --version
check npm              ""              npm --version
check pnpm             "10.14.0"       pnpm --version
check claude           "2.1.284"       claude --version
check gh               "2.102.0"       gh --version
check git              "git version"   git --version
check ruflo            "3.56.7"        ruflo --version
check gsd-core         ""              node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" current-timestamp
check gstack-browse    ""              "$HOME/.claude/skills/gstack/browse/dist/browse" --help
check chromium         "151.0.7922.34" /opt/ms-playwright/chromium-1234/chrome-linux64/chrome --headless --no-sandbox --version
check bun              "1.4.2"         bun --version
check dart             "3.13.5"        dart --version
check flutter          "3.47.7"        flutter --version
check somnio           "somnio v3.1.1" somnio --version
check actionlint       "1.7.12"        actionlint -version
check gitleaks         "8.30.1"        gitleaks version
check shellcheck       "0.11.0"        shellcheck --version

# Every Somnio catalog skill is installed globally for Claude (25 at the pin).
n="$(find "$HOME/.claude/skills" -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l)"
if [ "$n" -ge 25 ]; then
  echo "ok   claude-skills          $n SKILL.md files under ~/.claude/skills"
else
  echo "FAIL claude-skills          only $n SKILL.md files under ~/.claude/skills"
  fail=1
fi

# Agent rules are per-project for Claude: prove one installs into a scratch dir.
scratch="$(mktemp -d)"
if (cd "$scratch" && somnio rules install --agent claude --project --stacks typescript >/dev/null 2>&1) &&
  [ -n "$(find "$scratch/.claude" -type f 2>/dev/null | head -n 1)" ]; then
  echo "ok   somnio-rules           project install wrote $(find "$scratch/.claude" -type f | wc -l) file(s)"
else
  echo "FAIL somnio-rules           project rules install failed"
  fail=1
fi
rm -rf "$scratch"

exit "$fail"
IN_CONTAINER
