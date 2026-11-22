# #752: mention-lane PRs follow the target repo's conventions

An issue mention that pushes code now opens its draft PR on a **ticket-keyed branch**
(`feat/ACME-123-add-request-logging`), and the PR body is **the repo's own PR template, filled in by the
agent**. Decisions OD-1 to OD-4 are taken (ticket § Decisions, owner, 2026-11-22):

- OD-1: the key is the first `[A-Z][A-Z0-9]+-\d+` in the title, else in the body. With no key, the branch
  stays `automata/task-<id8>`.
- OD-2: the type is the title's Conventional prefix (`feat|fix|chore|docs|refactor|test|ci`), else `feat`.
- OD-3: the slug is the title words after the key, kebab-case ASCII, at most 40 characters. If the branch
  already exists on the remote at intake, `-<threadId[0:8]>` is appended.
- OD-4: the agent fills the template in a `json pull-request` block. `Refs #N` and the task footer are always
  appended.

PR mentions, issue-delivery threads (`automata/task-*`), self-heal (`automata/fix-*`) and the legacy per-user
mention path (`handle-app-mention.ts`) are unchanged. This spec writes no code. Examples use `acme/*` and
`ACME-123`.

## 1. Ground truth (re-verified at `main` = `eb9de3d9`, 2026-11-22)

Every row of the ticket's reality check was re-opened at this sha. **Status** is `holds` (same lines),
`moved` (same fact, new lines), `changed` (a nuance that changes the design) or **`no longer holds`**. Rows
G13 to G22 are facts the ticket did not have.

| #   | Fact | Where (at `eb9de3d9`) | Status |
| :-- | :--- | :-------------------- | :----- |
| G1  | A cell's `gh` is read-only (GET/HEAD REST, GraphQL without mutations). The mention skill forbids `gh pr create`. The platform opens the PR. | `packages/cell-broker/src/gh.ts:21-26`; `deploy/skills/github-mention/SKILL.md:44,83` | holds |
| G2  | The PR is opened by `openRemoteTaskPullRequest`, called from the daemon-event finish, not by the mention reply. | `apps/www/src/server-lib/handle-daemon-event.ts:778-822` (call `:781-782`); `apps/www/src/server-lib/task/remote-task-pr.ts:351-476` | holds |
| G3  | Title and body come from the agent's `json pull-request` block (`agent-pr-content.ts:37-73`), else `generatePRContent` (`generate-pr-content.ts:86-123`), else the latest commit subject and "Changes made by an automated task run.". Then `withIssueReference` (closing keywords become `Refs`, and `Refs #N` is appended), then the footer `---` / `📎 **Task**: …`. | `remote-task-pr.ts:310-335` (choice), `:190-206` (`withIssueReference`), `:236-239` (`latestCommitSubject`), `:443` (`parseAgentPrContent`) | holds |
| G4  | `remote-task-pr.ts:443` reads `parseAgentPrContent(threadChat?.messages)`. That is `findLastLeadAgentText(messages, PULL_REQUEST_FENCE.hasOpener)`: the **last lead agent message that has a `json pull-request` opener**, not necessarily the final message. Inside it, the LAST opener decides. | `agent-pr-content.ts:40-47`; `apps/www/src/server-lib/review/lead-text.ts:9-24`; `apps/www/src/server-lib/review/tagged-fence.ts:30-68` | changed (nuance: an earlier message's block also counts) |
| G5  | The body cap already exists: `AGENT_PR_BODY_MAX = 60_000` (GitHub's limit is 65 536). A longer, empty or non-JSON block makes `parseAgentPrContent` return null, and the caller falls back to generation. | `agent-pr-content.ts:27-30,63-71` | new (the cap exists) |
| G6  | The mention skill's output is exactly one `mention-reply` block. It never asks for a `pull-request` block. Only issue-delivery asks for one (a multi-line JSON block). | `SKILL.md:22-30,58,80`; `deploy/skills/issue-delivery/SKILL.md:169-177` | moved (`:58` also says "Still exactly one block") |
| G7  | Nothing reads `.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE.md` or `docs/pull_request_template.md`. The only hit is a self-heal bench seed string. | `git grep -i pull_request_template` → only `packages/shared/src/self-heal/bench/seed-catalog.ts:259` | holds |
| G8  | `remoteTaskBranchName` = `automata/task-<id8>`. `taskRunPushBranch` returns it for a base-branch run with no PR. Dispatch and `cell-plan` call `taskRunPushBranch`. **The PR open does not**: it calls `remoteTaskBranchName(threadId)` directly. | `remote-task-pr.ts:61-63`, `:92-112`, `:389`; `apps/www/src/agent/hatchet/dispatch.ts:1218-1233`; `apps/www/src/app/api/daemon/cell-plan/route.ts:200-207,226` | changed (`:389` is a third derivation, not a `taskRunPushBranch` caller) |
| G9  | Dispatch passes `sourceMetadata: thread?.sourceMetadata` (`:1223`). `cell-plan` passes `sourceMetadata: thread.sourceMetadata` (`:205`) with `branch: thread.branchName ?? thread.repoBaseBranchName` (`:203`). `mentionPushRef` turns `push` into `refs/heads/<push>` and refuses anything that fails `isBranchRef`. | `dispatch.ts:861-874,1218-1233`; `cell-plan/route.ts:198-207` | holds |
| G10 | The mention stamp holds no issue title. The title is fetched at intake inside a `safeSection` closure and is only rendered into the prompt. The stamp is built before the fetch and passed as `stampExtra.mention`. | `packages/shared/src/db/types.ts:221-249`; `apps/www/src/app/api/webhooks/github/org-mention-lane.ts:508` (`buildMentionStamp`), `:606-620` (issue fetch), `:665-668` (`stampExtra`), `:725-751` | moved (type ends at `:249`) |
| G11 | The `automata/task-` prefix is read only by the delivery loop. `enroll.ts:54-59` skips any non-delivery skill (mention threads included), and `:80` uses `remoteTaskBranchName`. The box and cell push fences match the exact ref. | `apps/www/src/server-lib/delivery/exclusions.ts:21,38-43`; `delivery/webhooks.ts:22`; `delivery/enroll.ts:54-59,80`; `packages/worker/src/agent-run/workflow.ts:886-894`; `packages/cell-broker/src/git.ts:663-672` | holds |
| G12 | The delivery-loop body parser expects `Refs #N` as the last line above the footer. | `apps/www/src/server-lib/delivery/delivery-effects.ts:151-170` | holds (`:160` is the function) |
| G13 | The worker checks the branch out, or continues `origin/<branch>` when `ls-remote --heads` finds it. | `packages/worker/src/agent-run/provision.ts:197-229` | holds |
| G14 | **The ref validator to reuse is `isBranchRef`** (`refs/heads/` prefix; no `..`, `@{`, trailing `.`, `.lock` part, leading `-`, `HEAD`/`@`, control characters, space, `~^:?*[\`, U+FFFD or lone surrogates). The box fence (`pushRefFence`), the cell step (`cell-authority.ts:92`), dispatch (`mentionPushRef`) and the git broker all apply it. It does **not** require ASCII. | `packages/utils/src/receive-pack-refs.ts:207-234`; `workflow.ts:886-894`; `packages/shared/src/model/cell-authority.ts:92`; `packages/worker/src/agent-run/git-broker.ts:96` | new |
| G15 | The cell checkout refuses a work branch outside `^[A-Za-z0-9._/@+-]+$`, or one that starts with `-` or holds `..`. | `packages/worker/src/agent-run/cell-image.ts:204,226-230,260-261` | new |
| G16 | `isMentionLaneStamp` only checks `type === "automation-skill"` and `mention !== undefined`. Stamp fields are not schema-validated on read or write (no zod for the stamp), so a new optional field needs a type change only. Each reader must validate the field itself. | `apps/www/src/server-lib/review/review-skill.ts:603-610`; `git grep asksForDelivery` (type, writer, one reader) | new |
| G17 | **The thread id does not exist at intake.** `runAutomation` → `createNewThread` mints it after the stamp is built. `CreateThreadOptions` has no id field. So OD-3's `-<threadId[0:8]>` cannot be written into the stamp at intake. | `org-mention-lane.ts:643-674`; `apps/www/src/server-lib/new-thread-shared.ts:44-88`; `apps/www/src/server-lib/automations.ts:364-401` | new (drives D1) |
| G18 | The mention-reply parser takes the last lead message containing `mention-reply`, then the LAST tagged `json mention-reply` opener, closed by the first line after it that is exactly three backticks. A `json pull-request` block, before or after it, is neither a `mention-reply` opener nor a match for the untagged fallback regex (`` ```json[ \t]*\r?\n ``). So two blocks parse correctly. | `mention-reply-finish.ts:135-156,525-530`; `tagged-fence.ts:12-14,34-36,71,84-100` | new |
| G19 | The mention skill contract check (`assertMentionSkillContract`) needs a `` ```json `` fence followed, somewhere later, by `"mention-reply"` and a closing fence. A `pull-request` example placed first still passes. Placing it after the `mention-reply` example is cleaner. The tracked skill is pinned by tests. | `review-skill.ts:582-595`; `apps/www/src/server-lib/review/mention-reply-finish.test.ts:1086-1120` | new |
| G20 | `withIssueReference` can make a body longer: `fix #1` → `Refs #1` adds one character per rewrite. A 60 000-character body plus the `Refs` line and the footer could pass 65 536. GitHub then answers 422, which `createPullRequest` rethrows, and no PR opens. | `remote-task-pr.ts:132-135,190-206,334-348` | new (D4 guard) |
| G21 | Precedent for the existence check: an exact-ref `octokit.rest.git.getRef({ ref: "heads/<branch>" })` on the App client, with 404 meaning "no branch". | `apps/www/src/server-lib/audit/open-fix-pr.ts:477-490` | new |
| G22 | Copies of `automata/task-` that describe mention threads: `SKILL.md:16` and `deploy/skills/PROVENANCE.md:163` (M5). Copy of the "exactly one block" rule: `SKILL.md:22,30,58,80` and `deploy/lib/seed-skill-bodies.ts:36` (the seed body). Tests pinning it for a mention thread: `cell-plan/route.test.ts:472-484` and the `pushRef` table in `dispatch.test.ts:1629-1717`. Other hits stay as they are: delivery tests, `issue-delivery/SKILL.md:84`, the task canary `packages/worker/dev/canary/run-input.ts:71-73` (a plain task, not a mention), the worker and utils fixtures, `dispatch-golden.test.ts:149` (plain task). | `git grep -n 'automata/task-'` | new |

"Does not exist" claims, each grepped at `eb9de3d9`: no `workBranch` field in `packages/shared/src` (only the
worker's `AgentRunInput.workBranch`, a different thing); no reader of a PR template (G7); no thread id
supplied at creation (G17); no zod schema for `MentionLaneStamp` (G16); and no `docs/specs/752/` before this
file.

## 2. Contract

### 2.1 Stamp (`packages/shared/src/db/types.ts`, `MentionLaneStamp`)

```ts
/**
 * Issue mentions only, written only when the issue names a ticket key (#752):
 * the convention branch `<type>/<KEY>[-<slug>]`, chosen once at intake.
 */
workBranch?: string;
/**
 * With `workBranch`, written only when true: the name was already taken on
 * the remote at intake, so the run pushes `<workBranch>-<threadId[0:8]>`
 * (the thread id did not exist yet when the stamp was written).
 */
workBranchTaken?: true;
```

Both fields are JSON on `thread.sourceMetadata`, so no migration is needed. A stamp without them, or a PR stamp,
behaves exactly as today.

### 2.2 Functions (new file `apps/www/src/server-lib/task/mention-work-branch.ts`)

| Function | Contract |
| :------- | :------- |
| `mentionWorkBranchName({ title, body }): string \| null` | Pure. OD-1..OD-3 without the suffix. Null when there is no key, or when the result fails `isMentionWorkBranch`. |
| `isMentionWorkBranch(name): boolean` | `isBranchRef("refs/heads/" + name)`, ASCII only, at most 128 characters, and the shape `^(feat\|fix\|chore\|docs\|refactor\|test\|ci)/[A-Z][A-Z0-9]{1,31}-\d{1,12}(-[a-z0-9]+)*$`. The shape means the name can never be a base branch such as `main` or `develop`. |
| `chooseMentionWorkBranch({ octokit, owner, repo, title, body, isClaimed }): Promise<Pick<MentionLaneStamp, "workBranch" \| "workBranchTaken">>` | Never throws. `{}` when there is no name. Otherwise it runs two checks in parallel: an exact `git.getRef("heads/<name>")`, and `isClaimed(name)`, the DB claim query below (RF-1). It returns `{ workBranch }` only when `getRef` answers 404 **and** `isClaimed` resolves false. A 200 from `getRef`, any other `getRef` error, a claimed name, or a rejected `isClaimed` all give `{ workBranch, workBranchTaken: true }`. It fails open to the suffixed name, never to the bare one. |

### 2.2a Claim query (new, `packages/shared/src/model/threads.ts`, RF-1)

```ts
/**
 * True when any thread of the repo already carries a mention stamp with this
 * convention branch (#752 RF-1): a second mention on the same issue must not
 * reuse a name a run that has not pushed yet will push.
 */
export async function isMentionWorkBranchClaimed(
  db: DB,
  { repoFullName, workBranch }: { repoFullName: string; workBranch: string },
): Promise<boolean>;
```

It runs `SELECT 1 FROM thread WHERE github_repo_full_name = $1 AND source_metadata -> 'mention' ->> 'workBranch' = $2 LIMIT 1`,
with the same `sql` jsonb style as `delivery-loop.ts:597-598`. The leading column of
`github_repo_full_name_github_pr_number_index` (`schema.ts:533-536`) bounds the scan to the repo. Matching is
exact on the stored `repoFullName`, which the lane always writes from the same webhook field. Archived and
finished threads count too. That is conservative: a name used once is never reused bare.

### 2.3 `remote-task-pr.ts`

| Function | Contract |
| :------- | :------- |
| `remoteTaskBranchFor({ threadId, sourceMetadata, baseBranch }): string` (new, exported) | For an **issue** mention stamp whose `workBranch` is a string: `workBranch`, plus `-<threadId[0:8] lowercased>` when `workBranchTaken`. It returns that name only if it passes `isMentionWorkBranch` **and is not equal to `baseBranch`** (RF-2; impossible by the shape, but kept as a fence). Otherwise it returns `remoteTaskBranchName(threadId)`. Deterministic, so every caller gets the same answer from the same row. |
| `taskRunPushBranch` | The base-branch, no-PR case returns `remoteTaskBranchFor({ threadId, sourceMetadata, baseBranch })` instead of `remoteTaskBranchName(threadId)`. It does no base check of its own. Every other case is unchanged. |
| `openRemoteTaskPullRequest` | `:389` becomes `const branch = remoteTaskBranchFor({ threadId, sourceMetadata: thread.sourceMetadata, baseBranch: thread.repoBaseBranchName })`. The compare, the open-PR lookup, `pulls.create({ head })` and `updateThread({ branchName })` all use it. Its base fallback is the same one `taskRunPushBranch` applies (RF-2). |

## 3. Design

### D1. The branch is chosen once, at intake (Scope 1, OD-1..OD-3, AC-1, AC-2)

In `handleOrgMention`'s issue branch (`org-mention-lane.ts:606-620`), the `safeSection("issue", …)` closure
also records `{ title: issue.title, body: issue.body ?? null }` in a local variable. After the `try` succeeds
(an issue fetch failure already renders "unavailable" and leaves the local unset), and only for an issue, the
lane calls `chooseMentionWorkBranch` with the App `octokit` it already holds (`:480`) and
`isClaimed = (name) => isMentionWorkBranchClaimed(db, { repoFullName: input.repoFullName, workBranch: name })`.
It spreads the result into
`stampExtra.mention` at `:665-668`. A PR mention never calls it, so its stamp keeps its keys. No key means no
`getRef` call and no new field.

`mentionWorkBranchName`:

1. **Type (OD-2).** `^\s*(feat|fix|chore|docs|refactor|test|ci)(\([^)]*\))?!?:\s*`, case-insensitive, on
   the title. The match gives the type in lowercase. With no match, the type is `feat`. `title'` is the title
   with that prefix removed.
2. **Key (OD-1).** The first `(?<![A-Za-z0-9])[A-Z][A-Z0-9]+-\d+(?![A-Za-z0-9])` in the **full** title,
   else in the body, skipping any match whose project part is in the denylist
   `MENTION_KEY_DENYLIST = ["UTF", "SHA", "ISO", "RFC"]`, so the next match is tried. Uppercase only, as
   decided. The boundaries, the length bounds (key part ≤ 32 characters, number ≤ 12 digits) and the
   denylist are additions, see OQ-1. Searching the full title means
   `feat(ACME-5): add x` still finds the key in the scope.
3. **Slug source (OD-3).** With the key in the title, use the text after the key. With the key only in the
   body, use `title'`. If the text after the key slugifies to nothing (for example "Add logging ACME-123"),
   use the text before the key, with the Conventional prefix removed (OQ-2).
4. **Slugify.** NFKD normalization, strip `\p{M}`, lowercase, every run of `[^a-z0-9]` becomes `-`, trim `-`.
   Above 40 characters, cut at the last `-` at or before 40 (or hard-cut at 40 when there is none) and trim `-`.
5. **Name.** `<type>/<KEY>-<slug>`, or `<type>/<KEY>` when the slug is empty. Return null unless
   `isMentionWorkBranch(name)`.

Examples: `[ACME-123] Add request logging` → `feat/ACME-123-add-request-logging`.
`fix: ACME-9 handle null input` → `fix/ACME-9-handle-null-input`.
`Add request logging` with no key in the body → null, so the branch stays `automata/task-<id8>`.

**Why a flag instead of the suffixed name:** see G17. The suffix is appended by `remoteTaskBranchFor` when
it is read, from the same `threadId` every caller already passes. All three callers still derive one value
from one row.

**Fail-open rule (OD-3):** any `getRef` outcome except 404 (200, 403, 5xx, a network error) writes
`workBranchTaken: true`. A transient failure costs a longer name, never a push onto someone else's branch.

**Claimed names (RF-1):** the remote check alone does not stop a second mention on the same issue. Its
intake happens while the first run is still provisioning or working, often minutes before that run pushes,
so the branch is not on GitHub yet and both threads would get the bare name and race one ref. Nothing
serializes two threads on one issue (`org-mention-lane.ts:508-668` claims per comment, not per issue). So
intake also sets `workBranchTaken` when `isMentionWorkBranchClaimed` finds any thread of the repo with the same
stored `workBranch`. The second thread then pushes `<name>-<thread8>`. The window left is two intakes running
at once, each finishing its claim query before the other's thread row is inserted. That is sub-second, and
only possible when two mentions on one issue arrive together.

### D2. One function decides the branch (Scope 1, AC-1)

There are three derivations today (G8, G9), and the fix makes them one:

| Caller | Today | After |
| :----- | :---- | :---- |
| dispatch `dispatch.ts:1218-1233` | `taskRunPushBranch({ …, sourceMetadata: thread?.sourceMetadata })` → `push`. `workBranch = push` when `push !== branch`. `pushRef = refs/heads/<push>` (`mentionPushRef`) | No code change. `push` becomes the convention name, and `workBranch` and `pushRef` follow. |
| `cell-plan` `route.ts:200-207,226` | `taskRunPushBranch({ …, sourceMetadata: thread.sourceMetadata })` → `allowedRef = refs/heads/<pushBranch>` | No code change. |
| PR open `remote-task-pr.ts:389` | `remoteTaskBranchName(threadId)`, which **ignores the stamp** | `remoteTaskBranchFor({ threadId, sourceMetadata: thread.sourceMetadata })` |

Why the PR open calls `remoteTaskBranchFor` and not `taskRunPushBranch`: `taskRunPushBranch` also returns a
non-base `branch` for a plain task run started on a feature branch. Routing the opener through it would start
opening PRs for those runs, which is out of scope. `remoteTaskBranchFor` is the name rule that
`taskRunPushBranch` itself uses, so the three still agree by construction.

The base-branch fallback lives only in `remoteTaskBranchFor` (RF-2), so `taskRunPushBranch` and the PR open
cannot diverge on it.

After the PR opens, `updateThread({ branchName: branch, githubPRNumber })` (`:462`) stores the convention name.
A later run then has a PR and a non-base `branch`, and `taskRunPushBranch` returns `branch`: the same name, so
the PR head equals it from then on. A stamp that fails validation falls back to `automata/task-<id8>` in all
three callers alike, so the fence and the PR never disagree.

### D3. Branch-name safety (Scope 1)

The generated character set is `[a-z]/[A-Z0-9-]` and `[a-z0-9-]`, which passes `isBranchRef` (G14), the cell
`REF_NAME` (G15), `cell-authority.ts:92`, `pushRefFence` and `mentionPushRef`. `isMentionWorkBranch` checks
again whenever the stamp is read (G16: the stamp is untrusted JSON as far as the reader knows). It adds ASCII
and the type/key shape on top of `isBranchRef`, the validator being reused, without reimplementing
check-ref-format. Nothing outside these files changes.

### D4. Body safety (Scope 3, OD-4, AC-3)

- `parseAgentPrContent` is unchanged. Its 60 000 cap (G5) and the null-on-malformed rule already give
  "over the cap or unparseable → today's body" (generation, then the generic text).
- `withIssueReference` and the footer stay in the same order, so `delivery-effects.ts:160` still finds
  `Refs #N` above the footer (G12). Delivery threads never carry a mention stamp, so their bodies do not change.
- **New guard (G20):** in `createPullRequest`, if the final body (after `withIssueReference` and the footer) is
  longer than 65 536 characters, rebuild it from `"Changes made by an automated task run."` with the same
  reference and footer, and log `[remote-task-pr] agent body over GitHub's cap`. This applies to every thread
  and changes nothing below the cap.

### D5. The skill asks for the PR block (Scope 2, OD-4, AC-3)

Edits to `deploy/skills/github-mention/SKILL.md`:

- `:16`: "this run's own work branch (`automata/task-…`)" becomes "this run's own work branch (already
  checked out; `git branch --show-current` names it, often `<type>/<TICKET>-<slug>`)".
- `:22`, `:30`, `:58`, `:80`: "exactly one block" becomes **"exactly one `mention-reply` block, plus, on an
  issue mention that pushed, at most one `pull-request` block placed before it; both in the final message"**.
  Keep the `mention-reply` example as the first `` ```json `` fence in the body (G19).
- New sub-section under Section A §2 (issue push only):
  1. Look for a PR template in the checkout, in this order: `.github/pull_request_template.md`,
     `.github/PULL_REQUEST_TEMPLATE.md`, `docs/pull_request_template.md`.
  2. If one exists, fill every section from the change: the ticket link (the key from the issue), the
     description, the type of change, the quality checks actually run (with their results), and the changelog.
     Keep the template's headings and checkboxes. Never invent a check that was not run.
  3. Emit `` ```json pull-request `` with `{"title": "<type>(<area>): <summary>", "body": "<markdown>"}` on one
     line (JSON escapes newlines). The title is a Conventional Commit and stays under 256 characters.
  4. With no template, the block is optional. Without it, the platform writes the body (today's behaviour).
  5. Never write `Closes`/`Fixes #N` (the platform rewrites them anyway). Never paste the footer.
- Hard rules `:80`: "One `mention-reply` block, one `reply`, every run". `:83` is unchanged.

Parser checks (G4, G18): the mention reply still finds its block when a `pull-request` block comes before or
after it. The opener finds the `pull-request` block in the same final message. Putting both in the final
message avoids the G4 nuance, where an earlier draft block from a previous message would win.

`deploy/skills/PROVENANCE.md` gets a new **M6** entry (and M5's `automata/task-…` becomes "the checked-out
work branch"). `deploy/lib/seed-skill-bodies.ts:36` is another copy of "exactly one block" (the minimal seed
body for a repo without the full skill). It changes to "ends with exactly one `json mention-reply` block" so
the wording matches the relaxed rule. The seed keeps no PR-template instruction, so a seeded repo gets
today's PR body. No test pins that string (`git grep`). `skill-save-checks.test.ts` validates the seed bodies
and joins P4's gates. The skill is pushed by the operator with `deploy/skill-push.ts` to every repo with an enabled
org-lane mention automation (see §7).

### D6. Negative controls (AC-4, AC-5)

- **PR mention:** the lane never calls `chooseMentionWorkBranch` (`input.isPullRequest`).
  `remoteTaskBranchFor` ignores a PR stamp even if it carries a forged `workBranch`, and `taskRunPushBranch`'s
  PR-mention branch (`:109`) is untouched.
- **Issue-delivery:** its stamp has no `mention` key, so it keeps `remoteTaskBranchName`. `enroll.ts:80`,
  `exclusions.ts:21`, `webhooks.ts:22` and `delivery-effects.ts:151-170` are untouched, and their tests run
  unchanged.
- **Self-heal:** `automata/fix-*` comes from `selfHealRefFence`, which is untouched.
- A convention-named mention PR is outside `automata/task-*`. That is intended: the delivery loop never
  enrolled mention PRs (`enroll.ts:54-59`), so `isDeliveryLoopOwned` returning false for them changes nothing.

## 4. Risks

- **Push fence.** The convention name is the only ref the run may push, fixed before dispatch (D2). A
  collision is avoided by OD-3's suffix, failing open to the suffixed name (D1).
- **Check-then-push race (OQ-4).** A second Automata thread is covered by the claim query (RF-1). A person or
  another tool can still create the same branch on GitHub between intake and the run's first provision. That
  window lasts from intake until provision, which includes the queue wait and so can be minutes, not seconds.
  Provision would then continue `origin/<branch>` (G13), and the agent's push goes fast-forward onto that
  branch. This is accepted: a person creating a branch with the exact generated name in that window is
  unlikely, and the PR is a draft a person reviews.
- **`ls-remote --heads origin <name>` matches by suffix: a hard failure** (RF-6). `provision.ts:198-207` treats
  any output as "the branch exists", and `ls-remote --heads origin feat/ACME-1-x` also lists
  `refs/heads/other/feat/ACME-1-x`. The fetch at `:209-219` then asks for `refs/heads/feat/ACME-1-x`, which
  does not exist. `runGit` throws, provision fails, and the run fails. This is existing behaviour, but a
  ticket-keyed name makes it more likely than a unique `automata/task-<id8>`. **Follow-up ticket:** use
  `ls-remote --heads origin refs/heads/<name>` (an exact ref) in provision and in `cell-image.ts`.
- **A remote branch named exactly `feat`, `fix` (or any type) blocks the push** (RF-6). Git cannot hold both
  `refs/heads/feat` and `refs/heads/feat/…` (a directory/file conflict), so GitHub rejects the push. The
  intake `getRef("heads/feat/…")` answers 404, so no suffix is added: the suffix would not help anyway, since
  every `feat/*` name conflicts. The run's push fails and no PR opens. **Follow-up ticket:** at intake, also
  `getRef("heads/<type>")`; on 200, store no `workBranch` (fall back to `automata/task-<id8>`).
- **False-positive keys** (`UTF-8`, `SHA-256`, `ISO-8601` in a title) give a wrong but valid branch name
  (cosmetic only). See OQ-1.
- **Agent writes a poor template fill.** The PR is a draft and a person reviews it. A malformed block falls
  back (D4).
- **Rollback (RF-5):** revert. A PR already opened on the convention name keeps working: `branchName` is
  stored, and `taskRunPushBranch` returns it for a thread with a PR. **Runs in flight lose their PR:** a run
  dispatched before the revert was fenced to and pushes the convention name. The reverted PR open then
  compares `automata/task-<id8>`, gets 404 → `no_branch`, and opens nothing. The work sits on the convention
  branch with no PR. A later run of such a thread pushes `automata/task-<id8>` from the base. The operator
  finds the affected threads with this read-only query, then opens their PRs by hand from the listed branch:

  ```sql
  SELECT id,
         github_repo_full_name,
         source_metadata -> 'mention' ->> 'workBranch'      AS work_branch,
         source_metadata -> 'mention' ->> 'workBranchTaken' AS taken,  -- 'true' → push name is work_branch || '-' || lower(left(id, 8))
         github_pr_number,
         created_at
  FROM thread
  WHERE source_metadata -> 'mention' ? 'workBranch'
  ORDER BY created_at DESC;
  ```

  Rows with `github_pr_number IS NULL` are the ones without a PR.

## 5. Tests per AC

| AC | Tests (files) |
| :- | :------------ |
| AC-1 | `mention-work-branch.test.ts`: `[ACME-123] Add request logging` → `feat/ACME-123-add-request-logging`. `remote-task-pr.test.ts`: `remoteTaskBranchFor` and `taskRunPushBranch` return the literal `feat/ACME-123-add-request-logging` for an issue-mention stamp; `remoteTaskBranchFor` falls back to `automata/task-<id8>` when the stored name equals `baseBranch` (RF-2); `openRemoteTaskPullRequest` compares `main...feat/ACME-123-add-request-logging`, lists open PRs with head `acme:feat/ACME-123-add-request-logging`, creates with that `head`, and records it as `branchName`. **Literal assertions (RF-3):** `dispatch.test.ts` (new rows in the `pushRef` table `:1629+`): a fresh issue mention stamped `workBranch: "feat/ACME-123-add-request-logging"` → `input.workBranch === "feat/ACME-123-add-request-logging"` and `input.pushRef === "refs/heads/feat/ACME-123-add-request-logging"`; the same stamp with `workBranchTaken: true` → both end in `-<the thread's first 8 chars>`, written out in the test from the fixture's known id; a **follow-up run after the PR opened** (`githubPRNumber: 5`, `branchName: "feat/ACME-123-add-request-logging"`) → `pushRef === "refs/heads/feat/ACME-123-add-request-logging"` and no `workBranch` (the branch is already checked out from `branch`). `cell-plan/route.test.ts` (siblings of `:472-484`): the same three rows, asserting `allowedRef` as the literal `"refs/heads/feat/ACME-123-add-request-logging"`, the literal suffixed ref, and the literal ref for the PR-opened follow-up. No expected value is computed with a helper from the code under test. |
| AC-2 | `mention-work-branch.test.ts`: no key → null (and `chooseMentionWorkBranch` → `{}` with neither `getRef` nor `isClaimed` called); `fix: ACME-9 handle null input` → `fix/ACME-9-handle-null-input`; key only in the body; `feat(ACME-5): add x`; `Support UTF-8 names (ACME-7)` → `feat/ACME-7-…` (denylist skips `UTF-8`); a 60-character title cut at a word ≤ 40; diacritics stripped; nothing after the key; `getRef` 200 → `workBranchTaken`; 404 and not claimed → bare; 404 and claimed → `workBranchTaken` (RF-1); `isClaimed` rejecting → `workBranchTaken`; `getRef` 500, 403 or thrown → `workBranchTaken`; `isMentionWorkBranch` refuses `main`, `feat/../x`, `feat/ACME-1.lock`, non-ASCII and a bare `ACME-1`. `remote-task-pr.test.ts`: `workBranchTaken` → `feat/ACME-123-add-request-logging-<id8>` as a literal for the fixture thread; an invalid stored name → `automata/task-<id8>`. `packages/shared/src/model/thread.test.ts` (RF-1): `isMentionWorkBranchClaimed` is true for a thread of `acme/widgets` stamped with the name, false for the same name in `acme/other`, false for a different name, and false for a thread with no mention stamp. `org-mention-lane.test.ts`: an issue titled `[ACME-123] …` → the stamp passed to `runAutomation` carries `workBranch`; `git.getRef` resolving → also `workBranchTaken: true`; **a second mention on the same issue after a first thread row exists with that stamp (`getRef` still 404) → `workBranchTaken: true`** (RF-1); an issue without a key → stamp keys unchanged; a failed `issues.get` → no `workBranch`. |
| AC-3 | `remote-task-pr.test.ts`: an issue-mention thread whose **final lead message holds both blocks, a `json pull-request` block with a template body followed by the `json mention-reply` block** (RF-3: the shape the skill asks for) → PR title and body come from the `pull-request` block, body = that body + `\n\nRefs #N` + footer; the same message with only the `mention-reply` block → today's body (generation mock, then generic); a 60 001-character block → fallback; a body pushed past 65 536 by `withIssueReference` → the generic body with `Refs` and footer (D4 guard). `mention-reply-finish.test.ts`: a final message with a `pull-request` block before, and one with it after, the `mention-reply` block → `parseMentionReply` ok with the right `reply`; the tracked skill names the three template paths and `json pull-request`, and no longer says "Emit exactly one block". |
| AC-4 | **PR mention:** `remote-task-pr.test.ts` (`taskRunPushBranch` describe, beside `:469`): a PR-mention stamp carrying a forged `workBranch` → still returns the PR head; `remoteTaskBranchFor` on it → `automata/task-<id8>`. `org-mention-lane.test.ts`: a PR mention calls neither `git.getRef` nor the claim query, and its stamp has no `workBranch`. `dispatch.test.ts`: the existing PR-mention and non-mention rows of the `pushRef` table (`:1629-1717`) are unchanged. **Delivery thread (RF-3, new):** the tests at `remote-task-pr.test.ts:185` and `:363` are plain task threads, not delivery threads, so they do not count. Add one in the `openRemoteTaskPullRequest` describe: a thread with `sourceMetadata: { type: "automation-skill", skillName: "issue-delivery", contentSha, source }` (the stamp `enroll.ts:54-59` accepts) and `githubIssueNumber` set → compare, lookup and `pulls.create` use `head` = the literal `automata/task-<id8>`, and the body has no `Refs` from the mention policy. Plus a `taskRunPushBranch` row for the same stamp → `automata/task-<id8>`. |
| AC-5 | Unchanged and green: `delivery/exclusions.test.ts`, `delivery/webhooks.test.ts`, `delivery/delivery-effects.test.ts`, `delivery/enroll.test.ts`, `delivery/cycle-finish.test.ts`. |
| AC-6 | **Production UAT, deferred** to after deploy and the skill push. In a repo with `.github/pull_request_template.md` and ticket-keyed branches, an issue titled `[KEY-n] …` gets the mention "implement this". Expected: a draft PR on `feat/KEY-n-<slug>` (or the issue's type), body = the filled template + `Refs #N` + footer, linked in the reply. Evidence: PR URL, `git ls-remote` head, the step's `allowedRef`. Recorded on the ticket. |

## 6. Gates (every phase)

`pnpm turbo tsc-check --force`, `pnpm turbo lint`, `pnpm turbo format-check` (by hand: prettier with
`--config .prettierrc --no-editorconfig`), and each phase's vitest files with
`pnpm --filter @terragon/www exec vitest run --no-file-parallelism <files>`. The full www suite runs once
before ship.

## 7. phases[]

Each phase changes at most 5 files (tests count) and is green on its own. The reader ships before the
writer: P1 and P2 change nothing until a stamp carries `workBranch`, and P3 starts writing it. P4 (the skill)
works with either branch name.

```yaml
phases:
  - id: P1
    goal: the name rule, the stamp fields, one read path (base fallback inside remoteTaskBranchFor), the PR open's head, the body-length guard
    files:
      - packages/shared/src/db/types.ts
      - apps/www/src/server-lib/task/mention-work-branch.ts        # new: mentionWorkBranchName, isMentionWorkBranch, chooseMentionWorkBranch (isClaimed injected)
      - apps/www/src/server-lib/task/mention-work-branch.test.ts   # new
      - apps/www/src/server-lib/task/remote-task-pr.ts             # remoteTaskBranchFor(+baseBranch), taskRunPushBranch, :389, D4 guard
      - apps/www/src/server-lib/task/remote-task-pr.test.ts        # incl. the real delivery-thread negative (RF-3)
    acs: [AC-1, AC-2, AC-3, AC-4]
    # RF-4: taskRunPushBranch changes here, so its two other callers' suites run here too.
    gates: [tsc-check, lint, format-check, "www vitest src/server-lib/task/mention-work-branch.test.ts src/server-lib/task/remote-task-pr.test.ts src/agent/hatchet/dispatch.test.ts src/agent/hatchet/dispatch-golden.test.ts src/app/api/daemon/cell-plan/route.test.ts"]
  - id: P2
    goal: pin with literal refs that dispatch (workBranch, pushRef) and cell-plan (allowedRef) agree with the PR head, incl. the suffixed name and the PR-opened follow-up; no production change
    files:
      - apps/www/src/agent/hatchet/dispatch.test.ts
      - apps/www/src/app/api/daemon/cell-plan/route.test.ts
    acs: [AC-1, AC-4]
    gates: [tsc-check, lint, format-check, "www vitest src/agent/hatchet/dispatch.test.ts src/agent/hatchet/dispatch-golden.test.ts src/app/api/daemon/cell-plan/route.test.ts"]
  - id: P3
    goal: intake writes workBranch / workBranchTaken on an issue mention stamp, with the remote check AND the DB claim (RF-1)
    files:
      - apps/www/src/app/api/webhooks/github/org-mention-lane.ts
      - apps/www/src/app/api/webhooks/github/org-mention-lane.test.ts   # fakeOctokit gains rest.git.getRef; second-mention case
      - packages/shared/src/model/threads.ts                           # isMentionWorkBranchClaimed
      - packages/shared/src/model/thread.test.ts                       # the model's existing test file
    acs: [AC-1, AC-2, AC-4]
    gates: [tsc-check, lint, format-check, "www vitest src/app/api/webhooks/github/org-mention-lane.test.ts", "shared vitest src/model/thread.test.ts"]
  - id: P4
    goal: the mention skill reads the PR template and emits a pull-request block; the one-block rule relaxed in the skill and the seed body; provenance and pins
    files:
      - deploy/skills/github-mention/SKILL.md
      - deploy/skills/PROVENANCE.md
      - apps/www/src/server-lib/review/mention-reply-finish.test.ts   # two-block parse + skill pins
      - deploy/lib/seed-skill-bodies.ts                                # :36 wording only
    acs: [AC-3]
    gates: [tsc-check, lint, format-check, "www vitest src/server-lib/review/mention-reply-finish.test.ts src/server-lib/review/skill-save-checks.test.ts", "deploy/skill-push.ts --dry-run on the file (validator, no DB write)"]
  - id: AC5-regression
    goal: no files; the delivery-loop suites run unchanged
    files: []
    acs: [AC-5]
    gates: ["www vitest src/server-lib/delivery/"]
```

The shared gate is `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism src/model/thread.test.ts`
(a throwaway Postgres, per AGENTS.md).

**Rollout (operator, after merge, not phases):** deploy www (no migration, no worker change). Then push the
skill with `deploy/skill-push.ts` to every repo with an enabled org-lane `github_mention` automation (list
them from `getAllAutomationsForAdmin`, the same query `deploy/onboard-review-repo.ts` uses). Then run AC-6.
Keep the §4 rollback query at hand.

## 8. Open questions

| # | Question | Recommendation |
| :- | :------- | :------------- |
| OQ-1 | OD-1's bare regex matches inside words (`XACME-12`) and common non-tickets (`UTF-8`, `SHA-256`, `ISO-8601`, `RFC-7231`). | **Add the alphanumeric boundaries, the length bounds and the denylist `UTF`, `SHA`, `ISO`, `RFC`** (D1 step 2): a denylisted match is skipped and the next one is tried. Other false positives are accepted, since they still give a valid name and are only cosmetic. Grow the list only from UAT evidence. |
| OQ-2 | Nothing after the key ("Add request logging ACME-123"). OD-3 says "words after the key". | **Fall back to the words before the key, then to `<type>/<KEY>`.** A bare `<type>/<KEY>` collides more, but the suffix covers that. |
| OQ-3 | A second mention on the same issue starts a new thread. Through the claim query (RF-1) or the remote check, it gets `-<thread8>` and opens a second PR. This holds even when the first run has not pushed yet, which can be minutes after intake. | **Accept** (OD-3 as written). Continuing the first thread's branch would cross threads and is out of scope. |
| OQ-4 | Races left after RF-1: (a) two intakes on one issue at the same moment, both querying before either thread row exists (sub-second); (b) a non-Automata actor creating the exact name on GitHub between intake and the first provision, a window that includes the queue wait, so it can be minutes (§4). | **Accept both.** (a) needs two simultaneous mentions on one issue. (b) needs a person to guess the generated name. A second check at dispatch would make the name depend on time, so the three derivations could disagree. |
| OQ-5 | GitHub also honours a root `pull_request_template.md`, a `.github/PULL_REQUEST_TEMPLATE/` folder and case variants. OD-4 names three paths. | **Keep OD-4's three paths.** File a follow-up if a client repo uses another one. |
| OQ-6 | Should the guard in D4 (final body > 65 536 → generic body) also log the thread to a metric? | **Log only** (the line in D4). It is pathological, and a metric adds a dependency for a case that may never happen. |
| OQ-7 | The two RF-6 risks (the `ls-remote` suffix match fails the run; a remote `feat`/`fix` branch blocks the push). | **Follow-up ticket**, with the fixes named in §4. Out of #752's scope. |

## 9. Amendments (2026-11-22, validate round 1)

The validator returned BLOCK. The changes below were applied in place, and the body sections above were
updated to match.

| # | Change | Where |
| :- | :----- | :---- |
| RF-1 (blocking) | Two mentions on one issue could both pass the remote check before the first run pushes (minutes later). Intake now also sets `workBranchTaken` when any thread of the repo has a mention stamp with the same `workBranch`, via the new `isMentionWorkBranchClaimed` in `packages/shared/src/model/threads.ts` with a test in `thread.test.ts`. `chooseMentionWorkBranch` takes it as an injected `isClaimed`, and a rejected claim query fails open to the suffix. OQ-3/OQ-4 no longer claim a "seconds" window. | §2.2, §2.2a, D1 "Claimed names", §4, §5 AC-2, P3 (4 files), OQ-3, OQ-4 |
| RF-2 | The "equals the base branch → `automata/task-<id8>`" fallback moved into `remoteTaskBranchFor`, which now takes `baseBranch`. `taskRunPushBranch` and the PR open (which passes `thread.repoBaseBranchName`) share it. | §2.3, D2, §5 AC-1 |
| RF-3 | Dispatch and `cell-plan` tests assert literal refs (`refs/heads/feat/ACME-123-add-request-logging`), with rows for the suffixed name and for a follow-up run after the PR opened. The AC-3 PR-open test puts the `pull-request` and `mention-reply` blocks in the same final message. A real `issue-delivery`-stamped negative test replaces the cited `:185` and `:363` (plain task threads). | §5 AC-1, AC-3, AC-4 |
| RF-4 | P1's gates also run `dispatch.test.ts`, `dispatch-golden.test.ts` and `cell-plan/route.test.ts`. | §7 P1 |
| RF-5 | Rollback stated accurately: runs dispatched before a revert push the convention name, and the reverted PR open returns `no_branch`, so that work has no PR. A read-only SQL query lists the threads whose stamp has `workBranch`. | §4 Rollback |
| RF-6 | Risks restated: the `provision.ts:198-219` `ls-remote --heads` suffix match makes the fetch, and so the run, fail; a remote branch named exactly `feat`/`fix` blocks the push. Both are follow-up tickets. | §4, OQ-7 |
| Also | OQ-1 adds the key denylist `UTF`, `SHA`, `ISO`, `RFC` (D1 step 2, AC-2 case). `deploy/lib/seed-skill-bodies.ts:36` added to the copies (G22) and updated in P4 (wording only; P4 = 4 files). AC-4 citations fixed (`taskRunPushBranch` describe beside `:469`, `pushRef` table `:1629-1717`, the delivery stamp per `enroll.ts:54-59`). | G22, D5, §5 AC-4, §7 P4, OQ-1 |
