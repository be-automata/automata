# Batteries image

The one pinned image every agent run on the execution box starts from
([ADR-013](../../../docs/adr/ADR-013-image-per-run-execution.md), plan:
[`docs/plans/image-per-run-execution.md`](../../../docs/plans/image-per-run-execution.md)).

Status: **P0**. No worker code uses this image yet. CI builds it on every change here
(`.github/workflows/batteries-image.yml`) and, on `main`, publishes it to public GHCR as
`ghcr.io/be-automata/automata-batteries`. The box pins the **digest** from the job summary, never a
tag.

## What is in it

| Battery                   | Version                             | Pinned by                                                      |
| ------------------------- | ----------------------------------- | -------------------------------------------------------------- |
| Base                      | `ubuntu:24.04`                      | index digest                                                   |
| apt packages              | Ubuntu snapshot `20261015T000000Z`  | `APT_SNAPSHOT`                                                 |
| Node                      | 24.21.0                             | tarball sha256                                                 |
| pnpm                      | 10.14.0                             | binary sha256                                                  |
| Claude Code CLI           | 2.1.284                             | exact npm version (same as `cloud-init.yaml`)                  |
| gh                        | 2.102.0                             | tarball sha256                                                 |
| Flutter SDK (+ its Dart)  | 3.47.7 (bundles Dart 3.13.5)        | tarball sha256                                                 |
| Somnio CLI + all skills   | v3.1.1 @ `aa53f071…`                | commit sha + `pubspec.lock` overlay sha256                     |
| gstack (full suite)       | `df89475b…`                         | commit sha; its own setup, telemetry off                       |
| bun                       | 1.4.2                               | zip sha256                                                     |
| Chromium + headless shell | 151.0.7922.34 (Playwright rev 1234) | zip sha256                                                     |
| GSD (`@opengsd/gsd-core`) | 1.16.0                              | committed `package-lock.json` sha256                           |
| ruflo CLI + MCP server    | 3.56.7                              | committed `package-lock.json` sha256, prebuild + model sha256s |
| Vendor runtime skills     | `24c77e7d…` (Somnio 0.9.43)         | commit sha of `be-automata/vendor-runtime-skills`              |
| actionlint                | 1.7.12                              | tarball sha256                                                 |
| gitleaks                  | 8.30.1                              | tarball sha256                                                 |
| shellcheck                | 0.11.0                              | tarball sha256                                                 |

Most pins are copied from `packages/worker/deploy/batteries.json`, `harness.json` and
`linux/cloud-init.yaml`, so the host model and the image run the same builds during the migration.

Runtime user: `agent`, uid 10001, HOME `/home/agent`, workdir `/workspace`. Batteries that install
into a HOME (Somnio skills, gstack, GSD) were installed as that user, never as root.

The image carries **no secret and no per-run policy**: no credential, no Claude `settings.json`, no
`.claude.json`, no trust seed, no MCP registration. The worker copies those in per run (ADR-013).
The hooks gstack and GSD register at install are kept as `~/.claude/settings.batteries.json` for
the worker to merge per lane.

## Build

From the repo root. The build context is `packages/worker/deploy`, which holds the lockfiles the
image reuses:

```bash
docker buildx build --platform linux/amd64 \
  -f deploy/images/batteries/Dockerfile \
  -t automata-batteries:dev --load \
  packages/worker/deploy
```

Needs network access to the Ubuntu snapshot archive, nodejs.org, GitHub, Google Cloud Storage
(Flutter), the Playwright CDN, the npm registry and Hugging Face.

## Verify

```bash
deploy/images/batteries/verify.sh automata-batteries:dev
```

One throwaway container with the run hardening baseline (`--network none`, `--cap-drop ALL`,
`no-new-privileges`, `--init`, `--read-only` with only HOME, `/opt/flutter` and `/tmp` writable).
It checks that the runtime user is not root, has no capabilities and cannot write the rootfs, that no
per-run policy is baked in, runs each tool's version command against its pin, counts the installed
Claude skills, and runs the per-run Somnio rules install against a scratch checkout that tracks its
own `CLAUDE.md` (the checkout must end clean). Exits non-zero on any failure.

## Publish

`.github/workflows/batteries-image.yml` runs on changes to this directory, the lockfile dirs the
build copies (`packages/worker/deploy/batteries/{gsd,ruflo,somnio-cli}`) or the workflow. Pull
requests build and verify. `main` also pushes `:sha-<commit>`, attests build provenance, and
writes `WORKER_BATTERIES_IMAGE=ghcr.io/be-automata/automata-batteries@sha256:…` to the job summary.
It authenticates with `GITHUB_TOKEN` (`packages: write`) only.

The package is **public**: the org is on GitHub Free, where private packages are capped at 500 MB,
and the image is about 8.3 GB with no secrets in it. GitHub has no API to change package
visibility, so after the **first** push an org owner does it once by hand: github.com → the
`be-automata` org → Packages → `automata-batteries` → Package settings → Danger Zone → Change
visibility → Public. Check the same page's "Manage Actions access" lists this repository with
Write.

On the box, before a digest is used:

```bash
docker pull ghcr.io/be-automata/automata-batteries@sha256:<digest>
gh attestation verify oci://ghcr.io/be-automata/automata-batteries@sha256:<digest> --repo be-automata/automata
deploy/images/batteries/verify.sh ghcr.io/be-automata/automata-batteries@sha256:<digest>
```

## Notes

- **One Dart.** `dart` on `PATH` is Flutter's bundled SDK (`/opt/flutter/bin/dart`); there is no
  standalone Dart SDK.
- **Somnio agent rules** cannot be installed globally for Claude (the CLI only supports per-project
  rules for Claude). Every run installs them into its checkout and git-excludes them (ADR-013
  "Run path"); the installer rewrites a tracked `CLAUDE.md`, so the run restores tracked files
  afterwards.
- **The Somnio CLI is compiled ahead of time** (`dart compile exe`), not `pub global activate`d:
  an activated binstub re-resolves its dependencies at start and fails with `--network none`. The
  pub cache it was resolved into is deleted after compiling; `PUB_CACHE` points into the writable
  HOME for the run's own `pub get`.
- **`SOMNIO_ROOT` is set on purpose.** The CLI's last fallback walks up from the cwd looking for a
  `skills/` + `agent-rules/` + `cli/pubspec.yaml` layout, which a checked-out repo could plant.
- **Read-only rootfs.** Flutter writes stamps and a lock under `/opt/flutter/bin/cache` on every
  invocation, so `/opt/flutter` belongs to `agent` and a run mounts it, like HOME, as a per-run
  anonymous volume (populated from the image, removed with the container).
- **Bumping a pin** is a reviewed change to the `ARG` lines only: the image records them in
  `/opt/automata/pins.env` and `verify.sh` checks the installed tools against that file. Update the
  table above in the same change.
