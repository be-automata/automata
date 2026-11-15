# Spec #620 — worker: validate self-heal fence refs with isBranchRef

Source of truth: GitHub issue be-automata/automata#620 (body below, verbatim; decision record `Verdict: READY ON DEFAULTS` in the run state). Branch `fix/620-worker-isbranchref` off main `e81f85a4`.

## Ticket

Follow-up from #610/#618 (/simplify findings). `isBranchRef` (#618) is the platform's meaning of a valid `refs/heads/<name>` ref. The worker still applies its own rules in two places. Both should call `isBranchRef` and keep only the local `automata/fix-` rules, with no outcome change for real branch names.

### Reality check on be-automata/automata@e81f85a4

| What                                                                                                                     | Where                                                                                                                                                           |
| :----------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isBranchRef`, plus the `checkRefFence` overload that takes a null fence                                                 | `packages/utils/src/receive-pack-refs.ts:180-234`                                                                                                               |
| `selfHealRefFence`: an inline suffix regex, plus checks for `..`, a trailing `.` and `.lock`                             | `packages/worker/src/agent-run/workflow.ts:821-848`                                                                                                             |
| Its only caller                                                                                                          | `workflow.ts:1247` → `startGitBroker` `:1631-1637`                                                                                                              |
| The broker guard `refFence.exactRef.startsWith("refs/heads/")` (no test covers its throw)                                | `packages/worker/src/agent-run/git-broker.ts:93-97`                                                                                                             |
| Where fix names come from: `automata/fix-<int>-<8 hex>-a<int>`                                                           | `apps/www/src/server-lib/audit/fix-run-prompt.ts:49-59`; checked against `attempt.branch` in `plan-self-heal-run.ts:397-403`                                    |
| Fence tests: names that must fail closed, plus a prefix drift check                                                      | `workflow.test.ts:836-888`                                                                                                                                      |
| Broker tests                                                                                                             | `git-broker.test.ts:229,281,297-463`; `broker-integration.test.ts:306,350`; `workflow-cleanup.test.ts:876-906`; `receive-pack-refs.test.ts:13,203-217`          |
| Acceptance checks that depend on this behaviour: the journal line `ref fence refused push` and `automata/fix-*` PR heads | `packages/worker/deploy/linux/self-heal-acceptance.sh:265-270,382,524`; `self-heal-acceptance.test.ts:776,1060`                                                 |
| `git check-ref-format`, out of scope (stays)                                                                             | `abnormal-end.ts:317,602` (salvage checks the work branch inside the container with the git that pushes); `knowledge/mirror.ts:183` (a remote's default branch) |

`automata/task-*` names (`remote-task-pr.ts:60`) never get a worker fence. Only `selfHeal.kind === "fix"` gets one, so task branches are not affected.

### Contract

- `selfHealRefFence(fix)` returns `{ exactRef: "refs/heads/" + branch }` only when all of these hold:

  1. `branch` starts with `WORKER_FIX_BRANCH_PREFIX`;
  2. the suffix matches the worker's local shape rule (see the open decision);
  3. `isBranchRef("refs/heads/" + branch)` is true.

  Otherwise it throws `/self-heal fix run/`. It returns `undefined` for runs that are not fix runs.

- `startGitBroker` throws when `refFence` is set and `isBranchRef(refFence.exactRef)` is false.
- The inline checks for `..`, a trailing `.` and `.lock` are removed, because `isBranchRef` owns them.

### Behaviour delta

The direction is the reverse of what you might expect. I verified this by running the old rule and `isBranchRef` side by side over each name below on e81f85a4:

| Input                                                                               | Old worker | `prefix && isBranchRef` alone |
| :---------------------------------------------------------------------------------- | :--------- | :---------------------------- |
| Any generated fix name (sweep of 4,000+ names)                                      | accept     | accept: no outcome changes    |
| `@{`, `HEAD` as the whole name, U+FFFD, trailing `.`, `//`, `..`, `.lock`, space    | refuse     | refuse                        |
| `automata/fix-` (empty suffix)                                                      | refuse     | **accept**                    |
| `automata/fix-_x`, `-x`, `.x`, `a/b`, `1/main`, `café`, `a@b`, `a+b`, `a#b`, `a{b}` | refuse     | **accept**                    |
| Broker: `refs/heads/`, `a..b`, `HEAD`, `-x`, `a.`, `a//b`, `a@{1}`, U+FFFD          | accept     | refuse (tighter)              |

The old rule's accepted set is a subset of `isBranchRef`'s, so `isBranchRef` alone would **loosen** the fence. The broker guard only gets tighter, and its one production input already passes.

### Acceptance Criteria

- **AC1:** `selfHealRefFence` and `startGitBroker` both call `isBranchRef`. No ref-format regex or `..`/`.lock` check is left in `workflow.ts` or `git-broker.ts`.
- **AC2:** `automata/fix-12-deadbeef-a1` still maps to exactly `refs/heads/automata/fix-12-deadbeef-a1`.
- **AC3:** Every case in `workflow.test.ts:861-868` still throws: `main`, `refs/heads/…`, `automata/fix-`, `automata/fix-1/../main`, the name with a space, `.lock`, `Automata/fix-1`. Add `automata/fix-a@{1}`, `automata/fix-HEAD.`, `automata/fix-a/b` and `"automata/fix-a\ufffd"`.
- **AC4:** A new `git-broker.test.ts` case: a `refFence` holding `refs/heads/`, `refs/heads/a..b` or `refs/tags/v1` makes `startGitBroker` reject before it listens.
- **AC5:** A test proves every name `fixBranchName` generates still passes. Use a property test or a table that includes 99999 and a fingerprint of all zeros.
- **AC6:** No change to the self-heal acceptance contract: the journal text `git-broker: ref fence refused push (<reason>) ref=<ref>` stays byte-identical, and `self-heal-acceptance.sh` and its test pass unchanged.
- **AC7:** Both `check-ref-format` call sites are left as they are.

### Tests

```bash
pnpm --filter @terragon/utils exec vitest run --no-file-parallelism src/receive-pack-refs.test.ts
pnpm --filter @terragon/worker exec vitest run --no-file-parallelism \
  src/agent-run/workflow.test.ts src/agent-run/git-broker.test.ts \
  src/agent-run/workflow-cleanup.test.ts src/agent-run/broker-integration.test.ts \
  src/agent-run/receive-pack-refs.test.ts src/agent-run/self-heal-acceptance.test.ts
pnpm turbo tsc-check
pnpm turbo lint
```

Not verified: what `broker-integration.test.ts` needs from the environment (a local `git`?).

### Open decisions

- **OD1: the local shape rule for the suffix.**
  - Options:
    - **(a)** Keep `^[A-Za-z0-9][A-Za-z0-9._-]*$` as the worker's own rule, with `isBranchRef` underneath.
    - **(b)** Pin the exact generated shape, `^\d+-[0-9a-f]{8}-a\d+$`. This risks drifting from `fixBranchName`.
    - **(c)** Prefix plus a non-empty suffix only. This loosens the fence, as the delta table shows.
  - **Recommended: (a).** Outcomes stay identical (old ⊆ `isBranchRef`).
  - Blocks implementation: no, (a) is the default.
- **OD2: the broker error text.** Recommended: say "must be a valid refs/heads/ branch ref" and keep the `got:` suffix. Blocks implementation: no.

### UAT

**T0 (local):** run the Tests commands. In a REPL, confirm that `selfHealRefFence` throws on the AC3 names and maps a generated name, and that `startGitBroker` rejects `refs/heads/a..b`. No deploy step, since generated names do not change outcome.

_(Ticket headings demoted one level to nest under this section; text unchanged.)_

## Decisions

Decision record: `Verdict: READY ON DEFAULTS`.

- **OD1 — suffix shape rule: decided (a)**, confirmed by the owner in session. The worker keeps `^[A-Za-z0-9][A-Za-z0-9._-]*$` on the suffix after `automata/fix-`, and `isBranchRef("refs/heads/" + branch)` runs underneath it. Rejected: (b) pinning `^\d+-[0-9a-f]{8}-a\d+$`, which duplicates `fixBranchName` and can drift from it; (c) prefix plus a non-empty suffix, which loosens the fence (see the delta table).
- **OD2 — broker error text: default.** `git-broker: refFence.exactRef must be a valid refs/heads/ branch ref, got: ${refFence.exactRef}`. The `got:` suffix stays. This is an assumption on the stated default; no test or script pins the old text (`git grep "refFence.exactRef must"` finds only `git-broker.ts:95`).

## Ground truth (verified at e81f85a4 on 2026-11-14)

Re-read in this worktree (`git log -1` = `e81f85a48f9e2ce4f46d320dbd5086393a1aff65`). Every reference in the ticket's reality check holds; refinements are marked **precise** and the one real correction **correction**.

### `isBranchRef` and `checkRefFence` (`packages/utils/src/receive-pack-refs.ts`)

- `checkRefFence` overloads :180-187, implementation :188-205 (non-null fence → `FencedRefResult`; null → adds `no_ref_fence`). `isBranchRef(ref: string): boolean` is :217-234, with `BRANCH_REF_PREFIX = "refs/heads/"` at :207. **Precise**: the ticket's :180-234 spans both.
- `isBranchRef` refuses: a missing `refs/heads/` prefix; an empty name, `@`, `HEAD`; a leading `-`; a trailing `.`, `..`, `@{`; any of `[\u0000- \u007f~^:?*[\\]` (controls, space, DEL, git punctuation); U+FFFD and lone surrogates; any empty component (leading, trailing or doubled `/`), a component starting with `.` or ending in `.lock`.
- Exported via the `./receive-pack-refs` subpath (`packages/utils/package.json:14`). `@terragon/utils: workspace:*` is already in `packages/worker/package.json` dependencies, linked at `packages/worker/node_modules/@terragon/utils`. `git-broker.ts:10-14` already imports `checkRefFence`, `parseReceivePackCommands` and `FencedRefResult` from it, and the worker's `receive-pack-refs.test.ts:8` imports from it too. **No `package.json` or lockfile change.**
- Current users of `isBranchRef`: `packages/shared/src/model/cell-authority.ts:3,116` and `packages/utils/src/receive-pack-refs.test.ts:46-88`. None in the worker.

### `selfHealRefFence` today (`packages/worker/src/agent-run/workflow.ts`)

```ts
// :817-821
/**
 * Mirror of @terragon/shared `FIX_BRANCH_PREFIX` (the worker does not depend
 * on shared); a drift test in workflow.test.ts pins the two together.
 */
export const WORKER_FIX_BRANCH_PREFIX = "automata/fix-";

// :823-848
export function selfHealRefFence(
  selfHeal: AgentRunInput["selfHeal"],
): { exactRef: string } | undefined {
  if (selfHeal?.kind !== "fix") return undefined;
  const branch = selfHeal.branch;
  const suffix = branch.startsWith(WORKER_FIX_BRANCH_PREFIX)
    ? branch.slice(WORKER_FIX_BRANCH_PREFIX.length)
    : "";
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(suffix) ||
    suffix.includes("..") ||
    suffix.endsWith(".") ||
    suffix.endsWith(".lock")
  ) {
    throw new Error(
      `self-heal fix run: branch is not a ${WORKER_FIX_BRANCH_PREFIX}* branch name`,
    );
  }
  return { exactRef: `refs/heads/${branch}` };
}
```

- Only caller: `workflow.ts:1247` (`const refFence = selfHealRefFence(input.selfHeal);`), then the credential-broker check :1248-1252, then `startGitBroker({ …, ...(refFence ? { refFence } : {}) })` at :1631-1637. `git grep selfHealRefFence` finds no other caller (tests load it dynamically at `workflow.test.ts:76,88`).
- `workflow.ts` imports `@terragon/utils/payload-seal` at :2, so a `@terragon/utils/receive-pack-refs` import sits beside it.
- **Equivalence proof for OD1 (a)** (why outcomes cannot change). Any suffix the old rule accepts starts with `[A-Za-z0-9]` and holds only `[A-Za-z0-9._-]`, so the name `automata/fix-<suffix>` has exactly two components (`automata`, `fix-<suffix>`), no `/` inside the suffix, no `@`, no forbidden character, no leading `-` or `.`, and the old rule already excludes `..`, a trailing `.` and a trailing `.lock`. Every `isBranchRef` refusal is therefore already a refusal of the old rule: old-accept ⊆ `isBranchRef`-accept. With (a), new = prefix ∧ suffix-regex ∧ `isBranchRef` = old ∧ `isBranchRef` = old. The three inline checks (`..`, trailing `.`, `.lock`) become redundant because `isBranchRef` owns them; the suffix regex is what keeps the fence as tight as today.
- The suffix regex is not dead weight: `Number.isInteger(1e21)` is true and `${1e21}` is `"1e+21"`, so `fixBranchName` could in theory emit `automata/fix-1e+21-…`; the regex refuses `+` while `isBranchRef` would accept it. (Not reachable from GitHub issue numbers; it only illustrates that (c) loosens.)

### The broker guard today (`packages/worker/src/agent-run/git-broker.ts`)

```ts
// :88-97
export async function startGitBroker(
  opts: StartGitBrokerOptions,
): Promise<GitBroker> {
  const { installationToken, repoFullName, runBearer, refFence } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (refFence && !refFence.exactRef.startsWith("refs/heads/")) {
    throw new Error(
      `git-broker: refFence.exactRef must be a refs/heads/ ref, got: ${refFence.exactRef}`,
    );
  }
```

- It runs before the repo-slug check (:105-110), before `createServer` (:228) and before `server.listen(0, "127.0.0.1", …)` (:237). So a throw there means nothing listens: AC4's "rejects before it listens" is structural, and the test can assert it by the rejection plus `fetchImpl` never being called.
- `StartGitBrokerOptions.refFence?: { exactRef: string }` doc at :81-85 says "(`refs/heads/automata/fix-…`)"; update it to say the ref must pass `isBranchRef`.
- **Journal line (AC6), `git-broker.ts:186-197`**, untouched by this ticket:

  ```ts
  console.error(
    `git-broker: ref fence refused push (${gate.reason})` +
      (gate.ref ? ` ref=${printable(gate.ref)}` : ""),
  );
  ```

  `printable` is at :329. The HTTP body is `push refused by the self-heal ref fence` with `connection: close`.

### Where fix names come from (`apps/www`)

- `fixBranchName` is `apps/www/src/server-lib/audit/fix-run-prompt.ts:48-60`. It asserts `issueNumber` and `attemptNo` are positive integers (`Number.isInteger(v) && v >= 1`, :42-46), the fingerprint matches `FINGERPRINT_RE = /^[0-9a-f]{8,}$/` (:38), and returns `` `${FIX_BRANCH_PREFIX}${issueNumber}-${fingerprint.slice(0, 8)}-a${attemptNo}` `` (:59). `FIX_BRANCH_PREFIX = "automata/fix-"` is `packages/shared/src/self-heal/fix-paths.ts:14`.
- Callers: `fix-run-prompt.ts:116`, `self-heal-dispatcher.ts:647` (`branchFor`), `plan-self-heal-run.ts:397-403` (re-derives and throws `attempt branch does not match fixBranchName`). Ticket refs hold.
- **Correction — the worker test cannot import `fixBranchName`.** `fix-run-prompt.ts` imports `@terragon/shared` (:1-9); the worker does not depend on `@terragon/shared` (no link under `packages/worker/node_modules/@terragon/`: only `agent`, `daemon`, `knowledge`, `tsconfig`, `utils`), and the file lives in `apps/www` behind the `@/` alias. A cross-package import would fail to resolve and would violate the worker's lean-plane rule. **AC5 approach** (see Constraints): a source drift test that pins the template and fingerprint regex in `fix-run-prompt.ts`, the same technique the existing prefix drift test uses (`workflow.test.ts:876-887` reads `../../../shared/src/self-heal/fix-paths.ts`), plus a table over the documented shape.

### Tests that exist today

- `workflow.test.ts:836-888`: `describe("selfHealRefFence (FENCE-01 wiring)")` with the `fix(branch)` builder :837-845, the golden mapping :847-851, the no-fence cases :853-858, the fail-closed list :860-874 (the seven names in AC3, at :862-868) asserting `toThrow(/self-heal fix run/)`, and the prefix drift test :876-887.
- `git-broker.test.ts` (525 lines): `FIX_REF = "refs/heads/automata/fix-12-deadbeef-a1"` :229; `bodyReadingFetch()` :258-272 counts dials; `bootFenced()` :274-284 (refFence at :281); `describe("startGitBroker refFence (FENCE-01 …)")` starts :297. **No test covers the guard's throw** (`git grep` for the error text finds only the source).
- `broker-integration.test.ts`: `FIX_BRANCH = "automata/fix-12-deadbeef-a1"` :306, `refFence: { exactRef: \`refs/heads/${FIX_BRANCH}\` }` :350.
- `workflow-cleanup.test.ts:876` uses `branch: "automata/fix-12-deadbeef-a1"`.
- Worker `receive-pack-refs.test.ts`: `BRANCH` :13; near-miss list :203-217.
- `self-heal-acceptance.test.ts:776` feeds `git-broker: ref fence refused push (ref_not_allowed) ref=refs/heads/main` and :783 asserts `EVIDENCE ref-fence refusal: … ref fence refused`; :1060-1066 ignores non-`automata/fix-` heads; :229 pins the runbook's `src/agent-run/receive-pack-refs` and `src/agent-run/git-broker` test paths.
- `self-heal-acceptance.sh`: `grep -c -e 'ref fence refused push'` at :265 and :270; the `isfix` jq def `startswith("automata/fix-")` at :382; the PR listing `startswith("automata/fix-")` at :524. Ticket refs hold.

### Out of scope (stays)

- `abnormal-end.ts:317` `REF_FORMAT_SCRIPT = 'exec git check-ref-format "refs/heads/$1"'`, used at :602; `knowledge/mirror.ts:183` `gitExec(["check-ref-format", "--branch", branch], …)`. Also pinned by `container-daemon-process.test.ts:827,843` and `workflow-cleanup.test.ts:3276`.
- `remoteTaskBranchName` at `apps/www/src/server-lib/task/remote-task-pr.ts:59-61`; task runs get no worker fence.

### Environment needs of the worker tests (measured)

- Baseline at e81f85a4: the six worker files pass, **289/289**; utils `receive-pack-refs.test.ts` passes **38/38** (sandboxed is fine for utils).
- **Local port binding is required.** Sandboxed, `git-broker.test.ts` and `broker-integration.test.ts` fail with `listen EPERM 127.0.0.1` (24 failures, 19 errors); the brokers listen on `127.0.0.1:0`. Run the worker gate unsandboxed.
- `broker-integration.test.ts` needs **local `git`** (`describe.skipIf(!hasGit)` at :190 and :303; the FENCE-01 real-push block serves a bare repo via `git receive-pack|upload-pack --stateless-rpc`, no network) and **`gh`** for its gh blocks (`skipIf(!hasGh)` :68, :121; `gh auth status` against the local broker, no real login). Missing binaries skip, not fail: check the verbose output that the two FENCE-01 cases actually ran.
- `self-heal-acceptance.test.ts` spawns `/bin/bash` on the script and uses `jq`. All present here (`git`, `gh`, `jq`, `shellcheck`).
- **No Docker** is needed for any of the listed worker or utils tests.

### Already done / does not exist

- Nothing for #620 is on main: the worker does not import `isBranchRef`, and the inline checks are still present.

## Constraints for the implementer

- **Outcomes must not change.**
  - `selfHealRefFence`: old-accept ⊆ new-accept, and every old refusal still refuses (proof above). Keep the prefix check, keep the suffix regex `^[A-Za-z0-9][A-Za-z0-9._-]*$` exactly, add `isBranchRef(\`refs/heads/${branch}\`)`, and delete only the `..`, trailing `.`and`.lock` checks.
  - Keep the throw text byte-identical: `` `self-heal fix run: branch is not a ${WORKER_FIX_BRANCH_PREFIX}* branch name` ``. Every refusal (prefix, regex or `isBranchRef`) throws this one error.
  - The returned value stays `{ exactRef: \`refs/heads/${branch}\` }`; non-fix runs still return `undefined`.
  - `startGitBroker`: replace `!refFence.exactRef.startsWith("refs/heads/")` with `!isBranchRef(refFence.exactRef)`, in the same place (before the repo-slug check and before `createServer`/`listen`). Text per OD2.
- **AC1 is literal.** After the change, `workflow.ts` and `git-broker.ts` hold no ref-format regex other than the OD1 suffix-shape rule, and no `..`/`.lock`/trailing-`.` check. Name the suffix rule as the worker's local shape rule in the doc comment (e.g. a `FIX_SUFFIX_SHAPE` constant) so a reviewer can tell it from a ref-format check. Update the `selfHealRefFence` doc (:823-828) to say: prefix + local shape + `isBranchRef`.
- **Journal text byte-identical (AC6):** do not touch `git-broker.ts:186-197`, `printable`, the 403 body, or `self-heal-acceptance.sh`/its test.
- **No change to the `check-ref-format` call sites (AC7):** `abnormal-end.ts:317,602`, `knowledge/mirror.ts:183`.
- **Imports:** `import { isBranchRef } from "@terragon/utils/receive-pack-refs";` in `workflow.ts` (next to the `@terragon/utils/payload-seal` import at :2), and add `isBranchRef` to the existing named import at `git-broker.ts:10-14`. No new dependency; do not import `@terragon/shared` or anything from `apps/www` into the worker.
- **Tests (where each AC lands):**
  - AC2, AC3: `workflow.test.ts` — keep the golden case; append `"automata/fix-a@{1}"`, `"automata/fix-HEAD."`, `"automata/fix-a/b"`, `"automata/fix-a�"` to the fail-closed list (:861-869).
  - AC4: `git-broker.test.ts` — a new `it` that, for each of `refs/heads/`, `refs/heads/a..b`, `refs/tags/v1`, awaits `expect(startGitBroker({ installationToken: TOKEN, repoFullName: REPO, runBearer: BEARER, fetchImpl, refFence: { exactRef } })).rejects.toThrow(/must be a valid refs\/heads\/ branch ref/)` and checks the dial counter stayed 0. Do not assign the module-level `broker` (there is nothing to close).
  - AC5: `workflow.test.ts`, inside the `selfHealRefFence` describe:
    1. **Shape drift test.** Read `../../../../apps/www/src/server-lib/audit/fix-run-prompt.ts` via `new URL(…, import.meta.url)` (path from `packages/worker/src/agent-run/`; verify it resolves) and assert it contains ``return `${FIX_BRANCH_PREFIX}${issueNumber}-${fingerprint.slice(0, 8)}-a${attemptNo}`;`` and `const FINGERPRINT_RE = /^[0-9a-f]{8,}$/;`. If either changes, this test fails and forces the table below to be revisited.
    2. **Table over the documented shape.** A local `generated(issue, fp8, attempt)` that builds `` `${WORKER_FIX_BRANCH_PREFIX}${issue}-${fp8}-a${attempt}` ``, crossed over issue `{1, 9, 10, 12, 99999, 2147483647, Number.MAX_SAFE_INTEGER}`, fp8 `{"00000000", "ffffffff", "deadbeef", "0123abcd"}` and attempt `{1, 2, 9, 10, 99999}`; each maps to exactly `refs/heads/<name>`. (A seeded sweep was built, then dropped in the /simplify pass as redundant with this table: it used the same shape and added no edge value.) No `fast-check`: it is not installed (`node_modules/fast-check` absent); do not add it.
  - Keep the existing prefix drift test (:876-887) as is.
- **TypeScript (AGENTS.md):** strict; no `any`; no `!` without a comment; `??` over `||`; `async`/`await` only; English identifiers; no commented-out code; no enums.
- **Formatting:** `pnpm exec prettier --no-editorconfig --config .prettierrc --write <files>` (the `.editorconfig` disagrees with the repo's prettier config).
- **Content:** no client or customer names in code, tests, comments or the PR.
- Scope: worker only. No change to `packages/utils`, `apps/www`, `packages/shared`, the acceptance script or the runbook.

## Gates

Run in this order; each must be green. The worker command needs local port binding (run unsandboxed).

```bash
pnpm --filter @terragon/utils exec vitest run --no-file-parallelism src/receive-pack-refs.test.ts
pnpm --filter @terragon/worker exec vitest run --no-file-parallelism \
  src/agent-run/workflow.test.ts src/agent-run/git-broker.test.ts \
  src/agent-run/workflow-cleanup.test.ts src/agent-run/broker-integration.test.ts \
  src/agent-run/receive-pack-refs.test.ts src/agent-run/self-heal-acceptance.test.ts
pnpm turbo tsc-check
pnpm turbo lint
pnpm turbo format-check
```

- `pnpm turbo tsc-check` requires the docs codegen first if `apps/docs` is in the graph: `pnpm --filter @terragon/docs exec fumadocs-mdx`.
- Expected counts: utils 38 (unchanged); worker 289 plus the new cases. Confirm in verbose output that `broker-integration.test.ts`'s two FENCE-01 cases ran rather than skipped.
- AC1 check: `git grep -nE '\.\.|\.lock|startsWith\("refs/heads/"\)' packages/worker/src/agent-run/workflow.ts packages/worker/src/agent-run/git-broker.ts` shows no ref-format check left in `selfHealRefFence` or the guard (other hits, e.g. relative import paths, are fine).
- AC6/AC7 check: `git diff --stat origin/main -- packages/worker/deploy packages/worker/src/agent-run/abnormal-end.ts packages/worker/src/knowledge/mirror.ts packages/worker/src/agent-run/self-heal-acceptance.test.ts` is empty.

## Phases

1. **Fence validators** (2 files): `packages/worker/src/agent-run/workflow.ts`, `packages/worker/src/agent-run/git-broker.ts`. Import `isBranchRef`; replace the inline checks and the guard; update the two doc comments; OD2 text.
2. **Tests** (2 files): `packages/worker/src/agent-run/workflow.test.ts` (AC2, AC3 additions, AC5 drift test and table), `packages/worker/src/agent-run/git-broker.test.ts` (AC4).
3. **Gates**: run the Gates block, then the AC1/AC6/AC7 checks; prettier on the four files.

## Validate round 1 (PASS_WITH_WARNINGS) — fixes folded in

These override anything above.

- **RF-1, a precise AC1 check.** AC1 now reads: no ref-format check is left in `workflow.ts` or `git-broker.ts` except the named local suffix rule (OD1 (a)). The check is the command below. Today it matches only the four lines being removed (`git-broker.ts:93`, `workflow.ts:839-841`), and after the change it must print nothing:

  ```
  grep -nE 'includes\("\.\."\)|endsWith\("\.(lock)?"\)|startsWith\("refs/heads/"\)' packages/worker/src/agent-run/{workflow,git-broker}.ts
  ```

- **RF-2, a narrower AC5 claim.**
  - The source-text drift test is kept, following the precedent of the prefix test at `workflow.test.ts:876-887`.
  - The table of names proves that the fence accepts the documented name shape. It does not prove what `fixBranchName` emits; the tests are labelled to say so.
  - Follow-up, named in the PR and not built here: a shared `@terragon/utils/fix-branch` module (the prefix plus a pure name builder) imported by shared, www and the worker. It would remove both drift tests.
- **RF-3, "the tests did not skip" is a hard gate.**
  - Run the worker files unsandboxed with `--reporter=verbose` and save the output.
  - The two FENCE-01 cases under `describe.skipIf(!hasGit)` and the `skipIf(!hasGh)` blocks must show as passed.
  - `self-heal-acceptance.test.ts` (`skipIf(isRoot)`) must show as run.
  - `broker-integration.test.ts` must report 0 skipped.
- **RF-4, the `isBranchRef` call inside `selfHealRefFence` is defence in depth.** No name passes the prefix and suffix checks but fails `isBranchRef` (2,000,000-sample fuzz: 0 disagreements), so no test can show that call doing work. It is verified by reading the code (AC1). The real behaviour change is the broker's new refusals: `refs/heads/`, `refs/heads/a..b` and `refs/tags/v1` (AC4).
- **AC4 test note:** do not assign the module-level `broker` (`git-broker.test.ts:12`'s `afterEach` handles null).

## Phases (from the validator)

1. **Validators.**
   - Files: `packages/worker/src/agent-run/workflow.ts`, `packages/worker/src/agent-run/git-broker.ts`.
   - Gates: `pnpm --filter @terragon/worker exec tsc --noEmit`, then the RF-1 grep.
2. **Tests.**
   - Files: `packages/worker/src/agent-run/workflow.test.ts`, `packages/worker/src/agent-run/git-broker.test.ts`.
   - Gate: the worker vitest command with `--reporter=verbose`, unsandboxed, plus the RF-3 evidence.
3. **Repo gates.**
   - utils `receive-pack-refs.test.ts`.
   - `pnpm turbo tsc-check`, `pnpm turbo lint`.
   - prettier on the changed files.
   - `git diff --stat origin/main -- packages/worker/deploy packages/worker/src/agent-run/abnormal-end.ts packages/worker/src/knowledge/mirror.ts packages/worker/src/agent-run/self-heal-acceptance.test.ts` must be empty.
