# Cell guest image

`ghcr.io/be-automata/automata-cell` is the guest image of an OpenSandbox cell (ADR-014, #656). It is
the ADR-013 batteries image, pinned by digest in the `FROM`, plus three baked files:

- `/opt/automata-daemon/index.js`: the daemon bundle (`pnpm --filter @terragon/daemon build`).
  A cell cannot bind-mount, and the cell contract has no copy-in, so the bundle is in the image.
- `/opt/automata/cell-entry.sh`: the cell's command. It starts the daemon.
- `/opt/automata/cell-send.sh`: writes one daemon message. An exec has no stdin, and the daemon's
  `--write` reads stdin, so a fixed helper replaces ad-hoc shell quoting.

The image sets no `ENTRYPOINT` or `CMD`: OpenSandbox replaces both with its own bootstrap and runs
the request `entrypoint` as the command. It runs as `agent` (uid 10001), never root.

## Entry contract

```
/opt/automata/cell-entry.sh --url https://<broker-host>[:port]
```

- **`--url` only.** It accepts `https://` plus a lowercase host and an optional port, so a stray
  value can never become a daemon flag. Anything else exits **64**.
- **HOME.** It must be an absolute, existing directory, else the entry exits **66**.
- **Env refusal.** The daemon hands all of its env to the agent, so a credential in the cell's env
  would reach Claude and its tools. The entry reads the raw environment (NUL-separated, from
  `/proc/<pid>/environ`; `compgen -e` would miss names that are not shell identifiers, such as
  `npm_config_//registry.example/:_authToken`) and refuses to start (exit **78**) when any name
  matches, case-insensitively,
  `TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|APIKEY|_KEY$|PRIVATE|PASS|AUTH|_PAT$|COOKIE|DATABASE_URL|^AWS_`,
  unless the name is on its allowlist (`CELL_ENV_ALLOWLIST` in
  `packages/worker/src/agent-run/cell-image.ts`, equal to the `allow` list in the script). It prints
  the variable **name**, never the value. The pattern is broad on purpose: a name such as
  `GIT_AUTHOR_NAME` matches `AUTH`, so identity must travel another way (repo-local git config).
- **Env scrub.** The daemon is started under `/usr/bin/env -i` with only the allowlisted names and
  the static run env (`CELL_DAEMON_ENV`: the allowlist plus `FORCE_COLOR` and
  `TOOL_FAILURE_STREAK_LIMIT`). Any other name is dropped, so the agent never inherits one the entry
  did not vet.
- **Both env channels are covered.** A request `env` (the adapter sends none) and the operator's
  `docker.sandbox_env` in the OpenSandbox server config (upstream `config.py:1411-1415`). A box
  config that puts a credential in `sandbox_env` makes every cell fail closed at start. Static,
  non-secret run env (`FORCE_COLOR=0`, `TOOL_FAILURE_STREAK_LIMIT`) may go there.
- **Exit codes.** Entry: 64 bad arguments, 66 HOME, 78 forbidden env name (`CELL_ENTRY_EXIT`). Send:
  64 bad argument, 65 argument over the cap (`CELL_SEND_EXIT`).
- **Socket.** The daemon listens on `/home/agent/.automata-run/daemon.sock`. The run dir is 0700.
- **PATH.** `PATH` starts with `/home/agent/.automata-run/flutter-pin` (the box's shim dir), so PR-E
  can write Flutter pin shims after the clone without restarting the daemon. That dir is
  agent-writable and first on `PATH`, so both scripts reset `PATH` to `/usr/bin:/bin` before any
  other command and call node by `/usr/local/bin/node`, never through the inherited `PATH`.
- **Not here.** Somnio rules, Flutter pin shims and git setup need the checkout, which is cloned
  after the cell is up. PR-E runs them by exec.

`cell-send.sh <base64>` takes one argument of at most `CELL_SEND_MAX_BYTES` (131071) characters: Linux
caps one argv string at 128 KiB. PR-E caps or splits a larger message.

The URL is an entry argument because the adapter sends no create env and exec has none. The
provider's `entrypoint` is fixed when the provider is built, but the broker host
(`plan.tags.deployment`) arrives per run. PR-E either builds the provider per deployment host (cached
by host; one host per worker in practice) or makes the entrypoint per-plan in the adapter, and says
which.

## TLS in the cell

OpenSandbox's bootstrap installs the egress sidecar's MITM CA into the system store with
`update-ca-certificates`. As a non-root user with no sudo (and `no_new_privileges`), that step fails;
upstream logs a warning and retries. The image makes TLS work without root through two settings:

- `OPENSANDBOX_MERGED_CA_PATH=/home/agent/.opensandbox/merged-ca-certificates.pem`: upstream's own
  knob for where bootstrap writes the merged bundle (system roots plus the MITM CA). Bootstrap then
  points `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE` at it (curl, Python, Go's `gh`).
  `NODE_EXTRA_CA_CERTS` points at the MITM CA under `/opt/opensandbox`, which covers the daemon and
  Claude Code.
- `GIT_SSL_CAINFO` is the same path, because Ubuntu's `git` uses libcurl-gnutls, which ignores
  `SSL_CERT_FILE`. `verify.sh` checks that linkage.

**Why a CA bundle the agent can write is safe:**

- Only uid 10001 can write it, the same identity that runs every tool in the cell. Whatever can
  rewrite the bundle can already run arbitrary code as that user.
- The daemon does not trust it: `NODE_EXTRA_CA_CERTS` is the sidecar's CA, not the HOME file.
- Trust is enforced outside the guest. All egress goes through the sidecar, which terminates TLS and
  verifies the upstream certificate itself. A CA planted in the guest bundle only makes the guest
  trust a server it cannot reach past the sidecar's allowlist.

TLS as uid 10001 is proven live by PR-E's canary gate, not here (the earlier evidence used a root
guest). If the bundle does not take, the cell fails closed.

## Token custody

The image holds no token, placeholder or key: no `ARG` or `ENV` is a credential, there is no
`ADD`, no `RUN` and no secret mount, and the build context is secret-scanned (gitleaks). The daemon
takes its token from each message, not from env. PR-E sends the placeholder
(`automata-cell-daemon-token`) as the message `token`; the sidecar vault swaps it for the real
credential on `/api/daemon-event` only. Every other www path gets the placeholder and a 401.
Execd logs exec argv, so a message passed to `cell-send.sh` must never carry a real credential.
One argv string is capped at 128 KiB on Linux, so a larger message needs splitting.

## Build, verify, publish

`.github/workflows/cell-image.yml` has two jobs, both running the shared action
`.github/actions/cell-image-build`: it builds the daemon with pnpm, stages the context in
`$RUNNER_TEMP/cell-ctx` (`Dockerfile`, both scripts, `daemon/index.js`; no source map), scans it with
gitleaks, builds `linux/amd64`, runs `verify.sh`, then `scan-layers.sh`. `verify.sh` sees a running
container; `scan-layers.sh` runs the same sha256-checked gitleaks over the image config and every
layer above the batteries base, so a token baked into a layer (even one deleted again) fails the job.

- **`build-verify`** (pull requests and refs other than `main`): `contents: read` only, nothing is
  pushed.
- **`publish`** (`main` only, independent of `build-verify`, which does not run there): holds `packages: write`, `id-token: write` and
  `attestations: write`. It rebuilds rather than loading the `build-verify` image, because a runner's
  image store does not cross jobs and an ~8.3 GB image is far over the artifact budget. The rebuild
  runs the same scans and `verify.sh` on the image it then pushes (`:sha-<commit>`), prints the digest
  to the job summary and attests provenance.

The path filters cover everything the bundle is built from: `deploy/images/cell`, the shared build
action, `packages/daemon`, `packages/agent` (a daemon dependency), `packages/tsconfig`, the root
`package.json`, `pnpm-workspace.yaml`, `.npmrc` and `pnpm-lock.yaml`. `packages/bundled` is not a
filter: it depends on the daemon, not the other way round, and the image never consumes it. To do the
same by hand:

```bash
pnpm --filter @terragon/daemon build
ctx="$(mktemp -d)" && mkdir "$ctx/daemon"
cp deploy/images/cell/{Dockerfile,cell-entry.sh,cell-send.sh} "$ctx/"
cp packages/daemon/dist/index.js "$ctx/daemon/index.js"
docker buildx build --platform linux/amd64 --build-arg REVISION="$(git rev-parse HEAD)" \
  -t automata-cell:dev --load "$ctx"
deploy/images/cell/verify.sh automata-cell:dev
```

The digest goes into `OPENSANDBOX_GUEST_IMAGE` on the worker (PR-E). The box pre-pulls it (PR-G).

## One-time owner step

The package is public, as the batteries one (see `deploy/images/batteries/README.md`). After the
**first** push an org owner sets visibility once by hand: the `be-automata` org, Packages,
`automata-cell`, Package settings, Danger Zone, Change visibility, Public. The same page's "Manage
Actions access" must list this repository with Write. Until then the box cannot pull anonymously.

## Bumping

- A new batteries digest is a reviewed edit of the `FROM` and the `base.name` label (a test asserts
  they are equal), made together with the batteries bump.
- A daemon change publishes a new cell digest on `main`. Bump `OPENSANDBOX_GUEST_IMAGE` with each
  worker deploy: the worker speaks the daemon protocol of its own revision, while the cell carries
  the bundle of the image's revision (the `org.opencontainers.image.revision` label).

## Box pre-pull (PR-G runbook)

Pull the pinned digest into the **OpenSandbox server's own rootless daemon**, whose image store is
separate from the ADR-013 runner daemon's (so the batteries layers are on disk twice; check the
disk). A cold pull of about 8.3 GB exceeds the adapter's ready and request timeouts, so the pre-pull
is required.

```bash
docker pull ghcr.io/be-automata/automata-cell@sha256:<digest>
gh attestation verify oci://ghcr.io/be-automata/automata-cell@sha256:<digest> --repo be-automata/automata
deploy/images/cell/verify.sh ghcr.io/be-automata/automata-cell@sha256:<digest>
```

The server's `execd_image` must be the 1.2.1 execd whose `bootstrap.sh` this image's TLS setup
relies on.
