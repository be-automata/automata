# Batteries image

The one pinned image every agent run on the execution box starts from
([ADR-013](../../../docs/adr/ADR-013-image-per-run-execution.md), plan:
[`docs/plans/image-per-run-execution.md`](../../../docs/plans/image-per-run-execution.md)).

Status: **P0**. No worker code uses this image yet.

## What is in it

| Battery                   | Version                             | Pinned by                                                      |
| ------------------------- | ----------------------------------- | -------------------------------------------------------------- |
| Base                      | `ubuntu:24.04`                      | index digest                                                   |
| apt packages              | Ubuntu snapshot `20261015T000000Z`  | `APT_SNAPSHOT`                                                 |
| Node                      | 24.21.0                             | tarball sha256                                                 |
| pnpm                      | 10.14.0                             | binary sha256                                                  |
| Claude Code CLI           | 2.1.284                             | exact npm version (same as `cloud-init.yaml`)                  |
| gh                        | 2.102.0                             | tarball sha256                                                 |
| Dart SDK                  | 3.13.5                              | zip sha256                                                     |
| Flutter SDK               | 3.47.7 (bundles Dart 3.13.5)        | tarball sha256                                                 |
| Somnio CLI + all skills   | v3.1.1 @ `aa53f071…`                | commit sha + `pubspec.lock` overlay sha256                     |
| gstack (full suite)       | `df89475b…`                         | commit sha; its own setup, telemetry off                       |
| bun                       | 1.4.2                               | zip sha256                                                     |
| Chromium + headless shell | 151.0.7922.34 (Playwright rev 1234) | zip sha256                                                     |
| GSD (`@opengsd/gsd-core`) | 1.16.0                              | committed `package-lock.json` sha256                           |
| ruflo CLI + MCP server    | 3.56.7                              | committed `package-lock.json` sha256, prebuild + model sha256s |
| actionlint                | 1.7.12                              | tarball sha256                                                 |
| gitleaks                  | 8.30.1                              | tarball sha256                                                 |
| shellcheck                | 0.11.0                              | tarball sha256                                                 |

Most pins are copied from `packages/worker/deploy/batteries.json`, `harness.json` and
`linux/cloud-init.yaml`, so the host model and the image run the same builds during the migration.

Runtime user: `agent`, uid 10001, HOME `/home/agent`, workdir `/workspace`. Batteries that install
into a HOME (Somnio skills, gstack, GSD) were installed as that user, never as root.

The image carries **no secret and no per-run policy**: no credential, no Claude `settings.json`, no
trust seed, no MCP registration. The worker copies those in per run (ADR-013).

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
(Dart, Flutter), the Playwright CDN, the npm registry and Hugging Face.

## Verify

```bash
deploy/images/batteries/verify.sh automata-batteries:dev
```

One throwaway container, `--network none`, `--cap-drop ALL`: checks the runtime user is not root,
runs each tool's version command against its pin, counts the installed Claude skills, and installs
one stack of Somnio agent rules into a scratch project. Exits non-zero on any failure.

## Notes

- **Two Dart SDKs.** `dart` on `PATH` is the standalone SDK at `/opt/dart-sdk` (the operator's
  reference install); `flutter` uses its own bundled Dart, which is the same version at this pin.
  Dropping the standalone SDK would save about 0.5 GB (open question in the ADR).
- **Somnio agent rules** cannot be installed globally for Claude (the CLI only supports per-project
  rules for Claude). They ship as source under `SOMNIO_ROOT=/opt/somnio-ai-tools`; whether a run
  installs them into its checkout is a run-time decision.
- **`SOMNIO_ROOT` is set on purpose.** The CLI's last fallback walks up from the cwd looking for a
  `skills/` + `agent-rules/` + `cli/pubspec.yaml` layout, which a checked-out repo could plant.
- **Writable layer.** Flutter writes its own cache lock and `pub get` writes `PUB_CACHE`, so
  `/opt/flutter` and `/opt/pub-cache` belong to `agent` and the container is not `--read-only` yet.
- **Bumping a pin** is a reviewed change to the `ARG` lines; keep `verify.sh`'s expected versions in
  step.
