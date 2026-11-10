#!/usr/bin/env bash
# Compile the allow_cell policy (ADR-014) to WASM, or check the committed WASM.
#
#   packages/shared/scripts/build-cell-policy.sh          # check + test + rewrite cell.wasm
#   packages/shared/scripts/build-cell-policy.sh --check  # check + test + compare; exit 1 on drift
#
# Why the .wasm is committed: apps/www runs on Cloudflare Workers, which refuse to compile
# WebAssembly from bytes at runtime. The module has to be a static import that wrangler bundles
# (apps/www/worker-entry.ts), so it must exist before `wrangler deploy`, `pnpm test` and
# `next dev`, none of which have an OPA toolchain. CI rebuilds it with the pinned OPA below and
# fails when the bytes differ from the committed file (`opa build -t wasm` is deterministic for
# the same OPA version and Rego source).
#
# OPA comes from $OPA, else `opa` on PATH. The version is pinned: a different OPA can emit
# different (still valid) bytes, and the check would report drift that is not there.
set -euo pipefail

OPA_VERSION="1.10.0"
ENTRYPOINT="cell/decision"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLICY_DIR="$HERE/../src/cell-policy/policy"
WASM="$HERE/../src/cell-policy/cell.wasm"
OPA="${OPA:-opa}"

mode="build"
case "${1:-}" in
  "") ;;
  --check) mode="check" ;;
  *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

if ! command -v "$OPA" >/dev/null 2>&1; then
  echo "opa not found: install OPA v$OPA_VERSION or set OPA=/path/to/opa" >&2
  exit 2
fi
actual="$("$OPA" version | sed -n 's/^Version: //p')"
if [ "$actual" != "$OPA_VERSION" ]; then
  echo "opa $actual found, $OPA_VERSION required (the committed cell.wasm is built with it)" >&2
  exit 2
fi

"$OPA" fmt --fail --list "$POLICY_DIR" >/dev/null || {
  echo "Rego not formatted: run '$OPA fmt -w $POLICY_DIR'" >&2
  exit 1
}
"$OPA" check --strict "$POLICY_DIR"
"$OPA" test "$POLICY_DIR"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/cell-policy.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
# Only cell.rego goes into the bundle: the tests are not part of the policy.
# Built from inside the policy directory with a relative path: the WASM embeds
# the source path (for locations), so an absolute path would make the bytes
# depend on where the checkout lives.
(cd "$POLICY_DIR" && "$OPA" build -t wasm -e "$ENTRYPOINT" -o "$tmp/bundle.tar.gz" cell.rego)
tar -xzf "$tmp/bundle.tar.gz" -C "$tmp" /policy.wasm 2>/dev/null \
  || tar -xzf "$tmp/bundle.tar.gz" -C "$tmp" policy.wasm

if [ "$mode" = "check" ]; then
  if ! cmp -s "$tmp/policy.wasm" "$WASM"; then
    echo "cell.wasm does not match cell.rego: run packages/shared/scripts/build-cell-policy.sh and commit the result" >&2
    exit 1
  fi
  echo "cell.wasm matches cell.rego (opa $OPA_VERSION, entrypoint $ENTRYPOINT)"
else
  cp "$tmp/policy.wasm" "$WASM"
  echo "wrote $WASM (opa $OPA_VERSION, entrypoint $ENTRYPOINT)"
fi
