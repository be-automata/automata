# Spec #622 — one `@terragon/utils/fix-branch` module for the self-heal fix-branch name

Source of truth: GitHub issue be-automata/automata#622 (body below, verbatim; decision record `Verdict: READY ON DEFAULTS` in the run state). Branch `refactor/622-fix-branch-module` off main `8ebffabe`.

## Ticket

Follow-up to #620 / #621. #621 merged as `8ebffabe`, so this goes on `main` and is not stacked. The `automata/fix-` prefix and the name builder are defined in shared, www and the worker. Two source-text drift tests hold the copies together, and the worker test cannot call the real builder. This ticket moves them into one pure utils module that all three planes import.

### Reality check on be-automata/automata@8ebffabe

| What                                                                 | Where                                                                                                                                                                                                        |
| :------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FIX_BRANCH_PREFIX`                                                  | `packages/shared/src/self-heal/fix-paths.ts:14`. The header (`:5`) says "no imports at all"                                                                                                                  |
| `WORKER_FIX_BRANCH_PREFIX` mirror                                    | `packages/worker/src/agent-run/workflow.ts:822`                                                                                                                                                              |
| `FIX_SUFFIX_SHAPE` (local), `selfHealRefFence`                       | `workflow.ts:830`, `:840-855`                                                                                                                                                                                |
| `FINGERPRINT_RE` (private), `assertPositiveInteger`, `fixBranchName` | `apps/www/src/server-lib/audit/fix-run-prompt.ts:38,42-46,49-60`                                                                                                                                             |
| Builder callers                                                      | `fix-run-prompt.ts:116`, `plan-self-heal-run.ts:397-404` (throws `attempt branch does not match fixBranchName`), `self-heal-dispatcher.ts:647`                                                               |
| Prefix callers                                                       | `handlers.ts:1209`, `evaluate-fix-ci.ts:845`, `fix-pr-lifecycle.ts:681`, `deploy/self-heal-bench/verify-fixes.ts:56` (a relative import, run with tsx)                                                       |
| Drift tests                                                          | `workflow.test.ts:890-898` (source text, from #621) and `:917-924` (prefix)                                                                                                                                  |
| Literals kept on purpose                                             | `review-skill.ts:532` (pinned by `skill-contract-drift.test.ts:299`); `packages/worker/deploy/linux/self-heal-acceptance.sh:382,524`                                                                         |
| Name clash                                                           | `packages/shared/src/model/knowledge-minimize.ts:27` exports a different `FINGERPRINT_RE` (`{16}`)                                                                                                           |
| abnormal-end                                                         | `abnormal-end.ts` has no fix-prefix logic. Not affected                                                                                                                                                      |
| Dependencies                                                         | shared, www and the worker already depend on `@terragon/utils` (`package.json:45/69/37`). Utils `exports` is an explicit map; `package-exports.test.ts` checks that every entry exists and pins some of them |
| Plane rule                                                           | `worker/src/agent-run/types.ts:4-10` forbids www imports. The worker already imports `@terragon/utils/receive-pack-refs`                                                                                     |

**Found while checking:** `Number.isInteger(1e21)` is true, so the builder returns `automata/fix-1e+21-…`, which `FIX_SUFFIX_SHAPE` rejects. Real issue numbers never reach this. It matters only once a property test runs the real builder (see OD3).

### Contract

`packages/utils/src/fix-branch.ts`: no imports, exported as `"./fix-branch"`.

```ts
export const FIX_BRANCH_PREFIX = "automata/fix-";
export const FIX_FINGERPRINT_RE: RegExp; // /^[0-9a-f]{8,}$/
export interface FixBranchNameInput {
  issueNumber: number;
  fingerprint: string;
  attemptNo: number;
}
export function fixBranchName(input: FixBranchNameInput): string; // same checks and messages
```

- shared `fix-paths.ts` re-exports the prefix, and its header is updated.
- www `fix-run-prompt.ts` imports and re-exports the builder and its input type. It deletes its local regex, assert and builder.
- The worker imports the prefix and deletes `WORKER_FIX_BRANCH_PREFIX`.
- Both drift tests and `readSource` are deleted.

### Acceptance Criteria

- **AC1** Output is byte-identical to `main` for issues {1, 9, 10, 12, 99999, 2147483647, `MAX_SAFE_INTEGER`} × fingerprints {`00000000`, `ffffffff`, `deadbeef`, `0123abcd`, 64-hex} × attempts {1, 2, 9, 10, 99999}.
- **AC2** Same error messages (`fix run issue number|attempt number must be a positive integer, got <v>`, `fix run fingerprint must be lowercase hex (>= 8 chars)`) for 0, -1, 1.5, NaN, `../x`, `DEADBEEF` and `abc`.
- **AC3** The existing `plan-self-heal-run` and dispatcher tests pass unchanged.
- **AC4** `git grep 'readSource\|WORKER_FIX_BRANCH_PREFIX' packages/worker` returns nothing.
- **AC5** The worker test runs the real `fixBranchName` over the AC1 table, and every result gets `{exactRef: "refs/heads/<name>"}` from `selfHealRefFence`.
- **AC6** `utils/src/fix-branch.test.ts` owns AC1 and AC2. `package-exports.test.ts` pins `./fix-branch`.
- **AC7** No new dependency edges. The worker imports nothing new from www or shared.
- **AC8** `verify-fixes.ts` still loads under tsx. _Not verified._

### Tests

```bash
pnpm --filter @terragon/utils exec vitest run --no-file-parallelism src/fix-branch.test.ts src/package-exports.test.ts
pnpm --filter @terragon/shared exec vitest run --no-file-parallelism src/self-heal/fix-paths.test.ts
pnpm --filter @terragon/www exec vitest run --no-file-parallelism src/server-lib/audit/fix-run-prompt.test.ts src/server-lib/audit/plan-self-heal-run.test.ts src/server-lib/review/skill-contract-drift.test.ts src/agent/hatchet/dispatch.test.ts
pnpm --filter @terragon/worker exec vitest run --no-file-parallelism src/agent-run/workflow.test.ts
pnpm turbo tsc-check && pnpm turbo lint
```

### Open decisions

- **OD1. Where `FIX_SUFFIX_SHAPE` lives.** Default: it stays in the worker as the fence's own looser rule. Blocks implementation: no.
- **OD2. Compatibility re-exports.** Default: keep the shared and www re-exports, so the call sites stay untouched. Blocks implementation: no.
- **OD3. The `1e21` case: decided by the owner (2026-11-15).** Stay byte-identical, keep AC1 and AC5 at or below `MAX_SAFE_INTEGER`, and file a follow-up to bound issue and attempt numbers to safe integers.
- **OD4. Name.** Default: `FIX_FINGERPRINT_RE`, to avoid the knowledge-minimize clash. Blocks implementation: no.
- **Order relative to #621.** Settled: #621 is merged.

### UAT (T0 local)

1. Run the Tests block. Everything passes.
2. Run `git grep -n '"automata/fix-"' -- '*.ts' ':!*.test.ts'`. It lists only `fix-branch.ts` and `review-skill.ts`.
3. In `packages/utils`, import `fixBranchName` with `pnpm exec tsx -e` and call it with `{issueNumber:42, fingerprint:"0123456789abcdef", attemptNo:2}`. It returns `automata/fix-42-01234567-a2`.

_(Ticket headings demoted one level to nest under this section; text unchanged.)_

## Decisions

Decision record: `Verdict: READY ON DEFAULTS` (2026-11-15).

- **OD3: decided by the owner (blocking).** The move is byte-identical: same output, same checks in the same order, same error text. AC1 and AC5 stay at or below `Number.MAX_SAFE_INTEGER`. Bounding issue and attempt numbers to safe integers (the `1e21` → `automata/fix-1e+21-…` case) is **#623**, not this ticket. Do not add a `Number.isSafeInteger` check here.
- **OD1: default.** `FIX_SUFFIX_SHAPE` stays worker-local in `workflow.ts`, as the fence's own looser rule. It is not moved to utils.
- **OD2: default.** Keep the compatibility re-exports: shared `fix-paths.ts` re-exports `FIX_BRANCH_PREFIX`; www `fix-run-prompt.ts` re-exports `fixBranchName` and `FixBranchNameInput`. No caller import changes in www or shared.
- **OD4: default.** The regex is named `FIX_FINGERPRINT_RE`, to avoid the clash with `knowledge-minimize.ts:27`'s `FINGERPRINT_RE` (`/^[0-9a-f]{16}$/`).

## Ground truth (verified at 8ebffabe on 2026-11-15)

Re-read in this worktree (`git log -1` = `8ebffabe0b5f5e867fbc0a5ecebf71a40a8b6733`, branch `refactor/622-fix-branch-module`, clean). Every file:line in the ticket's reality check holds. Refinements are marked **precise**; additions the ticket does not list are marked **addition**.

### Reality-check table, re-verified

| Ticket ref                                                                                    | Status                                                                                                  |
| :-------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------ |
| `fix-paths.ts:14` `FIX_BRANCH_PREFIX`; header `:5` "no imports at all"                        | holds (header is `:1-11`, the phrase is on `:5`)                                                        |
| `workflow.ts:822` `WORKER_FIX_BRANCH_PREFIX`                                                  | holds (doc comment `:818-821`)                                                                          |
| `workflow.ts:830` `FIX_SUFFIX_SHAPE`, `:840-855` `selfHealRefFence`                           | holds (fn `:840-854`, closing brace `:854`; doc `:832-839`)                                             |
| `fix-run-prompt.ts:38,42-46,49-60`                                                            | holds (`FixBranchNameInput` `:32-36`; builder doc comment `:48`)                                        |
| `fix-run-prompt.ts:116`, `plan-self-heal-run.ts:397-404`, `self-heal-dispatcher.ts:647`       | holds                                                                                                   |
| `handlers.ts:1209`, `evaluate-fix-ci.ts:845`, `fix-pr-lifecycle.ts:681`, `verify-fixes.ts:56` | holds (`handlers.ts` import `:38`, `evaluate-fix-ci.ts` `:20`, `fix-pr-lifecycle.ts` `:24`)             |
| `workflow.test.ts:890-898` and `:917-924`                                                     | holds; `readSource` is `:880-884`                                                                       |
| `review-skill.ts:532`, `skill-contract-drift.test.ts:299`, `self-heal-acceptance.sh:382,524`  | holds                                                                                                   |
| `knowledge-minimize.ts:27`                                                                    | holds                                                                                                   |
| `package.json:45/69/37`                                                                       | holds (shared `:45`, www `:69`, worker `:37`, all `"@terragon/utils": "workspace:*"` in `dependencies`) |
| `types.ts:4-10` plane rule; worker imports `receive-pack-refs`                                | holds (`workflow.ts:3`, `git-broker.ts`)                                                                |
| `abnormal-end.ts` no fix-prefix logic                                                         | holds (no `fix-` / `FIX_` match)                                                                        |

### Current code, byte for byte (`apps/www/src/server-lib/audit/fix-run-prompt.ts`)

```ts
// :1-9
import type { DBUserMessage } from "@terragon/shared";
import type { AuditFindingRow } from "@terragon/shared/model/audit-findings";
import {
  FIX_BRANCH_PREFIX,
  FIX_DENY_PATHS,
  allowedFilesFor,
  denyExceptionsFor,
  isDeniedPath,
} from "@terragon/shared/self-heal/fix-paths";

// :32-60
export interface FixBranchNameInput {
  issueNumber: number;
  fingerprint: string;
  attemptNo: number;
}

const FINGERPRINT_RE = /^[0-9a-f]{8,}$/;
/** A plain branch name: no spaces, backticks, newlines or `..`. */
const REF_NAME_RE = /^[A-Za-z0-9._/-]+$/;

function assertPositiveInteger(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`fix run ${what} must be a positive integer, got ${value}`);
  }
}

/** `automata/fix-<issue>-<fp8>-a<attempt>` — one branch per attempt. */
export function fixBranchName({
  issueNumber,
  fingerprint,
  attemptNo,
}: FixBranchNameInput): string {
  assertPositiveInteger(issueNumber, "issue number");
  assertPositiveInteger(attemptNo, "attempt number");
  if (!FINGERPRINT_RE.test(fingerprint)) {
    throw new Error("fix run fingerprint must be lowercase hex (>= 8 chars)");
  }
  return `${FIX_BRANCH_PREFIX}${issueNumber}-${fingerprint.slice(0, 8)}-a${attemptNo}`;
}
```

- Check order: issue number, then attempt number, then fingerprint. An input with two bad fields throws the first one's message. Keep the order.
- **Addition: `REF_NAME_RE` (`:40`) stays in www.** It guards `baseBranch` in `renderFixSection` (`:103`), not the builder. Only `FINGERPRINT_RE`, `assertPositiveInteger` and `fixBranchName` move. `FIX_BRANCH_PREFIX` stays imported in `fix-run-prompt.ts` only if something else in the file still uses it. Today the builder is its only use (`:59`), so drop it from the `:3-9` import list after the move (lint `noUnusedLocals`).
- **Addition: measured baseline on main** (tsx over the real builder, unsandboxed). The AC1 table (7 issues × 5 fingerprints, the 64-hex one being `"0123456789abcdef".repeat(4)`, × 5 attempts) gives 175 names. First `automata/fix-1-00000000-a1`, last `automata/fix-9007199254740991-01234567-a99999`. sha256 of the names joined by `\n`, in issue → fingerprint → attempt loop order: `f4cc7c43183ea8fd60096fd24d920c604dd481d09450f8597279aaf4983f8524`. The AC2 inputs give exactly these messages:
  - `fix run issue number must be a positive integer, got 0` (also `-1`, `1.5`, `NaN`)
  - `fix run attempt number must be a positive integer, got 0` (also `-1`, `1.5`, `NaN`)
  - `fix run fingerprint must be lowercase hex (>= 8 chars)` for `../x`, `DEADBEEF`, `abc`

### Current code in shared and the worker

- `packages/shared/src/self-heal/fix-paths.ts:1-14`:

  ```ts
  /**
   * Self-heal fix lane path policy (phase 9) — THE one definition of which files
   * a fix run may change and which it may never touch.
   *
   * Dependency-free on purpose (no imports at all): the www fix prompt, the www
   * compare-diff guard and — through a drift-tested mirror — the worker's
   * pushed-diff check all read this module, and the deploy tsx scripts can load
   * it without alias resolution. The prompt is advice to a well-behaved agent;
   * the worker and www checks are the enforcement, and they must agree with the
   * prompt byte for byte, which is why the list lives here and nowhere else.
   */

  /** Every fix branch starts with this; the git-broker ref fence accepts nothing else. */
  export const FIX_BRANCH_PREFIX = "automata/fix-";
  ```

- `packages/worker/src/agent-run/workflow.ts:818-854`: the `WORKER_FIX_BRANCH_PREFIX` mirror (`:822`) with its comment "the worker does not depend on shared; a drift test in workflow.test.ts pins the two together" (`:818-821`), `FIX_SUFFIX_SHAPE` (`:830`), and `selfHealRefFence`, which uses the prefix three times (`:845`, `:846`, and the error text at `:850`: `` `self-heal fix run: branch is not a ${WORKER_FIX_BRANCH_PREFIX}* branch name` ``). `isBranchRef` is already imported at `:3`, next to `@terragon/utils/payload-seal` at `:2`.

### Every importer and user, repo-wide (`git grep`)

`FIX_BRANCH_PREFIX`:

- source: `fix-paths.ts:14` (definition); `fix-run-prompt.ts:4,59`; `handlers.ts:38,1209`; `evaluate-fix-ci.ts:20,845`; `fix-pr-lifecycle.ts:24,681`; `deploy/self-heal-bench/verify-fixes.ts:56,328` (relative `../../packages/shared/src/self-heal/fix-paths`).
- tests: `packages/shared/src/self-heal/fix-paths.test.ts:4,14`; `apps/www/src/server-lib/audit/fix-run-prompt.test.ts:6,63,69` (imports it from `@terragon/shared/self-heal/fix-paths`); `apps/www/src/server-lib/review/skill-contract-drift.test.ts:20,299-301`.
- comments only: `review-skill.ts:519-520` ("not imported, so this module stays importable by deploy tsx scripts"), `verify-fixes.ts:11`.

`fixBranchName` (all through `fix-run-prompt.ts`, which keeps the re-export):

- source: `plan-self-heal-run.ts:28,397,403`; `self-heal-dispatcher.ts:45,647`.
- tests: `fix-run-prompt.test.ts:13,56-82`; `plan-self-heal-run.test.ts:28,234,314`; `apps/www/src/agent/hatchet/dispatch.test.ts:58,2126` (via `@/server-lib/audit/fix-run-prompt`).
- comments: `plan-self-heal-run.ts:75`; **addition** `packages/shared/src/model/audit-fix-attempts.ts:74` ("fixBranchName in www"; update to name `@terragon/utils/fix-branch`, optional).

`FixBranchNameInput`: only `fix-run-prompt.ts:32,53`. No other importer.

`FINGERPRINT_RE`: `fix-run-prompt.ts:38,56` (private) and the unrelated `knowledge-minimize.ts:27,310,325`.

`WORKER_FIX_BRANCH_PREFIX`: `workflow.ts:822,845,846,850`, and **addition** `workflow.test.ts:77` (`let WORKER_FIX_BRANCH_PREFIX: string;`) and `:89` (`WORKER_FIX_BRANCH_PREFIX = mod.WORKER_FIX_BRANCH_PREFIX;`). Both test lines must go too for AC4.

`readSource` in the worker: only `workflow.test.ts:881,891,920`. (Repo-wide hits for `ThreadSource…` are a different identifier; AC4's grep is scoped to `packages/worker`, where `ThreadSource` does not appear.)

Literal `"automata/fix-"` in non-test `.ts` today: `review-skill.ts:532`, `fix-paths.ts:14`, `workflow.ts:822`. After the change: `review-skill.ts:532` and `packages/utils/src/fix-branch.ts` only (UAT step 2).

### The two drift tests and `readSource` (`packages/worker/src/agent-run/workflow.test.ts`)

Inside `describe("selfHealRefFence (FENCE-01 wiring)")` (`:836-925`):

- `:880-884` the `readSource` helper (`fs.readFile(new URL(rel, import.meta.url), "utf8")`).
- `:886-915` `describe("documented fix-name shape (the fence accepts it; this does not exercise fixBranchName)")`:
  - `:887-888` a local `generated(issue, fp8, attempt)` that builds the name by hand;
  - `:890-898` the source drift test, which reads `fix-run-prompt.ts` and matches the template and `const FINGERPRINT_RE = /^[0-9a-f]{8,}$/;` (**delete**);
  - `:900-914` the table over 7 issues × 4 fp8 × 5 attempts, run through `generated` (**rewrite** to call the real `fixBranchName`, AC5).
- `:917-924` the prefix drift test, which reads `../../../shared/src/self-heal/fix-paths.ts` and expects `` `export const FIX_BRANCH_PREFIX = "${WORKER_FIX_BRANCH_PREFIX}";` `` (**delete**). After the move this text no longer exists in `fix-paths.ts`, so it would fail anyway.
- Keep `:847-878` (golden mapping, no-fence cases, fail-closed list) unchanged.
- Baseline: `workflow.test.ts` passes **55/55** at 8ebffabe.

### How `packages/utils` declares subpath exports

- `packages/utils/package.json:6-17` is an explicit `exports` map of string targets (`"./<name>": "./src/<name>.ts"`), ten entries today, the last being `"./broker-headers": "./src/broker-headers.ts"` (`:16`). `"type": "module"`. No build step: consumers load the `.ts` source. The only runtime dependency is `graphql`.
- `packages/utils/src/package-exports.test.ts` (50 lines) reads the manifest, and:
  - `it.each` over every entry checks that the target file exists (`:38-45`);
  - one pin: `expect(exportsMap["./run-lane"]).toBe("./src/run-lane.ts")` (`:47-49`).
    Baseline **11/11**. Add `"./fix-branch": "./src/fix-branch.ts"` to the map and a second pin `it` in the same style (AC6). Expected after: 13.
- Symlinks exist: `packages/{shared,worker}/node_modules/@terragon/utils` and `apps/www/node_modules/@terragon/utils` all point at `packages/utils`. **No `package.json` dependency change and no lockfile change.**

### `verify-fixes.ts`, tsx, and the "no imports" header (AC8: now verified)

- `deploy/self-heal-bench/verify-fixes.ts` runs as `pnpm exec tsx deploy/self-heal-bench/verify-fixes.ts …` from the repo root (its own header `:5` and `USAGE` `:70`; `deploy/PILOT-RUNBOOK.md:1884`). No CI job runs it. Its tsx process opens an IPC pipe, so a sandboxed run fails with `listen EPERM …/tsx-501/*.pipe`. Run it unsandboxed.
- Unsandboxed, with no arguments, it **loads today**: it prints `USAGE` and exits 1 (`runMain`). That is the load check for AC8: after the change, the same command must still print `USAGE`, with no `ERR_MODULE_NOT_FOUND` / `Cannot find package`.
- **It already loads workspace subpaths transitively.** `verify-fixes.ts:46` imports `apps/www/src/server-lib/audit/suppression-guard.ts`, which imports `@terragon/shared/self-heal/fix-paths` and `@terragon/shared/self-heal/guard-reasons` (`:1-12`). Node resolves a bare specifier from the importing file's location, so those come through `apps/www/node_modules/@terragon/shared`. "Without alias resolution" in the header means no `@/` tsconfig alias, not "no workspace packages".
- Measured resolution of `@terragon/utils/receive-pack-refs` (an existing subpath), unsandboxed:
  - `createRequire(<file>).resolve(...)` under tsx resolves to `packages/utils/src/receive-pack-refs.ts` from `packages/shared/src/self-heal/fix-paths.ts`, `packages/worker/src/agent-run/workflow.ts`, `apps/www/src/server-lib/audit/fix-run-prompt.ts` and `deploy/self-heal-bench/verify-fixes.ts`;
  - a throwaway probe file in `deploy/self-heal-bench/` that imports it ran under tsx (also from cwd `/tmp`); the probe was deleted at once and the tree is clean;
  - **but plain Node fails from `deploy/`** (`MODULE_NOT_FOUND` via `createRequire`, and `import.meta.resolve` throws): there is no `node_modules/@terragon` at the repo root or under `deploy/`. The deploy-dir import works only through tsx's resolver, by a mechanism not pinned down here. From `packages/shared/src/…` it resolves by plain Node rules, through the `packages/shared/node_modules/@terragon/utils` symlink;
  - `packages/shared/src/model/cell-authority.ts` already imports `@terragon/utils/receive-pack-refs` (`:3`) and loads under tsx.
- **Conclusion.** `fix-paths.ts` re-exporting from `@terragon/utils/fix-branch` keeps it import-light: one import of a module that has no imports. It also keeps `verify-fixes.ts` on standard resolution. **Do not change `verify-fixes.ts`.** It keeps importing `FIX_BRANCH_PREFIX` from `../../packages/shared/src/self-heal/fix-paths`. A direct `@terragon/utils/fix-branch` import from `deploy/` would rest on tsx-only resolution.
- `review-skill.ts:519-520` keeps its literal for the same deploy-tsx reason, and `skill-contract-drift.test.ts:299-301` still pins it. Out of scope.

### Tests named in the ticket exist

All present at 8ebffabe: `packages/shared/src/self-heal/fix-paths.test.ts`, `apps/www/src/server-lib/audit/fix-run-prompt.test.ts`, `apps/www/src/server-lib/audit/plan-self-heal-run.test.ts`, `apps/www/src/server-lib/review/skill-contract-drift.test.ts`, `apps/www/src/agent/hatchet/dispatch.test.ts`. `packages/utils/src/fix-branch.test.ts` does not exist yet (created here). `self-heal-dispatcher.test.ts` exists, but it never names a fix branch (0 hits), so it is not needed for AC3.

- `fix-run-prompt.test.ts:56-82` holds the www `fixBranchName` golden (`automata/fix-42-01234567-a2`), the prefix check, and the throw cases. It keeps passing through the re-export. Leave it in place: it proves the re-export.
- Environment: `packages/shared` vitest has `globalSetup: "./src/test-global-setup.ts"` (docker compose Postgres, or `TEST_DATABASE_ADMIN_URL`). The www suite needs the same. The utils and worker files need neither. Not run here: the shared and www baselines.

### Already done / does not exist

- `packages/utils/src/fix-branch.ts` does not exist, and there is no `./fix-branch` export. No `fast-check` in any manifest. Do not add it.

## Constraints for the implementer

- **Byte-identical output and errors (OD3).** Move the three pieces verbatim. `FIX_FINGERPRINT_RE = /^[0-9a-f]{8,}$/`. `assertPositiveInteger` keeps `Number.isInteger(value) && value >= 1` (written as today: `!Number.isInteger(value) || value < 1`) and the message `` `fix run ${what} must be a positive integer, got ${value}` ``. The fingerprint message stays `"fix run fingerprint must be lowercase hex (>= 8 chars)"`. The check order stays issue → attempt → fingerprint. The template stays `` `${FIX_BRANCH_PREFIX}${issueNumber}-${fingerprint.slice(0, 8)}-a${attemptNo}` ``. No `isSafeInteger` bound (#623). The 175-name sha256 above must still match. Compute it the same way in `fix-branch.test.ts` and assert it, or assert the explicit table.
- **`packages/utils/src/fix-branch.ts` has no imports** and exports exactly `FIX_BRANCH_PREFIX`, `FIX_FINGERPRINT_RE`, `FixBranchNameInput` (an `interface`) and `fixBranchName`. `assertPositiveInteger` stays module-private. Give it a header doc saying it is the one definition shared by shared, www and the worker, and that it is dependency-free so any plane and the deploy tsx scripts can load it.
- **Exports map:** add `"./fix-branch": "./src/fix-branch.ts"` to `packages/utils/package.json`, plus a pin in `package-exports.test.ts`.
- **No new dependency edges.** Only `@terragon/utils/fix-branch` is imported, by shared, www and the worker, which all depend on utils already. No `package.json` dependency or lockfile change. The worker imports nothing from `@terragon/shared` or `apps/www` (`types.ts:4-10`).
- **shared `fix-paths.ts`:** replace the `:14` definition with `export { FIX_BRANCH_PREFIX } from "@terragon/utils/fix-branch";` (keep its doc line). Update the `:5-8` header: the module's only import is the dependency-free `@terragon/utils/fix-branch`; the deploy tsx scripts still load it without alias resolution; the worker reads the prefix from utils directly, so there is no drift-tested mirror for it any more. Keep the deny-list text about the worker's pushed-diff mirror accurate: only the prefix sentence changes.
- **www `fix-run-prompt.ts`:** delete `FixBranchNameInput` (`:32-36`), `FINGERPRINT_RE` (`:38`), `assertPositiveInteger` (`:42-46`) and `fixBranchName` (`:48-60`). Add `import { fixBranchName, type FixBranchNameInput } from "@terragon/utils/fix-branch";` and `export { fixBranchName, type FixBranchNameInput };` (or `export { fixBranchName } from …` plus `export type { FixBranchNameInput } from …`; use one form, and keep `fixBranchName` usable at `:116`). Keep `REF_NAME_RE`. Drop `FIX_BRANCH_PREFIX` from the shared import if it is now unused. Do not touch any www caller.
- **Worker `workflow.ts`:** `import { FIX_BRANCH_PREFIX } from "@terragon/utils/fix-branch";` beside the other utils imports (`:2-3`). Delete `WORKER_FIX_BRANCH_PREFIX` and its comment (`:818-822`), and use `FIX_BRANCH_PREFIX` at `:845`, `:846` and `:850`. The error text stays `self-heal fix run: branch is not a automata/fix-* branch name` after interpolation. `FIX_SUFFIX_SHAPE` stays in the worker, unchanged (OD1). `selfHealRefFence` behaviour is unchanged.
- **Worker `workflow.test.ts`:**
  - delete `:77` and `:89` (the `WORKER_FIX_BRANCH_PREFIX` plumbing), `readSource` (`:880-884`), the source drift test (`:890-898`), the prefix drift test (`:917-924`) and the hand-built `generated` helper (`:887-888`);
  - statically `import { fixBranchName } from "@terragon/utils/fix-branch";` in the import block;
  - AC5: rewrite the table (`:900-914`) to run the real `fixBranchName` over the AC1 table (issues `{1, 9, 10, 12, 99999, 2147483647, Number.MAX_SAFE_INTEGER}`, fingerprints `{"00000000", "ffffffff", "deadbeef", "0123abcd", <64-hex>}`, attempts `{1, 2, 9, 10, 99999}`), expecting `{ exactRef: \`refs/heads/${name}\` }` for each;
  - rename the describe: drop "this does not exercise fixBranchName"; it now does;
  - AC4: `git grep 'readSource\|WORKER_FIX_BRANCH_PREFIX' packages/worker` must print nothing.
- **`packages/utils/src/fix-branch.test.ts` owns AC1 and AC2.** AC1 is the 175-name table: assert the explicit expected names, or the sha256 `f4cc7c43…8524` plus the first and last names, plus a few spot goldens (`automata/fix-42-01234567-a2` from `0123456789abcdef`). Also assert that every name starts with `FIX_BRANCH_PREFIX` and that `FIX_FINGERPRINT_RE.source === "^[0-9a-f]{8,}$"`. AC2 covers `0`, `-1`, `1.5`, `NaN` on both issue and attempt, and `../x`, `DEADBEEF`, `abc` on the fingerprint. Each is an exact-message `toThrow("<full message>")`, not a regex.
- **Do not change:** `deploy/self-heal-bench/verify-fixes.ts`, `review-skill.ts`, `skill-contract-drift.test.ts`, `self-heal-acceptance.sh` and its test, `FIX_SUFFIX_SHAPE`, `knowledge-minimize.ts`, any www/shared caller of the prefix or builder, or `fix-run-prompt.test.ts`.
- **TypeScript (AGENTS.md):** strict; `interface` for the input; no `any`; no `!` without a comment (note `noUncheckedIndexedAccess` in table loops); `??` over `||`; ES imports only; English identifiers; kebab-case file names; no commented-out code; no enums.
- **Formatting:** `pnpm exec prettier --no-editorconfig --config .prettierrc --write <changed files>` (the `.editorconfig` disagrees with the repo's prettier config).
- **Content:** no client or customer names in code, tests, comments or the PR.

## Gates

Run in this order; each must be green. The worker file and the tsx check need to run unsandboxed (tsx IPC pipe; vitest workers). Shared and www need docker Postgres (or `TEST_DATABASE_ADMIN_URL`).

```bash
pnpm --filter @terragon/utils exec vitest run --no-file-parallelism src/fix-branch.test.ts src/package-exports.test.ts
pnpm --filter @terragon/shared exec vitest run --no-file-parallelism src/self-heal/fix-paths.test.ts
pnpm --filter @terragon/www exec vitest run --no-file-parallelism \
  src/server-lib/audit/fix-run-prompt.test.ts src/server-lib/audit/plan-self-heal-run.test.ts \
  src/server-lib/review/skill-contract-drift.test.ts src/agent/hatchet/dispatch.test.ts
pnpm --filter @terragon/worker exec vitest run --no-file-parallelism src/agent-run/workflow.test.ts
pnpm --filter @terragon/docs exec fumadocs-mdx
pnpm turbo tsc-check
pnpm turbo lint
pnpm turbo format-check
```

Checks after the gates:

- AC4: `git grep -n 'readSource\|WORKER_FIX_BRANCH_PREFIX' packages/worker` prints nothing.
- UAT 2: `git grep -n '"automata/fix-"' -- '*.ts' ':!*.test.ts'` lists only `apps/www/src/server-lib/review/review-skill.ts` and `packages/utils/src/fix-branch.ts`.
- AC7: `git diff --stat origin/main -- '*/package.json' package.json pnpm-lock.yaml` shows only `packages/utils/package.json` (the exports line), and `git diff origin/main -- packages/worker | grep '^+import'` adds only `@terragon/utils/fix-branch`.
- AC8: `pnpm exec tsx deploy/self-heal-bench/verify-fixes.ts` (repo root, no args, unsandboxed) prints `USAGE` and exits 1, with no module-resolution error.
- UAT 3: `cd packages/utils && pnpm exec tsx -e 'import("./src/fix-branch.ts").then(m => console.log(m.fixBranchName({issueNumber:42, fingerprint:"0123456789abcdef", attemptNo:2})))'` prints `automata/fix-42-01234567-a2`.
- Out of scope untouched: `git diff --stat origin/main -- deploy packages/worker/deploy apps/www/src/server-lib/review packages/shared/src/model/knowledge-minimize.ts` is empty.
- Expected counts: utils `package-exports` 11 → 13; worker `workflow.test.ts` 55 → 53 (two drift tests removed; the table `it` is rewritten in place); the shared/www files keep their main counts (not measured here).

## Phases

1. **utils module** (4 files): `packages/utils/src/fix-branch.ts` (new), `packages/utils/src/fix-branch.test.ts` (new, AC1/AC2), `packages/utils/package.json` (exports entry), `packages/utils/src/package-exports.test.ts` (pin). Gate: the utils vitest command and `pnpm --filter @terragon/utils exec tsc --noEmit`.
2. **shared and www switch to utils** (2 files, plus 1 optional): `packages/shared/src/self-heal/fix-paths.ts` (re-export and header), `apps/www/src/server-lib/audit/fix-run-prompt.ts` (delete local pieces, import and re-export); optional comment touch in `packages/shared/src/model/audit-fix-attempts.ts:74`. Gate: the shared and www vitest commands, `tsc --noEmit` for both packages, and the AC8 tsx check.
3. **worker switches to utils** (2 files): `packages/worker/src/agent-run/workflow.ts` (import `FIX_BRANCH_PREFIX`, delete the mirror), `packages/worker/src/agent-run/workflow.test.ts` (delete the drift tests, `readSource` and the `:77`/`:89` plumbing; AC5 runs the real builder). Gate: the worker vitest command and the AC4 grep.
4. **Repo gates** (no new files): prettier on every changed file, then `fumadocs-mdx`, `pnpm turbo tsc-check`, `pnpm turbo lint`, `pnpm turbo format-check`, then the after-gate checks above.

## Validate round 1 (PASS_WITH_WARNINGS): fixes folded in

These override anything above.

- **R1.** The worker gate also runs `src/agent-run/self-heal-fix-check.test.ts`. That test imports shared `fix-paths.ts` by relative path, so after this change it also loads `@terragon/utils/fix-branch`. It also holds the deny-path mirror drift test.
- **R2.** The www gate also runs `src/server-lib/audit/no-merge.static.test.ts`. Its scan list names both `fix-paths.ts` and `workflow.ts`.
- **R3.** `pnpm turbo lint` reaches only www, because utils and the worker have no `lint` script. Their real gates are `tsc-check` (`noUnusedLocals`) and prettier.
- **R4.** AC8 is verified, not "Not verified": `pnpm exec tsx deploy/self-heal-bench/verify-fixes.ts` from the repo root prints USAGE and exits 1. That stays a gate after the change.
- **Baseline reproduced by the validator.** 175 names, sha256 `f4cc7c43…8524`. The first name is `automata/fix-1-00000000-a1` and the last is `automata/fix-9007199254740991-01234567-a99999`.

## Phases (from the validator)

1. **utils module.**
   - Files: `packages/utils/src/fix-branch.ts`, `packages/utils/src/fix-branch.test.ts`, `packages/utils/package.json`, `packages/utils/src/package-exports.test.ts`.
   - Gate: `pnpm --filter @terragon/utils exec vitest run --no-file-parallelism src/fix-branch.test.ts src/package-exports.test.ts`, then `pnpm --filter @terragon/utils exec tsc --noEmit`.
2. **shared and www.**
   - Files: `packages/shared/src/self-heal/fix-paths.ts`, `apps/www/src/server-lib/audit/fix-run-prompt.ts`.
   - Gates, unsandboxed with docker Postgres:
     - shared: `src/self-heal/fix-paths.test.ts`.
     - www: `src/server-lib/audit/fix-run-prompt.test.ts`, `plan-self-heal-run.test.ts`, `no-merge.static.test.ts`, `src/server-lib/review/skill-contract-drift.test.ts` and `src/agent/hatchet/dispatch.test.ts`.
     - AC8: the `verify-fixes.ts` USAGE check.
3. **worker.**
   - Files: `packages/worker/src/agent-run/workflow.ts`, `packages/worker/src/agent-run/workflow.test.ts`.
   - Gates: worker vitest over `src/agent-run/workflow.test.ts` and `src/agent-run/self-heal-fix-check.test.ts`, then the AC4 grep (`git grep -n 'readSource\|WORKER_FIX_BRANCH_PREFIX' packages/worker` must print nothing).
4. **Repo gates.**
   - `pnpm --filter @terragon/docs exec fumadocs-mdx`, `pnpm turbo tsc-check`, `pnpm turbo lint`.
   - prettier on the changed files.
   - The AC7 diff-stat and UAT steps 2 and 3.
