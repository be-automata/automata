# #729 part A: an authorized issue mention can open a draft PR

Part A of #729 covers Scope A.1–A.6 and AC-1 to AC-6 and AC-11. It stacks on part B (PR #736,
`fix/729b-mention-named-reasons`), which changes the same lane. Decisions OD-1 to OD-7 are taken
(ticket § Decisions): keep the write-capable gate (OD-1), mention PRs are always draft (OD-2), the
branch is `automata/task-<id8>` (OD-3), the PR says `Refs #N` (OD-5), the PR is opened by the mention
run and an "implement this issue" reply also names the `automata:deliver` label (OD-6), and the owner's
`autoCreatePRs` off is respected (OD-7).

No code is written by this spec. Examples use `acme/widgets`.

## 1. Ground truth (re-verified at `85d64b10` = part B on top of `main` = `3a895870`, 2026-11-21)

The ticket's reality check was written at `b84dbd69`. Each of its rows is re-checked below at its new
location. **Status:** `holds` (the fact is unchanged, maybe at new lines), `changed` (still true but
different in a way that matters), or **`no longer holds`**. Rows G17 to G24 are new facts the ticket
did not have.

| #   | Fact (ticket row, re-checked)                                                                                                                                                                                                                                                                                                                                                                           | Where (now)                                                                                                                                                                                                                                           | Status              |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------ |
| G1  | Trigger gate: a whole-token `@<slug>`, not a bot, association OWNER/MEMBER/COLLABORATOR **and** write/maintain/admin from `getCollaboratorPermissionLevel`; any error denies; a denied commenter gets no reply.                                                                                                                                                                                       | `apps/www/src/app/api/webhooks/github/org-mention-lane.ts:41-47` (doc), `:58-69` (sets), `authorizeCommenter` `:213-250`, call `:484-506`, silent skip `:498-506`                                                                                    | holds (moved)       |
| G2  | Branch selection: PR → `pulls.get`, fork head → `CROSS_REPO_MENTION_REPLY`, else `branchName = pr.head.ref`; issue → `repos.get().default_branch`. Ticket: "the code never checks `pr.state`, `pr.merged`".                                                                                                                                                                                         | PR `:563-605`, fork `:571-574`, **state check `:575-587`**, issue `:606-620` (now `repos.get` in parallel with `issues.get`, #727)                                                                                                                   | **no longer holds** (part B checks merged/closed) |
| G3  | The run starts with `runAutomation({ options: { branchName, prBaseBranchName, prNumber \| issueNumber, transformMessage, stampExtra: { mention } } })`.                                                                                                                                                                                                                                              | `org-mention-lane.ts:643-673`; now also `pullRequest` (#727), `isDraft` on the stamp (#504), `onStartFailure` (part B)                                                                                                                                | changed (more options) |
| G4  | A mention stamp turns git checkpointing off, comment "the agent pushes its own fix to the PR head, and the lane never auto-commits or opens a pull request".                                                                                                                                                                                                                                         | `apps/www/src/server-lib/automations.ts:165-167` (comment), `:413-416` (rule: `mention !== undefined \|\| companion !== undefined \|\| automation.disableGitCheckpointing`)                                                                            | holds (moved; companion added) |
| G5  | `runAutomation` catches every error in its body, logs `Error running automation <id>:` and returns `undefined`; only `validateCanRunAutomation` throws.                                                                                                                                                                                                                                              | `automations.ts:209-214` (validate, outside the `try`), `:448-466` (catch); the catch now also calls `options.onStartFailure` `:450-454`                                                                                                              | changed (part B hook) |
| G6  | The lane posts `MENTION_NOT_STARTED_REPLY` for every `threadId === undefined`; the reason is never posted.                                                                                                                                                                                                                                                                                         | `org-mention-lane.ts:683-698`: a `BranchDoesNotExistError` gets `missingBranchMentionReply` with `reason=head_branch_missing\|branch_missing`; the generic text stays for `start_failed`                                                              | **no longer holds** (part B) |
| G7  | Thread creation runs `ensureBranchExists` on the working branch (passed as `baseBranchName` for a PR mention); a missing branch throws `BranchDoesNotExistError`.                                                                                                                                                                                                                                   | `apps/www/src/server-lib/new-thread-shared.ts:157-171`; `apps/www/src/lib/github.ts:36` (`ensureBranchExists`), `:102` (`BranchDoesNotExistError`)                                                                                                   | holds               |
| G8  | The skill forbids pushing on an issue: "On an **issue** there is no branch to push … push nothing"; "**Never open a pull request and never push to any branch but the PR head you are on.** On an issue, push nothing." `Bash` is for `git push` "on a pull request only".                                                                                                                        | `deploy/skills/github-mention/SKILL.md:20`, `:44`, `:83` (also `:16`, `:40` describe issues as no-push); `deploy/skills/PROVENANCE.md:163` (edit **M5. Issues push nothing.**)                                                                     | holds (+ `:16`, `:40`, PROVENANCE M5) |
| G9  | `remoteTaskBranchName(threadId)` = `automata/task-<first 8 of id, lowercased>`; `taskRunPushBranch` returns it for a run with no PR whose branch is the base.                                                                                                                                                                                                                                       | `apps/www/src/server-lib/task/remote-task-pr.ts:59-61`, `:71-88`                                                                                                                                                                                     | holds               |
| G10 | Dispatch gives a plain task run that work branch; the worker checks it out after the clone.                                                                                                                                                                                                                                                                                                         | `apps/www/src/agent/hatchet/dispatch.ts:1137-1141` (`isPlainTaskRun`), `:1184-1193` (`push`/`workBranch`), `:1228`; worker `packages/worker/src/agent-run/provision.ts:197-218`, cell `packages/worker/src/agent-run/cell-image.ts:252-262`          | holds               |
| G11 | The cell fences pushes to that ref: `cell-plan` opens the step with `allowedRef: refs/heads/${taskRunPushBranch(...)}`; the broker refuses any other ref with 403 before minting a token.                                                                                                                                                                                                         | `apps/www/src/app/api/daemon/cell-plan/route.ts:197-205` (`pushBranch`), `:224` (`allowedRef`); `packages/cell-broker/src/git.ts:663-672` (`checkRefFence` → 403)                                                                                   | holds               |
| G12 | The box git broker fences refs only when `refFence` is set, which today means the self-heal fix lane; other box runs can push any ref of the repo.                                                                                                                                                                                                                                                  | `packages/worker/src/agent-run/git-broker.ts:40-48` (doc), `:83-86` (option), `:94-98` (validation), `:187-188` (gate); wiring `packages/worker/src/agent-run/workflow.ts:835-849` (`selfHealRefFence`), `:1209-1214`, `:1485`                        | holds               |
| G13 | At finish, a remote run with no PR calls `openRemoteTaskPullRequest`, which skips on `has_pr`, `checkpointing_off`, `auto_create_off`, compares base…work branch, adopts or creates (draft unless `prType` is `ready`), authored by the owner's token with App fallback.                                                                                                                           | `apps/www/src/server-lib/handle-daemon-event.ts:773-813`; `remote-task-pr.ts:224-335` (skips `:249-260`, compare `:266-281`, adopt `:283-290`, draft `:310`, create `:150-222`)                                                                         | holds (moved)       |
| G14 | The mention reply is a separate `waitUntil`, unordered with the PR open; the reply appends `_Pushed <sha>._` when `commit` is set.                                                                                                                                                                                                                                                                  | PR open `handle-daemon-event.ts:774-812` vs reply `:851-867`; `apps/www/src/server-lib/review/mention-reply-finish.ts:185-195` (`renderMentionReply`)                                                                                                 | holds (moved)       |
| G15 | Issue delivery turns an issue into a draft PR through the same opener, then enrols the PR in the delivery loop (skill-gated).                                                                                                                                                                                                                                                                     | `deploy/skills/issue-delivery/SKILL.md:1-12`, `:160`, `:190`; `apps/www/src/server-lib/delivery/enroll.ts:11-12` (`DELIVERY_SKILL_NAME`), `:34-60`; enrol call `handle-daemon-event.ts:787-800`                                                       | holds               |
| G16 | ADR-004: a PR-write run gets GitHub write only through the per-run broker. ADR-014: no cell holds a long-lived credential; one resolver decides.                                                                                                                                                                                                                                                  | `docs/adr/ADR-004-review-lane-emit-only-credential-fence.md:65-69`, `:102-107`; `docs/adr/ADR-014-third-party-execution-compute.md:40`, `:47`                                                                                                         | holds               |
| G17 | **New.** The "is issue" fact is already on the stamp: `MentionLaneStamp.isPullRequest: boolean`, written by `buildMentionStamp` from the webhook input. A review comment is always on a PR (`isPullRequest: true`).                                                                                                                                                                                  | `packages/shared/src/db/types.ts:221-245`; `org-mention-lane.ts:710-731`; guard `apps/www/src/server-lib/review/review-skill.ts:603-610` (`isMentionLaneStamp`)                                                                                       | new                 |
| G18 | **New, load-bearing.** The onboarded mention automation row itself sets `disableGitCheckpointing: true`. Narrowing only the `mention !== undefined` clause in G4 would leave issue mentions OFF through `automation.disableGitCheckpointing`.                                                                                                                                                       | `deploy/lib/onboard-review-repo-args.ts:335-361` (`buildMentionAutomation`, `:360`)                                                                                                                                                                   | new                 |
| G19 | **New.** An issue mention ALREADY gets the work branch at dispatch today: `prNumber` is undefined and `branch === thread.repoBaseBranchName` (the default branch), so `taskRunPushBranch` returns `automata/task-<id8>` and `workBranch` is set (box). `cell-plan` derives the same ref (cell). Checkpointing is not an input of either. For thread `f8efdf72` the cell fence was `refs/heads/automata/task-f8efdf72`. | `dispatch.ts:1184-1193`; `cell-plan/route.ts:199-205`; `disableGitCheckpointing` is read only in www (`automations.ts`, `new-thread-shared.ts:327`, `handle-daemon-event.ts:591`, `remote-task-pr.ts:255`), never in `packages/worker` or `packages/daemon` | new                 |
| G20 | **New.** A PR mention thread stores `branchName: null`, `repoBaseBranchName: pr.head.ref`, `githubPRNumber: N`. So `taskRunPushBranch` returns null for it: dispatch sets no `workBranch`, and **`cell-plan` refuses a PR mention with 409 `work_branch_unresolved`**. PR mentions therefore cannot run in a cell today. Out of scope here (§7).                                                     | `automations.ts:318-321`, `:369-371` (`headBranchName: null`); `new-thread-shared.ts:233-234`; `cell-plan/route.ts:205`; test `cell-plan/route.test.ts:429-443`                                                                                       | new (follow-up)     |
| G21 | **New.** The remote plane never creates a branch from `createNewBranch`: `startAgentMessage` passes only `branch` to `dispatchAgentRun`. Turning checkpointing on changes `createNewBranch` only for the in-process sandbox path (`HATCHET_ENABLED` off and provider not `hatchet-remote`).                                                                                                       | `new-thread-shared.ts:325-329`, `:379`; `apps/www/src/agent/msg/startAgentMessage.ts:400-411`; `dispatch.ts:487-491` (`hatchetDispatchEnabled`)                                                                                                       | new                 |
| G22 | **New.** On both computes the agent's `gh` is read-only, so `gh pr create` is refused by the platform, not only by the skill: box gh broker allows GET/HEAD and mutation-free GraphQL (`403` otherwise); cell gh broker is read-only too.                                                                                                                                                         | `packages/worker/src/agent-run/gh-broker.ts:42-48`; `packages/cell-broker/src/gh.ts:21-26`                                                                                                                                                            | new                 |
| G23 | **New.** The box broker is on unless `WORKER_CREDENTIAL_BROKER=legacy-direct`; a self-heal fix run on a broker-off box is refused before the clone.                                                                                                                                                                                                                                                | `packages/worker/src/agent-run/config.ts:693-696`; `workflow.ts:1209-1214`                                                                                                                                                                            | new                 |
| G24 | **New.** The timeout salvage pushes `workBranch` through the git broker when a run times out, so an issue mention that timed out today can already push `automata/task-<id8>` (and no PR opens: checkpointing is off and the typed-terminal path runs no PR hook).                                                                                                                               | `packages/worker/src/agent-run/abnormal-end.ts:530-534`, `:607-664`; typed terminal `mention-reply-finish.ts:503-539`                                                                                                                                 | new                 |
| G25 | **New.** The mention skill text is pinned by one test, which reads the tracked file and runs the lane's validator on it. There is no other golden for it.                                                                                                                                                                                                                                         | `apps/www/src/server-lib/review/mention-reply-finish.test.ts:845-883`; skill push `deploy/skill-push.ts:1-48`; seed body `deploy/lib/seed-skill-bodies.ts:32-37`                                                                                     | new                 |

**Ticket rows that no longer hold:** G2 (part B now checks `merged`/`merged_at`/`state`), G6 (part B names the
`BranchDoesNotExistError` reason). Changed: G3 and G5 (part B and #727 added options and the hook). The
ticket's DoD names "cell-broker suites": `packages/cell-broker` has no test script; its tests live in
`apps/www/src/server-lib/cell-broker/*.test.ts` (the #610 ref fence: `git-push.test.ts:1327+`). The ticket's
test bullet "Cell broker: add one with an issue-mention step" is better placed in `cell-plan/route.test.ts`
(the broker is step-agnostic; the ref comes from `cell-plan`).

**What does not exist yet (re-checked):** a mention path that opens a PR; a ref fence on box mention runs;
ordering between the PR-open hook and the mention reply; any control-plane rule that a mention PR is draft
or carries `Refs #N`.

## 2. Design

### D1. Checkpointing ON for issue mentions, OFF for PR mentions (A.1, AC-1, AC-6)

The "is issue" fact is `stampExtra.mention.isPullRequest === false` (G17). No new stamp field.

In `runAutomation`'s skill_message branch (`automations.ts:413-416`) the mention stamp **decides on its own**
for mention threads, and the automation row's flag no longer applies to them (G18):

```ts
disableGitCheckpointing: options?.stampExtra?.mention
  ? options.stampExtra.mention.isPullRequest
  : options?.stampExtra?.companion !== undefined ||
    (automation.disableGitCheckpointing ?? false),
```

The onboarded rows keep `disableGitCheckpointing: true` (no DB change, and a revert restores today's
behaviour exactly). The comments at `automations.ts:165-167` and `onboard-review-repo-args.ts:335-338` are
updated to say the mention stamp decides. The `user_message` branch (`:261`) is unchanged: the org lane
only accepts `skill_message` automations (`org-mention-lane.ts:256`).

### D2. The work branch on both computes (A.1, OD-3) — no code

An issue mention already gets `automata/task-<id8>` at dispatch on the box and as `allowedRef` in the cell
(G19). Checkpointing is not an input of either. Part A adds a test that pins it for a mention-stamped
issue thread in `cell-plan/route.test.ts`, and reuses the existing dispatch test
(`dispatch.test.ts:1608`) for the box. The in-process sandbox path (G21) is not a production path for org
threads and keeps the existing sandbox checkpoint behaviour (§6, risk R4).

### D3. Reuse `openRemoteTaskPullRequest` with a mention PR policy (A.2, A.3, OD-2, OD-5, OD-7)

The compare, adopt-or-create, author fallback and DB writes stay as they are. Two small changes are added,
both decided from the thread it already reads (`remote-task-pr.ts:245-248`):

1. **The `checkpointing_off` skip goes away for issue mentions on its own**, because D1 stores
   `disableGitCheckpointing: false` on those threads. The skip (`:255-257`) stays for every other thread.
   A PR mention never reaches it anyway: its thread has `githubPRNumber`, so the finish hook is not called
   (`handle-daemon-event.ts:773`), and `has_pr` (`:252-254`) is the backstop.
2. **A pure policy** `mentionPullRequestPolicy(thread.sourceMetadata)` returns `{ issueNumber }` for a
   mention stamp with `isPullRequest === false`, else `null`. When it returns a value:
   - `draft` is `true` whatever `settings.prType` is (OD-2). Task runs keep `settings.prType !== "ready"`
     (`:310`), unchanged.
   - The body goes through `withIssueReference(body, issueNumber)` in `createPullRequest`, after the
     agent block or the generated or fallback body is chosen and before the task link (`:184-208`):
     a. every GitHub closing keyword in front of an issue reference (`close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved`,
        case-insensitive, optional `:`, `#N` or `owner/repo#N`) is rewritten to `Refs <ref>`, so a
        mention PR never auto-closes an issue on merge (OD-5), whatever the agent's `json pull-request`
        block says;
     b. if no `Refs #<issueNumber>` line is left, `\n\nRefs #<issueNumber>` is appended.
   - An **adopted** PR (`:283-290`) is not edited: it was opened by an earlier run of the same thread
     under the same policy.
3. **OD-7:** `auto_create_off` (`:258-260`) is unchanged and is checked before any GitHub call. D4 reports
   it in the reply.

### D4. Reply after the PR outcome (A.5, AC-2, AC-5, OD-6, OD-7) — one design: the reply awaits the outcome

Chosen: **the reply is written after the PR outcome**, by handing the mention hook the PR hook's promise.
Sequencing the two `waitUntil`s for mention threads only would need a thread read before choosing the
order; the promise needs none and costs nothing for other threads.

- `handleThreadFinish` (`handle-daemon-event.ts:773-813`): the PR open becomes one promise
  `remotePr: Promise<RemoteTaskPrOutcome | null> | undefined`, defined only under the existing condition
  (`sandboxId === null && prNumber === null && repoFullName && !isStop`). It never rejects: an error is
  logged as today (`[remote-task-pr] finish-hook failed (non-fatal)`) and resolves `null`. The enrol step
  chains on it as today, inside its own `waitUntil`.
- `handleMentionReplyAtFinish` gains `remotePullRequest?: Promise<RemoteTaskPrOutcome | null>`. After the
  stamp, silent-cause and shadow checks, and **only when `stamp.isPullRequest === false`**, it awaits it.
  The typed-terminal entry (`handleMentionRepliesAtTerminal`, `:503-539`) passes nothing: no PR was
  attempted there.
- `executeMentionReply` gains `pullRequest?: RemoteTaskPrOutcome | null` and appends one line before the
  marker on every body it posts (parsed reply, provider notice, terminal notice, generic notice):

  | Outcome                                       | Line                                                                                                 |
  | :-------------------------------------------- | :--------------------------------------------------------------------------------------------------- |
  | `opened`                                      | `Opened a draft pull request: https://github.com/<repoFullName>/pull/<n>`                           |
  | `adopted`                                     | `Updated the open pull request: https://github.com/<repoFullName>/pull/<n>`                         |
  | `skipped: auto_create_off`                    | `_No pull request was opened: automatic pull requests are turned off in the task owner's settings._` |
  | `skipped: no_changes` or `no_branch`          | `_No pull request was opened: no changes were pushed._`                                              |
  | other skips, `null`, or no promise            | no line (the outcome is logged)                                                                     |

  The repo comes from the stamp; the URL is built there (no helper exists in the repo for it).
  Order in the body: reply text, `_Pushed <sha>._`, the PR line, the delivery hint, the marker.
- **OD-6.** The lane sets a new optional stamp field `asksForDelivery?: true` on issue mentions whose
  instruction matches `/\bimplement\b.{0,20}\bissue\b/i` (`isDeliveryAsk(instruction)`, exported and unit
  tested: "implement this issue", "please implement the issue as written", "implement issue #12"; not
  "how would you implement the cache?"). It is added to `MentionLaneStamp` (`types.ts:221`) and written
  only when true, so every existing stamp stays key-for-key the same. The reply then appends
  `For the full delivery pipeline (spec, gated implementation and the fix loop), add the \`automata:deliver\` label to this issue.`
  The label name is the literal the delivery lane already uses (`delivery-effects.ts:206`); a repo
  without that automation gets a hint that does nothing (risk R6).

### D5. The box fences mention pushes (A.6, AC-4, AC-6)

The worker learns the fence from a new optional dispatch field, mirrored in both input types:

- www `AgentRunInput.pushRef?: string` (`dispatch.ts`, next to `workBranch` `:455-462`) and worker
  `AgentRunInput.pushRef?: string` (`packages/worker/src/agent-run/types.ts`, next to `workBranch` `:178-183`):
  "the one fully-qualified ref this run may push; set for mention-lane threads only".
- Dispatch sets it only when `isMentionLaneStamp(thread?.sourceMetadata)`:
  - issue mention → `refs/heads/${push}` (`push` from `taskRunPushBranch`, `:1186-1191`, which is
    `automata/task-<id8>`, the same value as `workBranch` and as the cell's `allowedRef`);
  - PR mention → `refs/heads/${branch}`, the PR head the run clones (`taskRunPushBranch` returns null
    for it, G20).
  - A blank result throws into the existing dispatch catch (token revoked, thread failed): a mention is
    never dispatched unfenced. Every other run carries no `pushRef`, so the golden payload
    (`__fixtures__/transport.golden.json`) is unchanged.
- Worker `workflow.ts:1209`: `const refFence = selfHealRefFence(input.selfHeal) ?? pushRefFence(input.pushRef)`.
  `pushRefFence` returns `{ exactRef }` after `isBranchRef`, and throws on an invalid ref. The existing
  broker-off refusal (`:1210-1214`) then applies to mention runs too (G23), with its message generalised
  ("a fenced run requires the credential broker"). `startGitBroker` is unchanged: it already refuses any
  other ref, a tag, a delete and a malformed command list with 403/415 (`git-broker.ts:40-48`).
- The cell executor ignores `pushRef`: the cell's fence is `allowedRef` from `cell-plan` (G11), and the
  two derive the issue ref from the same `taskRunPushBranch`.
- The timeout salvage (G24) pushes `workBranch` through the same broker, so it stays inside the fence.

### D6. Skill text (A.4, AC-11)

`deploy/skills/github-mention/SKILL.md`:

- `:16`: on an issue, the working directory is the run's own work branch, cut from the default branch.
- `:20`: `Bash` is for reading, and for `git commit` + `git push origin HEAD` of a code change: on a pull
  request that is the PR head, on an issue the work branch that is checked out.
- `:40` heading drops "— pull requests only". `:44` becomes: on an **issue**, commit on the checked-out
  branch and run `git push origin HEAD`; never create, rename or switch branches; never run
  `gh pr create`; the platform opens a draft pull request that references the issue and links it under
  your reply. Write `Refs #<N>` in commit messages, never `Closes`/`Fixes`. A question pushes nothing.
- `:83` becomes: **Never open a pull request yourself, and never push any ref but the one checked out**
  (the PR head on a pull request, the work branch on an issue): `git push origin HEAD` only.

`deploy/skills/PROVENANCE.md:163` (M5) is rewritten to the new rule. The pin test
(`mention-reply-finish.test.ts:845-883`) gains: the tracked file contains `git push origin HEAD` and
`gh pr create`, and no longer contains `On an issue, push nothing`; the validator still accepts it.

**Push (operator step, not code).** After www and the worker are deployed, per repo on the org lane:
`DATABASE_URL=… pnpm exec tsx deploy/skill-push.ts <orgSlug> acme/widgets github-mention deploy/skills/github-mention/SKILL.md`
(`--dry-run` first for the sha). Pushing the skill before www would make agents push a branch that no
PR opens for (checkpointing still off): deploy order is worker, www, then the skill. The version id is
noted in the PR.

### D7. AC-3 negative controls: unchanged paths

Part A does not touch the gate. The controls are the existing code and tests:

- association pre-filter `org-mention-lane.ts:224-226`; permission API error `:228-236`; read/triage
  `:245-249`; the lane skips with no claim and no reply `:498-506`, before `runAutomation` `:643`.
- tests: `org-mention-lane.test.ts:113-165` ("authorizeCommenter (fail-closed)", "denies read/triage and
  any API failure"), `:467` ("an unauthorised commenter … starts nothing"), `:479` ("a permission API
  error denies (fail-closed)"). Part A adds one issue-shaped variant of `:467` asserting `runAutomation`
  is never called.

## 3. Alternatives checked

| Choice                    | Alternative                                                                                       | Why not                                                                                                                                                         |
| :------------------------ | :------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 stamp decides          | Flip the onboarded rows to `disableGitCheckpointing: false`                                       | A prod DB write per repo, and the row would then turn checkpointing on for PR mentions too unless the stamp clause stays. The stamp already carries the fact. |
| D1 no new field           | A `mentionTarget: "issue" \| "pr"` stamp field                                                    | Duplicates `isPullRequest` (G17).                                                                                                                              |
| D3 policy inside opener   | Pass `{ forceDraft, issueRef }` from `handleThreadFinish`                                         | The caller has no stamp in hand (it would need a thread read); the opener already reads the thread.                                                           |
| D3 rewrite closing words  | Append `Refs #N` only                                                                             | A `Closes #N` left in the agent's body still closes the issue on merge, which OD-5 rejects.                                                                    |
| D4 await the promise      | Sequence the two `waitUntil`s for mention threads; or have the PR hook post the reply             | The first needs a thread read before deciding; the second moves the mention writer's idempotency and terminal logic into the PR hook.                          |
| D4 URL in reply           | `#<n>` autolink                                                                                    | Works on GitHub, but the ticket's test asks for the URL; the URL also reads unambiguously in email notifications.                                             |
| D4 OD-6 deterministic     | Tell the agent in the skill to mention the label                                                  | Not testable, and a model can forget it.                                                                                                                       |
| D5 explicit `pushRef`     | Fence every box run that has `workBranch`                                                         | Changes manual and scheduled task runs too, and cannot fence PR mentions (no `workBranch`). A follow-up can widen it to every task run for cell parity.        |
| D5 refuse when broker off | Run unfenced on a `legacy-direct` box                                                             | The fence would then depend on box config; the self-heal lane already set the fail-closed precedent (G23).                                                   |
| Second PR opener          | A mention-specific opener                                                                         | Forbidden by A.2; the existing one already does compare, adopt, author fallback.                                                                               |

## 4. Risks

- **R1. Wider write surface.** An issue comment can now produce a pushed branch and a draft PR. Mitigations:
  the unchanged write-capable gate (D7), the one-ref fence on both computes (D5, G11), read-only `gh` on both
  (G22), draft only (D3), closing keywords neutralised (D3). Residual: a commit message written `Fixes #N`
  still closes the issue when merged into the default branch (GitHub reads commit messages); the skill
  forbids it (D6) and a human merges a draft.
- **R2. Stray branches.** A run that pushes and then ends on a typed terminal cause (timeout, OOM) gets no PR
  hook, so `automata/task-<id8>` stays without a PR (G24, already possible today through the salvage). A later
  run of the same thread adopts it (`remote-task-pr.ts:50-55`).
- **R3. Fence on broker-off boxes.** A mention on a `legacy-direct` box now fails at start instead of running
  unfenced. Production boxes run the broker by default (G23).
- **R4. In-process sandbox plane.** Where Hatchet dispatch is off, an issue mention with checkpointing on gets
  the sandbox checkpoint (`createNewBranch`, `checkpointThread`) and its PR rules (owner's `prType`, no `Refs`).
  Not a production path for org-lane threads (G21); recorded, not fixed.
- **R5. Reply latency.** The issue reply now waits for the compare, and for `generatePRContent` when the agent
  wrote no `json pull-request` block. Both are inside the same `waitUntil` budget as today.
- **R6. Delivery hint.** The `automata:deliver` hint is a literal; a repo without the delivery automation gets a
  hint that does nothing.
- **R7. Author.** The PR is authored by the automation owner's GitHub token (App fallback), not the commenter
  (`remote-task-pr.ts:40-48`), as for every task run.
- **Rollback.** Revert the PR, then re-push the previous `github-mention` skill version with `skill-push.ts`.
  No migration; the onboarded rows were never changed.

## 5. Tests per AC

| AC     | Tests (files)                                                                                                                                                                                                                                                                                                                                                                 |
| :----- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1   | `apps/www/src/server-lib/automations.test.ts`: an issue mention stamp → `createNewThread` gets `disableGitCheckpointing: false` even when the automation row has `true`. `apps/www/src/server-lib/task/remote-task-pr.test.ts`: an issue-mention thread opens a draft with `prType: "ready"`; its body ends with `Refs #N` with no agent block, with an agent block, and when the agent wrote `Closes #N` / `fixes acme/widgets#N` (rewritten); a plain task thread keeps `prType` and gets no `Refs`. `cell-plan/route.test.ts`: a mention-stamped issue thread gets `allowedRef = refs/heads/automata/task-<id8>`. |
| AC-2   | `apps/www/src/server-lib/review/mention-reply-finish.test.ts`: `executeMentionReply` appends the PR URL for `opened` / `adopted`, the `auto_create_off` and `no_changes` lines, nothing for `null`, on the parsed and notice bodies; `handleMentionReplyAtFinish` awaits the promise for an issue stamp and ignores it for a PR stamp. `apps/www/src/server-lib/handle-daemon-event.remote.test.ts`: for a remote issue-mention finish, the reply hook receives the PR hook's outcome (the reply is written after `openRemoteTaskPullRequest` resolves). |
| AC-3   | `apps/www/src/app/api/webhooks/github/org-mention-lane.test.ts`: existing `:113-165`, `:467`, `:479` re-run unchanged, plus one issue-mention read-permission case asserting no `runAutomation`, no claim, no reply.                                                                                                                                                         |
| AC-4   | `packages/worker/src/agent-run/workflow.test.ts`: `pushRefFence` returns the fence for `refs/heads/automata/task-…` and a PR head, throws on a tag or blank; a `pushRef` run on a `legacy-direct` box is refused. `packages/worker/src/agent-run/git-broker.test.ts`: a broker with `refFence: refs/heads/automata/task-abcd1234` refuses `refs/heads/main` (403) and forwards the work branch. `apps/www/src/agent/hatchet/dispatch.test.ts`: an issue-mention dispatch carries `pushRef` = the work branch; a non-mention task run carries none. Cell side: existing `apps/www/src/server-lib/cell-broker/git-push.test.ts:1327+` (#610 AC4) plus the AC-1 `cell-plan` case. |
| AC-5   | `mention-reply-finish.test.ts`: `no_changes` outcome → the parsed answer is posted with only the `no changes were pushed` line. `remote-task-pr.test.ts:265` (existing "skips when the branch is not ahead") covers the opener.                                                                                                                                                   |
| AC-6   | `automations.test.ts`: a PR mention stamp → `disableGitCheckpointing: true`. `dispatch.test.ts`: a PR-mention dispatch carries `pushRef = refs/heads/<head>` and no `workBranch`. `handle-daemon-event.remote.test.ts:166` (existing: a PR thread schedules the review effect, no PR open).                                                                                     |
| AC-11  | `mention-reply-finish.test.ts:845-883`: new assertions on the tracked skill (D6). `org-mention-lane.test.ts`: `isDeliveryAsk` cases and the stamp carries `asksForDelivery: true` only for a matching issue instruction (OD-6).                                                                                                                                                  |

UAT (ticket § Tests, on the org's own test repo after deploy and skill push): (a) an issue mention "fix the
typo in X" ends with a draft PR, `Refs #N`, linked in the reply; (c) a read-only account's mention gets nothing.
Step (b) is part B's.

## 6. Gates (every phase)

`pnpm turbo tsc-check --force`, `pnpm turbo lint`, `pnpm turbo format-check` (prettier with
`--config .prettierrc --no-editorconfig` when run by hand), and the vitest files the phase touches:
`pnpm --filter @terragon/www exec vitest run --no-file-parallelism <files>` /
`pnpm --filter @terragon/worker exec vitest run --no-file-parallelism <files>`. The full www and worker suites
run once before ship.

## 7. Out of scope, found while verifying

- **PR mentions cannot run in a cell** (G20): `cell-plan` refuses them with `work_branch_unresolved` because
  the thread's push branch resolves to null. Needs its own ticket (store the head as the thread's branch, or
  teach `taskRunPushBranch` about mention threads). Part A does not change it.
- Widening the box fence to every task run (D5 alternative), for parity with the cell.

## 8. phases[]

Each phase changes at most 5 files (tests count) and leaves every gate green on its own. Order: the PR
rules exist before anything can reach them, the fence exists before mentions push, and the skill comes last.

```yaml
phases:
  - id: P1
    goal: mention PR policy in the existing opener (always draft, Refs #N, closing keywords rewritten)
    files:
      - apps/www/src/server-lib/task/remote-task-pr.ts
      - apps/www/src/server-lib/task/remote-task-pr.test.ts
    acs: [AC-1, AC-5]
    gates: [tsc-check, lint, format-check, "www vitest src/server-lib/task/remote-task-pr.test.ts"]
  - id: P2
    goal: worker reads pushRef and fences the git broker to it
    files:
      - packages/worker/src/agent-run/types.ts
      - packages/worker/src/agent-run/workflow.ts
      - packages/worker/src/agent-run/workflow.test.ts
      - packages/worker/src/agent-run/git-broker.test.ts
    acs: [AC-4]
    gates: [tsc-check, lint, format-check, "worker vitest src/agent-run/workflow.test.ts src/agent-run/git-broker.test.ts"]
  - id: P3
    goal: dispatch sets pushRef for mention threads (issue = work branch, PR = head); pin the cell allowedRef for an issue mention
    files:
      - apps/www/src/agent/hatchet/dispatch.ts
      - apps/www/src/agent/hatchet/dispatch.test.ts
      - apps/www/src/app/api/daemon/cell-plan/route.test.ts
    acs: [AC-1, AC-4, AC-6]
    gates: [tsc-check, lint, format-check, "www vitest src/agent/hatchet/dispatch.test.ts src/agent/hatchet/dispatch-golden.test.ts src/app/api/daemon/cell-plan/route.test.ts"]
  - id: P4
    goal: the mention reply renders the PR outcome and the delivery hint (stamp field asksForDelivery)
    files:
      - packages/shared/src/db/types.ts
      - apps/www/src/server-lib/review/mention-reply-finish.ts
      - apps/www/src/server-lib/review/mention-reply-finish.test.ts
    acs: [AC-2, AC-5]
    gates: [tsc-check, lint, format-check, "www vitest src/server-lib/review/mention-reply-finish.test.ts"]
  - id: P5
    goal: handleThreadFinish hands the PR outcome promise to the mention hook
    files:
      - apps/www/src/server-lib/handle-daemon-event.ts
      - apps/www/src/server-lib/handle-daemon-event.remote.test.ts
      - apps/www/src/server-lib/handle-daemon-event.provider.test.ts # only if its remote-task-pr mock needs the new shape
    acs: [AC-2, AC-6]
    gates: [tsc-check, lint, format-check, "www vitest src/server-lib/handle-daemon-event.remote.test.ts src/server-lib/handle-daemon-event.provider.test.ts"]
  - id: P6
    goal: turn checkpointing on for issue mentions (stamp decides), lane writes asksForDelivery, AC-3 issue variant
    files:
      - apps/www/src/server-lib/automations.ts
      - apps/www/src/server-lib/automations.test.ts
      - apps/www/src/app/api/webhooks/github/org-mention-lane.ts
      - apps/www/src/app/api/webhooks/github/org-mention-lane.test.ts
      - deploy/lib/onboard-review-repo-args.ts # comment only
    acs: [AC-1, AC-3, AC-6]
    gates: [tsc-check, lint, format-check, "www vitest src/server-lib/automations.test.ts src/app/api/webhooks/github/org-mention-lane.test.ts", "node --test deploy/onboard-review-repo.test.ts"]
  - id: P7
    goal: github-mention skill lets an issue mention push its work branch; provenance and pin test updated
    files:
      - deploy/skills/github-mention/SKILL.md
      - deploy/skills/PROVENANCE.md
      - apps/www/src/server-lib/review/mention-reply-finish.test.ts
    acs: [AC-11]
    gates: [tsc-check, lint, format-check, "www vitest src/server-lib/review/mention-reply-finish.test.ts", "skill-push.ts --dry-run on the file (validator, no DB write)"]
```

Operator steps after merge (not phases): deploy the worker, then www (no migration), then push the skill per
org-lane repo with `deploy/skill-push.ts`, then run UAT (a) and (c).

---

## 9. Validator amendments (2026-11-21, verdict PASS_WITH_WARNINGS)

Binding on the implementation; they override §2–§8 where they differ.

1. **RF1 (P2).** `packages/worker/src/agent-run/workflow-cleanup.test.ts:922-925` asserts the
   self-heal-only broker-off message. Add that file to P2: update the regex, put the
   "pushRef run on a `legacy-direct` box is refused" test there (the runFn harness lives there),
   and add a wiring test that a `pushRef` run calls `startGitBroker` with `refFence {exactRef}`
   and a plain task run passes none. Update `git-broker.ts`'s refusal text and doc comment so they
   no longer say "self-heal" only.
2. **RF2 (P4).** The mention reply's wait on the PR outcome is bounded: `Promise.race` with
   20 s; on timeout treat it as `null` (no PR line) and log `reason=pr_outcome_timeout`. When
   `openRemoteTaskPullRequest` throws after `pulls.create`, resolve with the PR number if it is
   known. R5 is rewritten to say the reply now runs after the compare and `generatePRContent`.
3. **RF3 (P1).** The closing-keyword rewrite skips fenced code blocks and inline code, and also
   rewrites the full-URL form `Closes https://github.com/<o>/<r>/issues/<N>`.
4. **G20 is fixed here (new phase P0).** Today every PR mention in an org with cells on fails:
   the thread's checkout is stored as `repoBaseBranchName` (the PR head) with `githubPRNumber` set,
   so `taskRunPushBranch` (`remote-task-pr.ts:71-88`) returns `null` and `cell-plan` refuses with
   `409 work_branch_unresolved` (`cell-plan/route.ts:199-205`), a "named" refusal with no box
   fallback (`packages/worker/src/agent-run/cell-refusal-text.ts:62`). Fix it at the root, not with
   a box fallback (cells were turned on for an org on purpose): a **mention thread on a PR**
   resolves its push branch to the PR head it checked out, decided from the thread's mention stamp
   (`isPullRequest: true`), and the push is fenced to `refs/heads/<head>` on both computes
   (consistent with D5). It must **never** resolve to the PR's base branch, and other PR threads
   (review lane, companion, delivery fix) keep `null`. Tests: `remote-task-pr.test.ts` (mention PR
   thread → head; review/companion PR thread → null; base never returned) and `cell-plan/route.test.ts`
   (a PR-mention step opens with `allowedRef: refs/heads/<head>`).
5. Warnings carried into the implementation: dispatch chooses issue vs PR from
   `stamp.isPullRequest` (a later run on a mention thread whose PR the finish opened must not flip
   its fence); a PR head ref that fails `isBranchRef` ends the run with a named reply, not a
   silent throw; `handle-daemon-event.remote.test.ts` must mock `mention-reply-finish`.

Phases (final): **P0** G20 push branch for mention PR threads (`remote-task-pr.ts`, its test,
`cell-plan/route.test.ts`, and the stamp read where the thread is loaded) → P1 → P2 (+
`workflow-cleanup.test.ts`, `git-broker.ts` text) → P3 → P4 (+ timeout) → P5 → P6 → P7, as listed
by the validator, each ≤ 5 files.
