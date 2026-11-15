# Spec #610 — branch fence for remote-cell pushes

Source of truth: GitHub issue be-automata/automata#610 (body below, as hardened 2026-11-14; decision record `Verdict: READY` in the run state). Branch `feat/610-cell-ref-fence` off main `f7c1faec`.

## Ticket

The cell git broker (#606, merged in #608) forwards a push to **any** ref of the step's repo. Only the budget and idempotency limit it, and #606 OD-3 deferred the fence. This ticket stores the one ref a step may push, set when the step is opened, and enforces it before GitHub is contacted. It must land before L3 PR 4 sets `CELL_BROKER_ENABLED`. Precedents: Anthropic's web git proxy validates branch names, and GitHub Copilot's cloud agent may push only `copilot/` branches.

## Reality check on be-automata/automata@2b0ab177

| Fact                                                                                                                                     | Where                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `cell_step` has no ref column                                                                                                            | `packages/shared/src/db/schema.ts:3303-3331`                                                  |
| `openStep` inserts the step. On conflict it updates only `currentAttempt`. It has no production caller yet (PR 4 is the first)           | `packages/shared/src/model/cell-authority.ts:79-130`                                          |
| `resolveBearer` joins `cell_bearer`→`cell_step` and returns `BearerContext` (stepKey, attempt, org, thread)                              | `cell-authority.ts:48-53, 233-275`                                                            |
| The broker gets the repo from `thread.githubRepoFullName`. No ref reaches the push path                                                  | `packages/cell-broker/src/common.ts:119-142, 430-455`                                         |
| Push order: 415, 413, `readCommandSection`, the `0000` probe, `mintWriteToken` (:621), `beginEffect` (:654). Commands are parsed at :603 | `packages/cell-broker/src/git.ts:585-654`                                                     |
| `checkRefFence(commands, {exactRef})`: every command must equal `exactRef`, deletes are refused, an empty list returns `no_commands`     | `packages/utils/src/receive-pack-refs.ts:169-189`                                             |
| On the box, only self-heal fix runs are fenced (`refs/heads/automata/fix-*`, fail closed). The refusal is 403 plus `connection: close`   | `packages/worker/src/agent-run/workflow.ts:829-847, 1247`; `git-broker.ts:184-197`            |
| A task run that starts on the base branch pushes `automata/task-<threadId[0..8]>` (`workBranch`). Other runs push `input.branch`         | `apps/www/src/agent/hatchet/dispatch.ts:1168-1175`; `server-lib/task/remote-task-pr.ts:59-60` |
| `thread.repoBaseBranchName` is the thread's base, not necessarily GitHub's default branch                                                | `schema.ts:388`                                                                               |
| OD-3 in #606 covers self-heal fix runs only                                                                                              | `docs/specs/606/spec.md:141`                                                                  |

**Not verified:** I found no code on main that enforces OD-3's "remote cells refuse self-heal fix runs".

## Contract

- **Storage:** a nullable `allowed_ref text` column on `cell_step`, added by `deploy/migrations/2026-11-15-cell-step-allowed-ref.sql` (`-- migrate:expand`, `ADD COLUMN IF NOT EXISTS`), plus the same column in `schema.ts`.
- **Written by `openStep`:**
  - It takes a new parameter `allowedRef: string | null`.
  - A non-null value must be `refs/heads/<name>` and pass `isBranchRef` (`@terragon/utils/receive-pack-refs`: git's ref-format rules plus the F3 refusals; not `selfHealRefFence`, which refuses `/`). Anything else throws a `RangeError`.
  - The ref cannot change for the life of the step. Re-opening the step with a different ref returns `conflict`.
- **Read:** `resolveBearer` selects `allowedRef`, and `authorizeCellRequest` passes it to `handlePush`.
- **Applied:**
  - The check runs in `handlePush` after the command section is parsed and the probe is ruled out, and before `mintWriteToken`.
  - It calls `checkRefFence(section.commands, {exactRef})`.
  - A refusal drops the reader and returns `brokerError(403, "ref_not_allowed" | "delete_not_allowed")`. No token is minted, no effect is claimed and no budget is spent.
  - Fetch, the receive-pack advert and the probe are not affected.
- **When the column is null:** every push is refused with 403 `no_ref_fence` (OD-1 decided: null means the step does not push).
- **Who sets it (PR 4):**
  - task runs: `refs/heads/<workBranch ?? branch>`
  - self-heal fix runs: `refs/heads/<selfHeal.branch>`
  - review and audit runs: null

## Acceptance Criteria

- AC1: The migration passes `node deploy/lint-migrations.ts`, and schema-drift is green with no new allowlist entry.
- AC2: `openStep` stores `allowedRef`. It throws a `RangeError` for a non-`refs/heads/` value or a malformed name (`..`, `.lock`, control characters). It returns `conflict` when the step is re-opened with a different ref.
- AC3: A push whose every command targets `allowed_ref` behaves exactly as today: it is forwarded, recorded and replayed.
- AC4: A push where any command targets another ref gets 403 `ref_not_allowed`, and deleting `allowed_ref` gets 403 `delete_not_allowed`. In both cases there is no upstream request and no `mintWriteToken` call, and `effects_used` is unchanged.
- AC5: A null `allowed_ref` refuses every push with 403 `no_ref_fence`, with no upstream request, no `mintWriteToken` call and `effects_used` unchanged; a test pins it.
- AC6: The probe, clone, fetch and advert are unchanged.

## Tests

- `packages/shared/src/model/cell-authority.test.ts`: AC2.
- `apps/www/src/server-lib/cell-broker/git-push.test.ts`: AC3-AC6, with an upstream spy and a budget check.
- `apps/www/src/server-lib/cell-broker/real-git.test.ts`: a real `git push` outside the fence fails with a readable error.
- Gates:
  - `pnpm --filter @terragon/www exec vitest run --no-file-parallelism src/server-lib/cell-broker`
  - `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism`
  - `pnpm turbo tsc-check`
  - `pnpm turbo lint`
  - `node deploy/lint-migrations.ts`
  - CI `schema-drift`

## Open decisions

_All resolved; the outcomes are in **Decisions** below._

All resolved by the owner on 2026-11-14:

- **OD-1, null fence: decided (a).** A null `allowed_ref` refuses every push (403 `no_ref_fence`). `openStep` has no production caller yet, so every step that L3 PR 4 opens can state its ref, and null means "does not push". The rejected option (b), refusing only the default branch, would leave tags and other people's branches open.
- **OD-2, one ref per step: decided.** One exact ref, matching the box. A prefix fence is added only when a run type needs one.
- **OD-3, refusal shape: decided.** A 403 through `brokerError` (`ref_not_allowed`, `delete_not_allowed`, `no_ref_fence`). The real-git test checks that git shows a readable error.
- **OD-4, self-heal fix runs on cells: decided.** #606 OD-3 is lifted in L3 PR 4, not here.

## UAT

| Tier     | Case                                                      | Expected                                                         |
| -------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| T0 local | the Tests gates, with Docker Postgres                     | green; AC1-AC6 covered                                           |
| T0 local | `real-git.test.ts`: push to `allowed_ref`, then to `main` | the first is accepted; the second gets 403 with no upstream call |
| T1a CI   | `ci.yml`, including `schema-drift` and migration lint     | green                                                            |
| T1a CI   | `migrate.yml` on main                                     | the expand migration applies and `assert-schema-ready` passes    |

The routes stay off until L3 PR 4 (`CELL_BROKER_ENABLED` defaults to false, `packages/env/src/apps-www.ts:109`), so this ticket has no T1b or production UAT.

## Decisions (settled 2026-11-14 by the owner)

- **OD-1 — null fence:** decided (a). A null `cell_step.allowed_ref` refuses every push with 403 `no_ref_fence`. Null means "this step does not push". `openStep` has no production caller yet, so every step L3 PR 4 opens can state its ref. Rejected: (b) refusing only the default branch, which leaves tags and other branches open.
- **OD-2 — refs per step:** one exact ref (`refs/heads/<name>`), checked with `checkRefFence(commands, { exactRef })`, matching the box. A prefix form is added only when a run type needs one.
- **OD-3 — refusal shape:** 403 through `brokerError` with the codes `ref_not_allowed`, `delete_not_allowed` and `no_ref_fence`. The real-git test checks that git shows a readable error.
- **OD-4 — self-heal fix runs on cells:** #606 OD-3 ("remote cells refuse self-heal fix runs") is lifted in L3 PR 4, not here. This PR adds no self-heal code.

## Ground truth (verified at f7c1faec on 2026-11-14)

Re-read in this worktree. The ticket's reality check was written at `2b0ab177`; #613 (`f7c1faec`) has since changed `packages/cell-broker/src/git.ts`. Deltas are marked **moved** or **correction**.

### Storage and `openStep`

- `cell_step` has no ref column: `packages/shared/src/db/schema.ts:3309-3337` (`export const cellStep` :3309, columns :3311-3330, indexes :3333-3336). **Moved** from :3303-3331 (the doc comment starts at :3300). The table was created by `deploy/migrations/2026-11-13-cell-broker-authority.sql:10`.
- `thread.githubRepoFullName` is at `schema.ts:387` and `thread.repoBaseBranchName` at `schema.ts:388`. Unchanged.
- `openStep` is at `packages/shared/src/model/cell-authority.ts:79-160`. **Moved**: the ticket cites :79-130, but the function ends at :160.
  - Signature: `openStep({ db, step: { stepKey, organizationId, threadId, attempt, stepTimeoutMs, effectBudget: number | null } })`. It returns `Promise<{ ok: true } | { ok: false; reason: "stale_attempt" | "step_done" | "conflict" | "revoked" }>`.
  - Validation: `assertPositiveInt` for `attempt` and `stepTimeoutMs` (:63-67, :99-100). `effectBudget` must be null or a non-negative integer, else a `RangeError` (:101-106). The new `allowedRef` check sits with these and also throws a `RangeError`.
  - Write: one `INSERT … ON CONFLICT (step_key) DO UPDATE SET current_attempt = <attempt>` (:107-131). The update runs only when `current_attempt < attempt`, `done_at IS NULL`, `revoked_through` is null or below the attempt, and the organization and thread match (:120-129).
  - When the upsert returns no row, the existing row is read back (:134-146).
  - Conflict semantics (:147-159), in this order:
    1. A missing row, a different organization or a different thread gives `conflict`.
    2. Then `done_at` gives `step_done`.
    3. Then a revoked attempt gives `revoked`.
    4. Then the same attempt gives `{ ok: true }` (an idempotent re-open).
    5. Anything else is `stale_attempt`.
- **Production callers of `openStep`: none.** `git grep "openStep("` finds only `cell-authority.ts:79`, the tests `cell-authority.test.ts:34, :93, :111`, and `packages/shared/src/model/test-helpers.ts:434`.
- `test-helpers.ts:408-466` is `createTestCellStep({ db, repoFullName = "acme/widgets", effectBudget = null, stepTimeoutMs, attempt = 1 })`.
  - Its `open(openAttempt)` closure calls `openStep` at :434 with the fixture's fixed step fields.
  - It returns `{ stepKey, organizationId, threadId, attempt, open, bearer, token }`.
  - It is used by every www broker test: `common.test.ts`, `gh.test.ts`, `git-push.test.ts`, `git-read.test.ts`, `real-gh.test.ts` and `real-git.test.ts` under `apps/www/src/server-lib/cell-broker/`.
- `cell-authority.test.ts:28-51` has its own `newStep(effectBudget)` helper with an inline `openStep` (:34). It is a second call site to update.

### Reading the bearer

- `BearerContext { stepKey; attempt; organizationId; threadId }` is at `cell-authority.ts:48-53`. Unchanged.
- `resolveBearer(executor, token, lock)` is at `cell-authority.ts:233-285` and is **private** (not exported).
  - It selects from `cell_bearer` inner-joined with `cell_step` (:244-260). With `lock` it adds `FOR UPDATE OF cell_step` (:261-263).
  - It returns `{ ok: true; context: BearerContext; effectBudget; effectsUsed }` (:275-284).
  - **Moved**: the ticket cites :233-275.
- Callers of `resolveBearer`:

  - `verifyBearer` (:288-299), which returns `{ ok: true, context }`;
  - `beginEffect` (:353), which returns `{ kind: "go"; context: BearerContext }` (:348);
  - `markStepDone` (:475).

  Adding `allowedRef` to `BearerContext` therefore reaches the broker with no new query.

- `packages/cell-broker/src/common.ts`:
  - `resolveCellStep(db, token)` is at :119-142. It calls `verifyBearer`, then reads `thread.githubRepoFullName` for the step's thread and organization. It returns `{ ok: true; context: BearerContext; repoFullName }`.
  - `authorizeCellRequest(deps, request, { onMissingBearer })` is at :430-457. It returns `CellAuthorization` (:413-423), which is `{ ok: true; bearer; context: BearerContext; repoFullName; owner; repo }`.
  - The ticket's ranges (:119-142, :430-455) still hold; `authorizeCellRequest` ends at :457.
- How the context reaches `handlePush`: `createGitBrokerHandler` (`git.ts:754`) calls `authorizeCellRequest` (:758-760), then `handlePush({ deps, request, bearer: auth.bearer, context: auth.context, owner, repo, url })` (:807-816).
  - `PushRequest.context` is a `BearerContext` (:609-617).
  - **No change to `common.ts` or to the handler wiring is needed** once `BearerContext` carries `allowedRef`.
- An exact-equality assertion on the context will break: `apps/www/src/server-lib/cell-broker/common.test.ts:310-319` (`toEqual({ ok: true, context: { stepKey, attempt, organizationId, threadId }, repoFullName })`). Add `allowedRef` to it.

### The push path (after #613), `packages/cell-broker/src/git.ts`

- `GitBrokerDeps` (:67-94) now has `mintWriteToken: WriteTokenMinter` (:71) and `allowWorkflowWrite: (organizationId) => Promise<boolean>` (:77).
  - `WriteTokenMinter` is `(owner, repo, { allowWorkflows }) => Promise<{ token }>` (`common.ts:460-464`).
- `mintPushToken(deps, organizationId, owner, repo)` (:585-608, **new in #613**) does two things:
  1. It awaits `deps.allowWorkflowWrite(organizationId)` (:593), which is **database I/O in the www route**. On a throw it logs and returns `internalError("workflow_write_setting")`, a 500.
  2. It then calls `deps.mintWriteToken(owner, repo, { allowWorkflows })` (:601). A throw there is mapped by `mintFailureResponse` to 403 `missing_permission` or 502.
- `mintPushToken` serves both write legs: the push POST (:663) and the receive-pack advert (:829).
- `handlePush` (:626-752). Its order today (doc comment :619-625):
  1. 415 `unsupported_encoding` (:635-637).
  2. Declared `Content-Length` over the cap: 413 (:638-642).
  3. `readCommandSection(request.body)` (:644-645), which gives 400 or 413 and drops the reader itself (:204-245).
  4. The zero-command block (:647-661): only git's bare-flush probe has no commands. Anything else gives 400 after `drop(section.reader)`.
  5. **`mintPushToken` (:663-668)**, which does the settings read and then the mint.
  6. The probe pass-through (:670-683).
  7. `pushIdempotencyKey` (:685), then the generation loop with `beginEffect` (:694). **Moved**: the ticket's numbering (mint :621, `beginEffect` :654) is from before #613.
- **Fence insertion point:** between :661 and :663. After the command section is parsed and the probe is ruled out, and before `mintPushToken`. The fence therefore also comes before the `allowWorkflowWrite` read, which does I/O.
  - Guard it with `section.commands.length > 0`. The probe carries no ref, and `checkRefFence` answers `no_commands` for an empty list, so the probe must not be fenced (AC6).
  - On refusal, call `drop(section.reader)` and return `brokerError(403, code)`.
  - At that point nothing is minted, no setting is read, no claim exists and no budget is spent.
- Update the `handlePush` doc comment (:619-625), which lists the order, so that it names the fence (403) between the probe check and the org settings read.
- The advert leg (:819-837) and the upload-pack leg are untouched (AC6).
  - Observation, out of scope: a null-fence step can still mint a write token on the advert leg, but it cannot push.
- `brokerError(status: number, code: string, headers?: HeadersInit): Response` is at `common.ts:28-34` and returns `Response.json({ error: code }, { status, headers })`.
  - `drop(reader)` is at `git.ts:129-131` and calls `discard`; it never throws.
  - The box's refusal adds `connection: close` (`packages/worker/src/agent-run/git-broker.ts:184-197`). The cell broker has no precedent for that header; OD-3 says only `brokerError`.

### The fence and ref-format helpers

- `checkRefFence(commands, { exactRef }): RefFenceResult` is at `packages/utils/src/receive-pack-refs.ts:173-189`, exported through `@terragon/utils/receive-pack-refs` (`packages/utils/package.json:14`).
  - `RefFenceResult` (:47-54) is `{ ok: true; pushedSha } | { ok: false; reason: "ref_not_allowed" | "delete_not_allowed" | "no_commands"; ref? }`.
  - Every command must equal `exactRef`, or the result is `ref_not_allowed`. A zero `newSha` is `delete_not_allowed`. The ref check runs first, so deleting another ref reports `ref_not_allowed`.
  - The two refusal reasons already equal the 403 codes the cell broker returns.
  - `git.ts` already imports from this module (:9-13: `isZeroObjectName`, `parseReceivePackCommands`, `ReceivePackCommand`).
- The command parser rejects an empty ref or a ref with control characters (`parseCommandLine`, :158-167).
- **Correction, ref-format validator:** `selfHealRefFence` is at `packages/worker/src/agent-run/workflow.ts:829-847`, called at :1247. Its check cannot be reused as is:
  - It is **inline**, with no exported validator.
  - It lives in `@terragon/worker`, which `@terragon/shared` does not depend on (and the worker does not depend on shared, `workflow.ts:819-822`).
  - It validates only the suffix after `automata/fix-`, against `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` plus no `..`, no trailing `.` and no `.lock`. That rule refuses `/`, so it would reject the task branch `automata/task-<id>` and every `input.branch` such as `feat/x`.
- Other validators checked; none implements git's `check-ref-format`:
  - `packages/sandbox/src/commands/utils.ts:17` `validateBranchName` blocks only shell metacharacters.
  - `packages/shared/src/model/knowledge-minimize.ts:35` `BRANCH_RE` is `/^[^\s~^:?*[\\]{1,255}$/` and allows `..` and `.lock`.
  - `apps/www/src/server-lib/knowledge/github-head.ts:90` wraps `BRANCH_RE`.
  - `packages/worker/src/agent-run/abnormal-end.ts:317` and `packages/worker/src/knowledge/mirror.ts:183` shell out to `git check-ref-format`, which a database model must not do.
  - No npm package for this is installed (`node_modules/.pnpm` has no git-ref or branch-name validator).
  - Conclusion: a pure `refs/heads/` ref-format check does not exist yet. Its natural home is next to `checkRefFence` in `@terragon/utils/receive-pack-refs` (see Constraints).

### Run branches (for PR 4, informational)

- `workBranch` is set at `apps/www/src/agent/hatchet/dispatch.ts:1168-1175`. It is computed only when `isPlainTaskRun && prNumber === undefined && branch === thread?.repoBaseBranchName`.
- `remoteTaskBranchName(threadId)` returns `automata/task-${threadId.slice(0, 8).toLowerCase()}` (`apps/www/src/server-lib/task/remote-task-pr.ts:59-61`).
- #606 OD-3 is at `docs/specs/606/spec.md:141`. It covers self-heal fix runs only. No code on main enforces "remote cells refuse self-heal fix runs" (still unverified; it is out of scope per OD-4).
- `CELL_BROKER_ENABLED: bool({ default: false })` is at `packages/env/src/apps-www.ts:109`.

### Tests today

- `apps/www/src/server-lib/cell-broker/git-push.test.ts` (1350 lines):
  - `REF = "refs/heads/feat/x"` (:28). `commandSection(newSha, ref = REF)` (:50) builds the command pkt-lines.
  - `fixture(effectBudget)` is `createTestCellStep({ db, effectBudget })` (:61-62).
  - `harness(answer, over)` (:123-210) builds:
    - an upstream `fetchImpl` `vi.fn` that records POSTs in `calls` and serves adverts from `tips`;
    - `mintReadToken`, `mintWriteToken` and `allowWorkflowWrite` as `vi.fn`s.
  - The budget is checked with `effectsUsed(stepKey)` (:64-70), which reads `cell_step.effects_used`, and `effectRows(stepKey, key?)` (:72-85).
  - The existing no-side-effect pattern (e.g. :353-356, :671-674, :848-850) asserts `mintWriteToken` and `fetchImpl` were not called, then `effectRows(...)` is 0 and `effectsUsed(...)` is 0.
  - Every existing push targets `REF`. The 700-command case (:1203-1208) uses other refs but gets 413 inside `readCommandSection`, before the fence.
- `real-git.test.ts` (339 lines):
  - It uses `describe.skipIf(!hasGit)` (:67) and a local HTTP server from `startRouteServer` (:71-77). On EPERM or EACCES each case calls `ctx.skip()`, so it needs local port binding (run it unsandboxed).
  - Each case calls `setup()` (:162-184), which makes a new step through `step()` (:154-160) with `createTestCellStep({ db, repoFullName: "org/repo", effectBudget: 10 })`.
  - The cases push `HEAD:refs/heads/feat/x` (:243), `feat/big` (:272) and `feat/over` (:324). Each case needs its own `allowedRef`.
- `packages/cell-broker` has **no tests and no vitest** (`package.json` has only tsc and format scripts). Its behaviour is tested from `apps/www/src/server-lib/cell-broker/`.

### Migrations

- The latest file is `deploy/migrations/2026-11-14-org-cell-workflow-write.sql` (`-- migrate:expand`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS … boolean;`), the precedent to copy. There are 22 `.sql` files. `drift-allowlist.json` is `[]`.
- The migrate suite pins the count at **22**, which goes to **23**:
  - `packages/migrate/src/cli.test.ts:65` (`"22 pending"`), :70 (`"applied 22 migration(s)"`), :74 (`"22 applied, 0 pending"`) and :79 (`toHaveLength(22)`).
  - `packages/migrate/src/runner.test.ts:89` and :118 (`toHaveLength(22)`), plus the id list ending at :86. Append `"2026-11-15-cell-step-allowed-ref"`.
  - `packages/migrate/src/files.test.ts`: the id list ending at :129. Append the same id.
- `deploy/lint-migrations.ts` exists.

### Already done / does not exist

- Already done for the fence: **nothing**. There is no `allowed_ref` or `allowedRef` anywhere, no commit references #610, and `handlePush` never calls `checkRefFence`.
- Does not exist yet: the column, the migration, the `openStep` parameter, `BearerContext.allowedRef`, a reusable `refs/heads/` ref-format validator, the `no_ref_fence` code, and the fence tests.

## Constraints for the implementer

- **Composable, reuse first.**
  - The fence is `checkRefFence` from `@terragon/utils/receive-pack-refs`. Do not write a second matcher.
  - Map its `reason` straight to the 403 code: `ref_not_allowed` and `delete_not_allowed` are the same strings.
  - `no_ref_fence` is the broker's own code for `context.allowedRef === null`. Check it first, before `checkRefFence`.
- **Ref-format check:** add one pure, exported validator, e.g. `isBranchRef(ref: string): boolean`, to `packages/utils/src/receive-pack-refs.ts`. That subpath is already exported, so `package.json` and `package-exports.test.ts` do not change. Test it in `receive-pack-refs.test.ts`.
  - The ref must start with `refs/heads/` and have a non-empty name. Apply git's `check-ref-format` rules per component:
    - no component starts with `.` or ends with `.lock`;
    - no `..`, no `@{`, and the name is not `@`;
    - no control characters, space, `~`, `^`, `:`, `?`, `*`, `[` or `\`;
    - no leading, trailing or doubled `/`, and no trailing `.`.
  - It must accept the run branches (`refs/heads/automata/task-1a2b3c4d`, `refs/heads/automata/fix-…`, `refs/heads/feat/x`).
  - `openStep` throws `RangeError("allowedRef must be null or a refs/heads/ branch ref")` when the validator fails.
  - Reusing it inside the worker's `selfHealRefFence` is optional and not part of this PR. If it is done, the existing worker tests must still pass.
- **`openStep`:**
  - Add the required `step.allowedRef: string | null`. Insert it into the row.
  - Add `sql\`${cellStep.allowedRef} IS NOT DISTINCT FROM ${step.allowedRef}\``(or the drizzle equivalent) to the`onConflictDoUpdate` `where`.
  - Extend the read-back select and the `conflict` branch (:147-153) with the same comparison, so that re-opening with a different ref, including null against a ref, returns `conflict` before any other reason.
  - Never update `allowed_ref` on conflict: it is immutable for the life of the step.
- **`resolveBearer`:** select `cellStep.allowedRef` and put it in `BearerContext.allowedRef: string | null`. Also update the module doc comment (:7-36) and the `openStep` doc (:71-78).
- **Test helpers:**
  - `createTestCellStep` gains `allowedRef?: string | null`, defaulting to `"refs/heads/feat/x"` so the existing push tests keep their meaning. Document the default. A test that needs null passes `allowedRef: null` explicitly.
  - Update `cell-authority.test.ts`'s `newStep` the same way.
  - `real-git.test.ts`'s `step()` and `setup()` take the ref each case pushes.
- **Migration:** `deploy/migrations/2026-11-15-cell-step-allowed-ref.sql`. Its header is `-- migrate:expand` plus a short comment (#610; NULL means the step does not push; apply before deploying the www revision that reads it). The single statement is `ALTER TABLE "cell_step" ADD COLUMN IF NOT EXISTS "allowed_ref" text;`. Add `allowedRef: text("allowed_ref")` to `schema.ts` with a doc comment, with no default and nullable. No allowlist entry.
- **Migrate suite:** bump 22 to 23 and append the id at every pinned site listed under Ground truth → Migrations.
- **Order (amendment 12 of #606 holds):** the fence runs after the probe check and before `mintPushToken`. No claim, mint or settings read happens on a refusal. Fetch, the advert and the probe are unaffected.
- **Formatting:** `pnpm exec prettier --no-editorconfig --config .prettierrc --write <files>`. The `.editorconfig` otherwise disagrees with the repo's prettier config.
- **Docker:** the shared, www and migrate suites start a docker compose Postgres. Run them unsandboxed, as `real-git.test.ts` also needs local port binding.
- **Content:** no client or customer names in code, tests, comments or the PR.
- **TypeScript (AGENTS.md):**
  - strict mode; `interface` for object shapes and literal unions instead of enums;
  - no `any`, no `!` without a justifying comment;
  - `??` instead of `||`, `async`/`await` only;
  - narrow `unknown` in catches, never swallow errors, never log a token or bearer;
  - kebab-case files, English identifiers.
- Do not touch `CELL_BROKER_ENABLED` and do not add an `openStep` production caller: both belong to PR 4.

## Gates

Run them in this order; each must be green before shipping:

```bash
pnpm --filter @terragon/utils exec vitest run --no-file-parallelism
pnpm --filter @terragon/shared exec vitest run --no-file-parallelism src/model/cell-authority.test.ts
pnpm --filter @terragon/www exec vitest run --no-file-parallelism src/server-lib/cell-broker
pnpm --filter @terragon/migrate exec vitest run --no-file-parallelism
node deploy/lint-migrations.ts
pnpm turbo tsc-check
pnpm turbo lint
pnpm turbo format-check
pnpm --filter @terragon/shared exec vitest run --no-file-parallelism   # full shared suite, before ship
```

- `pnpm --filter @terragon/cell-broker exec vitest run` does not apply. The package has no tests and no vitest dependency; its tests live in `apps/www/src/server-lib/cell-broker/`.
- The shared, www and migrate suites need Docker Postgres (run unsandboxed). `real-git.test.ts` needs local port binding, or its cases skip.
- In CI, `schema-drift` must be green with `drift-allowlist.json` still `[]` (AC1).

## Validate round 1 (PASS_WITH_WARNINGS) — fixes folded in

These override anything above that conflicts with them.

- **F1, null fence placement.** The `allowedRef === null` → 403 `no_ref_fence` check sits **inside** the same `section.commands.length > 0` guard as `checkRefFence`, between the zero-command block (`git.ts:647-661`) and `mintPushToken` (`:663`). The probe of a null-fence step still passes through unchanged. A test pins this.
- **F2, AC5 scope and the real-git assertions.**
  - "No `mintWriteToken` call" applies to the receive-pack **POST** only. The receive-pack advert still mints for a null-fence step (`git.ts:819-837`), so the test spies are scoped to the POST.
  - The real-git fence test asserts three concrete things: `git push` exits non-zero, its stderr contains `403`, and the bare repo's target ref is unchanged (`git rev-parse --verify` fails, or still points at the old sha).
- **F3, `isBranchRef` rules (decided: fail closed).** On top of git's ref-format rules, `isBranchRef` also refuses:

  - a branch name starting with `-`;
  - the name `HEAD` (that is, `refs/heads/HEAD`).

  Each gets a test case.

- **F4.** The Contract's "the same ones `selfHealRefFence` applies" is superseded. Do not reuse that regex: it refuses `/`. `isBranchRef` in `@terragon/utils/receive-pack-refs` is the validator.

## Phases (from the validator)

1. **Validator.**
   - Files: `packages/utils/src/receive-pack-refs.ts` and its test.
   - Change: add the pure `isBranchRef`.
2. **Storage.**
   - Files: `deploy/migrations/2026-11-15-cell-step-allowed-ref.sql`, `packages/shared/src/db/schema.ts`, and the migrate tests (`cli`, `runner`, `files`).
   - Change: the migrate test counts go from 22 to 23, and the new id is appended.
3. **Authority model.**
   - Files: `packages/shared/src/model/cell-authority.ts`, its test, and `test-helpers.ts`.
   - Change: `openStep` takes `allowedRef`, validates it (`RangeError`), and turns a different ref into `conflict` (both in the upsert `where` and in the read-back). `BearerContext.allowedRef` is filled by `resolveBearer`. The `createTestCellStep` default is `refs/heads/feat/x`.
4. **Broker fence.**
   - Files: `packages/cell-broker/src/git.ts`, and in `apps/www/src/server-lib/cell-broker/` the `git-push`, `common` and `real-git` tests.
5. **Full gates.**
