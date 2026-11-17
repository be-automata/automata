# shellcheck shell=bash disable=SC2034
# Sourced by install-opensandbox.sh and opensandbox-p0-probe.sh: the OpenSandbox
# BOM (#656), the same four images as the IT harness
# (packages/sandbox/opensandbox-it/up.sh; a test pins these to those). Pulled by
# digest and re-tagged locally as automata-osb/*.
#
# pull_one needs the sourcing script's `dk` (docker on the dedicated daemon) and
# `die`.

# opensandbox/server:release-1.2.1
SERVER=opensandbox/server@sha256:07f9b39adb8cadf68357dd1b86367068210e960fc4cb50e11b75176387557ea7
# opensandbox/execd:release-1.2.1
EXECD=opensandbox/execd@sha256:6b12d17844ac7167271488302c71934e47f76abb9ddab19ec8529bd1c1c56b23
# opensandbox/egress:release-1.2.1
EGRESS=opensandbox/egress@sha256:84b98d3b5989a87389c977f6433f8cd3c7998d03aa15aaae41ebcb15b7eb8000
# python:3.12-slim
PY=python@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b

# "<digest ref> <local tag>" per image.
BOM_PAIRS=(
  "$SERVER automata-osb/server:1.2.1"
  "$EXECD automata-osb/execd:1.2.1"
  "$EGRESS automata-osb/egress:1.2.1"
  "$PY automata-osb/py:3.12"
)

# pull_one REF: pull REF unless the store has it, 3 tries.
pull_one() {
  local ref="$1" attempt
  dk image inspect "$ref" >/dev/null 2>&1 && return 0
  for attempt in 1 2 3; do
    dk pull -q "$ref" >/dev/null && return 0
    [ "$attempt" = 3 ] && die "pull failed: $ref"
    sleep $((attempt * 5))
  done
}
