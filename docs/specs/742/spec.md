# Spec #742: 60-minute task-lane runs, 4-CPU cells, and Flutter SDK pinning in cells

- Ticket: be-automata/automata#742 (the Decisions table at its end is binding).
- Ground truth re-verified at `c96f7440` (origin/main, the ticket's pin), branch
  `feat/742-run-budget-flutter-pin`, on 2026-11-21.
- Decisions applied: OD-1 = D (`ctx.refreshTimeout` per task-lane, non-self-heal run, proven
  first by a hatchet-lite v0.94.10 IT; fallback A = global 60m). OD-2 = A (keep 4096 MiB).
  OD-3 = B (Flutter SDK pinning ships in this ticket). OD-4 = A (keep the 10-minute Bash cap).
- No schema change, so `assert-schema-ready` and migrations are not involved.

## 1. Ground truth

### 1.1 Reality-check rows, re-verified

"Holds" means the file and line say what the ticket says. "Drift" means it holds with
different lines. "Does not hold" means the ticket's statement is wrong or incomplete.

| # | Ticket claim | Verified at | Status |
|---|---|---|---|
| 1 | `executionTimeout: "30m"`, one task def for all 4 variants | `packages/worker/src/agent-run/definition.ts:200`, variants `:63-66`; lanes `run-lane.ts:15-23`, `ownsAbnormalTerminal` `:30-37` | Holds |
| 2 | `scheduleTimeout: "30m"` | `definition.ts:199` | Holds |
| 3 | `RUN_EXECUTION_TIMEOUT_MS = 30 * 60_000` feeds the classifier and the fix-check deadline | `workflow.ts:954`, `fixCheckDeadline` `:958-963` (used `:1154`), abnormal state `:647-651`; classifier `abnormal-end.ts:89-92`, copy `:117`, `limitMinutes` `:137-139`; pins `workflow.test.ts:181-200`, `:1204-1210`, `cell-ttl.test.ts:43-56` | Holds. Also: `workflow.ts:587-588` comment ("the 30-minute execution timeout counts from here") |
| 4 | onFailure `"3m"` | `workflow.ts:384`, `:402` | Holds |
| 5 | Bash cap 10 / 5 min | `packages/daemon/src/adapters/claude-adapter.ts:27-28` | Holds (OD-4: unchanged) |
| 6 | `CELL_RUN_TTL_MS = 45 min`, pinned to timeout + 15 | `packages/types/src/cell.ts:100` (doc `:95-99` cites `definition.ts:200`); pin `cell-ttl.test.ts:49-56` | Holds |
| 7 | Cell step timeout = `CELL_RUN_TTL_MS` | `apps/www/src/app/api/daemon/cell-plan/route.ts:223`; fixed at first open `packages/shared/src/model/cell-authority.ts:231`; pin `route.test.ts:266-267` | Holds |
| 8 | Sandbox TTL = `CELL_RUN_TTL_MS`, plan refuses more | `route.ts:243` → `packages/sandbox/src/providers/opensandbox-cell.ts:825`; `cell-create-plan.ts:166-167`; `cell-create-plan.test.ts:332-340`; `route.test.ts:253` | Holds |
| 9 | `mintBearer` refuses `ttlMs > stepTimeoutMs` at `cell-authority.ts:549-596` | `mintBearer` starts `cell-authority.ts:524`, refusal `:574`, `expiresAt` `:594` | Drift (starts at 524) |
| 10 | Event token capped at `CELL_RUN_TTL_MS`, retire grace 15 min | `apps/www/src/lib/daemon-token.ts:172`, `:13`; `cell-event-token.integration.test.ts:267-268` (uses the constant) | Holds |
| 11 | Server cap `max_sandbox_timeout_seconds = 3600`, pinned by deploy-assets tests | `packages/worker/deploy/linux/opensandbox-server.toml:15-16`; `deploy-assets.test.ts:1037-1041` asserts `>= CELL_RUN_TTL_MS` | **Does not hold in full.** `container-deploy-assets.test.ts:457-460` pins the cap to exactly `toBe(3600)`, so it fails on any change. The OPENSANDBOX_IT config `packages/sandbox/opensandbox-it/config.toml:6` is also `3600`, and the ticket does not list it |
| 12 | `CELL_LEASE_STALE_MS` 5 min | `cell.ts:103` | Holds (unchanged) |
| 13 | Cell resources 2 CPU / 4096 MiB, no test pins them | `route.ts:248`; `opensandbox-cell.ts:826-828`; validation `cell-create-plan.ts:172-173`, `opensandbox-cell.ts:253-254`; no `cpu` in `route.test.ts` | Holds |
| 14 | `STALLED_CUTOFF_SECS = 75 * 60` | `apps/www/src/server-lib/cron.ts:45` (doc `:30-44`); `threads.ts:1652`; pin `cron.test.ts:114-117` | Holds |
| 15 | Deferral budget 12 min, boot inequality, "75-minute" string | `admission-retry.ts:18-29`, `config.ts:644-655` (string `:653`) | Holds. Not in the ticket: `admission-retry.ts:124` (another "75-minute" comment), `config.test.ts:581` (regex pins "75-minute"), `headroom.test.ts:244` (describe title; its assertion `<= 30*60 - 15*60` stays true) |
| 16 | `DELIVERY_RUN_STALE_MS = 45 min` | `apps/www/src/server-lib/delivery/cycle-finish.ts:31-32`; test uses the constant (`cycle-finish.test.ts:175`) | Holds |
| 17 | `SUPERSEDE_FRESHNESS_MS` 75 min | `packages/shared/src/model/hatchet-run.ts:34` | Holds (unchanged under OD-1 D) |
| 18 | Rule (iii) lookup 2 h, live recheck 15 min | `supersede-sweep.ts:153`, `:83` | Holds |
| 19 | Self-heal holder lease 75 min | `self-heal-slot.ts:39` | Holds |
| 20 | Check token 45 min, fix gate 2 h | `apps/www/src/server-lib/audit/plan-self-heal-run.ts:47`, `:49` | Holds |
| 21 | Review in-flight 60 min, stranded 30 min, stale queued 1 h | `apps/www/src/server-lib/audit/self-heal-admission.ts:32`; `process-queued-thread.ts:470`, `:38` | Holds (the first file is under `audit/`) |
| 22 | Mention copy has no number | `mention-reply-finish.ts:112` | Holds |
| 23 | `TOOL_FAILURE_STREAK_LIMIT` 12 at `tool-failure-streak.ts:24` | `:24` is `TOOL_FAILURE_STREAK_LIMIT_ENV`, an env key. The daemon default is observe mode (`limit` 0, `:12-16`), and the worker sets 12 (#548) | Drift (an env key, not a constant; not time based either way) |
| 24 | "Hard-capped at 30 min" comments | `provision.ts:396` (`STALE_RUN_DIR_AGE_MS` 24 h at `:375`), `hello/worker.ts:181` | Holds |
| 25 | Box slots / `check-slots-fit.ts`; cell admission = box admission | `packages/worker/deploy/check-slots-fit.ts` exists; `cell-run.ts:318-327` | Holds (box facts not re-measured) |
| 26 | CPU 3×4 = 12 on 8 cores, CFS quota | `opensandbox-cell.ts:827` sends `resourceLimits.cpu` | Holds in code. That this is a quota and not a reservation was not re-measured |
| 27 | Memory 3×4 GiB of 15 | `config.ts:631-635` | Holds (OD-2: unchanged) |
| — | SDK 1.26.0 exposes `ctx.refreshTimeout(incrementBy)` | `packages/worker/package.json:33` (`^1.26.0`), lockfile `pnpm-lock.yaml:2933` = 1.26.0; `v1/client/worker/context.d.ts:211`, impl `context.js:337-347` (it calls `dispatcher.refreshTimeout(durationToString(incrementBy), taskRunExternalId)`, and with no `taskRunExternalId` it only **warns and returns**) | Holds. Not used anywhere in the repo |
| — | "No Flutter SDK pinning in the cell image (no FVM, one Flutter version)" | See 1.3 | **Does not hold in full.** Pin detection and exit-69 notice shims exist for the box container path (#558). The cell image already puts a shim dir first on PATH, but nothing in the cell path writes to it |
| — | OD-3: ships via `batteries-image.yml` → `cell-image` → box `--prepare-only` digest switch | See 1.3 | **Does not hold for cells.** `--prepare-only` switches the batteries image on the runner daemon only. The cell digest switches by a pre-pull into the OpenSandbox daemon plus env and secret changes |
| — | Rollout order | Ticket "Risks": cap → www → worker. Decisions line (corrected 2026-11-21): cap → www → worker → image | **Holds after the correction.** The order was not an owner decision; the issue now says www before worker |

### 1.2 Where the run knows its lane (OD-1)

- `runAgent` (`workflow.ts:504`) → `runAgentAttempt` (`:583`), which sets `runStartedAt` at `:589`
  before anything else. The lane fields `prKey`, `supersedePolicy` and `prNumber`, and the shape of
  `selfHeal`, are plain on the wire (`AgentRunWireInput = Omit<AgentRunInput,"selfHeal"> & { selfHeal?: SelfHealWireShape }`,
  `run-secrets.ts:29`). So `ownsAbnormalTerminal(wire)` can be decided at `:589`, before the unseal
  (`:594`), the admission deferral and the clone.
- `RunCtx` (`run-admission.ts:37-42`) is a narrow structural type with no `refreshTimeout`. It
  must gain `refreshTimeout?: (incrementBy: Duration) => Promise<void>`.
- The abnormal-end state is built at `workflow.ts:647-651` with `runExecutionTimeoutMs`, after
  `runAgentResolved` begins. The effective budget must be passed down from `runAgentAttempt`.

### 1.3 Flutter in the images and the cell path (OD-3)

- **Batteries image** `deploy/images/batteries/Dockerfile`: `ARG FLUTTER_VERSION=3.47.7` and
  `FLUTTER_SHA256` (`:44-47`). Its rule (`:14-16`): every download is fixed by version and sha256.
  `ENV PUB_CACHE=/home/agent/.pub-cache`, `FLUTTER_ROOT=/opt/flutter`, `CI=true`, and PATH has
  `/opt/flutter/bin` (`:192-197`). The SDK is fetched with
  `fetch-verified https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_${FLUTTER_VERSION}-stable.tar.xz`
  and unpacked to `/opt/flutter`, owned by agent (`:198-202`). The tree is about 2.5 GB (`:180`).
  `flutter --version` warms the tool snapshot (`:302-304`). The pins go to `/opt/automata/pins.env`
  (`:386-393`), which `verify.sh` checks (`verify.sh:87`, `:110`). `verify.sh` runs the image with
  `--network none --read-only` and only HOME, `/opt/flutter` and `/tmp` writable (`verify.sh:30-32`).
- **Box container path**: a read-only rootfs, with `/opt/flutter` mounted as a per-run anonymous
  volume (batteries `README.md:116-118`). Pin detection is `detectFlutterPinFrom`
  (`packages/worker/src/agent-run/container-entry.ts:153-181`). It reads `.fvmrc` `flutter`, then
  `.fvm/fvm_config.json` `flutterSdkVersion`, takes an exact version only (regex `:162`), and
  **never reads `pubspec.yaml` `environment.flutter`**. On a mismatch the entry writes `flutter` and
  `dart` shims to `~/.automata-run/flutter-pin` that exit 69 (`:37-41`, `:87-107`). It is wired at
  `container-daemon-process.ts:317`, `:355`. The batteries README (`:119-124`) says matching needs
  the release in the image: "a second SDK of disk on the box (the prod disk fits one image)".
- **Cell image** `deploy/images/cell/Dockerfile`: `FROM ghcr.io/be-automata/automata-batteries@sha256:da029c44…`
  (pinned digest, equal to the `base.name` label, which a test asserts). It has exactly one `RUN`
  (Postgres and the CA-store grant), pinned by `cell-image-assets.test.ts:136-148`. PATH starts with
  `/home/agent/.automata-run/flutter-pin`. The cell README (`:58-63`) says "so PR-E can write Flutter
  pin shims after the clone without restarting the daemon". `cell-entry.sh:49` creates the
  directory and `:23` passes `PUB_CACHE` and `FLUTTER_ROOT` through. The rootfs in a cell is
  writable: the CA grant exists because OpenSandbox's bootstrap runs `update-ca-certificates` as
  uid 10001 (Dockerfile comment).
- **Cell run** `packages/worker/src/agent-run/cell-run.ts`: has no `flutter` reference. The bootstrap
  (`:494-495`, `bootstrap` `:931-975`) clones (`:948` "cell: clone complete"), sets git config,
  HOME and the socket, then pulls the first message (`:497-500`). **So a pinned repo in a cell
  today runs on 3.47.7 silently, or the agent downloads the SDK itself**, which is what the
  incident did.
- **The cell contract**: "a cell cannot bind-mount, and it has no copy-in" (`docs/specs/656/spec-f.md:113`;
  exec has no env or stdin, `packages/types/src/cell.ts:171-180`).
- **Image pipeline**: `.github/workflows/batteries-image.yml` builds, runs `verify.sh`
  (`:81`), and on main pushes a digest to GHCR and attests it (`:92-120`). The runner disk is
  tight (`:41-49`). `.github/workflows/cell-image.yml` does the same for `automata-cell`, about
  8.3 GB (`:55`, `:81-108`).
- **Digest switch**: `deploy/provision-execution-box.sh --prepare-only` pulls, verifies and records
  the **batteries** digest (`CURRENT`/`PREVIOUS` in `/etc/automata/batteries-image.state`,
  `:31-36`, `:379-398`). It keeps PREVIOUS only if `PREVIOUS_MIN_FREE_GB` (10) stays free
  (`:81`, `:418-427`; "a 12.5 GB image twice on a 75 GB disk left 3.3 GB"). The **cell** digest
  switches by a different route: a pre-pull into the OpenSandbox server's own rootless daemon
  (cell `README.md:194-197`, required because a cold 8.3 GB pull exceeds the adapter timeouts),
  then `WORKER_OPENSANDBOX_GUEST_IMAGE` in `worker-box.env` (`cell-config.ts:10`, `:26`; deploy
  `README.md:1330`) and the www secret `OPENSANDBOX_GUEST_IMAGE` (deploy `README.md:1310`).
- **Egress**: `automata/registries@1` (`packages/shared/src/model/cell-egress-catalog.ts:27`) carries
  `pub.dev` and `pub.dartlang.org` but **not** `storage.googleapis.com`, by design (deploy
  `README.md:1397-1430`, #719 OD-1: that host serves every GCS bucket, so it is an upload channel).
  The incident's in-run download of `flutter_linux_3.41.2-stable.tar.xz` from
  `storage.googleapis.com` succeeded. That means the client repo's cell egress permitted that host
  (no policy, or listed in its `domain` allowlist). It is not a platform default.
- Dependencies: no `semver` or `yaml` in any workspace `package.json`. `semver@7.8.6` is already in
  the lockfile transitively (`pnpm-lock.yaml:10749`).

## 2. Design per scope item

### S1 and S2: task-lane budget via `refreshTimeout` (OD-1 = D)

New module `packages/worker/src/agent-run/run-budget.ts` (pure):

```ts
export const REGISTERED_EXECUTION_TIMEOUT_MS = 30 * 60_000; // mirrors definition.ts:200
export const TASK_LANE_EXECUTION_TIMEOUT_MS = 60 * 60_000;
/** The engine's refresh semantics as measured by refresh-timeout.integration.test.ts. */
export const TASK_LANE_REFRESH: Duration = /* "30m" if additive, "60m" if reset-from-now */;
export function runExecutionBudgetMs(input): number // task && !selfHeal → 60 min, else 30 min
```

- `runAgentAttempt` (`workflow.ts:583`), right after `runStartedAt`: if
  `ownsAbnormalTerminal(wire)`, call `await ctx.refreshTimeout?.(TASK_LANE_REFRESH)` and log one
  journal line (`run budget: 60m (refreshed)`). Then thread the **effective** budget into
  `runAgentResolved` → `newAbnormalEndState({ runExecutionTimeoutMs: effective })`:
  - the refresh resolved → 60 min;
  - it threw, or `ctx.refreshTimeout` is absent → 30 min, with a journal line
    `run budget: 30m (refresh failed: <class>)`. The SDK's silent no-op when it has no
    `taskRunExternalId` (`context.js:340-343`) is invisible to us. The IT proves the shipped
    shape always has one. The classifier still types a 30-min cancel as `timeout` with the copy
    "30-minute", which is honest.
- `fixCheckDeadline` keeps `REGISTERED_EXECUTION_TIMEOUT_MS`. Self-heal runs never refresh,
  so its deadline stays start + 30 − 1 min (AC2).
- `RUN_EXECUTION_TIMEOUT_MS` in `workflow.ts:954` becomes a re-export of
  `REGISTERED_EXECUTION_TIMEOUT_MS`, or is replaced by it. Its pin test (`workflow.test.ts:1208`)
  keeps asserting registered = `"30m"`. `definition.ts` stays `"30m"`, so `workflow.test.ts:181-200`
  is unchanged.
- `RunCtx` gains the optional `refreshTimeout`. The Hatchet `Context` satisfies it structurally.
- Refresh once, at start. The admission deferral (12 min max) is spent inside the 60 min, leaving
  48 usable minutes.
- **Fallback A** (only if the IT shows the refresh does not hold): `executionTimeout: "60m"` in
  `definition.ts:200`, `TASK_LANE_EXECUTION_TIMEOUT_MS` for every lane, and then rows 17
  (`SUPERSEDE_FRESHNESS_MS` → 105 min), 19 (self-heal lease → 105 min) and the fix-check deadline
  (an explicit 30-min self-heal budget) all move in the same PR. That is a new PR scope: stop and
  re-plan, do not improvise it.

### S3: cell TTL 75 min

- `packages/types/src/cell.ts:100` → `75 * 60 * 1000`. Its doc names the task-lane budget
  (`run-budget.ts`), not `definition.ts:200`.
- `cell-ttl.test.ts` pins `TASK_LANE_EXECUTION_TIMEOUT_MS + 15 min === CELL_RUN_TTL_MS` and
  `REGISTERED_EXECUTION_TIMEOUT_MS < TASK_LANE_EXECUTION_TIMEOUT_MS`. It also keeps a negative
  control. This is valid because cells run plain task runs only
  (`apps/www/src/server-lib/compute/cell-eligibility.ts:5`).
- The step timeout, sandbox TTL, bearer and event token follow automatically
  (`route.ts:223`, `:243`; `cell-authority.ts:574`; `daemon-token.ts:172`). Their tests use the
  constant (rows 7, 8, 10).

### S4: OpenSandbox server cap 5400 s

- `opensandbox-server.toml:15-16` → `5400`, with the comment "≥ CELL_RUN_TTL_MS (75 min = 4500 s)".
- `packages/sandbox/opensandbox-it/config.toml:6` → `5400` (keeps the IT able to create a
  full-TTL cell, and keeps both files in step).
- `container-deploy-assets.test.ts:457-460`: replace `toBe(3600)` with
  `ttl * 1000 >= CELL_RUN_TTL_MS` (AC4). `deploy-assets.test.ts:1037-1041` already enforces it.
- Box step (operator): re-render the server config and restart `automata-opensandbox.service`
  (the runbook in `packages/worker/deploy/README.md` §OpenSandbox). Steps below.

### S5: 4 CPU

- `route.ts:248` → `{ cpu: 4, memoryMiB: 4096 }` (OD-2). Lift it to a named export
  (`CELL_RESOURCES`) so `route.test.ts` asserts `plan.resources` and the provider test asserts
  `"4000m"`/`"4096Mi"` (`opensandbox-cell.ts:827-828`).

### S6: watchdogs, sweeps, comments

- `cron.ts:45` → `105 * 60`, and its doc becomes "30 schedule + 60 task-lane exec + 15".
  `cron.test.ts:114-117` asserts `toBe(105*60)` and `> (30 + 60) * 60`.
- `cycle-finish.ts:31-32` → `75 * 60_000` ("past the task lane's 60-minute cap with slack").
- `config.ts:644-655`: the comment becomes `30 + 60 + margin ≤ 105` and the string becomes
  "105-minute". `config.test.ts:581` regex updated. `admission-retry.ts:18-27`, `:124` and the
  `headroom.test.ts:244` title are text only.
- Comments: `provision.ts:396`, `hello/worker.ts:181` ("a task run is capped at 60 min, every
  other run at 30"), `workflow.ts:587-588`, `cell.ts:95-99`.
- Unchanged by decision: rows 2, 4, 5, 12, 17-23, 25, 27.

### S7: PR body changelog

One line per moved number: 30→60 task lane (refresh), 45→75 cell TTL, 3600→5400 server cap,
2→4 CPU, 75→105 stalled cutoff, 45→75 delivery stale, plus the SDK cache versions.

### OD-3: Flutter SDK pinning in cells

**Recommendation: mechanism (a) without the FVM binary: a sha256-pinned SDK cache in the
batteries image, selected per run by the cell bootstrap through the shim dir that already exists.**

1. **Image (batteries).** A committed list next to the existing pin,
   `ARG FLUTTER_EXTRA_VERSIONS="3.41.2"` plus one `FLUTTER_SHA256_<ver>` each (the same pinning
   rule as `:14-16`). Each one is fetched with `fetch-verified` from the same
   `flutter_infra_release` URL, unpacked to `/opt/flutter-sdks/<ver>`, `chown agent` in the same
   layer (as `:180-182` requires), `git config --system --add safe.directory`, and warmed with
   `flutter --version` and `flutter precache --universal --linux` as agent. The default SDK stays
   at `/opt/flutter`, and `/opt/flutter-sdks/3.47.7` is a symlink to it so selection is uniform.
   `pins.env` gains `FLUTTER_EXTRA_VERSIONS`. Start with **one** extra version (the incident's
   3.41.2). Each extra costs about 2.5 GB unpacked in both daemon stores (section 4).
2. **Verify (batteries `verify.sh`).** For each version in `pins.env`, offline (`--network none`,
   as today): `/opt/flutter-sdks/<ver>/bin/flutter --version` reports `<ver>`, and
   `flutter test` on a fixture package created inline (`flutter create --offline`, or a
   two-file pubspec plus test with only `sdk: flutter` deps) passes. **That is the proof that no
   download happens during a run** (OD-3's requirement). It runs on the writable cell-like
   layout: `-v /opt/flutter-sdks/<ver>` anonymous volume, the same trick as `/opt/flutter`.
3. **Pin resolution (worker, pure).** New `packages/worker/src/agent-run/flutter-sdk.ts`:
   - `detectFlutterRequirementFrom(probe)`: reuses `detectFlutterPinFrom` (`.fvmrc` →
     `.fvm/fvm_config.json`, exact version) and, if there is none, reads `pubspec.yaml`
     `environment.flutter` (line-scoped regex under `environment:`, no YAML dependency). An exact
     version is a pin. A range (`^3.41.0`, `">=3.41.0 <4.0.0"`) is a constraint. `any` or absent
     means none.
   - `selectFlutterSdk(req, available, defaultVersion)`: pin → that version if available, else
     `miss`. Constraint → the default if it satisfies, else the highest available that satisfies,
     else `miss`. Constraint matching adopts `semver` (already in the lockfile; added to
     `packages/worker/package.json`). Dart's constraint syntax for these forms is npm-compatible,
     and unit tests pin each form. Root checkout only, as #558 does.
4. **Cell bootstrap (worker).** In `cell-run.ts` `bootstrap`, after "clone complete" (`:948`)
   and before the first message: one bounded `provider.exec` reads the three marker files (capped
   as `MAX_MARKER_BYTES`), and one `ls /opt/flutter-sdks` lists what the image has. The worker
   decides. On a non-default selection it execs one fixed script with the validated version
   (regex `container-entry.ts:162`) as argv. The script writes
   `~/.automata-run/flutter-pin/{flutter,dart}` wrappers:
   `exec env FLUTTER_ROOT=/opt/flutter-sdks/<v> /opt/flutter-sdks/<v>/bin/<tool> "$@"`. It also
   writes an `fvm` wrapper that maps `fvm flutter|dart …` to the same SDK and refuses every other
   subcommand with a notice, because client scripts often call `fvm flutter`. PATH already
   puts the shim dir first (cell Dockerfile ENV), so the running daemon and agent pick it up with
   no restart. Journal: `cell: flutter <v> (pinned by .fvmrc)` / `(default satisfies pubspec)` /
   `MISS <v> not in image (have …)`.
   - **Fallback on a miss**: keep the image default and write no blocking shim. In a cell the
     agent may still fetch the SDK if the repo's egress allows it, as in the incident. The journal
     line names the missing version, so the operator can add it to `FLUTTER_EXTRA_VERSIONS`.
     The box path keeps its exit-69 behaviour (unchanged).
   - A failure of the exec itself fails open to the default, with a journal line. It never fails
     the run.
5. **Cell image.** After batteries publishes on main: bump `FROM` and the `base.name` label to the
   new batteries digest (`cell-image-assets.test.ts` asserts they are equal). Add a
   `cell/verify.sh` check that `/opt/flutter-sdks/3.41.2/bin/flutter --version` works as uid 10001
   and that the shim dir is still first. That needs a batteries digest that exists only after
   merge, so it ships as a **second PR** (phase 9).

**Alternatives checked**

| Mechanism | Verdict | Why |
|---|---|---|
| (a) FVM binary in the image + `fvm install` of N versions | Rejected as the install path; its CLI surface is kept through the `fvm` wrapper | FVM installs by `git clone` of the Flutter repo: no sha256, which breaks the image's pinning rule (`Dockerfile:14-16`), and needs github.com at build. A non-git tarball as FVM cache is unverified. Adopting FVM later is a follow-up once its offline cache acceptance is measured |
| (a') sha256-pinned SDK cache in the image, shim selection (**recommended**) | Chosen | Fits ADR-013 (everything the run uses is in the digest, built and verified by CI). Holds no credential (ADR-014). No run-time network. Reuses #558 detection, the existing shim dir and the image pipeline. Cost: disk per version |
| (b) bootstrap step in cell-run that downloads the pinned SDK | Rejected | Fails OD-3 ("without downloading it during the run"): it moves minutes and about 1 GB out of the agent but not out of the run budget. It needs `storage.googleapis.com` egress per repo, which #719 OD-1 deliberately keeps out of every bundle (an upload channel to any GCS bucket). Nothing caches between cells |
| (c) shared read-only SDK volume on the box, keyed by version | Rejected for now | Cells cannot bind-mount and have no copy-in (`spec-f.md:113`, `cell.ts:171-180`). It needs a new `CellCreatePlan` field, OpenSandbox 1.2.1 volume support (unmeasured), an ADR-014 amendment and box-side state populated out of band. That state exists on one box only, with no equivalent on a non-box cell provider, and Flutter writes `bin/cache` stamps and locks, so a read-only mount does not run as is. Best disk efficiency: revisit if the SDK list grows past about 3 |

**Out of scope for OD-3**: the box container path using the cache (its read-only rootfs needs
each SDK as a per-run volume copy, about 2.5 GB per cold start). That path keeps its exit-69 shim.
Also out: nested pins in monorepo packages, and Android/iOS artifacts.

## 3. Hatchet IT (OD-1 gate, phase 1)

New `packages/worker/src/agent-run/refresh-timeout.integration.test.ts`. It copies the harness of
`admission-deferral.integration.test.ts:49-191` (compose up, tenant bootstrap, REST trigger, the
stub `fn`, `attempts` map, `statusOf`, `pollUntil`) and registers `buildAgentRunDefinition("agent-run-discard", …)`
with `executionTimeout: "10s"` and `retries: 0` asserted. The stub calls `ctx.refreshTimeout(x)` at
a chosen offset, then sleeps in 200 ms ticks that honour `ctx.cancelled`. Scaled 10 s (not 5 s)
so the engine's timeout poll granularity cannot flip a case.

| Case | Refresh | Runs for | Expect | Proves |
|---|---|---|---|---|
| R0 control | none | 15 s | FAILED, `attempts == [0]` | registered timeout bites at this scale |
| R1 holds | `"20s"` at t≈1 s | 15 s | COMPLETED, `[0]` | a refreshed run outlives its registered timeout (both semantics give ≥ 21 s) |
| R2 semantics | `"10s"` at t≈4 s | 17 s | COMPLETED ⇒ additive (deadline 20 s); FAILED ⇒ reset-from-now (14 s) | which value `TASK_LANE_REFRESH` must be (`"30m"` vs `"60m"`). The test asserts the shipped constant's assumption, so a wrong constant fails |
| R3 no re-execute | `"10s"` at t≈1 s | 60 s | FAILED, then after a 6 s settle `attempts == [0]` | `retries: 0` still never re-executes a timed-out **refreshed** run (#371 fact extended) |
| R4 worker shape | uses the real `RunCtx` adapter path (`ctx.refreshTimeout` from the SDK `Context`) | — | `refreshTimeout` defined, and the SDK's no-`taskRunExternalId` warn never logged | the silent no-op branch (`context.js:340-343`) is not hit |

Record the measured semantics (additive or reset) in `docs/uat/hatchet-lite-v0.94.10-observed.md`.
Add the file to the HATCHET_IT command in `CLAUDE.md` (Verification commands) and in
`.github/workflows/ci.yml`, which lists the same files. `CLAUDE.md`'s table is inside the
harness-managed block, so the PR notes the edit for the next `harness-init` run.

**Gate**: if R1 or R3 fails, stop after phase 1 and take fallback A (section 2).

## 4. Risks

- **Rollout order: cap → www → worker → image** (corrected on the issue 2026-11-21). www first
  gives cells a 75-min TTL, bearer and step while runs are still capped at 30 min, which is
  harmless. The worker's 60-min refresh then lands on cells that already outlive it. Worker
  before www would leave a window where a 60-min run outlives a 45-min cell and dies without a
  typed timeout.
- A stuck task run holds a slot 60 min instead of 30. The stuck-agent stop (#546/#548) is the
  guard.
- 12 CPU limits on 8 cores (1.5× overcommit). This is a quota, not a refusal.
- Bearer and event token live 75 min, still step- and event-scoped.
- **Disk (OD-3).** Each extra SDK adds about 2.5 GB unpacked to the batteries image on the runner
  store (CURRENT + PREVIOUS) and to the cell image in the OpenSandbox store (current + any
  previous). The box disk was already tight (`provision-execution-box.sh:418-421`). Operator:
  `df` both stores before the pre-pull and drop PREVIOUS if `PREVIOUS_MIN_FREE_GB` would be
  breached. That is why the list starts with one version.
- **CI runner disk.** The batteries build already frees the runner disk (`batteries-image.yml:41-49`).
  One more SDK may need a further cleanup step. Watch the `df -h /` lines.
- The `pubspec` constraint reading is a heuristic (line regex, root only). It has unit tests per
  form, and on anything unparsed it falls back to the default.
- If the refresh call fails, the run silently has 30 min. It is journaled, and the copy stays
  truthful.

## 5. Rollout (binding order) and rollback

| Step | What | Who | Rollback |
|---|---|---|---|
| 1 | OpenSandbox server cap 5400: re-render `opensandbox-server.toml` from the merged checkout, restart `automata-opensandbox.service` at an idle moment, confirm a 4500 s create is accepted | Box operator | Leave it (5400 is harmless at a 45-min TTL), or re-render the old file |
| 2 | Worker (refresh, effective budget, Flutter selection; the selection is a no-op until step 4's digest) via `automata-worker-safe-restart` | Box operator (deploy) | Redeploy the previous worker revision: runs fall back to 30 min |
| 3 | www (`CELL_RUN_TTL_MS` 75, 4 CPU, 105-min cutoff, 75-min delivery stale) via `wrangler deploy` | Operator | Redeploy previous www. Steps opened at 75 min keep it (`cell-authority.ts:231`) and expire on their own |
| 4a | Batteries digest (merge → `batteries-image.yml` publishes). Optionally `provision-execution-box.sh --image <digest> --prepare-only` so box runs move too (SDKs unused there) | CI + box operator | `WORKER_BATTERIES_IMAGE` back to PREVIOUS |
| 4b | Cell image PR (phase 9) merges → `cell-image.yml` publishes → pre-pull into the OpenSandbox daemon (cell README PR-G runbook, check `df`) → set `WORKER_OPENSANDBOX_GUEST_IMAGE` in `worker-box.env` and the www secret `OPENSANDBOX_GUEST_IMAGE` → safe-restart the worker | CI + box operator | Set both back to the old digest (keep it pulled), safe-restart |
| 5 | Re-run the incident request as written. Post duration, peak memory and CPU (telemetry #548), plus the journal's `cell: flutter …` line, on #742 | Person / operator | — |

Code steps are 2, 3, 4a's build and 4b's build. Box operator steps are 1, the 4a provision, the
4b pre-pull, env, secret and restart, and 5.

## 6. Tests per acceptance criterion

| AC | Tests |
|---|---|
| 1 | IT R0, R1, R3 (engine). `run-budget.test.ts`: task → 60, task+selfHeal → 30, pr → 30, review → 30, and refresh is called only for `ownsAbnormalTerminal`. `workflow.test.ts`: the run fn calls `ctx.refreshTimeout(TASK_LANE_REFRESH)` once for a task input and never for review, pr or self-heal (stub ctx) |
| 2 | `abnormal-end.test.ts` (existing, with `LIMIT_MS`) plus a `workflow.test.ts` case: the effective 60 min reaches `newAbnormalEndState`, and a cancel at 60 min gives `timeout` with "reached its 60-minute limit". Refresh rejected → 30 min. `fixCheckDeadline` pin (`workflow.test.ts:1204-1205`) unchanged: start + 30 − 1 min |
| 3 | `cell-ttl.test.ts` (task-lane + 15 = 75, negative control). `route.test.ts:253`, `:266-267`; `cell-create-plan.test.ts:332-340`; `cell-event-token.integration.test.ts:267-268` stay green on the constant |
| 4 | `deploy-assets.test.ts:1037-1041`; `container-deploy-assets.test.ts` (`>= CELL_RUN_TTL_MS/1000`, IT config keys equal); step 1 live check |
| 5 | `route.test.ts`: `plan.resources` equals `{cpu: 4, memoryMiB: 4096}`. `opensandbox-cell` provider test: body `resourceLimits` `{cpu: "4000m", memory: "4096Mi"}` |
| 6 | `cron.test.ts` (105 min, > 90 min). `cycle-finish.test.ts` (on the constant) plus an assertion `DELIVERY_RUN_STALE_MS > TASK_LANE_EXECUTION_TIMEOUT_MS` (www may import the constant from the worker only if a dependency already exists; otherwise a literal 60 min with a comment pointing at `run-budget.ts`) |
| 7 | `config.test.ts:581` (11 deferrals refused, message names "105-minute"); `headroom.test.ts:244-262` |
| 8 | A grep run in the acceptance gate: `rg -n "30.minute hard cap\|hard-capped at 30\|30-minute hard" packages apps` returns nothing |
| 9 | Live re-run (rollout step 5), evidence posted on #742 |
| OD-3 | `flutter-sdk.test.ts`: `.fvmrc` wins over `fvm_config.json` wins over pubspec. Exact pubspec version gives a pin. `^3.41.0`, `>=3.41.0 <4.0.0` and `any` each map as designed. Default-satisfies, highest-satisfying, miss, junk version (regex refusal). `cell-run.test.ts`: after clone, a pinned repo with the SDK present execs the wrapper script with the version argv, logs the journal line, and the wrapper text sets `FLUTTER_ROOT`. Miss → no script, MISS line. Exec failure → run continues. Batteries `verify.sh`: offline `flutter --version` plus `flutter test` per cached version (CI). `cell/verify.sh`: pinned SDK runs as uid 10001 (phase 9 CI) |

Gates after the last phase: `pnpm turbo tsc-check --force`, `lint`, `format-check`, and the
worker, www, shared and sandbox vitest suites, plus the HATCHET_IT suite (with the new file) and
its compose teardown.

## 7. Phases

Each phase leaves `pnpm turbo tsc-check --force`, `pnpm turbo lint` and the touched vitest files
green. At most 5 files are changed per phase, tests included.

```yaml
phases:
  - id: 1
    name: "OD-1 gate: refreshTimeout IT on hatchet-lite v0.94.10"
    files:
      - packages/worker/src/agent-run/refresh-timeout.integration.test.ts   # new, cases R0-R4
      - docs/uat/hatchet-lite-v0.94.10-observed.md                           # measured semantics
      - CLAUDE.md                                                            # HATCHET_IT list
      - .github/workflows/ci.yml                                             # HATCHET_IT list
    verify: "HATCHET_IT=1 pnpm --filter @terragon/worker exec vitest run --no-file-parallelism src/agent-run/refresh-timeout.integration.test.ts; then the compose teardown"
    exit: "R1 and R3 pass -> continue with D; else stop, re-plan fallback A"
  - id: 2
    name: "Per-lane run budget in the worker (S1, S2)"
    files:
      - packages/worker/src/agent-run/run-budget.ts          # new: constants, resolver, TASK_LANE_REFRESH from phase 1
      - packages/worker/src/agent-run/run-budget.test.ts     # new
      - packages/worker/src/agent-run/run-admission.ts       # RunCtx.refreshTimeout?
      - packages/worker/src/agent-run/workflow.ts            # refresh at runAgentAttempt, effective budget, mirror, TMO-01 comment
      - packages/worker/src/agent-run/workflow.test.ts       # refresh called per lane, effective budget, mirror pin
    note: "CELL_RUN_TTL_MS is still 45 min and cell-ttl.test still compares the registered 30 min: green"
  - id: 3
    name: "Cell TTL 75 min + server cap 5400 (S3, S4)"
    files:
      - packages/types/src/cell.ts
      - packages/worker/src/agent-run/cell-ttl.test.ts
      - packages/worker/deploy/linux/opensandbox-server.toml
      - packages/sandbox/opensandbox-it/config.toml
      - packages/worker/src/agent-run/container-deploy-assets.test.ts
    verify: "worker vitest cell-ttl, deploy-assets, container-deploy-assets; shared cell-create-plan; www route.test (constant-based, untouched)"
  - id: 4
    name: "www: 4 CPU, stalled cutoff 105, delivery stale 75 (S5, S6 www half)"
    files:
      - apps/www/src/app/api/daemon/cell-plan/route.ts
      - apps/www/src/app/api/daemon/cell-plan/route.test.ts
      - apps/www/src/server-lib/cron.ts
      - apps/www/src/server-lib/cron.test.ts
      - apps/www/src/server-lib/delivery/cycle-finish.ts
  - id: 5
    name: "Worker boot inequality text + stale comments (S6 worker half, AC7, AC8)"
    files:
      - packages/worker/src/agent-run/config.ts
      - packages/worker/src/agent-run/config.test.ts
      - packages/worker/src/agent-run/admission-retry.ts
      - packages/worker/src/agent-run/provision.ts
      - packages/worker/src/hello/worker.ts
    note: "headroom.test.ts:244 describe title and the opensandbox-cell provider resources assertion (AC5) go in phase 6 if this phase is full"
  - id: 6
    name: "Provider resources assertion + headroom title (AC5, AC7 tidy)"
    files:
      - packages/sandbox/src/providers/opensandbox-cell.test.ts
      - packages/worker/src/agent-run/headroom.test.ts
      - apps/www/src/server-lib/delivery/cycle-finish.test.ts   # DELIVERY_RUN_STALE_MS > 60 min
  - id: 7
    name: "OD-3 image: pinned SDK cache in batteries"
    files:
      - deploy/images/batteries/Dockerfile      # FLUTTER_EXTRA_VERSIONS + sha256 ARGs, /opt/flutter-sdks, pins.env
      - deploy/images/batteries/verify.sh       # offline flutter --version + flutter test per version
      - deploy/images/batteries/README.md       # the cache, how to add a version, disk cost
    verify: "batteries-image.yml on the PR (build + verify.sh); no TS touched"
  - id: 8
    name: "OD-3 worker: pin resolution + cell bootstrap selection"
    files:
      - packages/worker/src/agent-run/flutter-sdk.ts        # new: requirement detection (reuses detectFlutterPinFrom), selection, wrapper script
      - packages/worker/src/agent-run/flutter-sdk.test.ts   # new
      - packages/worker/src/agent-run/cell-run.ts           # bootstrap: read markers, ls /opt/flutter-sdks, exec wrapper script, journal
      - packages/worker/src/agent-run/cell-run.test.ts
      - packages/worker/package.json                        # + semver (pnpm-lock.yaml regenerates: 6th file, lockfile only)
    note: "the lockfile is a generated companion of package.json; if the reviewer counts it, move package.json + lockfile + the semver use to a phase 8a and keep the constraint matcher behind an injected function in 8"
  - id: 9
    name: "OD-3 cell image bump (SECOND PR, after phase 7's batteries digest is published on main)"
    files:
      - deploy/images/cell/Dockerfile           # FROM + base.name label = new batteries digest
      - deploy/images/cell/verify.sh            # pinned SDK runs as uid 10001; shim dir first
      - deploy/images/cell/README.md            # Flutter pin section: PR-E now writes selection shims
    verify: "cell-image.yml on the PR; worker vitest cell-image-assets.test.ts (FROM == label)"
```

## 8. Definition of done (spec-level)

- PR 1 (phases 1-8) and PR 2 (phase 9) merged by the person. Rollout steps 1-4b done in order.
- The IT's measured refresh semantics are recorded in the observed-facts doc.
- Step 5 evidence is posted on #742.
- Follow-ups filed if the re-run shows them: OD-2 (lane weight or memory), OD-4 (foreground
  `flutter test` killed), more SDK versions (MISS lines), the box container path using the cache.

---

## 9. Validator amendments (2026-11-21, verdict BLOCK → fixes applied)

Binding on the implementation; they override §1–§8 where they differ.

- **F1 rollout and rollback.** Rollout is cap → **www** → **worker** → image. Rollback runs in reverse:
  worker before www, www before the cap. Rolling www back while the worker still refreshes to 60
  minutes recreates the case where a run outlives a 45-minute cell.
- **F2 phase order.** Phase 1 creates `run-budget.ts` with the constants only (`TASK_LANE_BUDGET`,
  `TASK_LANE_REFRESH`), set from the semantics the IT measures. Phase 2 adds the resolver.
- **F3 worker stop deadline (owner: raise it).** In `automata-worker.service`, the `ExecStop`
  drain becomes `--timeout-s 4200` and `TimeoutStopSec` becomes `4500`. The
  `automata-worker-safe-restart` default drain becomes 75 minutes. `deploy-assets.test.ts:693-698` and
  `:729-731` move with it, and the README updates. This is its own phase (6b). Rollout step "worker"
  re-renders the unit on the box (`daemon-reload`).
- **F4 lane test.** Use `resolveRunLane(wire) === "task" && wire.selfHeal === undefined` on the wire
  input, in `run-budget.ts`. `ownsAbnormalTerminal(wire)` does not type-check
  (`SelfHealWireShape` vs `SelfHealRunShape`).
- **F5 semver.** Add `semver` and `@types/semver` to `packages/worker`. Phase 8 splits into 8a (pure
  pin resolution plus deps and lockfile) and 8b (cell bootstrap).
- **F6 bounded refresh.** `ctx.refreshTimeout` races a 10 s timer. A timeout, a rejection or a
  missing context logs one line (`run budget: refresh failed, staying at 30m`) and continues at 30
  minutes. The run is never failed on it.
- **F7 no unpinned precache.** Drop `flutter precache --universal --linux`. A baked SDK runs only
  `flutter --version`, like the default SDK, and fetches the rest with sha256 pins, or not at all.
- **F8 offline proof.** `verify.sh` warms a committed fixture (`pubspec.yaml` and `pubspec.lock`,
  `flutter_test` only) at build time for each baked version. It then runs `flutter test` on it with
  `--network none`. That proves the SDK needs no download, and pub resolves from the warmed
  `PUB_CACHE`.
- **F9 a missing SDK (owner: keep the default and log it).** When the pinned version is not baked,
  the cell keeps `/opt/flutter` and logs `cell: flutter pin <ver> not in the image; using <default>`
  (version text through a safe-version check, never raw). This **differs on purpose** from the box's
  exit-69 notice shim (#565). The owner wants a cell run to keep working on the default SDK rather
  than stop. The agent's `CLAUDE.md` note tells it which SDK it got, so its report can say so.
- **F10 wrapper and scope.** The wrapper is inline `bash -c '<text>' -- <ver>` from worker source,
  with no file in the image, so phase 8b does not depend on phase 9. Marker files are read with the
  existing `provider.copyOut` (absent counts as no pin). Reading the `pubspec.yaml` constraint is
  **cell-only**: the box path keeps `detectFlutterPinFrom` and its exit-69 shim unchanged. Moving the
  box onto baked SDKs is a follow-up.

Warnings taken:
- `FLUTTER_ROOT=/opt/flutter` stays in the daemon env, so tools that read it bypass the shim. This
  is a known limit, recorded here.
- R4 folds into R1.
- AC-8's grep also covers `stop-thread.ts:21`, `www-client.ts:827` and the `opensandbox-server.toml`
  comment.
- Phase 9's `FROM` bump pulls in every batteries change since the cell's current base; the PR lists
  that diff.

Final phases (each ≤ 5 files):
1. OD-1 gate IT: `refresh-timeout.integration.test.ts`, `run-budget.ts` (constants only),
   `docs/uat/hatchet-lite-v0.94.10-observed.md`, `CLAUDE.md`, `ci.yml`. Exit: R1 and R3 pass, else
   re-plan fallback A.
2. Per-lane budget: `run-budget.ts`, `run-budget.test.ts`, `run-admission.ts`, `workflow.ts`,
   `workflow.test.ts`.
3. Cell TTL 75 and cap 5400: `packages/types/src/cell.ts`, `cell-ttl.test.ts`,
   `opensandbox-server.toml`, `packages/sandbox/opensandbox-it/config.toml`,
   `container-deploy-assets.test.ts`.
4. www: `cell-plan/route.ts`, `route.test.ts`, `cron.ts`, `cron.test.ts`, `cycle-finish.ts`.
5. Boot inequality and comments: `config.ts`, `config.test.ts`, `admission-retry.ts`, `provision.ts`,
   `hello/worker.ts`.
6. Assertions and remaining comments: `opensandbox-cell.test.ts`, `headroom.test.ts`,
   `cycle-finish.test.ts`, `stop-thread.ts`, `www-client.ts`.
6b. Worker stop deadline: `automata-worker.service`, `automata-worker-safe-restart`,
   `deploy-assets.test.ts`, `packages/worker/deploy/README.md`.
7. Batteries SDK cache: `deploy/images/batteries/Dockerfile`, `verify.sh`, `README.md`, the fixture
   (`pubspec.yaml` and `pubspec.lock`).
8a. Pin resolution (pure): `packages/worker/package.json`, `pnpm-lock.yaml`, `flutter-sdk.ts`,
   `flutter-sdk.test.ts`.
8b. Cell bootstrap: `cell-run.ts`, `cell-run.test.ts`.
9. Second PR, after the batteries digest is on main: `deploy/images/cell/Dockerfile`,
   `cell/verify.sh`, `cell/README.md`.
