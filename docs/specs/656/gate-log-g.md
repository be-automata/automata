# #656 PR-G gate log

Branch `feat/656-g-box-hosting`, off `main` at `446caab6`. Spec: `docs/specs/656/spec-g.md`. Its validate rounds: BLOCK, then PASS_WITH_WARNINGS twice; every fix is folded in.

## L2–L4: the P0 probe on a throwaway box (AC-9)

- **Box:** `automata-cell-uat-656` (Hetzner 176511379), cx33 in nbg1; fsn1 had no cx33 capacity. Ubuntu 24.04.5, kernel 6.8.0-138, x86_64, with the repo's `cloud-init.yaml`, firewall 11699263 and label `purpose=656-s5-uat`. It is not `automata-exec-1`.
- **L3:**
  - `install-rootless-docker.sh` (runner profile) and `install-rootless-docker.sh --profile opensandbox` both exited 0. Every verify line was `ok`, including `worker-denied`: the worker account cannot reach the OpenSandbox socket.
  - `provision-execution-box.sh --prepare-only` was **not** run. It pulls the 12.5 GB batteries image and needs a GitHub token on the box for attestation. The runner daemon it would install was installed directly instead, so the two daemons coexist as the probe requires.
- **L4:** `opensandbox-p0-probe.sh --i-know-this-is-throwaway --out /root/p0-out9`, at commit `798e519a`.

**Result: `P0 VERDICT: rootless`. 34 PASS, 0 FAIL, exit 0.** `p0.json` holds no key; it was checked before it was copied.

```
PASS arch-x86_64 x86_64
NOTE os-release Ubuntu 24.04.5 LTS
NOTE kernel 6.8.0-138-generic
NOTE docker-version Docker version 29.10.0, build fdd4b8e
NOTE rootlesskit-version rootlesskit version 3.3.0
NOTE slirp4netns-flags --disable-host-loopback
NOTE apparmor-restrict-userns 1
NOTE apparmor-distro-profile present
NOTE apparmor-automata-profile absent
NOTE apparmor-status    rootlesskit   /usr/bin/rootlesskit 28561 rootlesskit   /usr/bin/rootlesskit 28571 rootlesskit
NOTE host-ipv6 2a01:4f8:1c18:f3cd::1/64
PASS daemon-rootless-cgroup2 docker info on the dedicated socket
PASS worker-denied automata cannot reach the socket
PASS runner-daemon-distinct other socket, other data root
NOTE images-pulled 4 by digest, tagged automata-osb/*
PASS run-dir-visible marker under /run/automata-opensandbox/p0 read back in a container
PASS server-healthy 127.0.0.1:18092 answers /health on the host netns
PASS server-host-loopback listener on 127.0.0.1 only
PASS server-mounts-dedicated-socket-only the one socket mount is the dedicated socket
PASS self-check-blocked adapter create gated on exit 3
PASS self-check-exec-3 exit 3
PASS allowed-https-200 ok=true 200
PASS allowed-80-blocked ok=false TimeoutError
PASS example-dns-nxdomain ok=false gaierror:-2
PASS example-ip-tls-blocked ok=false TimeoutError
PASS example-ip-http-blocked ok=false TimeoutError
PASS doh-by-ip-blocked ok=false TimeoutError
PASS dot-853-blocked ok=false TimeoutError
PASS udp-dns-sidecar-nxdomain ok=true 3 0
PASS metadata-blocked ok=false TimeoutError
PASS gateway-18092-blocked ok=false URLError
PASS gateway-8888-blocked ok=false URLError
PASS slirp-host-18092-blocked ok=false TimeoutError
PASS slirp-host-8888-blocked ok=false TimeoutError
PASS box-ip-8888-blocked ok=false TimeoutError
PASS sidecar-policy-refuses-guest ok=true 401
NOTE guest-gateway 172.17.0.1
PASS canary-scan-clean scanned=5
PASS guest-no-net-caps NET_ADMIN/NET_RAW bits
PASS dns6-no-answer ok=false gaierror:-2
NOTE ipv6-vacuous guest has no default v6 route; IPv6 bypass untested on this box
PASS deny-all-accepted PUT networkpolicy dropEstablished=true
PASS deny-all-blocks-allowed ok=false URLError
PASS second-delete-gone 404
PASS negative-control-4of4 4/4 reached
PASS sidecar-ruleset-policy-drop table inet opensandbox, policy drop
NOTE sidecar-ip6-nat-redirect rendered
PASS no-survivors containers, volumes, networks, netns back to baseline
NOTE netfilter-diff not compared; docker's empty 'table ip raw' is expected
P0 VERDICT: rootless
```

**Decision:** G1 installs the OpenSandbox server on the dedicated rootless daemon. The dind fallback is not needed.

## What the probe found on the way (eight runs)

Each failed run was a probe or production bug, not an enforcement failure. The fixes are in this branch's commits.

| Run | Failure                               | Cause                                                                                                                                                                                                                                                                                                                                                                                                            | Where it is fixed                                                                                                                                                |
| :-- | :------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–2 | every create, `http_error 400`        | **The OpenSandbox server rejects metadata values outside `[A-Za-z0-9._-]` (max 63, alphanumeric ends): `SANDBOX::INVALID_METADATA_LABEL`.** The probe's `p0:` keys hit it. **So does production: `cell-plan` sets `stepKey = "cell:" + apiKeyId` (`apps/www/src/app/api/daemon/cell-plan/route.ts:81`), so every production cell create would get a 400.** The IT never caught it because its keys are `osbit-…` | Probe: label-safe keys. **Production: PR-C**, with an adapter guard that refuses a tag value outside the label rules before any HTTP call (code PR-B shipped)    |
| 3   | quarantine `400`                      | OpenSandbox 1.2.1 validates the vault's bindings against a new policy. **A deny-all is refused (`credential vault policy validation: binding … is not allowed by egress policy`) while the vault still holds a binding.** The adapter's teardown order (revoke, then quarantine) is correct. A live cell cannot be quarantined without revoking its vault first                                                  | Probe: revoke first. **For PR-E/PR-D: an emergency deny-all must revoke first**                                                                                  |
| 4–8 | teardown `revoke:502 quarantine:502`  | A cell with no network policy has no egress sidecar, so revoke and deny-all are proxied to nothing and answer **502, not 404**. That makes `teardown` fail for such a cell. Production cells always have a policy, but **`teardown` is therefore not idempotent against a cell whose sidecar is gone**                                                                                                           | Probe: delete the no-policy control directly, as the IT's AC-8 does. **Adapter: PR-C** should treat a step failure followed by `GET /sandboxes/{id}` 404 as done |
| —   | `docker logs` on the dedicated daemon | its logging driver cannot be read back (`configured logging driver does not support reading`)                                                                                                                                                                                                                                                                                                                    | The probe now reports the server's error bodies instead                                                                                                          |

## Gates (worktree root)

| Gate                                                                                                                 | Exit  | Result                                                                                         |
| :------------------------------------------------------------------------------------------------------------------- | :---- | :--------------------------------------------------------------------------------------------- |
| `pnpm --filter @terragon/worker exec vitest run --no-file-parallelism src/agent-run/container-deploy-assets.test.ts` | 0     | 53 passed (outside the Claude sandbox; one `prove-container-limits` case fails only inside it) |
| `pnpm --filter @terragon/sandbox exec vitest run --no-file-parallelism src/providers/opensandbox-it/harness.test.ts` | 0     | 18 passed                                                                                      |
| `shellcheck -s bash` on the changed scripts                                                                          | 0     |                                                                                                |
| `pnpm turbo tsc-check --force`; `pnpm turbo lint --force`                                                            | 0 / 0 |                                                                                                |

## G1: live install on the throwaway box

On `automata-cell-uat-656`, at the G1 commit, `install-opensandbox.sh` installed the server on the dedicated rootless daemon:

- `automata-opensandbox.service` is active and `/health` answers 200 on `127.0.0.1:8090`.
- The listener is on `127.0.0.1` only (not `0.0.0.0` or `[::]`).
- `GET /sandboxes` without the API key returns 401, and with it returns 200.

The key lives only in `/etc/automata/opensandbox.env` (root:root 0600) and reaches the unit through `LoadCredential=`. No key value was printed or recorded.

## G2: worker wiring and the runbook

Files: `run-worker.sh.template`, `automata-worker.service`, `deploy-assets.test.ts`, `deploy/README.md` (new section "OpenSandbox cells (ADR-014, #656)", steps 1 to 9 in the order Access app, AUD, ingress with `access.required`, `ingress validate`, DNS route, 403 check), and this log.

- **Worker unit:** `LoadCredential=opensandbox.env:/etc/automata/opensandbox.env` plus an empty `SetCredential=opensandbox.env:` fallback, so a box without the file still boots.
- **Launcher:** inside a guard on a non-empty `$CREDENTIALS_DIRECTORY/opensandbox.env`, it exports `WORKER_OPENSANDBOX_API_KEY_FILE` and `WORKER_OPENSANDBOX_URL` (default `http://127.0.0.1:8090`). `WORKER_OPENSANDBOX_GUEST_IMAGE` comes from `worker-box.env`. `exec node` stays the last line. The launcher never reads the key.
- **Pinned by tests:** the names, both credential lines, the guard, no source/cat of the credential, and the last line.
- **Not yet verified:** that systemd 255 uses the empty `SetCredential=` when the `LoadCredential=` file is absent. This is the live check on the throwaway box (the main session runs it; the result goes here).

## G2 live check: the worker unit's credential fallback (systemd 255.4-1ubuntu8.18)

On the throwaway box, a throwaway unit carried the worker unit's two credential lines and a script that reports only whether the credential exists, its size, and whether it has an `OPENSANDBOX_API_KEY=` line:

| `SetCredential=`                             | Key file | Result                                                         |
| :------------------------------------------- | :------- | :------------------------------------------------------------- |
| `opensandbox.env:` (empty, as first written) | missing  | **unit fails**: `Failed to set up credentials: Protocol error` |
| `opensandbox.env:` (empty)                   | present  | starts; the credential has the key line                        |
| (none)                                       | missing  | unit fails (credentials)                                       |
| `opensandbox.env:none`                       | missing  | **starts**; the credential is 4 bytes with no key line         |
| `opensandbox.env:none`                       | present  | starts; the real key wins (85 bytes, one key line)             |

**An empty fallback does not apply on systemd 255.** As first written, the worker unit would not start on any box without the key file, production `automata-exec-1` included. The unit now ships `SetCredential=opensandbox.env:none`. A test pins it, with a negative control against the empty form.

The launcher still never reads the credential. The worker (PR-E) treats a credential without an `OPENSANDBOX_API_KEY=` line as "OpenSandbox not configured" and keeps the cell path off.

**Superseded by the drop-in (simplify pass).** The finding stands, but the `none` fallback no longer ships: the base worker unit has no credential line, and `install-opensandbox.sh` installs `automata-worker.service.d/opensandbox.conf` (only `LoadCredential=`) on a box that hosts the server. A box without OpenSandbox has no credential at all, the launcher's `-s` guard exports nothing, and PR-E fails closed when `WORKER_OPENSANDBOX_API_KEY_FILE` is unset. The live check of the drop-in on the throwaway box is recorded below once run.

## Refinement (8 findings, all fixed in `fc4990d4`) and the live re-run

- **High:** `install-rootless-docker.sh`'s AppArmor block reused `profile`, clobbering the runner/opensandbox selector on hosts with restricted user namespaces and no distro rootlesskit profile. The live box had the distro profile, so the P0 and G1 runs never took that branch. The local is now `aa_profile`, and a test pins it.
- **Mediums:**
  - The probe's refused deny-all path now deletes the cell and still runs the negative control.
  - The throwaway guard refuses an active worker or a seal key even with the flag.
  - The dedicated daemon restarts when a container cannot see the `/run` marker.
  - The README and launcher describe the real `none` fallback.
- **Lows:** the stale `.new` key file is removed first; the `/etc/automata` mode is kept; a new key or image restarts the server; `server.log` drops lines holding the key; tests are tightened.

**Live re-run on `automata-cell-uat-656` at `fc4990d4`.** Every step exited 0:

| Step                                         | Result                                                                                                                                                                                                                                   |
| :------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`             | 0                                                                                                                                                                                                                                        |
| `install-rootless-docker.sh` re-run (runner) | 0                                                                                                                                                                                                                                        |
| `install-opensandbox.sh` re-run              | 0. Every line `ok`, including the new **`run-dir-visible`** (a container reads the marker) and **`worker-denied` (permission denied)**. Key file root:root 600; unit active; health 200; loopback only; 401 without the key, 200 with it |
| `install-opensandbox.sh --check`             | 0                                                                                                                                                                                                                                        |
| P0 probe (`/root/p0-out10`)                  | **`P0 VERDICT: rootless`, 34 PASS / 0 FAIL**                                                                                                                                                                                             |
