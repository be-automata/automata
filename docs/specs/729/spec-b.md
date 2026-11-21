# #729 part B: a mention that cannot start says why

Part B of #729 ships before part A and can be reverted on its own (ticket § Risks). It covers
Scope B.1–B.3 and AC-7, AC-8, AC-9 and AC-10. Decision OD-4 applies: explain and start nothing,
no fallback to the base branch.

## 1. Ground truth (re-verified at `main` = `3a895870`, 2026-11-21)

| #   | Fact                                                                                                                                                                             | Where                                                                                                                                                                                                                        |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | A PR mention reads `pulls.get`, refuses a fork head with `CROSS_REPO_MENTION_REPLY`, then works on `pr.head.ref`. It never reads `pr.state` or `pr.merged`.                      | `apps/www/src/app/api/webhooks/github/org-mention-lane.ts` (`handleOrgLaneMention`, the `input.isPullRequest` branch)                                                                                                        |
| G2  | `runAutomation` wraps thread creation in a `try`, logs `Error running automation <id>:`, and returns `undefined`. Seven call sites read `result?.threadId` or the boolean.       | `apps/www/src/server-lib/automations.ts` (the `catch` before `return undefined`); callers: `org-mention-lane.ts`, `cron.ts`, `audit/run-audit-fix.ts`, `delivery/run-delivery-fix-cycle.ts`, `server-actions/automations.ts` |
| G3  | Thread creation calls `ensureBranchExists` on the working branch, which throws `BranchDoesNotExistError` (a `UserFacingError`) for a missing branch.                             | `apps/www/src/server-lib/new-thread-shared.ts`; `apps/www/src/lib/github.ts` (`BranchDoesNotExistError`)                                                                                                                     |
| G4  | When `threadId` is `undefined`, the lane posts `MENTION_NOT_STARTED_REPLY` ("Mention me again to retry") whatever the cause.                                                     | `org-mention-lane.ts` (`if (threadId === undefined)`)                                                                                                                                                                        |
| G5  | `reply()` is suppressed in shadow mode and only logged. The intake claim is kept on every early `return true`.                                                                   | `org-mention-lane.ts` (`const reply`, `claimIntake`/`releaseIntake`)                                                                                                                                                         |
| G6  | Production evidence: on 2026-11-20 at 22:23 UTC, a mention on a merged client PR whose head branch had been deleted got the generic reply 10 s later, and no thread was created. | operator report (client repo, not named here)                                                                                                                                                                                |

## 2. Design

1. **Merged or closed PR** (B.1, AC-7, AC-8). After the fork check, `pr.merged || pr.state === "closed"`
   replies `closedPrMentionReply({ merged, headRef })` and returns. There is no eyes reaction, no thread
   and no claim release. The text names the state and the branch and points to the issue or an open PR.
   There is no `repos.getBranch` call: the state alone decides, so "merged, branch deleted" and
   "merged, branch kept" get the same reply.
2. **Open PR whose head is gone, or a missing default branch** (B.1, B.2). `runAutomation` gains an
   optional `options.onStartFailure(error)` hook, called inside its existing `catch` (a throwing hook is
   logged and ignored). The return value is unchanged for every caller. The lane records the error. A
   `BranchDoesNotExistError` gets `missingBranchMentionReply({ branch, isPullRequest })` (worded "I couldn't find …; if it was deleted, restore it …; if it still exists, mention me again", because `ensureBranchExists` raises the error for any failed branch read, not only a 404) with reason
   `head_branch_missing` or `branch_missing`. Anything else keeps `MENTION_NOT_STARTED_REPLY` with
   reason `start_failed`. This also covers a branch deleted between `pulls.get` and thread creation, with no extra API call.
3. **Branch names are untrusted.** Every reply renders the ref through `safeGitRef`
   (`server-lib/review/pr-diff-context.ts`); an unsafe name becomes "its branch", so a backtick or `@`
   in a ref cannot close the code span or mention anyone.
4. **One reason per no-thread answer** (B.3, AC-9). `reply(body, reason)` logs
   `no thread reason=<reason> — replying` (or `[shadow] no thread reason=<reason> — reply suppressed`)
   with `reason` also as a log field. The reasons are a closed union, `MentionNoThreadReason`:
   `empty_instruction`, `cross_repo`, `pr_merged`, `pr_closed`, `head_branch_missing`,
   `branch_missing`, `start_failed`.

**Deviation from the ticket's sketch.** The ticket suggests `repos.getBranch` for the open-PR, missing-head
case. This spec uses the `BranchDoesNotExistError` that thread creation already raises, so the outcome is
the same, there is no extra GitHub call per PR mention, and the race above is covered.

## 3. Acceptance criteria covered

- **AC-7, AC-8:** `org-mention-lane.test.ts` "#729 a mention on a PR that is …" (merged; closed and unmerged),
  plus odd payloads (`merged` missing with `merged_at` set or null) and a review-comment mention: the named
  reply, no `runAutomation`, no reaction, never "Mention me again", `reason` logged, and the branch never
  read (so a deleted and a kept branch get the same reply).
- **AC-9:** the named reply for an open PR whose head is gone, the issue default branch missing,
  `start_failed` keeping the generic text, and a redelivered merged-PR mention answered once.
- **AC-10:** the shadow test extended: a merged-PR refusal in shadow posts nothing.
- `automations.test.ts`: `onStartFailure` receives the swallowed error, the return stays `undefined`, and a
  throwing hook does not escape.

## 4. Gates

`pnpm turbo tsc-check lint format-check --force`; `@terragon/www` vitest (full).
