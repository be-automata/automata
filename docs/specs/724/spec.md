# #724: Dart and Flutter `pub` trust the cell's interception CA (spec)

Branch `fix/724-cell-ca-trust`, base `origin/main` `b212e8bc`. Upstream OpenSandbox
`release-1.2.1` at `db708c218771a8d311356f0e96552c15df6e097a`. The guest's
`bootstrap.sh` ships inside the execd image
(`opensandbox/execd@sha256:6b12d178…`, `packages/worker/deploy/linux/opensandbox-bom.sh:12`).
It is not vendored in this repo: it was read with `gh api` at that sha.

## 1. Acceptance criteria (verbatim from the ticket) and decisions

1. In a cell built from the fixed image, as uid 10001, `dart create -t console … && dart pub add path:1.9.1 && dart pub get` exits **0** (re-runs #719 AC-1, step 2).
2. In the same cell, `flutter create --no-pub --platforms=web … && flutter pub get` exits **0** (#719 AC-1, step 4).
3. **Negative control.** In the same cell, a Dart HTTPS fetch to a host outside the allowlist (e.g. `https://httpbin.org/`) still fails, and the worker's `egress_events` records a deny for it. Interception and the allowlist are unchanged.
4. The fix still holds after a CA rotation, or the ticket states with evidence why rotation cannot happen within a cell's TTL. Evidence for the second case: the rotation watcher `watch_mitm_ca` in `bootstrap.sh:552-…`, armed at `:642`.
5. **No regression.** `npm view left-pad`, `git ls-remote https://github.com/…`, `curl https://pub.dev` and a `pip download` from PyPI (registries set) still succeed in the cell.
6. `verify.sh` has the new Dart trust check (Tests, below). It passes on the fixed image and fails on the current one, `sha256:4c7228d008fd…`.
7. `deploy/images/cell/README.md` "TLS in the cell" names the mechanism chosen in OD-1 and the per-ecosystem table, and records the Dart finding.
8. Results are posted on #719, AC-1 is re-run and checked, and #719 links here.

**Decisions (2026-11-20, owner took the recommendations):**

- **OD-1 = (b′).** At build time, make the system CA store writable by the agent in
  `deploy/images/cell/Dockerfile`. OpenSandbox's own `update-ca-certificates` step then succeeds as
  uid 10001, and its watcher re-runs that step when the CA rotates. **(a)**
  `DART_VM_OPTIONS=--root-certs-file` was the fallback only if `update-ca-certificates` could not run
  fully as non-root. Section 3 measures both: (b′) works fully, and (a) does not work at all.
- **OD-2.** No JDK change. The README notes that a future JDK's `cacerts` needs the same treatment.
- **OD-3.** Keep `GIT_SSL_CAINFO`.

## 2. Ground truth (re-verified 2026-11-20 at `b212e8bc`)

| #   | Claim                                                                                                                                                              | Where                                                                                                | Quote                                                                                                                                                                   | Holds?                                                                                                            |
| :-- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------- |
| G1  | The image ends as the agent                                                                                                                                        | `deploy/images/cell/Dockerfile:58`                                                                   | `USER agent`                                                                                                                                                            | yes                                                                                                               |
| G2  | One root phase, starting at `USER root`                                                                                                                            | `Dockerfile:26`                                                                                      | `USER root`                                                                                                                                                             | yes                                                                                                               |
| G3  | The image's **only** RUN: Postgres 16 + pip/venv, the snakeoil removed                                                                                             | `Dockerfile:36-44`                                                                                   | `rm -f /etc/ssl/private/ssl-cert-snakeoil.key /etc/ssl/certs/ssl-cert-snakeoil.pem; \`                                                                                  | yes                                                                                                               |
| G4  | CA env block                                                                                                                                                       | `Dockerfile:54-56`                                                                                   | `ENV OPENSANDBOX_MERGED_CA_PATH=/home/agent/.opensandbox/merged-ca-certificates.pem \ GIT_SSL_CAINFO=… \ PATH=/home/agent/.automata-run/flutter-pin:/opt/flutter/bin:…` | yes                                                                                                               |
| G5  | The base image is pinned by digest                                                                                                                                 | `Dockerfile:18`                                                                                      | `FROM --platform=linux/amd64 ghcr.io/be-automata/automata-batteries@sha256:da029c44…`                                                                                   | yes                                                                                                               |
| G6  | verify.sh runs one container: no network, no capabilities, no-new-privileges, `--init`; the default user (uid 10001)                                               | `deploy/images/cell/verify.sh:28-30`                                                                 | `docker run --rm -i --platform linux/amd64 --network none --cap-drop ALL --security-opt no-new-privileges --init --entrypoint /bin/bash "$image" -s <<'IN_CONTAINER'`   | yes                                                                                                               |
| G7  | Check helpers: `assert NAME DETAIL CMD…` passes on exit 0, and `expect_exit`. Each check prints one `ok`/`FAIL` line. Exit 0/1 is the verdict, 2 is a docker error | `verify.sh:39-56`, `:199-203`                                                                        | `assert() { … if "$@" >/dev/null 2>&1; then ok …`                                                                                                                       | yes                                                                                                               |
| G8  | It asserts that it runs as uid 10001                                                                                                                               | `verify.sh:74`                                                                                       | `assert identity-uid "uid=$(id -u)" test "$(id -u)" -eq 10001`                                                                                                          | yes                                                                                                               |
| G9  | The CA section checks only the env paths, that `~/.opensandbox` can be created, and git's libcurl-gnutls link                                                      | `verify.sh:127-137`                                                                                  | `# ── CA config for a non-root guest ──`                                                                                                                                | yes                                                                                                               |
| G10 | The README section "TLS in the cell"                                                                                                                               | `deploy/images/cell/README.md:73-97`                                                                 | `OpenSandbox's bootstrap installs the egress sidecar's MITM CA into the system store with update-ca-certificates. As a non-root user … that step fails`                 | yes. This text becomes **false** after the fix and must be rewritten                                              |
| G11 | The "Why a CA bundle the agent can write is safe" argument                                                                                                         | `README.md:87-95`                                                                                    | `Trust is enforced outside the guest. All egress goes through the sidecar…`                                                                                             | yes                                                                                                               |
| G12 | **Stale already:** "there is no `ADD`, no `RUN`"                                                                                                                   | `README.md:101-102`                                                                                  | `` `ADD`, no `RUN` and no secret mount ``                                                                                                                               | **no**: the Dockerfile has had one RUN since #707 (`README.md:13` says so itself). Fix it in the same README edit |
| G13 | The asset test pins **exactly one RUN** and its contents                                                                                                           | `packages/worker/src/agent-run/cell-image-assets.test.ts:124-140`                                    | `it("holds no credential-shaped ARG/ENV, no ADD or secret, and only the Postgres RUN"` … `expect(runs).toHaveLength(1);`                                                | yes. **Constrains the change**: the chown goes inside the existing RUN, or this test changes                      |
| G14 | The asset test pins the CA env and the shim-first PATH                                                                                                             | `cell-image-assets.test.ts:180-190`                                                                  | `expect(env.get("GIT_SSL_CAINFO")).toBe(CELL_CA_BUNDLE);`                                                                                                               | yes (unchanged)                                                                                                   |
| G15 | The asset test pins the last USER as agent, the COPY destinations, the FROM pin, and no credential-shaped ARG/ENV                                                  | `cell-image-assets.test.ts:101-198`                                                                  | `expect(users[users.length - 1]?.args).toBe("agent");`                                                                                                                  | yes                                                                                                               |
| G16 | The env allowlist parity tests: cell-entry `allow`, `CELL_ENV_ALLOWLIST`, the batteries ENV names                                                                  | `cell-image-assets.test.ts:560-576`, `:699-735`                                                      | `expect([...list("allow")].sort()).toEqual([...CELL_ENV_ALLOWLIST].sort());`                                                                                            | yes. b′ adds no env name, so these stay untouched                                                                 |
| G17 | CI runs verify.sh on every PR that touches `deploy/images/cell/**` (build-verify, read-only)                                                                       | `.github/actions/cell-image-build/action.yml:70-78`; the test at `cell-image-assets.test.ts:918-940` | `run: deploy/images/cell/verify.sh automata-cell:ci`                                                                                                                    | yes                                                                                                               |
| G18 | IT-E1 case (b): node and git TLS as uid 10001                                                                                                                      | `packages/worker/src/agent-run/cell-run.integration.test.ts:245-264`                                 | `it("(b) node and git reach their hosts as uid 10001"`                                                                                                                  | yes                                                                                                               |
| G19 | IT-E1 is opt-in. The image comes from `OPENSANDBOX_IT_CELL_IMAGE`, with no parsing beyond "not empty", and is **always `docker pull`ed inside the dind**           | `cell-run.integration.test.ts:47-59`, `:137`, `:153`                                                 | `await dind(["docker", "pull", "-q", IMAGE]);`                                                                                                                          | yes. A local-only tag makes this pull fail (section 4)                                                            |
| G20 | IT-E1's one cell allows only httpbin.org, github.com and \*.github.com                                                                                             | `cell-run.integration.test.ts:110-118`                                                               | `{ action: "allow", target: "httpbin.org" },`                                                                                                                           | yes. **httpbin.org is ALLOWED in the IT**, so it cannot be the IT's negative-control host                         |
| G21 | The adapter only checks that the image is not blank, and sends it as `image.uri`. Every cell gets `credentialProxy`                                                | `packages/sandbox/src/providers/opensandbox-cell.ts:1125`, `:823`, `:832`                            | `if (!isNonBlank(config.image)) {`                                                                                                                                      | yes                                                                                                               |
| G22 | Only the worker's production config requires a digest                                                                                                              | `packages/worker/src/agent-run/cell-config.ts:82`                                                    | `image = parsePinnedImage(rawImage);`                                                                                                                                   | yes. A tag is fine for the IT                                                                                     |
| G23 | The OpenSandbox server uses a cached image when its platform matches, and pulls only on `ImageNotFound` or a platform mismatch                                     | upstream `server/opensandbox_server/services/docker/container_ops.py:222-276`                        | `image = self.docker_client.images.get(image_uri)` … `except ImageNotFound: self._pull_image(`                                                                          | yes (external)                                                                                                    |
| G24 | `_sudo` falls back to a direct call when not root and there is no sudo                                                                                             | upstream `components/execd/bootstrap.sh:228-236`                                                     | `else "$@"`                                                                                                                                                             | yes (external)                                                                                                    |
| G25 | The bootstrap install: `mkdir -p /usr/local/share/ca-certificates && cp "$cert" …/opensandbox-mitmproxy-ca.crt && update-ca-certificates`                          | `bootstrap.sh:251-256`                                                                               | `_sudo cp "$cert" /usr/local/share/ca-certificates/opensandbox-mitmproxy-ca.crt`                                                                                        | yes (external)                                                                                                    |
| G26 | The merged bundle prefers certifi, else `/etc/ssl/certs/ca-certificates.crt`. It is written atomically                                                             | `bootstrap.sh:269-298`                                                                               | `if cat "$candidate" "$cert" > "$_merged_tmp" && mv "$_merged_tmp" "$merged"`                                                                                           | yes. The image has **no certifi** (measured: `ModuleNotFoundError`), so the merge reads `ca-certificates.crt`     |
| G27 | A failed install leaves the watcher baseline empty, so the watcher retries up to 3 times per generation and then gives up                                          | `bootstrap.sh:552-587`, `:600-603`                                                                   | `warning: mitm CA install failed 3 times; giving up until the next rotation`                                                                                            | yes (external)                                                                                                    |
| G28 | The watcher reinstalls when the CA fingerprint changes (every 30 s by default). It is armed regardless                                                             | `bootstrap.sh:552-586`, `:642`                                                                       | `watch_mitm_ca "$MITM_CA" "$_baseline_fp" &`                                                                                                                            | yes (external)                                                                                                    |
| G29 | Env exports: `NODE_EXTRA_CA_CERTS=$MITM_CA`, and `SSL_CERT_FILE`/`REQUESTS_CA_BUNDLE` pointing at the merged path                                                  | `bootstrap.sh:621-637`                                                                               | `export NODE_EXTRA_CA_CERTS="$MITM_CA"`                                                                                                                                 | yes (external)                                                                                                    |
| G30 | Batteries: the agent user is uid 10001, ca-certificates and openssl come from apt, no JDK                                                                          | `deploy/images/batteries/Dockerfile:96-97`, `:130-136`, `:182-183`                                   | `ca-certificates curl git jq …`; `useradd … --uid "${AGENT_UID}"`                                                                                                       | yes                                                                                                               |
| G31 | The server sets `no_new_privileges`                                                                                                                                | `packages/worker/deploy/linux/opensandbox-server.toml:39`                                            | `no_new_privileges = true`                                                                                                                                              | yes                                                                                                               |

**Measured in a local build of this Dockerfile** (`automata-cell:fix716`, the #716 build on the same
pinned base), `--network none`, as uid 10001:

| Fact                                                                             | Result                                                                                                                                                              |
| :------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Package versions                                                                 | `ca-certificates 20260816ubuntu0.24.04.1`, `openssl 3.0.13-0ubuntu3.16`; `ca-certificates-java` **not installed**                                                   |
| `/etc/ca-certificates/update.d`                                                  | exists, **empty**: no hooks run                                                                                                                                     |
| Owners today                                                                     | `/etc/ssl/certs`, `ca-certificates.crt`, `/usr/local/share/ca-certificates` and `/etc/ca-certificates*` are all `root:root`, mode 0755/0644. There is no `sudo`     |
| The current image as uid 10001, with caps dropped, run the way bootstrap does it | `cp: cannot create regular file '/usr/local/share/ca-certificates/opensandbox-mitmproxy-ca.crt': Permission denied`, and `update-ca-certificates` exits 2           |
| `dart`                                                                           | `/opt/flutter/bin/dart` → `/opt/flutter/bin/cache/dart-sdk/bin/dart`, the JIT VM (ELF x86-64), Dart 3.13.5. `openssl` is `/usr/bin/openssl`                         |
| A dangling hash link left by the snakeoil `rm` in G3                             | `/etc/ssl/certs/ce275665.0`. Harmless: `update-ca-certificates` deletes orphan links on its first run with an added cert                                            |
| OrbStack (local only)                                                            | It injects `orbstack-root.crt` into `/usr/local/share/ca-certificates` at container start. A local verify run therefore holds one extra root. CI and the box do not |

## 3. What `update-ca-certificates` writes as non-root, and the exact grant

The script at `/usr/sbin/update-ca-certificates` (ca-certificates 20260816) was read and run.

| Step                                                                                                  | Path                                                                                                 | Access needed                                                                                                                                                      |
| :---------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bootstrap `mkdir -p` + `cp`                                                                           | `/usr/local/share/ca-certificates/opensandbox-mitmproxy-ca.crt`                                      | **write on the dir** `/usr/local/share/ca-certificates` (the file is agent-owned after the first copy, and a rotation overwrites it)                               |
| read conf                                                                                             | `/etc/ca-certificates.conf`                                                                          | read only (never rewritten; only `dpkg-reconfigure` writes it)                                                                                                     |
| read roots                                                                                            | `/usr/share/ca-certificates/**`                                                                      | read only                                                                                                                                                          |
| temp files                                                                                            | `mktemp -p ${TMPDIR:-/tmp}`                                                                          | `/tmp`, already writable                                                                                                                                           |
| `cd /etc/ssl/certs`, then `ln -sf` a `<name>.pem` for each new cert, `rm` of removed and orphan links | `/etc/ssl/certs/*.pem`                                                                               | **write on the dir** `/etc/ssl/certs` (unlinking a root-owned link in an agent-owned dir needs no sticky bit and no ownership; the dir is 0755 with no sticky bit) |
| the bundle, rebuilt **in full on every run**                                                          | `/etc/ssl/certs/ca-certificates.crt.new`, then `chmod 0644`, then `mv -f` onto `ca-certificates.crt` | **write on the dir** only. The rename replaces the root-owned file, which is agent-owned afterwards. A chown of the file is **not** needed (measured)              |
| `openssl rehash .` (only when the set of links changed)                                               | `/etc/ssl/certs/<hash>.0`                                                                            | write on the dir                                                                                                                                                   |
| hooks: `run-parts --test /etc/ca-certificates/update.d`                                               | none (empty dir)                                                                                     | none                                                                                                                                                               |

**Grant:** one line inside the existing RUN (`Dockerfile:36-44`), placed right after the snakeoil
`rm` (before the apt-lists cleanup and the closing `test`s):

```sh
chown agent:agent /etc/ssl/certs /usr/local/share/ca-certificates; \
```

- Not recursive. Not on `/etc/ssl`, `/etc/ca-certificates*`, `/usr/share/ca-certificates`, or the
  file `ca-certificates.crt`.
- Inside the existing RUN, so G13's "exactly one RUN" still holds. That test's title and card change
  from "only the Postgres RUN" to "only the Postgres + CA-store RUN". The test pins the grant
  exactly: every `chown`/`chmod` statement of the RUN (split on `;`, newlines and `&&`,
  whitespace-normalised) must equal `["chown agent:agent /etc/ssl/certs /usr/local/share/ca-certificates"]`,
  and the RUN must contain no `chmod` at all. A separate negative-control test feeds fixtures (a
  `chown -R … /etc/ssl`, the grant plus an extra directory, the grant plus a `chmod 0777`) and
  asserts each one is flagged.
- The Dockerfile comment block at `:27-35` says why: #724, Dart reads only the system store, and the
  same safety argument as README:87-95.

**Measured with exactly this grant** (the two dirs chowned, nothing else, then `runuser -u agent`,
`--network none`). Throwaway CA g1, served by `openssl s_server` on `127.0.0.1:8443`:

| Probe                                                                                                        | Exit    | Note                                                                                              |
| :----------------------------------------------------------------------------------------------------------- | :------ | :------------------------------------------------------------------------------------------------ |
| Dart fetch, before the install                                                                               | 255     | `CERTIFICATE_VERIFY_FAILED: unable to get local issuer certificate` (the negative control works)  |
| `DART_VM_OPTIONS=--root-certs-file=<g1>` (fallback a)                                                        | **255** | **Ignored by the 3.13.5 JIT `dart` CLI.** Fallback (a) as written in the ticket **does not work** |
| `dart --root-certs-file=<g1> run` (a CLI flag)                                                               | 0       | Works only on the command line, so it cannot reach Flutter's `[sdkPath, 'pub', …]` subprocess     |
| The bootstrap sequence (`mkdir -p`, `cp`, `update-ca-certificates`)                                          | 0       | `2 added, 0 removed`; no hooks                                                                    |
| Dart fetch after the install                                                                                 | **0**   | about 2 s                                                                                         |
| Rotation: a new CA g2 with the **same subject**, copied to the same file name, then `update-ca-certificates` | 0       | `0 added` (the link exists), so `openssl rehash` is skipped. **The bundle is still rebuilt**      |
| Dart fetch against g2                                                                                        | **0**   | Dart reads `ca-certificates.crt` first, and it now holds g2                                       |
| Dart fetch against g1 after the rotation                                                                     | 255     | the old CA is no longer trusted                                                                   |

**Gotcha (for the README).** After a rotation, the hash link `<hash>.0` still points at the same
`.pem`, which now holds the new CA. mitmproxy's CA subject is the same in every generation, so the
hash, and therefore the link, stays valid. The bundle file, which Dart reads first, is always rebuilt.

**Conclusion:** (b′) needs only those two directories. Fallback (a) is not viable, so if (b′) ever
regressed, the next fallback is a `dart` wrapper, which does not cover Flutter's subprocess. Record
this in the README and on the ticket.

## 4. Can AC-1..AC-5 be verified before merge?

**Yes, on an amd64 host, with a one-line change to the IT.** The cheapest real path:

1. **The host.** IT-E1 needs amd64 (`docs/specs/656/gate-log-e.md:48-55`). On an arm64 Mac, the
   nested daemon sees a platform mismatch and re-pulls (G23), and the pinned dind will not start
   under `DOCKER_DEFAULT_PLATFORM`. Use a throwaway amd64 host, as #656 did (a Hetzner cpx32 with root
   Docker and no `.git`/`.env*`), not the production execution box.
2. **Build the image there** with the CI recipe: `pnpm --filter @terragon/daemon build`, stage
   `cell-ctx/{Dockerfile,cell-entry.sh,cell-send.sh,daemon/index.js}`, then
   `docker buildx build --platform linux/amd64 -t automata-cell:724 --load cell-ctx`
   (`action.yml:30-74`), then `deploy/images/cell/verify.sh automata-cell:724`.
3. **Get the image into the dind:** `bash packages/sandbox/opensandbox-it/up.sh`, then
   `docker save automata-cell:724 | docker exec -i osbit-dind docker load`.
4. **A local tag works, and no digest is needed.** The adapter accepts any non-blank ref (G21). The
   IT does not parse it (G19). Only production's `cell-config.ts` requires a digest (G22). The server
   uses the cached image when the platform matches (G23). A `name@sha256:` ref would not resolve
   without a registry, so use the tag. **One blocker:** the IT's unconditional
   `docker pull -q IMAGE` (`cell-run.integration.test.ts:153`) fails for a tag that exists only
   locally. It is now inspect-else-pull (the log says which branch ran), which matches
   `up.sh`'s `pull_one`. Then run
   `OPENSANDBOX_IT=1 OPENSANDBOX_IT_REUSE=1 OPENSANDBOX_IT_CELL_IMAGE=automata-cell:724 pnpm --filter @terragon/worker exec vitest run --no-file-parallelism src/agent-run/cell-run.integration.test.ts`.
   The alternative is a `registry:2` inside the dind, which gives a real digest but costs more and
   proves nothing extra.

**What each AC can show before merge:**

| AC  | Before merge (IT-E1 on amd64, real sidecar)                                                                                                                                                                                                                                                                                                                                                                                                                      | Only after merge (published digest, production cell)                                                |
| :-- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------- |
| 1   | new case (g): `dart create -t console` + `dart pub add path:1.9.1` + `dart pub get`, exit 0                                                                                                                                                                                                                                                                                                                                                                      | the #719 AC-1 re-run                                                                                |
| 2   | (g): `flutter create --no-pub --platforms=web` + `flutter pub get`, exit 0. The image already holds `sky_engine` and `flutter_web_sdk` (measured), so pub.dev is the only host needed (#719 spec:19)                                                                                                                                                                                                                                                             | the #719 re-run                                                                                     |
| 3   | (g): a Dart fetch to an **off-list host fails**. The host must not be httpbin.org (allowed in IT-E1, G20): use `https://example.org/`. Also check that the sidecar's log names the deny                                                                                                                                                                                                                                                                          | **the `egress_events` row** exists only in the worker's production path. Show it in the #719 re-run |
| 4   | No live case (h), dropped: the evidence is the offline rotation check in verify.sh (section 5, `dart-trust-rotation`, `dart-trust-rotation-old`) plus the upstream watcher `watch_mitm_ca` (`bootstrap.sh:552-603`, armed at `:642`; G27/G28). A live rotation needs a sidecar restart, and that breaks the guest's shared network namespace (the guest runs `network_mode=container:<sidecar>`, upstream `docker_service.py:883`), so it cannot be a trust test | none                                                                                                |
| 5   | (g): `npm view left-pad`, `git ls-remote`, `curl https://pub.dev`, `pip download six`                                                                                                                                                                                                                                                                                                                                                                            | the #719 re-run                                                                                     |

For (g), the IT's `plan()` egress (`:110-118`) gains `pub.dev`, `pub.dartlang.org`,
`registry.npmjs.org`, `pypi.org` and `files.pythonhosted.org` as exact hosts. That leaves the
vault, canary and test-DB cases unchanged, and `example.org` stays off-list. Put each command in a
`timeoutMs` of 300 s or more (a cold pub resolve under the 1-CPU cell), and the plan's `ttlMs` is
raised to 30 minutes so case (g) cannot outlive the cell. Case (g) is placed before case (d) (the
teardown), so it runs while the cell is still up. It calls `/opt/flutter/bin/dart` and
`/opt/flutter/bin/flutter` by absolute path, and each project is created in a fresh
`mktemp -d -p "$HOME"` directory, not in the cwd. The negative control also requires that
the Dart output contains neither `HandshakeException` nor `CERTIFICATE_VERIFY_FAILED`: the deny must
come from the allowlist, not from trust. The spec's `--offline` flag is not used anywhere.

**Ticket nit.** The Tests section's `flutter pub get --offline=false` fails before anything else runs,
because package:args flags take no value. Use `flutter pub get`, which is online by default.

**AC-6** is shown before merge twice over. CI's build-verify job runs verify.sh on the PR (G17), and
a local run of the new verify.sh against the published `…@sha256:4c7228d008fd…` must FAIL (or
against `automata-cell:fix716` as a stand-in, which has the same Dockerfile without the chown).

**Verdict:** AC-1, 2, 4 and 5, and the fetch-fails half of AC-3, can be shown before merge on a
throwaway amd64 host with a locally built tag. The `egress_events` half of AC-3, and AC-8, need the
published digest and the production re-run of #719.

## 5. verify.sh: the offline Dart trust check

The new block goes right after "CA config for a non-root guest" (after `verify.sh:137`), before the PATH checks. It runs inside the
existing container: uid 10001, `--network none` (loopback works, measured), caps dropped.
`openssl` is at `/usr/bin/openssl`; the script calls `/opt/flutter/bin/dart` by absolute path. The
system store it changes lives only in the `--rm` container, and the private keys exist only at
runtime (no layer, so the gitleaks layer scan is unaffected).

1. `ca-store-owner`: assert `stat -c %U` of `/etc/ssl/certs` and `/usr/local/share/ca-certificates`
   is `agent`, and `/etc/ssl`, `/etc/ssl/private` and `/usr/share/ca-certificates` are still `root`
   (the grant stays bounded).
2. In `t="$(mktemp -d)"`, `openssl req -x509` makes two throwaway CAs g1 and g2, with the **same
   subject** (`/CN=verify-probe-ca`, `basicConstraints=critical,CA:TRUE`, `keyUsage=keyCertSign`). Each
   signs a `localhost` leaf (`subjectAltName=DNS:localhost`, `extendedKeyUsage=serverAuth`).
3. Write `f.dart`:
   `import 'dart:io'; Future<void> main() async { final r = await (await HttpClient().getUrl(Uri.parse('https://localhost:8443/'))).close(); exit(r.statusCode == 200 ? 0 : 3); }`.
   **Do not `drain()`**: `s_server -www` keeps the connection open, and draining hung for 60 s
   (measured).
4. Serve g1's leaf: `openssl s_server -accept 127.0.0.1:8443 -www -quiet -cert … -key … &`. Poll
   `</dev/tcp/127.0.0.1/8443` for up to 5 s instead of sleeping.
5. `dart-trust-control`: `timeout 60 dart run f.dart` is **non-zero and its output contains
   `CERTIFICATE_VERIFY_FAILED`** before the install (any other failure, e.g. a dead server, must not
   pass for the control).
6. `dart-trust-install`: the bootstrap sequence, verbatim (G25):
   `mkdir -p /usr/local/share/ca-certificates && cp g1-ca.pem /usr/local/share/ca-certificates/opensandbox-mitmproxy-ca.crt && update-ca-certificates`,
   exit 0. **This is the step that FAILs on the current image** (Permission denied), which proves
   AC-6's "fails on the current one".
7. `dart-trust`: `timeout 60 dart run f.dart` exits 0.
8. `dart-trust-rotation`: copy g2 to the same file name, run `update-ca-certificates`, restart
   `s_server` with g2's leaf. Dart exits 0 against g2, and fails with `CERTIFICATE_VERIFY_FAILED` against g1's leaf
   (`dart-trust-rotation-old`). This is the
   offline proof for AC-4.
9. Kill `s_server` in every path, with a `trap` or an explicit kill before each restart, so the
   container's `--init` reaps it and the daemon round trip after it is not disturbed.

Cost: four `dart run` calls of about 2 s each (under emulation on an arm64 Mac; less on amd64 CI).
Update the header comment (`verify.sh:7-9`) to list the Dart trust check. shellcheck must stay clean
(the baseline is clean today).

## 6. Gates

| Gate                                                          | Command                                                                                                                                                                      |
| :------------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| asset tests (the RUN pin, the ENV pins, the allowlist parity) | `pnpm --filter @terragon/worker exec vitest run --no-file-parallelism src/agent-run/cell-image-assets.test.ts`                                                               |
| worker unit suite                                             | `pnpm --filter @terragon/worker exec vitest run --no-file-parallelism`                                                                                                       |
| type-check, lint, format                                      | `pnpm turbo tsc-check`, `pnpm turbo lint`, `pnpm turbo format-check`                                                                                                         |
| prettier on root files outside the packages (README, spec)    | `pnpm exec prettier --check --config .prettierrc --no-editorconfig deploy/images/cell/README.md docs/specs/724/spec.md`                                                      |
| shellcheck                                                    | `shellcheck deploy/images/cell/verify.sh deploy/images/cell/cell-entry.sh`                                                                                                   |
| local image build on the pinned base                          | stage `cell-ctx` as `action.yml:30-74` does, then `docker buildx build --platform linux/amd64 -t automata-cell:724 --load cell-ctx`                                          |
| image verify, new vs old                                      | `deploy/images/cell/verify.sh automata-cell:724` → exit 0; the same script against `automata-cell:fix716` or the `4c7228d0` digest → exit 1, failing at `dart-trust-install` |
| live (amd64 host)                                             | IT-E1 with `OPENSANDBOX_IT_CELL_IMAGE=automata-cell:724` and the new (g), after the inspect-or-pull change (section 4)                                                       |
| CI                                                            | `cell-image.yml` build-verify on the PR (runs verify.sh)                                                                                                                     |
| after merge                                                   | publish, pin the digest, re-run #719 AC-1 in production, post the exit codes, the `egress_events` deny row and the digest on #724 and #719                                   |

## 7. Files touched

- `deploy/images/cell/Dockerfile`: the chown inside the existing RUN, and the comment.
- `deploy/images/cell/verify.sh`: the Dart trust block and the header line.
- `deploy/images/cell/README.md`: rewrite "TLS in the cell" (b′ with the measured table, the
  per-ecosystem table from the ticket, the Dart finding, `DART_VM_OPTIONS` ignored, the
  rotation/hash note, the JDK note per OD-2), extend the "safe" bullets (the daemon starts under
  `env -i` and does not read the store, the sidecar verifies upstream against its own
  `/etc/ssl/certs`, writes die with the cell's writable layer, `/usr/lib/ssl/certs` links to the
  agent-owned dir), and fix G12.
- `packages/worker/src/agent-run/cell-image-assets.test.ts`: the RUN test's title, card, and the
  assertion that the RUN's only chown/chmod statements are exactly the one grant (a negative-control
  fixture proves a wider chown or any chmod is flagged).
- `packages/worker/src/agent-run/cell-run.integration.test.ts`: inspect-or-pull (with the pull
  comment and the header's `OPENSANDBOX_IT_CELL_IMAGE` line updated to accept a tag loaded in the
  dind), the extra `plan()` hosts, the 30-minute TTL and case (g), placed before (d). There is no
  case (h).

No `cell-entry.sh`, `cell-image.ts` or `daemon-env.ts` change (b′ adds no env name).

## 8. Risks

- **AC-2 may need a host besides pub.dev** if the Flutter tool fetches an artifact that is missing.
  The measured cache holds `sky_engine` and `flutter_web_sdk`, so it is unlikely. If it happens,
  it belongs to #719 (the host list), not to this fix.
- **Live rotation** is not exercised: rotating the CA means restarting the sidecar, and the guest
  shares the sidecar's network namespace (upstream `docker_service.py:883`), so a restart breaks the
  guest's network regardless of trust. The offline rotation check plus the upstream watcher
  (`bootstrap.sh:552-603`, armed at `:642`) covers the mechanism.
- **A writable system store.** The same argument as README:87-95: uid 10001 can already run
  anything in the cell, and the sidecar verifies upstream itself. The grant is the two directories
  only.
- **Rollback:** re-pin the previous cell digest. Cells stay off for every org until #719 AC-1
  passes.

## 9. Validator fixes: status

| #   | Fix                                                                        | In the code                                                                              | Deferred to the amd64 IT run                  |
| :-- | :------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------- | :-------------------------------------------- |
| 1   | case (g) before (d), `ttlMs` 30 min                                        | done (`cell-run.integration.test.ts`)                                                    | that (g) passes inside the TTL                |
| 2   | negative controls check how they fail                                      | done (verify.sh greps `CERTIFICATE_VERIFY_FAILED`; (g) refuses a handshake/verify error) | the (g) example.org deny, live                |
| 3   | case (h) dropped; AC-4 = offline rotation + upstream watcher               | done (no (h); `dart-trust-rotation`, `dart-trust-rotation-old`)                          | none                                          |
| 4   | asset test pins the exact chown, no chmod, with a negative fixture         | done (`cell-image-assets.test.ts`)                                                       | none                                          |
| 5   | (g) uses `/opt/flutter/bin/{dart,flutter}` in a `mktemp` dir under `$HOME` | done                                                                                     | that the commands exit 0 live                 |
| 6   | the chown sits right after the snakeoil `rm`                               | done (`Dockerfile`)                                                                      | none                                          |
| 7   | README safety bullets extended                                             | done (`README.md`)                                                                       | none                                          |
| 8   | IT pull comments updated                                                   | done (header and pre-pull comment)                                                       | that the inspect branch runs for a loaded tag |
