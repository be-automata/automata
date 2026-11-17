# #656 PR-F gate log: the cell guest image

Spec: `docs/specs/656/spec-f.md`. Branch `feat/656-f-cell-image`, off `main` at `446caab6`.

## Base

| Item        | Value                                                                                                                                                                         |
| :---------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FROM digest | `sha256:da029c443bfba5d61f67fdee4f5596ba1bfc6aff7653a46fa858a6b3cdfffffc` (OCI index pushed by batteries-image run `41584871485`, 2026-11-03, `f1ab6f26`, as `sha-f1ab6f26…`) |

## Local gates

Run before the PR opened; the literal output is in the PR description.

- `cell-image-assets.test.ts` (worker vitest), `shellcheck -s bash deploy/images/cell/*.sh` and
  `actionlint .github/workflows/cell-image.yml`.

## Build gate (the PR's `cell-image` run)

The Docker build and `verify.sh` run in CI, not in the Claude sandbox. Fill these in when the run
finishes:

- Run URL: PENDING (the PR's `cell-image` workflow run)
- `verify.sh` output: PENDING
- `scan-layers.sh` output (gitleaks over the image config and the layers above the base): PENDING
- Image size (`docker image inspect … size`): PENDING
- Pushed digest (main only, after merge): PENDING

## What the image half of AC-13 rests on

- Static: `cell-image-assets.test.ts` (no credential-shaped ARG/ENV, no RUN/ADD, the entry refuses
  credential-shaped names including non-identifier ones, and starts the daemon under `env -i`).
- In the `cell-image` run: `verify.sh` (running container) and `scan-layers.sh` (config and layers
  above the base), both before anything is pushed. `verify.sh` alone cannot see a token baked into
  a layer; the layer scan can.

## Not proven here

- The real image build, `verify.sh` inside the container, and the daemon round trip.
- gitleaks on the minified bundle (a path-scoped allowlist entry is the documented fallback).
- TLS as uid 10001 for `node`, `git` and `claude` through the sidecar: PR-E's live canary gate
  (AC-13 stays DEFERRED until then).
