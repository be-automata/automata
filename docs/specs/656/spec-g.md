# #656 PR-G: box hosting for the OpenSandbox server

Ticket: be-automata/automata#656 (S5 of #634). This PR is "PR-G" of the 7-PR plan. Branch `feat/656-g-box-hosting`, off `main` at `446caab6` (which includes PR-B, #665).

It covers:

- Scope items 3 and 4 (the box half), and the box rows of Scope 14 and 15 (server cap, loopback guard);
- AC-9, the box half of AC-10, the runbook for AC-12, and the server half of AC-16;
- #634 OD-4 (a dedicated rootless daemon for cells, gated by a P0 probe, with dind as the fallback).

Out of this PR:

- the worker's cell path and its config parser (PR-E; this spec proposes the env names PR-E reads);
- www's `CF-Access-*` fetch wrapper and its two Worker secrets (PR-C);
- the cell image (PR-F; `deploy/images/cell/` does not exist on `main`);
- wiring `install-opensandbox.sh` into `deploy/provision-execution-box.sh` (a follow-up, once the UAT passes).

## Ground truth (verified in this worktree at `446caab6`)

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Where                                                                                                          |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------- |
| None of the new files exist yet: `install-opensandbox.sh`, `opensandbox-p0-probe.sh`, `opensandbox-server.toml`, `automata-opensandbox{,-docker}.service`. `git ls-files` finds none of them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `packages/worker/deploy/linux/`                                                                                |
| The runner daemon's installer hard-codes its account, group, socket and unit as constants. There is no profile switch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `packages/worker/deploy/linux/install-rootless-docker.sh:57-63`                                                |
| The installer always makes the worker a member of the socket group and of the runner's primary group                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `install-rootless-docker.sh:232-240`                                                                           |
| When `kernel.apparmor_restrict_unprivileged_userns=1`, the installer writes its own `/etc/apparmor.d/automata-rootlesskit` profile, without checking for a distro profile                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `install-rootless-docker.sh:203-213`                                                                           |
| The runner unit uses slirp4netns, `--group=` with a host-side `chgrp`/`chmod 0660`, and `Type=notify`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `packages/worker/deploy/linux/automata-runner-docker.service:29`, `:40-42`, `:24`                              |
| The runner's containers get `--network none`, so agent runs cannot reach box loopback                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `packages/worker/deploy/README.md:463`; `packages/worker/src/agent-run/container-argv.ts:316`                  |
| The box is **Ubuntu 24.04** x86_64 (CX33, 4 vCPU / 8 GB / 80 GB). The provisioner warns on anything else                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `packages/worker/deploy/linux/cloud-init.yaml:10`; `deploy/provision-execution-box.sh:188-189`                 |
| The worker account `automata` is in the **rootful** `docker` group, which is already root-equivalent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `cloud-init.yaml:148-150`                                                                                      |
| The box also runs a rootful daemon for the engine stack, plus cloudflared. Both come from cloud-init                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `cloud-init.yaml:127-132`                                                                                      |
| Other box service accounts: `automata-telemetry` (Maple) and a DynamicUser otel collector. Both are limited to `IPAddressAllow=localhost`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `automata-maple.service:11-12`, `:28-29`; `automata-otel-collector.service:11`, `:21-22`                       |
| IT BOM digests: server `07f9b39a…`, execd `6b12d178…`, egress `84b98d3b…`, python `5e2bdb1b…` (all `release-1.2.1`, python 3.12-slim). The images are pulled by digest and re-tagged locally                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `packages/sandbox/opensandbox-it/up.sh:18-25`, `:47-58`                                                        |
| The IT renders the key into the config through `awk ENVIRON`, so it never appears in argv                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `up.sh:60-65`                                                                                                  |
| The IT config binds `0.0.0.0` (inside dind) and allows `max_sandbox_timeout_seconds = 3600`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `packages/sandbox/opensandbox-it/config.toml:3`, `:6`                                                          |
| `CELL_RUN_TTL_MS = 45 * 60 * 1000` (2700 s): the 30-minute run plus a 15-minute margin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `packages/types/src/cell.ts:94`; `packages/worker/src/agent-run/definition.ts:200`                             |
| The worker package depends on **neither** `@terragon/types` nor `@terragon/sandbox`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `packages/worker/package.json:32-39`                                                                           |
| The adapter sends `OPEN-SANDBOX-API-KEY` and reaches execd through the server, at `/sandboxes/{id}/proxy/44772/…`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `packages/sandbox/src/providers/opensandbox-cell.ts:455`, `:443-444`, `:28`                                    |
| The reconciler's teardown and list use only `GET /sandboxes?metadata=…`, `PUT …/networkpolicy`, `…/credential-vault` and `DELETE /sandboxes/{id}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `opensandbox-cell.ts:598`, `:644-661`                                                                          |
| The cell's ready timeout is 60 s, which a cold pull cannot meet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `opensandbox-cell.ts:29`                                                                                       |
| The batteries package is "about 8.3 GB". It takes **12.5 GB on disk per daemon store**. Two copies on the 75 GB production disk left 3.3 GB free, and `verify.sh` failed with ENOSPC                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `deploy/images/batteries/README.md:84`; `packages/worker/deploy/README.md:482`, `:512`                         |
| The tunnel: `hatchet.<domain>` → `http://127.0.0.1:8888`, served by `cloudflared-automata-hatchet.service` with config `/etc/cloudflared/config.yml`. That unit is not in the repo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `packages/worker/deploy/linux/TUNNEL-CUTOVER.md:13-14`                                                         |
| The hatchet-lite lesson: a tunnelled service with no auth gave the public an owner login                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `packages/worker/deploy/README.md:1028-1035`                                                                   |
| ADR-011: box services must accept inbound only "behind a tunnel with service-token auth". Its loopback finding is about the **deleted host-uid model** (`egress-nft.conf` and `automata-egress.service` are not in the tree)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `docs/adr/ADR-011-nango-oauth-vault-behind-credential-broker.md:194-205`                                       |
| Precedent for a root-only box secret: `/etc/automata/profile-evidence.env`, kept out of `worker-box.env`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `packages/worker/deploy/README.md:666-677`                                                                     |
| www reads `OPENSANDBOX_URL`, `OPENSANDBOX_API_KEY` and `OPENSANDBOX_GUEST_IMAGE`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `packages/env/src/apps-www.ts:114-116`                                                                         |
| Under a policy, a plain TCP connect on :80 or :443 proves nothing: the credential proxy answers every handshake there. The harness's `probeArgv` throws on such a probe unless it is marked `unproxied`, which is meant for the no-policy negative control only. The adapter's self-check contract is TLS + HTTP to a denied host, with exit 3 when blocked                                                                                                                                                                                                                                                                                                                                                                                       | `packages/sandbox/src/providers/opensandbox-it/harness.ts:205-210`, `:458-463`; `docs/specs/634/spec-s2.md:30` |
| `SELF_CHECK_ARGV`: `urlopen("https://example.org/")` exits 3 on any exception and 0 on any response. The adapter's `create` runs it before writing the vault and throws `egress_not_enforced` unless it exits 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `harness.ts:437-450`; `opensandbox-cell.ts:956-959`                                                            |
| The adapter's create body is always `{image, entrypoint, timeout, resourceLimits, metadata, networkPolicy, credentialProxy: {enabled: true}}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `opensandbox-cell.ts:701-713`                                                                                  |
| The harness probe is `PROBE_PY`, run through `probeArgv`, with results parsed by `parseProbeOutput`. Its kinds are `dns` (IPv4 only, `AF_INET`), `tcp`, `tls_ip`, `https`, `https_headers`, `http`, `gateway` and `canary_scan`. There is **no** AAAA, raw UDP DNS or IPv6-route kind                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `harness.ts:203-239`, `:261`, `:291`, `:393-413`, `:455`, `:518`                                               |
| `harness.ts` loads only `node:` modules and a type import, so importing it has no side effects. Its `API_BASE_URL` is hard-coded to `127.0.0.1:18091`, and `rawApi` uses it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `harness.ts:6-12`, `:19`, `:105-110`                                                                           |
| The IT's allowed host is `httpbin.org`, and every IT policy appends `{deny, ports:[80]}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `opensandbox-cell.integration.test.ts:80`, `:96`, `:98-110`                                                    |
| `tsx` is a root devDependency, so `node --import tsx` runs from the repo root on the box                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `package.json:27`                                                                                              |
| www's cell plane counts as "configured" when `OPENSANDBOX_URL` and `OPENSANDBOX_API_KEY` are both non-empty. That alone turns on the reconciler and `cell-plan` (cell-plan also needs the per-user flag)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `apps/www/src/server-lib/compute/cell-gate.ts:17-20`; `packages/env/src/apps-www.ts:110-116`                   |
| The README says the hatchet-lite steps run "BEFORE its REST port is tunnelled"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `packages/worker/deploy/README.md:1032-1035`                                                                   |
| Two shared bash-hygiene harnesses exist: `SCRIPTS` in `container-deploy-assets.test.ts:39-44` and `describeBashScriptHygiene` in `deploy-assets.test.ts:278-325`. The runner installer's tests live in **`container-deploy-assets.test.ts:94`**, not in `deploy-assets.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `packages/worker/src/agent-run/`                                                                               |
| shellcheck runs inside those vitest suites and is skipped when it is not installed. No workflow calls it on its own (a grep of `.github/` finds nothing)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `deploy-assets.test.ts:302-313`                                                                                |
| `hcloud server delete` is denied for agents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `.claude/settings.json:48`; `.claude/hooks/deny-destructive-cloud.py`                                          |
| **Spike 068** (rootless + OpenSandbox 1.2.1, arm64, Ubuntu 26.04) found the following. The spike lives in a git-excluded `.planning/` of the main checkout, not in this tree, so the facts it carries are copied into this spec. (1) The AppArmor failure (`fork/exec /proc/self/exe: permission denied`) came from adding the docs profile **on top of** the distro's `/etc/apparmor.d/rootlesskit`. (2) Because of `--detach-netns`, a `--network host` server answers on the VM's real `127.0.0.1`. (3) Docker leaves an empty `table ip raw` behind after a delete. (4) The IPv6 NAT `REDIRECT` rules render as `XT target REDIRECT not found`; this is to be verified on a v6-enabled box. (5) The x86_64 kernel and distro need a re-check. | spike README `:71-75`, `:79-80`, `:81-83`, `:153-154`, `:149`                                                  |
| S3 moved "the rootless re-check on an x86_64 box (IPv6 DNS redirect, rootlesskit AppArmor)" to S5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `docs/specs/634/spec-s3.md:7`                                                                                  |

## Design decisions

1. **Adopt, don't fork: parameterise the runner installer.** `install-rootless-docker.sh` gains `--profile runner|opensandbox`, with `runner` as the default.
   - **The `runner` profile stays behaviourally byte-identical.** The constant assignments at `:57-63` stay as literal lines inside the `runner` branch, because tests pin them (`container-deploy-assets.test.ts:117-118`). `provision-execution-box.sh:258` keeps calling the installer without the flag.
   - **The `opensandbox` profile:**
     - account `automata-opensandbox` (system, nologin), home `/var/lib/automata-opensandbox`;
     - **no shared group**: the socket dir is `/run/automata-opensandbox-docker` (0700, owned by the account), and the socket is 0600;
     - unit `automata-opensandbox-docker.service`;
     - tmpfiles file `automata-opensandbox-docker.conf`, holding **both** entries:
       - `d /run/automata-opensandbox-docker 0700 automata-opensandbox automata-opensandbox -` (the socket dir);
       - `d /run/automata-opensandbox 0700 automata-opensandbox automata-opensandbox -` (the server's rendered config, and the probe's state).
       - Both are created **before** the daemon first starts. When either is new while the daemon runs, the installer restarts the daemon once, because rootlesskit copies up `/run` at start;
     - **the worker is not added to any group.**
   - **Shared by both profiles:** packages, subid allocation (appended after every existing range), delegation (`pids_limit` and the plan's limits need it), linger, and the unit install.
   - **`verify` for the opensandbox profile:**
     - checks that the account reaches the socket and that the daemon is rootless on cgroup v2;
     - **negative check:** `runuser -u automata` must fail to reach it.
   - **AppArmor fix (spike 068 trail 1):** when `/etc/apparmor.d/rootlesskit` (the distro profile) exists, neither profile writes `automata-rootlesskit`. An `automata-rootlesskit` that already exists is never removed, so the production box does not change on a re-run.
   - Alternative checked: upstream `dockerd-rootless-setuptool.sh` (spike 068 used it). Rejected because it creates the socket under `/run/user/<uid>` and does not cover the delegation or the host-side socket mode, which the existing installer already gets right.
2. **The server is a system unit that drives a container on the dedicated daemon.**
   - `automata-opensandbox.service` runs with `User=automata-opensandbox`. It runs `docker -H unix:///run/automata-opensandbox-docker/docker.sock run --rm --name automata-osb-server --network host …` in the foreground.
   - It is a system unit, not a user unit, so PID 1 can read the root-only key file.
   - The daemon is a user unit, so the system unit cannot order itself after it. A bounded `ExecStartPre` waits for the socket instead, as `automata-worker.service:56` does for the engine.
3. **Loopback only.** The config sets `host = "127.0.0.1"`.
   - With `--detach-netns`, `--network host` is the box's real loopback (spike 068 trail 3).
   - The P0 probe proves this on x86_64. If the box's rootlesskit has no `--detach-netns`, the API is not on host loopback, and the probe fails `server-host-loopback`.
4. **The API key is in exactly one place at rest.**
   - The file is `/etc/automata/opensandbox.env`: mode 0600, owner root:root, one line `OPENSANDBOX_API_KEY=<64 hex>`.
   - `install-opensandbox.sh` generates it with `openssl rand -hex 32` under `umask 077` when the file is absent. It never prints it.
   - **Server:** `LoadCredential=opensandbox.env:/etc/automata/opensandbox.env`. PID 1 reads the root-only file and exposes it to the unit alone, at `$CREDENTIALS_DIRECTORY/opensandbox.env`. **The key is never in the process environment.**
     - `ExecStartPre` renders `opensandbox-server.toml` into `/run/automata-opensandbox/config.toml` (0600, tmpfs) with a two-file `awk`: the first file is the credential, the second is the template. The key is never in argv, `-e` or the environment, so `docker inspect` and `/proc/*/environ` show no key.
     - That directory is G0's tmpfiles entry, created **before** the daemon starts, because rootlesskit copies up `/run`. A directory made after the daemon starts is invisible to the daemon.
     - G0's probe proves the directory is visible (see the probe contract). If it is not, the fallback is `/var/lib/automata-opensandbox/run/` plus an `ExecStopPost` that removes the rendered file.
   - **Worker:** `automata-worker.service` gains `LoadCredential=opensandbox.env:/etc/automata/opensandbox.env` plus `SetCredential=opensandbox.env:none`. The `none` fallback (an empty one fails on systemd 255) applies when the file is absent, so a box without OpenSandbox (production today) still boots.
     - The launcher points PR-E at `$CREDENTIALS_DIRECTORY/opensandbox.env`.
     - The key never enters the worker's environment or `worker-box.env`.
   - Alternative checked: the key in `worker-box.env`. Rejected, because the key would then live in two files and the ticket rule is a root-only file.
5. **Loopback guard (Scope 15).** These uids can reach `127.0.0.1:8090` and the sidecar ports (`40000-40999`) on the box:
   - root, which includes cloudflared;
   - `automata`, already root-equivalent through the rootful `docker` group;
   - `automata-opensandbox` itself;
   - `automata-telemetry`, and the otel DynamicUser.
   - None of them runs untrusted code.
   - The untrusted code is agent runs (`--network none`) and cell guests. A cell guest sits behind the sidecar's deny, and slirp4netns runs with `--disable-host-loopback`, which is `dockerd-rootless.sh`'s default. The probe asserts both.
   - **Decision:** loopback plus the API key, with no unix socket and no host firewall in this PR.
     - A unix socket would not narrow the sidecar ports, which the server reaches on loopback.
     - Node's `fetch` cannot dial a unix socket without a new dispatcher.
     - Adding nft would undo cloud-init's removal of nftables (`deploy-assets.test.ts:264`).
     - A `meta skuid` rule on `lo` for those ports is a recorded follow-up.
6. **The tunnel ingress is path-fenced as well as Access-gated.** The cloudflared ingress for the server hostname passes only the reconciler's routes. Everything else on that hostname gets 404, including `/proxy/` (exec into a cell) and `POST /sandboxes` (create).
   - The rule's `originRequest.access` is set (`required: true`, team name, the app's AUD). cloudflared then rejects at the origin any request that has no valid Access JWT, which covers a misconfigured or deleted Access app. That gives two locks, the lesson from `README.md:1028-1035`.
7. **The worker env names proposed for PR-E.** They follow the worker's `WORKER_*` convention (`packages/worker/src/agent-run/config.ts:532-681`):
   - `WORKER_OPENSANDBOX_URL`: set by the launcher to `http://127.0.0.1:8090` only when the credential is non-empty; `worker-box.env` may override it.
   - `WORKER_OPENSANDBOX_API_KEY_FILE`: set by the launcher to `$CREDENTIALS_DIRECTORY/opensandbox.env`. PR-E accepts exactly one `OPENSANDBOX_API_KEY=<hex>` line and refuses anything else.
   - `WORKER_OPENSANDBOX_GUEST_IMAGE`: the cell image, digest-pinned, in `worker-box.env`. A tag is refused, as with `WORKER_BATTERIES_IMAGE`, through `parsePinnedImage`.
   - When any of the three is missing, a marked run fails closed with a code (Scope 15).
8. **The probe reuses the harness and the adapter, as a TypeScript driver.** We do not copy the probe into a new python heredoc, and we do not extract it to a `.py` file.
   - The driver is a new file, `packages/sandbox/src/providers/opensandbox-it/p0-probe.ts`. It runs from the box checkout as `node --import tsx packages/sandbox/src/providers/opensandbox-it/p0-probe.ts`.
   - It imports `probeArgv`, `parseProbeOutput`, `SELF_CHECK_ARGV`, `GUEST_IMAGE` and `GUEST_ENTRYPOINT` from `harness.ts`, plus `createOpenSandboxCellProvider` itself.
   - The enforced cell is therefore created by **the production adapter**, so the create body is exactly `opensandbox-cell.ts:701-713`, including `credentialProxy: {enabled: true}`. The adapter's own self-check gates the cell.
   - The driver never calls `rawApi`, whose base URL is the IT's. It builds its own `fetch` to the probe server's URL for the calls the adapter does not make: the negative-control create and the sidecar `/policy` read.
   - **`PROBE_PY` gains three kinds** (a `harness.ts` change, covered by `harness.test.ts`):
     - `dns6`: AAAA through `getaddrinfo(AF_INET6)`;
     - `udpdns`: sends one UDP datagram to `server:53` and returns the rcode and the answer count. **The query bytes are built in TypeScript** (`buildDnsQuery`, below) and passed as `query_b64`. Python only sends the datagram and reads the header (rcode is byte 3's low nibble; ANCOUNT is bytes 6-7), so the part vitest cannot run stays trivial;
     - `ipv6_route`: whether `/proc/net/ipv6_route` has a default route.
     - The IT keeps working unchanged: no existing kind changes.
   - Why not extract `PROBE_PY` to a `.py` file: that changes the IT's loading path for no gain, since the box already has node, pnpm and the checkout (`cloud-init.yaml:64-70`, `:147-151`).
   - **Cost:** one new file, so G0 is split in two (see Phases).

## Contract per file

### `packages/worker/deploy/linux/install-rootless-docker.sh` (changed)

- Usage: `[--profile runner|opensandbox] [--worker-user NAME] [--check]`. An unknown profile exits 2.
- `runner` is the code path of today; `opensandbox` is as described in decision 1.
- `--check --profile opensandbox` is read-only, and exits 1 on any `FAIL` line.
- The installer never touches `docker.service`, `automata-worker.service` or `/var/run/docker.sock`. The existing test `container-deploy-assets.test.ts:98-110` keeps passing.

### `packages/worker/deploy/linux/automata-opensandbox-docker.service` (new, a user unit)

- It is a copy of the runner unit with these changes:
  - `--data-root=%h/docker` and `--host=unix:///run/automata-opensandbox-docker/docker.sock --group=`;
  - one `ExecStartPost=/usr/bin/chmod 0600 …`, and no `chgrp`;
  - `Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_NET=slirp4netns`, with **no** override of `DISABLE_HOST_LOOPBACK`.
- Its comment states that the daemon's containers need egress, unlike the runner's: cells reach the internet through slirp4netns, behind the sidecar.

### `packages/worker/deploy/linux/opensandbox-server.toml` (new)

- It matches the IT `config.toml` key for key, except for these lines:
  - `host = "127.0.0.1"`;
  - `port = 8090`;
  - image tags `automata-osb/execd:1.2.1` and `automata-osb/egress:1.2.1`;
  - `max_sandbox_timeout_seconds = 3600`;
  - `api_key = "__API_KEY__"`, a placeholder that is never a value.
- `[egress] mode = "dns+nft"`, `[docker] network_mode = "bridge"`, `host_ip`/`publish_host = "127.0.0.1"`, plus the same `drop_capabilities`, `no_new_privileges` and `pids_limit`.

### `packages/worker/deploy/linux/automata-opensandbox.service` (new, a system unit)

- **Identity and files:**
  - `User=`/`Group=automata-opensandbox`;
  - `LoadCredential=opensandbox.env:/etc/automata/opensandbox.env`, with no `SetCredential` fallback, so a missing key fails the start;
  - `RuntimeDirectory=automata-opensandbox-client` (0700), with `Environment=DOCKER_CONFIG=%t/automata-opensandbox-client`. Under `ProtectSystem=strict` and `ProtectHome=yes`, the docker CLI's default `~/.docker` is not writable, and this directory is only read by the client.
- **Before the server starts:**
  1. wait up to 60 s for the socket;
  2. `docker rm -f automata-osb-server` (ignore a failure);
  3. render the config (0600) from `$CREDENTIALS_DIRECTORY/opensandbox.env` (decision 4).
- **Start:** `ExecStart=docker -H … run --rm --name automata-osb-server --network host --label automata.osb=1 -v /run/automata-opensandbox-docker/docker.sock:/var/run/docker.sock -v /run/automata-opensandbox:/etc/opensandbox:ro -v automata-osb-data:/data -e SANDBOX_CONFIG_PATH=/etc/opensandbox/config.toml automata-osb/server:1.2.1`.
  - The only `-v` source that is a docker socket is the dedicated one. A test pins this.
- **Stop:** `ExecStop=docker -H … stop -t 30 automata-osb-server`. S4 measured that cells survive a server restart (`docs/specs/634/gate-log-s4.md:38`).
- **Restart:** `Restart=always`, `RestartSec=5`.
- **Hardening**, as in `automata-maple.service:17-30`:
  - `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ReadWritePaths=/run/automata-opensandbox`, `ProtectHome=yes`, `PrivateTmp=yes`;
  - `RestrictAddressFamilies=AF_UNIX`, `IPAddressDeny=any`, `CapabilityBoundingSet=`.
  - The client only speaks to the unix socket.

### `packages/worker/deploy/linux/install-opensandbox.sh` (new, root, idempotent, `--check`)

1. Runs `install-rootless-docker.sh --profile opensandbox`.
2. Pulls the four BOM digests into the dedicated store, with an empty `DOCKER_CONFIG` and 3 retries, and tags them `automata-osb/*`. The digests appear in the file as literals, each commented with its tag.
3. Creates `/etc/automata/opensandbox.env` if it is absent. If it exists, it verifies root:root 0600 and the one-line shape, and refuses otherwise.
4. Installs and enables `automata-opensandbox.service`.
5. Verifies: `/health` answers 200 on `127.0.0.1:8090`; `ss -ltnH` shows the listener on `127.0.0.1` only (not `0.0.0.0` or `[::]`); an authenticated `GET /sandboxes` is 200; an unauthenticated one is 401.

- `--pull-cell-image <ref@sha256:…>`: pulls by digest only (a tag exits 2), but first refuses when `df` shows less than `CELL_IMAGE_MIN_FREE_GB` free (default 20) on the store's filesystem.
- It never prints the key and never uses `set -x`.

### `packages/worker/deploy/linux/opensandbox-p0-probe.sh` (new; root; throwaway boxes only)

The bash half. It does the root-side checks and runs the driver.

- **Throwaway-box guard.** The probe refuses to run when `automata-worker.service` is active, or when `/etc/automata/payload-seal.key` exists, unless `--i-know-this-is-throwaway` is passed.
- **Environment record** (`NOTE` lines):
  - `uname -m` (must be `x86_64`, or `FAIL`), `os-release`, kernel, Docker and rootlesskit versions, and slirp4netns flags (`--disable-host-loopback`, `--detach-netns`);
  - `kernel.apparmor_restrict_unprivileged_userns`, whether `/etc/apparmor.d/rootlesskit` and `automata-rootlesskit` exist, and the rootlesskit lines from `aa-status`;
  - the host's global IPv6 addresses.
- **Daemon checks** (`PASS`/`FAIL`):
  - the account's `docker info` shows rootless on cgroup v2;
  - the worker account **cannot** reach the socket;
  - the runner daemon, when it is installed, is a different socket and a different data root;
  - the server container's mounts name only the dedicated socket.
- **Copy-up check (`run-dir-visible`).** This is the real check behind decision 4.
  - As `automata-opensandbox`, the probe writes a non-secret marker to `/run/automata-opensandbox/p0/marker`.
  - It then runs `docker run --rm -v /run/automata-opensandbox/p0:/x:ro <python BOM digest> cat /x/marker` on the dedicated daemon, and requires the marker back.
  - On `FAIL`, G1 uses decision 4's `/var/lib` fallback.
  - The probe's state, including its throwaway key (0600) and rendered config, lives in that same directory, owned by `automata-opensandbox`. A root-owned `mktemp -d` at 0700 would be unreadable by the rootless uid. A trap removes the directory.
- **Throwaway server.**
  - It starts on `127.0.0.1:18092` with `-v /run/automata-opensandbox/p0:/etc/opensandbox:ro`. Its config is rendered from `opensandbox-server.toml`, with the port overridden and a generated key.
  - Server health on host loopback proves the server is on the host netns. `ss -ltnH` shows a loopback-only listener.
- **Cell probes.** The probe runs the driver (below) as root from the repo root. The key reaches the driver through a file path, never argv or env.
- **Survivor diff.** Containers, volumes, networks and netns return to the baseline. Docker's empty `table ip raw` is ignored (spike 068 trail 4).
- **Sidecar ruleset.** `nft list ruleset` in the sidecar shows `table inet opensandbox` with policy drop. The probe records whether the ip6 nat `REDIRECT` rendered.
- **Output and exit code.**
  - The output is one `PASS|FAIL|NOTE <check> <detail>` line per check, plus `--out DIR/p0.json` holding booleans, timings and versions only.
  - The last line is `P0 VERDICT: rootless` (exit 0) or `P0 VERDICT: FAIL (<checks>) -> dind fallback` (exit 1).
  - `NOTE` lines never count toward `PASS`.
  - The probe leaves the images pulled and removes everything else.

### `packages/sandbox/src/providers/opensandbox-it/p0-probe.ts` (new; the driver, decision 8)

- **Arguments:** `--base-url http://127.0.0.1:18092 --key-file <path> --allow-host httpbin.org --example-v4 <ip> --example-v6 <ip|none> --box-ip <ip>`.
  - The example.org addresses are resolved on the host by the bash half.
  - It prints the same `PASS|FAIL|NOTE` lines and a JSON summary, with no secret.
- **Enforced cell.** It is created through `createOpenSandboxCellProvider`, with `selfCheck: {argv: SELF_CHECK_ARGV}` and the image `GUEST_IMAGE`.
  - **The full plan** given to the adapter mirrors the IT's `plan()` (`opensandbox-cell.integration.test.ts:155-180`), so `create` never refuses it as `invalid_plan`:
    - `provider: "opensandbox"`, `runtime: "runc"`;
    - `tags`:
      - `automata: "cell"`;
      - `worker: "p0"`;
      - `epoch: "1"`;
      - `deployment: "p0-<hostname>"`;
      - `stepKey: "p0:<random hex>"`;
      - `attempt: "1"`;
      - `expiresAt: String(Date.now() + ttlMs)`;
    - `networkPolicy`: the policy below;
    - `vault`: one canary bearer entry for the allowed host;
    - `resources: {cpu: 1, memoryMiB: 512}`;
    - `ttlMs: 15 * 60 * 1000`. This is above `CELL_MIN_TTL_MS` and at or below `CELL_RUN_TTL_MS`, so PR-B's cap does not refuse it;
    - `egressDigest: "p0"`, `profileId: "opensandbox/runc"`.
  - The driver builds the plan with the `OpenSandboxCellCreatePlan` type, so `tsc` catches a missing field.
  - The plan uses the IT's policy shape: `{defaultAction: "deny", egress: [{allow, <allow-host>}, {deny, ports: [80]}]}`.
  - Its vault holds one canary bearer for the allowed host.
  - **`create` succeeding is the gated `self-check-blocked` PASS.** Any `egress_not_enforced` is `FAIL`.
  - The driver then runs `SELF_CHECK_ARGV` once more through `exec`, and requires exit 3.
- **Probes**, each a harness `ProbeSpec` through `probeArgv` and `parseProbeOutput`. A blocked check on :80 or :443 is never a plain TCP connect.
  - `https https://<allow-host>/get` → 200;
  - `http http://<allow-host>/get` → blocked (the :80 deny);
  - `dns example.org` → NXDOMAIN;
  - `tls_ip <example v4> sni=example.org` → fails;
  - `http http://<example v4>/` → fails;
  - `tls_ip 1.1.1.1 sni=cloudflare-dns.com` (DoH by IP) → fails;
  - `tcp 1.1.1.1:853` (DoT; port 853, so a TCP connect is meaningful) → times out;
  - `udpdns 8.8.8.8 example.org` → the sidecar's NXDOMAIN;
  - `http http://169.254.169.254/` (metadata) → fails;
  - box services from the guest must all fail or time out:
    - `http http://@gateway:18092/health` and `http http://@gateway:8888/`. The gateway is the guest's default route; under rootless it is not 10.0.2.2. The IT probes the same path at `opensandbox-cell.integration.test.ts:356`;
    - `tcp 10.0.2.2:18092` and `tcp 10.0.2.2:8888`, slirp4netns's host-loopback address;
    - `tcp <box-ip>:8888`;
  - `http` to the sidecar's `/policy` → 401;
  - a `canary_scan` that finds no canary;
  - guest caps without `NET_ADMIN` or `NET_RAW`, read through `exec` of `/proc/self/status`.
- **IPv6.**
  - `dns6 example.org` **always runs**, with or without a route: it tests the DNS proxy's AAAA path, and it must get no answer.
  - Then `ipv6_route`. **When the guest has no default IPv6 route**, the driver prints `NOTE ipv6-vacuous <detail>` and skips the IPv6 checks. They are recorded as not run, and never as `PASS`. The verdict still passes on the IPv4 set, and `gate-log-g.md` says the IPv6 bypass is untested on this box.
  - With a route:
    - `tls_ip <example v6> sni=example.org` fails;
    - `udpdns [2001:4860:4860::8888] example.org` gets no upstream answer.
- **Negative control:** the IT's own control, unchanged (`opensandbox-cell.integration.test.ts:848-878`).
  - The driver sends a raw `POST /sandboxes` with **no `networkPolicy` and no `credentialProxy`**: `{image: {uri: GUEST_IMAGE}, entrypoint, timeout: 600, resourceLimits: {cpu: "1000m", memory: "512Mi"}, metadata: {automata: "cell", worker: "p0", stepKey}}`.
  - A credential proxy without a policy has never been measured, so the control does not use one.
  - The adapter refuses a policy-less plan, so the driver cannot use the adapter here.
  - It waits for execd's ping. The cell must then reach example.org on 4 of 4 of the IT's probes:
    - `dns example.org`;
    - `https https://example.org/`;
    - `tcp <example v4>:80 unproxied`;
    - `tls_ip <example v4> sni=example.org`.
- **Deny-all, then delete.** After `PUT /networkpolicy?dropEstablished=true {deny, []}`, `https` to the allowed host fails. `teardown` runs, then a second `DELETE` returns 404.

### `packages/sandbox/src/providers/opensandbox-it/harness.ts` and `harness.test.ts` (changed)

- **`ProbeSpec` gains three kinds:**
  - `{kind: "dns6"; host}`;
  - `{kind: "udpdns"; server; host; qtype?: "A" | "AAAA"}`, where `server` may be an IPv4 or bracket-free IPv6 literal. `probeArgv` puts `query_b64 = buildDnsQuery(host, qtype)` on the wire;
  - `{kind: "ipv6_route"}`.
- **`PROBE_PY` gains `dns6`, `udpdns` and `ipv6_route` handlers.**
  - Each returns the same `{ok, err}` shape. `udpdns` adds `rcode` and `answers`; `ipv6_route` adds `default`.
  - No existing kind changes, and `probeArgv`'s :80 and :443 refusal stays as it is.
- **The new export `buildDnsQuery(host, qtype)`** returns the bytes of a standard DNS query: a random id, RD set, QDCOUNT 1, the labels, QTYPE and QCLASS IN. It refuses an empty label or a label longer than 63 bytes.
- **`harness.test.ts` covers:**
  - the wire shape of each new kind;
  - that `parseProbeOutput` keeps the new fields;
  - `buildDnsQuery`'s exact bytes for `example.org` A and AAAA (the id masked), and its refusals;
  - that `probeArgv` puts `query_b64` on the wire for `udpdns`, for both IPv4 and IPv6 servers.
  - No python runs in vitest.

### `packages/worker/deploy/linux/run-worker.sh.template` and `automata-worker.service` (changed)

- **Unit:** the `LoadCredential=` / `SetCredential=` pair from decision 4.
- **Launcher:** before the final `exec node`, which must stay the last line (`deploy-assets.test.ts:552-561`), and only when `${CREDENTIALS_DIRECTORY:-}/opensandbox.env` is non-empty, export:
  - `WORKER_OPENSANDBOX_API_KEY_FILE`;
  - `WORKER_OPENSANDBOX_URL="${WORKER_OPENSANDBOX_URL:-http://127.0.0.1:8090}"`.
- With no credential, nothing is exported.

### `packages/worker/deploy/README.md` (new section "OpenSandbox cells (ADR-014, #656)")

The steps run in this order, which secures the hostname before it is tunnelled (the rule at `README.md:1032-1035`).

1. **Install on the box:** `install-opensandbox.sh`, then `--check`.
2. **Pre-pull the cell image:** `install-opensandbox.sh --pull-cell-image <PR-F digest>`.
   - It takes roughly 12.5 GB or more in a **third** store, because no layers are shared across daemons. Check `df` first.
   - Decide with the owner before doing this on the production box (`README.md:512`).
3. **Access app and service token first.** Create a self-hosted Access app on the hostname, with exactly one policy: action **Service Auth**, including one service token.
   - Do **not** add an Allow policy or an identity provider. Either one makes Access answer a token-less request with a 302 to the login page instead of a 403.
   - Note the app's **AUD** tag.
4. **Ingress rule.** Add the server hostname rule to `/etc/cloudflared/config.yml`, before the hatchet rule's catch-all:
   - `path: ^/(health|sandboxes(/[^/]+(/(networkpolicy|credential-vault))?)?)$` → `http://127.0.0.1:8090`, with `originRequest.access: {required: true, teamName: <team>, audTag: [<AUD>]}`;
   - the same hostname without a path → `http_status:404`.
5. **Validate**, then restart the connector:
   - `cloudflared tunnel ingress validate`;
   - `cloudflared tunnel ingress rule https://<host>/sandboxes/x/proxy/44772/ping`, which must select the 404 rule;
   - restart `cloudflared-automata-hatchet.service`.
6. **DNS route last:** `cloudflared tunnel route dns automata-hatchet <host>`. Until this step the hostname resolves nowhere, so no unauthenticated window opens.
7. **Checks (AC-12):**
   - `curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<host>/health` without the token must print exactly **`403`** with an empty redirect.
     - A `302` (any redirect URL) means step 3 left a login path open. Remove it before going on.
     - This is the check that proves "Service Auth only".
   - With the two `CF-Access-*` headers and no API key, `GET /sandboxes` → 401.
   - With both, `GET /sandboxes?metadata=automata%3Dcell` → 200.
   - With both, `…/sandboxes/x/proxy/44772/ping` → 404.
8. **www secrets.** Every value goes through `wrangler secret put … --name automata-www` on stdin, never on a command line.
   - **PR-C owns the code that reads the two Access secrets.** This runbook only sets them.
   - Set them in this order, because `opensandboxConfigured()` (`cell-gate.ts:17-20`) turns the cell plane on once both URL and key are non-empty:
     1. PR-C's two Access secrets (the token id and secret);
     2. `OPENSANDBOX_GUEST_IMAGE` (the PR-F digest);
     3. `OPENSANDBOX_API_KEY`, streamed: `ssh <box> sudo sed -n 's/^OPENSANDBOX_API_KEY=//p' /etc/automata/opensandbox.env | npx wrangler secret put OPENSANDBOX_API_KEY --name automata-www`;
     4. **last**, `OPENSANDBOX_URL=https://<host>`, and only after step 7 passes.
   - The per-user flag `opensandboxCells` still gates `cell-plan`.
9. **Worker:** set `WORKER_OPENSANDBOX_GUEST_IMAGE` in `worker-box.env`, and restart with `automata-worker-safe-restart`.

- **Rollback**, in this order:
  1. unset www's `OPENSANDBOX_URL`;
  2. let the reconciler clear the cells first, or run `teardown` by hand;
  3. `systemctl disable --now automata-opensandbox.service`;
  4. remove the DNS route and the ingress rule.
- **The dind fallback**, if the P0 probe fails. G1 writes this section.

## Left to PR-E

- **Required PR-E test for the `none` file:** `SetCredential=opensandbox.env:none` makes the credential file non-empty on a box without OpenSandbox, so under systemd the launcher always exports `WORKER_OPENSANDBOX_API_KEY_FILE` and `WORKER_OPENSANDBOX_URL`. Fail-closed rests on PR-E's parser: a file whose content is `none` (no `OPENSANDBOX_API_KEY=` line) must read as "OpenSandbox not configured", the cell path stays off and a marked run fails closed with its code. PR-E must pin this with a test on the literal `none` file, plus a negative control (a file with exactly one `OPENSANDBOX_API_KEY=<64 hex>` line enables the path).

## Left to the live steps (main session, `hcloud --context automata`) and to the person

- **L2 (main session):** create a throwaway CX33 with `--image ubuntu-24.04`, the repo's `cloud-init.yaml` and a unique name. Never `automata-exec-1`. Check identity first (AP-001).
- **L3 (main session):**
  - wait for `/usr/local/automata/.provisioned`;
  - check out the PR branch and run `pnpm install --frozen-lockfile` (the driver needs tsx and the workspace);
  - run `deploy/provision-execution-box.sh --prepare-only`, so the runner daemon coexists;
  - then `install-rootless-docker.sh --profile opensandbox`.
- **L4 (main session):** run `opensandbox-p0-probe.sh --i-know-this-is-throwaway --out <dir>`, then copy `p0.json` and the output into `docs/specs/656/gate-log-g.md`. The verdict decides G1.
- **Person:**
  - **Delete the throwaway box.** `hcloud server delete` is denied to agents (`.claude/settings.json:48`).
  - Follow runbook steps 3–8 on the UAT dev hostname (R15), and later on the real box.
  - Decide on the cell image's disk use on the production box.

## Acceptance (this PR)

- **AC-9:** the L4 verdict is in `gate-log-g.md`.
  - `PASS` requires all of the following:
    - the adapter's gated self-check passed (exit 3);
    - example.org gets NXDOMAIN, and its IPv4 fails `tls_ip` and `http`;
    - with an IPv6 route, the IPv6 set is blocked; without one, it is `NOTE ipv6-vacuous`, never PASS;
    - `https` to the allowed host returns 200;
    - host loopback, metadata and the sidecar API are closed to the guest;
    - `run-dir-visible` passes;
    - the negative control reaches 4/4;
    - there are no survivors.
  - On `FAIL`, G1 ships the dind fallback, and the PR body says so.
- **AC-10, box half, and AC-16, server half:** a test pins `max_sandbox_timeout_seconds * 1000 >= CELL_RUN_TTL_MS`.
- **AC-12:** runbook steps 3–7 and the four checks are written. The person runs them on the dev hostname, and the result goes into the gate log.

## Tests

In `container-deploy-assets.test.ts` (G0a, G0b):

- `opensandbox-p0-probe.sh` joins `SCRIPTS` (`:39-44`). That covers `100755`, `#!/bin/bash` with `set -euo pipefail`, `bash -n`, and shellcheck.
- **The runner profile is unchanged:** the existing tests at `:94-188` pass with no edits, and the default profile is `runner`.
- **The opensandbox profile:**
  - the socket path is the same in the installer and the unit;
  - **both** tmpfiles entries are written, and are created before the daemon starts or restarts;
  - the unit has no `chgrp`, and `chmod 0600`;
  - `verify` has the negative worker check;
  - the worker is never `usermod`'ed in this profile (negative control: a branch-body extraction, as at `:159-162`).
- **AppArmor:** a distro `/etc/apparmor.d/rootlesskit` skips the write, and the installer never `rm`s `automata-rootlesskit`.
- **The probe script:**
  - no `set -x`, no `/var/run/docker.sock` host path, no `docker.service`, and no `echo`/`printf` of a key;
  - its state dir is `/run/automata-opensandbox/p0`, and there is no `mktemp -d`;
  - it has the copy-up marker check;
  - it has the throwaway guard;
  - it passes the key to the driver by file path only.
- The probe's BOM digests equal `up.sh:19-25` (extracted from both files).

In `harness.test.ts` (G0b): the new probe kinds (see the harness contract).

In `deploy-assets.test.ts` (G1 and G2):

- `describeBashScriptHygiene("packages/worker/deploy/linux/install-opensandbox.sh")`, next to the calls at `:316-325` (G1).
- The `printedStrings` check (`:331`): no `echo`/`printf` of `$KEY` or `OPENSANDBOX_API_KEY` in `install-opensandbox.sh`.
- **TTL pin:** parse `[server] max_sandbox_timeout_seconds`; `* 1000 >= CELL_RUN_TTL_MS`, imported from `@terragon/types/cell`.
  - This needs `"@terragon/types": "workspace:*"` in the worker's **devDependencies** (a test-only import), and a lockfile importer update, unless PR-E has already added it as a dependency.
- **Server config:**
  - `host = "127.0.0.1"`;
  - `api_key = "__API_KEY__"`, and no hex value of 32 or more characters in the file;
  - same keys as the IT `config.toml`, except for the listed differences (a negative control: an extra or missing key fails the test).
- **Server unit:**
  - the only socket mount source is `/run/automata-opensandbox-docker/docker.sock`;
  - it has `LoadCredential=opensandbox.env:/etc/automata/opensandbox.env`, and no `EnvironmentFile=` naming the key file;
  - `DOCKER_CONFIG` points under its `RuntimeDirectory`;
  - the hardening lines are present;
  - no `-e OPENSANDBOX_API_KEY` and no `--env-file`.
- **Worker unit:** it has both `LoadCredential=opensandbox.env:` and `SetCredential=opensandbox.env:`, so a box without the file still boots.
- **Launcher:**
  - `exec node` is still the last line;
  - the exports sit inside the non-empty-credential guard;
  - no line `source`s or `cat`s the credential.

## Gates (worktree root, CLAUDE.md verification table)

- `pnpm install --frozen-lockfile --prefer-offline` (the new devDependency).
- `pnpm --filter @terragon/docs exec fumadocs-mdx`, then `pnpm turbo tsc-check`, `pnpm turbo lint` and `pnpm turbo format-check`.
- `pnpm --filter @terragon/worker exec vitest run --no-file-parallelism`, with shellcheck installed so that no hygiene test skips (the local machine has 0.11.0). Also run `shellcheck -s bash` directly on the two new scripts.
- `pnpm --filter @terragon/sandbox exec vitest run --no-file-parallelism` (`harness.test.ts`; the IT stays skipped without `OPENSANDBOX_IT`).
- No Docker run, and no `OPENSANDBOX_IT`, in this PR's local gates.
- The live gate is L4, run on the throwaway box only.

## Risks

- **Rootless may not enforce on x86_64 / 24.04**, for example a missing `--detach-netns`, a v6 DNS bypass, or AppArmor. The P0 probe gates this.
  - **dind fallback:** run `docker:29.0.1-dind` (the IT digest) **under the dedicated rootless daemon**, never with `--privileged` on the rootful daemon, which would make a server escape root.
  - Whether a privileged dind works inside rootless is itself unverified. G1 has to measure it, or stop and ask the owner.
- **The IPv6 check may be vacuous:** a guest with no IPv6 route cannot test the v6 bypass. It is then recorded as untested, not passed.
- **Disk.** A third image store, about 12.5 GB or more, on a 75 to 80 GB disk that already ran out once. The pull refuses below 20 GB free. The owner decides for production.
- **The ingress path fence passes `POST /sandboxes`** (create), because cloudflared ingress cannot filter by method. Access, the API key and `originRequest.access` still apply. Method filtering would need a Worker or WAF rule, recorded as a follow-up.
- **The worker unit changes on production when it is re-rendered.** `SetCredential` keeps the unit booting, and a test pins this. The worker picks up the change only on its next safe restart.
- **The copy-up visibility of `/run/automata-opensandbox`:** G0's probe measures it (`run-dir-visible`), and decision 4 names the fallback.
- **Unverified upstream behaviour, checked live:**
  - a Service-Auth-only Access app answers 403 rather than 302 (runbook step 7 checks it);
  - `SetCredential=` works as the fallback for a missing `LoadCredential=` file on the box's systemd 255 (G2 checks it on the throwaway box by starting the worker unit without the file).

## Phases (5 files at most each)

Fix 3 adds files (the driver, and the harness change with its test), so G0 is split into G0a and G0b.

1. **G0a, the dedicated daemon and the server config:**
   - `install-rootless-docker.sh` (the profile, and both tmpfiles entries);
   - `automata-opensandbox-docker.service`;
   - `opensandbox-server.toml`;
   - `container-deploy-assets.test.ts` (the profile tests).
2. **G0b, the probe kit** (it reuses the harness probe):
   - `opensandbox-p0-probe.sh`;
   - `packages/sandbox/src/providers/opensandbox-it/p0-probe.ts`;
   - `harness.ts`;
   - `harness.test.ts`;
   - `container-deploy-assets.test.ts` (the probe script joins `SCRIPTS`, plus its static checks).
3. **L2–L4 live:** a throwaway CX33, then run the probe and record it in `gate-log-g.md`. The verdict decides G1.
4. **G1** (on a dind verdict, a spec addendum comes first):
   - `automata-opensandbox.service`;
   - `install-opensandbox.sh`;
   - `deploy-assets.test.ts`;
   - `packages/worker/package.json` (the devDependency);
   - `pnpm-lock.yaml`.
5. **G2:**
   - `run-worker.sh.template`;
   - `automata-worker.service`;
   - `deploy-assets.test.ts`;
   - `README.md`;
   - `gate-log-g.md`.
6. **Full gates,** then the person's steps.

## Validate history

**Cycle 1: BLOCK.** Eleven required fixes, all folded in above.

1. The probe's blocked checks use `https`, `http` and `tls_ip`, never a plain TCP connect on :80 or :443 (`harness.ts:458-463`; `spec-s2.md:30`). `SELF_CHECK_ARGV` runs as a gated check, through the adapter's create and once more through `exec`.
2. The probe cell's create body is the production body: the adapter itself makes the enforced cell (`opensandbox-cell.ts:701-713`, `credentialProxy: {enabled: true}`). The negative control replays the same body without `networkPolicy`.
3. The probe reuses `PROBE_PY`, `probeArgv` and `parseProbeOutput` through a tsx driver (`p0-probe.ts`). The harness gains `dns6`, `udpdns` and `ipv6_route`. G0 is split into G0a and G0b.
4. G0 writes both tmpfiles entries. The probe proves the `/run` copy-up with a marker read back inside a container, and keeps its state in `/run/automata-opensandbox/p0`, owned by the rootless uid, instead of a root `mktemp -d`.
5. `install-opensandbox.sh` gets its hygiene test through `describeBashScriptHygiene` in G1 (`deploy-assets.test.ts:278-325`), not through G0's `SCRIPTS`.
6. Runbook order: Access app and token, then AUD, then the ingress rule with `access.required`, then validate, then the DNS route, then the 403 check (`README.md:1032-1035`).
7. `@terragon/types` goes in devDependencies.
8. www's `OPENSANDBOX_URL` (`cell-gate.ts:17-20`) is set last, after AC-12. PR-C is named as the owner of the Access headers.
9. The server unit takes its key through `LoadCredential=`, never in the process environment. `DOCKER_CONFIG` points at the unit's `RuntimeDirectory`.
10. A Service-Auth-only Access app must answer 403, not 302. Runbook step 7 checks the status and the redirect URL.
11. A guest with no IPv6 route prints `NOTE ipv6-vacuous`, and the IPv6 checks never count as PASS.

**Cycle 2: PASS_WITH_WARNINGS.** Folded into G0b:

1. The negative control is the IT's own: no `networkPolicy`, no `credentialProxy`, and the IT's four probes (`opensandbox-cell.integration.test.ts:848-878`).
2. The `udpdns` query is built in TypeScript (`buildDnsQuery`, tested in `harness.test.ts`) and sent as `query_b64`. Python only sends it and reads the header.
3. Gateway probes are added: `http://@gateway:18092/health` and `http://@gateway:8888/` (as the IT does at `:356`).
4. The driver's full plan is spelled out: the tags `automata`, `worker`, `epoch`, `deployment`, `stepKey`, `attempt` and `expiresAt`; `resources`; and `ttlMs`.
5. `dns6` runs whether or not the guest has an IPv6 route.
