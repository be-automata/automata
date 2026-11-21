# Cell guest image

`ghcr.io/be-automata/automata-cell` is the guest image of an OpenSandbox cell (ADR-014, #656). It is
the ADR-013 batteries image, pinned by digest in the `FROM`, plus three baked files:

- `/opt/automata/daemon.js`: the daemon bundle (not the box's `/opt/automata-daemon/index.js` mount path: a COPY into a new directory leaves it unsearchable for uid 10001) (`pnpm --filter @terragon/daemon build`).
  A cell cannot bind-mount, and the cell contract has no copy-in, so the bundle is in the image.
- `/opt/automata/cell-entry.sh`: the cell's command. It starts the daemon.
- `/opt/automata/cell-send.sh`: writes one daemon message. An exec has no stdin, and the daemon's
  `--write` reads stdin, so a fixed helper replaces ad-hoc shell quoting.

It also installs the Postgres 16 server (`postgresql-16`, the box's major, from the batteries
image's apt snapshot; the image's one `RUN`) with no default cluster and no snakeoil key (#707). That
`RUN` also chowns the two CA-store directories to `agent` (#724, see "TLS in the cell").
Nothing starts it at boot: for a run of a repo the box's `TEST_SERVICES_REPOS` lists, the worker
starts one per cell as uid 10001 under `/tmp/automata-test-db`, on `127.0.0.1:25432` only, and the
agent gets `TEST_DATABASE_ADMIN_URL` (a `CREATEDB` role, a per-cell password) through its settings
`env` block (`packages/worker/src/agent-run/cell-test-db.ts`). It adds about 190 MB to the image.

The same `RUN` adds `python3-pip` and `python3-venv` (#716), which the batteries image now installs
too but the pinned base predates; after the `FROM` bump they are a no-op and can be dropped. Python
deps go into a venv in the checkout (PEP 668 refuses a system `pip install`); PyPI is reachable only
with the `automata/registries@1` egress bundle. They add about 22 MB.

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
- **Pinned Flutter SDKs (#742).** The batteries base carries `/opt/flutter-sdks/<version>` for the
  default SDK and every extra one in `pins.env` (`FLUTTER_EXTRA_VERSIONS`), owned by uid 10001.
  `verify.sh` runs each extra SDK here as that user, offline, and checks the version it reports.
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

OpenSandbox's bootstrap installs the egress sidecar's MITM CA into the system store
(`mkdir -p`, `cp` to `/usr/local/share/ca-certificates`, `update-ca-certificates`) and re-runs that
step when the CA rotates (`watch_mitm_ca`). The cell runs as uid 10001 with no sudo and
`no_new_privileges`, so on a stock image that step failed (`Permission denied`), and every client
that reads only the system store failed with it: Dart and Flutter `pub get` died with
`CERTIFICATE_VERIFY_FAILED` (#724, found by #719).

The image fixes it at build time (#724): the one `RUN` in the Dockerfile makes `/etc/ssl/certs` and
`/usr/local/share/ca-certificates` owned by `agent`. Those two directories only: not recursive, and
not `/etc/ssl`, `/etc/ssl/private`, `/etc/ca-certificates*` or `/usr/share/ca-certificates`. That is
what `update-ca-certificates` writes (the copied CA, the `<name>.pem` links, the rebuilt
`ca-certificates.crt` and the `<hash>.0` links); it needs no ownership of the root-owned files in
them, because replacing an entry needs only write on the directory. `verify.sh` checks the grant
(`ca-store-*`) and the bootstrap install with a throwaway CA, including a rotation (`dart-trust-*`);
a stock image fails at the install.

The fallback `DART_VM_OPTIONS=--root-certs-file=...` was measured and does **not** work: the Dart
3.13.5 `dart` CLI ignores it. Only the command-line flag works, and Flutter runs
`[sdkPath, 'pub', ...]` as a subprocess, so no flag reaches it. The system store is the only route.

Two settings stay, for clients that do not read the system store:

- `OPENSANDBOX_MERGED_CA_PATH=/home/agent/.opensandbox/merged-ca-certificates.pem`: upstream's own
  knob for where bootstrap writes the merged bundle (system roots plus the MITM CA). Bootstrap then
  points `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE` at it.
- `GIT_SSL_CAINFO` is the same path, because Ubuntu's `git` uses libcurl-gnutls, which ignores
  `SSL_CERT_FILE`. `verify.sh` checks that linkage.

| Client                | What it trusts                                                                                   |
| :-------------------- | :----------------------------------------------------------------------------------------------- |
| Node (daemon, Claude) | `NODE_EXTRA_CA_CERTS`, the MITM CA under `/opt/opensandbox`                                      |
| git                   | `GIT_SSL_CAINFO`, the merged bundle                                                              |
| pip, requests         | `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE`, the merged bundle                                        |
| curl, `gh`, OpenSSL   | `SSL_CERT_FILE` (the merged bundle) once bootstrap sets it, else the system store                |
| Dart, Flutter         | the system store only; `DART_VM_OPTIONS` is ignored                                              |
| Java                  | `cacerts`; there is no JDK in the image today. A JDK added later needs the same treatment (OD-2) |

A rotation re-runs the same install under the same file name, replacing the old generation's links.

**Why a CA store the agent can write is safe:**

- Only uid 10001 can write it, the same identity that runs every tool in the cell. Whatever can
  rewrite it can already run arbitrary code as that user.
- The daemon does not read it: `cell-entry.sh` starts it under `env -i` with an allowlist, and
  `NODE_EXTRA_CA_CERTS` is the sidecar's CA, not a file the agent writes.
- Trust is enforced outside the guest. All egress goes through the sidecar, which terminates TLS and
  verifies the upstream certificate itself against its own container's `/etc/ssl/certs` (upstream
  `config.yaml`), not the cell's. A CA planted in the cell's store only makes agent-run clients trust
  a server they cannot reach past the sidecar's allowlist.
- Writes do not survive the cell: the store lives in the cell's own writable layer.
- `/usr/lib/ssl/certs` links to `/etc/ssl/certs` (the OpenSSL CApath), and only agent-run clients
  read it.

TLS as uid 10001 is proven live by IT-E1 (case (b) for node and git, case (g) for Dart, Flutter and
the other registries), not by `verify.sh` alone. If the install does not take, the cell fails closed.

## Token custody

The image holds no token, placeholder or key: no `ARG` or `ENV` is a credential, there is no
`ADD`, no secret mount and only the one `RUN` (Postgres, pip/venv and the CA-store grant: no token
reaches it), and the build context is secret-scanned (gitleaks). The daemon
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
