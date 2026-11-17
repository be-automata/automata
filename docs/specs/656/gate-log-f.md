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

## Roborev

- **Job 1216 on `446caab..7b4cb55`:** **Fail**, with one High, one Medium and two Lows. All are fixed:
  - **High:** `scan-layers.sh` inspected the base image in the local store. BuildKit does not register the FROM image there, and the action prunes first, so the scan would exit before scanning and nothing would ever be pushed. It now reads the base's layer count from the registry (`docker buildx imagetools inspect --raw`, picking the linux/amd64 manifest from an index). Checked live on the throwaway Linux box against `ghcr.io/be-automata/automata-batteries@sha256:da029c44…`: 24 layers, exit 0. This also shows the base digest exists and is public.
  - **Medium:** the send-cap test used 131071 `A`s, which is not valid base64; GNU `base64 -d` rejects it. The accepted case is now the largest valid length under the cap. Checked on the box with GNU coreutils: 131068 decodes (exit 0), 131071 fails (exit 1).
  - **Low:** the README now describes the split workflow as shipped.
  - **Low:** `spec-f.md`'s Contract carries a "superseded in part" note naming the shipped differences and the source of truth.

## First `cell-image` CI run (44141111069, at `57f545e`)

- **Image built:** the 8.3 GB batteries base was pulled by digest and `--ignore-scripts` held for the daemon build.
- **`verify.sh` passed every check except the bundle and daemon checks.** Those included uid and HOME, root-owned node, scripts 0555, the PATH reset, no credential env or dotfiles, `/root` empty, the CA paths, git linking libcurl-gnutls, entry exit codes 64 and 66, and the env refusal (exit 78, canary not echoed) for both identifier and non-identifier names.
- **FAIL `bundle-mode`, `bundle-version`, `daemon-socket` and `send-roundtrip`.** `statx '/opt/automata-daemon/index.js': Permission denied`: `COPY --chmod=0444` into a new directory created that directory without search permission for uid 10001.
  - `verify.sh` failed closed as designed.
  - **Fix:** the bundle moves into the base's existing `/opt/automata` as `daemon.js` (`CELL_DAEMON_BUNDLE`), with no `RUN` added. The tests pin it, with a negative control against the box's mount path.
