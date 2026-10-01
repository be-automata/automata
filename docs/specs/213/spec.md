# Spec — #213: a worker restart must not re-post a PR's whole verdict history

Worktree: `/Users/senior/.superset/projects/automata-platform/.claude/worktrees/213`
Owned file: `apps/www/src/server-lib/review/execute-review-from-intent.ts`
Status: ready to implement.

---

## 0. Read this first — where the ticket text and the real code disagree

Everything below was verified by reading the code in **this worktree** on 2026-09-30.
Three disagreements between the ticket prose and the code are load-bearing; the
implementer must not "fix" them back.

**(a) The ticket's description of the fall-through is accurate, the line numbers are
slightly off.** The fall-through lives at
`apps/www/src/server-lib/review/execute-review-from-intent.ts:166-234`, not 178-198.
`isStale` is computed at **line 166** (`emitted.commit !== currentHeadSha`), the
`findBotReviewAtHead(...)` supersession probe is **lines 177-200**, and the
unconditional post of the marked COMMENT is **lines 201-233**. The behaviour is
exactly as the ticket says: when `findBotReviewAtHead` returns `null`, the code
posts a `COMMENT` review at `emitted.commit` annotated "the PR has since advanced".

**(b) Guard (1) as the issue words it ("do not post a verdict whose commit_id is no
longer the PR head") is ALREADY IMPLEMENTED, and the issue's claim that "this alone
would have prevented all twelve" is only true under a reading the acceptance
criteria forbid.** Verified at lines 168-176 and 201-210: a stale intent is *never*
posted as a formal verdict. `executeReviewIntent` (the only path that calls
`github.submitReview` with `APPROVE`/`REQUEST_CHANGES`) is reached only at line 236,
after the `isStale` branch has already returned. The stale path posts
`submitReviewWithComments(..., "COMMENT", ...)` exclusively. So "no formal verdict
off head" holds today.

Making guard (1) *also* prevent the twelve would require dropping the stale COMMENT
entirely — which directly contradicts acceptance criterion 2 ("a first delivery that
is merely late ... still reaches the PR, keeping its finding") and the Definition of
Done test "a stale-but-first delivery ... still posted, as a COMMENTED review,
finding intact. This is the regression that would be worse than the bug."

**Resolution, and it is locked:** the acceptance criteria win over the issue's prose.
Guard (1) is scoped to *"an off-head intent is never a formal verdict"* — already
true, now pinned by an explicit regression test so a future edit cannot route a stale
intent into `executeReviewIntent`. Guard (2) is the admission test that actually
stops the twelve, and is the only new logic in this ticket. The implementer must not
add a "drop all stale posts" switch.

**(c) The ticket says to derive idempotency from GitHub rather than a new column.
That is not merely possible — the primitive already exists and needs no
generalisation beyond how it is *called*.** `findBotReviewAtHead`
(`packages/review/src/review/state/head-review-guard.ts:47-59`) is already
parameterised by an arbitrary `headSha` and matches
`r.user?.login === botLogin && r.commitId === headSha && r.dismissedAt === null`.
Calling it with `emitted.commit` instead of `currentHeadSha` *is* the question
"is there already a review by us at THIS commit". **No change to `packages/review`
is required, and none is permitted** — `packages/review` is not owned by this ticket.

---

## 1. Objetivo / Goal

Stop a worker restart from re-posting verdicts that were already delivered.

When the worker's lease ends without a clean ack, Hatchet redelivers the review
task. `executeReviewFromIntent` re-parses the same persisted terminal text, finds
the same `emitted.commit`, sees that the PR has advanced, finds no bot review at the
*current* head, and posts the stale COMMENT again. On 2026-09-29 one restart drove
that loop twelve times against PR #208 in 63 seconds. The box executed zero tasks in
19:55-20:05, so nothing was recomputed — twelve already-delivered verdicts were
re-posted, each at its own original sha. #208 now carries 29 reviews and none at its
live head; a reader cannot tell which opinion is current.

Outcome enabled: **at most one review by us per `(repo, PR, commit)`**, derived from
GitHub's own state, so a redelivery storm of any length converges to the one review
that was already there — while a genuinely *first* delivery that merely arrived late
still reaches the PR with its finding intact.

This ticket does **not** fix the redelivery. It fixes what the redelivery does to a
PR's review history.

---

## 2. Alcance / Scope

### Incluido en esta fase (in scope)

- A replay guard in the `isStale` branch of
  `apps/www/src/server-lib/review/execute-review-from-intent.ts`: before posting the
  stale COMMENT, ask GitHub whether a non-dismissed review by `botLogin` already
  exists at `emitted.commit`. If yes, skip and log.
- One new outcome variant on `ReviewFromIntentOutcome`:
  `{ outcome: "skipped_duplicate_at_commit"; commit: string }`.
- An explicit, documented decision for the "GitHub lookup failed" case, with a test
  that asserts it.
- A new test file pinning all four Definition-of-Done scenarios plus the guard-(1)
  regression (an off-head intent never becomes a formal verdict).

### Fuera de scope (out of scope) — be exhaustive

- **The redelivery itself.** No change to Hatchet lease/ack, `retries`, the generation
  fence, or the worker restart path. This is the known class recorded as "worker death
  ⇒ redelivered run zombies".
- **Any database schema change.** Hard constraint: production schema migration in this
  repo is manual and the prod `DATABASE_URL` is a write-only Cloudflare Worker secret.
  No new column, no new table, no change to `packages/shared/src/db/schema.ts`, no
  entry in `deploy/assert-schema-ready.ts`.
- **Any change to `packages/review/`.** Not owned by this ticket.
  `findBotReviewAtHead` is used as-is. No rename, no new export, no signature change.
- **Any change to `review-sweep.ts`.** Its own pre-flight `findBotReviewAtHead` at
  `review-sweep.ts:124-131` stays exactly as it is.
- **Any change to `review-single-writer-finish.ts`.** The new outcome is additive; no
  caller performs an exhaustive switch over `ReviewFromIntentOutcome` (verified by
  grep across `apps/www/src` and `packages/`), so no caller needs touching.
- **The degraded / "could not be parsed" path.** `postDegradedComment` and the
  `!parsed.ok` branch (lines 104-151, 281-319) are not modified. See §5 for the
  verification that they do not share the guarded code path.
- **The fresh-at-head path.** `executeReviewIntent`'s existing `(headSha, verdict)`
  idempotency is already correct and already proven by
  `exactly-once-redelivery.test.ts`. Unchanged.
- **Cleaning up the 29 reviews already on #208.** No backfill, no bulk dismiss, no
  reconciler change.
- **Modifying any existing test file.** New tests go in a new file.
- **Reformatting.** `apps/www` is not covered by `format-check` in this repo
  (~30 pre-existing non-conforming files); do not run prettier over it and do not
  touch unrelated lines.
- **Inline-comment posting, the approve-severity floor, the draft cap, the permission
  mode, the skill resolver.** Untouched.
- **UI, i18n, API routes.** This ticket adds no user-facing surface.

---

## 3. Tecnologías y convenciones / Technologies & conventions

Versions cited from `apps/www/package.json` and `packages/review/package.json` in
this worktree:

| Thing | Version / value | Source |
|:--|:--|:--|
| Package | `@terragon/www` | `apps/www/package.json:2` |
| Next.js | `15.5.25` | `apps/www/package.json:97` |
| React | `19.1.2` | `apps/www/package.json:106` |
| TypeScript | `^5.8.3` | `apps/www/package.json:149` |
| Vitest | `^3.1.4` | `apps/www/package.json:152` |
| octokit | `^5.0.2` | `apps/www/package.json:99` |
| zod | `4.1.11` | `apps/www/package.json:128` |
| Review kernel | `@terragon/review` (workspace, pure logic, no transport) | `packages/review/package.json` |
| pnpm | `10.14.0` | repo root |

Conventions to respect (from `.claude/rules/typescript/best-practices.md`, inlined in
`AGENTS.md`):

- `kebab-case.ts` filenames. ES `import` only, never `require()`.
- `type` for unions (`ReviewFromIntentOutcome` is a discriminated union — extend it,
  do not convert it to an interface or an enum).
- Catch `unknown`; narrow with `instanceof Error` before reading `.message`. The file
  already does this at lines 222 and 314.
- `??` for defaults, never `||`.
- No `any`. No `@ts-ignore`.
- Services throw; callers decide. This module is a caller/orchestrator, so it *does*
  catch — matching the existing `try { ... } catch { }` around the head probe
  (lines 178-188).

Existing patterns in this file that the new code must look like:

- Decision-with-rationale comments. Every guard in this file carries a comment
  explaining *why*, often citing the incident that motivated it (see lines 105-119
  for the #140 precedent). The new guard gets the same treatment, citing #208.
- Structured logging via the injected optional `logger?: ReviewLogger`
  (`logger?.info(message, meta)`), never `console.*` inside this module.
- Outcome variants are returned, not thrown.

---

## 4. Dependencias previas / Prerequisites

Each box below was personally verified in this worktree on 2026-09-30 unless marked
otherwise.

- [x] `apps/www/src/server-lib/review/execute-review-from-intent.ts` exists, 319 lines,
      and contains the `isStale` branch at lines 166-234.
- [x] `findBotReviewAtHead` is exported from
      `@terragon/review/state/head-review-guard` and already imported at line 9 of the
      owned file.
- [x] `findBotReviewAtHead` takes an arbitrary `headSha: string` and filters on
      `commitId === headSha`, `user.login === botLogin`, `dismissedAt === null`, across
      **all** review states including `COMMENTED`
      (`packages/review/src/review/state/head-review-guard.ts:47-59`).
- [x] `ReviewGitHubClient.listReviews(repo, prNumber)` returns **all** reviews
      (`octokit.paginate(octokit.rest.pulls.listReviews, { per_page: 100 })`,
      `apps/www/src/server-lib/review/octokit-review-client.ts:49-58`), so a PR with 29
      reviews is fully visible to the guard.
- [x] `GitHubReview.commitId` is populated from GitHub's `commit_id`
      (`octokit-review-client.ts:39`) and `dismissedAt` is synthesised from
      `state === "DISMISSED"` (lines 30, 38).
- [x] `submitReviewWithComments` passes `commit_id: commitSha` to
      `octokit.rest.pulls.createReview` (`octokit-review-client.ts:80-92`), which is why
      a replayed stale COMMENT carries its *original* sha — the fact the incident
      report observed.
- [x] `ReviewFromIntentOutcome` is a plain discriminated union (lines 38-45); no caller
      switches exhaustively over it. Verified by grep over `apps/www/src` and
      `packages/`: the only consumers are
      `review-single-writer-finish.ts:210` (reads `.outcome`, compares against three
      specific strings for the workFailed signal) and
      `review-sweep.ts:143` (logs `.outcome`, sends it to PostHog).
- [x] Existing tests that must keep passing:
      `execute-review-from-intent.test.ts` (359 lines, includes the two stale cases at
      "STALE intent + no newer review" and "STALE intent + a newer bot review at HEAD"),
      `execute-review-from-intent.floor.test.ts`, `exactly-once-redelivery.test.ts`,
      `review-sweep.test.ts`, `review-tolerance.integration.test.ts`.
- [ ] **Docker is running.** The `@terragon/www` vitest suite starts a throwaway
      Postgres via docker compose. Not verifiable from this spec; the implementer
      confirms before running the verification command. The suite is slow — budget for
      it.
- [ ] `pnpm install --frozen-lockfile --prefer-offline` has been run in this worktree
      at least once. Not verified here.

---

## 5. Arquitectura / Architecture

### Pattern

Pure-decision orchestration over an injected `ReviewGitHubClient`. The guard adds no
new seam, no new module, no new dependency — it is one extra call to an existing pure
finder, inside the branch that already exists.

### Affected layers

| Layer | Affected | Description |
|:--|:--|:--|
| UI (`apps/www/src/components`) | **No** | Server-side only; nothing renders. |
| API routes (`apps/www/src/app/api`) | **No** | No endpoint added or changed. |
| Server actions | **No** | Not on this path. |
| Server-lib / review single writer | **Yes** | `execute-review-from-intent.ts` — the one owned file. |
| Review kernel (`packages/review`) | **No** | `findBotReviewAtHead` reused as-is. |
| DB / Drizzle schema | **No** | Hard constraint: no new persisted state. |
| GitHub client (`octokit-review-client.ts`) | **No** | `listReviews` already returns what the guard needs. |
| Sweep / finish hook | **No** | New outcome variant is additive. |
| Daemon / sandbox / worker | **No** | Redelivery is out of scope. |

### The signal that separates a replay from a late first delivery

This is the question the issue says must not be hand-waved, so it is stated once,
precisely:

> **A non-dismissed review authored by `botLogin` already exists on this PR whose
> `commit_id` equals `emitted.commit`.**

- **Present ⇒ replay.** We already said this, at this exact commit, and GitHub is
  still showing it. The reader already has the finding. Posting again adds a second
  copy of an opinion they can already read, and makes "which review is live?"
  strictly harder to answer. Drop it.
- **Absent ⇒ first delivery, merely late.** Nothing we wrote about this commit is on
  the PR. The branch moved while the review ran, but the finding has never been
  delivered. Post it — as the marked `COMMENT` the existing downgrade already
  produces.

Why this signal and not the alternatives considered:

- *Not* "the PR head moved" — that is true for a replay **and** for a late first
  delivery, so it cannot separate them. It is exactly the condition the current code
  tests, and exactly why the current code gets it wrong.
- *Not* a timestamp/age heuristic — the twelve re-posts arrived 63 seconds apart,
  hours after the originals. Any age threshold that caught them would also catch a
  slow-but-first review.
- *Not* a new `posted_at_commit` column — forbidden by the hard constraint, and
  redundant: GitHub already stores exactly this fact, durably, and is the surface the
  duplicate would appear on.

The derived key is `(botLogin, repoFullName, prNumber, commitId)`. Note this is a
**coarsening** of the `(thread, commit)` key the issue names: GitHub reviews carry no
thread id. The coarsening errs in the safe direction (it can never *miss* a duplicate
we posted) and its only cost is that two different review threads landing on the same
PR at the same already-reviewed commit would see the second suppressed — which is the
same one-review-per-commit invariant this module already asserts at head
(`review-intent-executor.ts:164-173`). This is accepted deliberately; see §10, D4.

### Numbered flow (the `isStale` branch after this change)

1. `parseReviewIntent(terminalText)` → `parsed.ok === true`. (A `false` here takes the
   degraded branch and never reaches any of the following. **Unchanged.**)
2. `applyApproveSeverityFloor(...)` → `execIntent`, `effectiveVerdict`. **Unchanged.**
3. `isStale = emitted.commit !== currentHeadSha`. **Unchanged.**
4. `isStale === false` → `runExecutor(...)` → `executeReviewIntent`, whose own
   `(headSha, verdict)` guard already handles redelivery. **Unchanged.**
5. `isStale === true` → **NEW** replay guard: `findBotReviewAtHead({ ..., headSha:
   emitted.commit })`.
   - Found → `logger.info(...)`, return `{ outcome: "skipped_duplicate_at_commit",
     commit: emitted.commit }`. **No GitHub write.**
   - Throws → `logger.warn(...)` and **fall through to step 6** (post anyway). See
     §10, D3.
   - Not found → continue to step 6.
6. Existing supersession probe: `findBotReviewAtHead({ ..., headSha: currentHeadSha })`.
   Found → `skipped_superseded`. Throws → fall through. **Unchanged.**
7. Post the marked `COMMENT` at `emitted.commit` via `submitReviewWithComments`.
   → `posted_stale_comment` / `post_failed`. **Unchanged.**

Step 5 runs **before** step 6 on purpose: "we already said this" is the more specific
and more actionable statement, it is the one that explains the #208 incident, and it
is the one whose log line an operator needs to see. Ordering them the other way would
still prevent the twelve (the head probe returned `null` throughout the incident), but
would attribute the skip to the wrong reason whenever both are true.

### Verified: the degraded path does NOT share the guarded code

Required by the ticket ("ALSO VERIFY, do not assume"). Verified by reading
`execute-review-from-intent.ts` end to end:

- The degraded comment is produced by `postDegradedComment` (lines 281-319), called
  from **line 143**, inside `if (!parsed.ok)` (line 104). That branch `return`s at line
  143/150 and at line 135 — it cannot fall through to line 153 onward.
- `const emitted = parsed.intent` (line 153) and everything after it, including the
  `isStale` branch where the new guard lives, is reachable **only** when
  `parsed.ok === true`.
- The two paths share exactly one thing: the client method
  `github.submitReviewWithComments`. A method, not a decision. The guard is not added
  to the client.
- The hourly sweep's own degraded stamping goes through the same `!parsed.ok` branch
  (`review-sweep.ts:143` → `executeReviewFromIntent` with `terminalText` that does not
  parse), so it is equally unaffected.
- The sweep's *pre-flight* skip (`review-sweep.ts:124-131`) is a separate
  `findBotReviewAtHead` call at live head, in a file this ticket does not touch.
- The box-reboot case ("degraded review at the reboot minute") also lands in
  `!parsed.ok`. Unaffected.

Conclusion: the "degraded / could not be parsed" path keeps working unchanged, and
the existing tests at `execute-review-from-intent.test.ts:215-295` pin it.

### File layout

```
apps/www/src/server-lib/review/
  execute-review-from-intent.ts              ← MODIFY (owned by #213)
  execute-review-from-intent.replay.test.ts  ← NEW
  execute-review-from-intent.test.ts         ← untouched
  execute-review-from-intent.floor.test.ts   ← untouched
  exactly-once-redelivery.test.ts            ← untouched
  review-sweep.ts / review-single-writer-finish.ts ← untouched
packages/review/src/review/state/
  head-review-guard.ts                       ← untouched (reused)
docs/specs/213/
  spec.md                                    ← this file
```

---

## 6. Archivos a crear o modificar / Files to create or modify

| Ruta (absolute) | Acción | Propósito | Ejemplo del proyecto a seguir |
|:--|:--|:--|:--|
| `/Users/senior/.superset/projects/automata-platform/.claude/worktrees/213/apps/www/src/server-lib/review/execute-review-from-intent.ts` | MODIFICAR | Add the `(bot, commit)` replay guard in the `isStale` branch + the new outcome variant. | The existing supersession probe in the same branch (lines 177-200) — same shape, same try/catch posture, same `logger?.info` meta keys. |
| `/Users/senior/.superset/projects/automata-platform/.claude/worktrees/213/apps/www/src/server-lib/review/execute-review-from-intent.replay.test.ts` | NUEVO | Pin the five scenarios of §8. | `exactly-once-redelivery.test.ts` for the stateful-GitHub fake; `execute-review-from-intent.test.ts` for `makeGithub()` + `fenced()` helpers. |

### Phase 1 — the guard (1 file)

**Touches exactly:**
`/Users/senior/.superset/projects/automata-platform/.claude/worktrees/213/apps/www/src/server-lib/review/execute-review-from-intent.ts`

> Preamble, run before touching the file: confirm Docker is running
> (`docker info` succeeds) and that `pnpm install --frozen-lockfile --prefer-offline`
> has been run once in this worktree. Both are needed by the verification command at
> the end of this phase, not by the edit itself.

1. Extend the `ReviewFromIntentOutcome` union (lines 38-45) with
   `| { outcome: "skipped_duplicate_at_commit"; commit: string }`.
   Place it immediately after `skipped_superseded` so related skips read together.
   Do **not** add `workFailed` to it — a correctly suppressed duplicate is a success,
   not a failed run, and adding `workFailed` would page an operator on every replay.
2. Update the `Guarantees:` block in the module docstring (lines 25-32) with a fourth
   bullet naming the new invariant, in the same voice as the existing three:
   `AT MOST ONE REVIEW PER COMMIT: a redelivered run whose intent names a commit we
   have already reviewed posts nothing (#213 — a worker restart re-posted 12 stale
   verdicts onto PR #208 in 63 seconds).`
3. Inside `if (isStale) { ... }`, **before** the existing `let newerAtHead = null;`
   (line 177), insert the guard. Shape it on the existing probe below it:

   ```ts
   // #213 REPLAY GUARD. The worker's lease can end without a clean ack, and the
   // redelivered task re-parses the SAME persisted terminal text — same intent,
   // same `emitted.commit`. The probe below only asks whether something sits at
   // LIVE head, which is false for a replay *and* for a late first delivery, so it
   // cannot tell them apart; on 2026-09-29 one restart therefore re-posted twelve
   // already-delivered verdicts onto PR #208 in 63 seconds, each at its own
   // original sha.
   //
   // The signal that DOES separate them is whether a non-dismissed review by us
   // already exists AT `emitted.commit`:
   //   - present  → we already said this; the reader has it. Drop the replay.
   //   - absent   → never delivered. Post it (the marked COMMENT below), because
   //                losing a first-and-only finding is worse than this bug.
   // Derived from GitHub's own state — the PR's reviews carry `commit_id` and an
   // author — deliberately NOT from a new DB column (prod schema migration here is
   // manual and the prod DATABASE_URL is a write-only Worker secret).
   //
   // `findBotReviewAtHead` is named for its usual caller but is parameterised by an
   // arbitrary sha, so passing `emitted.commit` asks exactly "has the bot already
   // reviewed THIS commit?" across all states including COMMENTED.
   try {
     const alreadyAtIntentCommit = await findBotReviewAtHead({
       github,
       repo: repoFullName,
       prNumber,
       headSha: emitted.commit,
       botLogin,
     });
     if (alreadyAtIntentCommit) {
       logger?.info(
         "review-from-intent: replay of an already-delivered verdict at this commit; skipping",
         {
           repoFullName,
           prNumber,
           intentCommit: emitted.commit,
           currentHeadSha,
           existingReviewId: alreadyAtIntentCommit.id,
           existingReviewState: alreadyAtIntentCommit.state,
         },
       );
       return {
         outcome: "skipped_duplicate_at_commit",
         commit: emitted.commit,
       };
     }
   } catch (err) {
     // LOOKUP FAILED → POST ANYWAY. Deliberate, and the same call this module
     // already makes at the probe below (line ~186): a rare duplicate is
     // recoverable by a reader, a permanently lost first-and-only finding is not.
     // A transient listReviews failure is independent of replay, so post-anyway
     // bounds the damage to the rare-failure window instead of re-opening the
     // deterministic 12x storm.
     logger?.warn(
       "review-from-intent: replay lookup failed; posting the stale COMMENT anyway",
       {
         repoFullName,
         prNumber,
         intentCommit: emitted.commit,
         error: err instanceof Error ? err.message : String(err),
       },
     );
   }
   ```

4. Change nothing else in the file. In particular do not touch `postDegradedComment`,
   `mapOutcome`, `runExecutor`, the floor application, or the `!parsed.ok` branch.

**Verification for phase 1** — run from the worktree ROOT
`/Users/senior/.superset/projects/automata-platform/.claude/worktrees/213`:

```bash
pnpm turbo tsc-check --force --filter=@terragon/www && pnpm --filter @terragon/www exec vitest run --no-file-parallelism
```

Proves: the new union member type-checks at every consumer, and every pre-existing
review test still passes (in particular the two stale cases and the degraded cases in
`execute-review-from-intent.test.ts`). Note that the existing test "STALE intent + no
newer review → posts a COMMENT at the reviewed commit" uses `makeGithub([])` — an
empty review list — so the new guard finds nothing and that test must still pass
unchanged. If it fails, the guard is wrong.

### Phase 2 — the tests (1 file)

**Touches exactly:**
`/Users/senior/.superset/projects/automata-platform/.claude/worktrees/213/apps/www/src/server-lib/review/execute-review-from-intent.replay.test.ts`

New file. Reuse the local `makeGithub()` / `fenced()` helper shape from
`execute-review-from-intent.test.ts:17-56` (copy them into the new file — they are
module-local there and not exported; do not export them from the existing file, which
this ticket does not own) and the stateful-client shape from
`exactly-once-redelivery.test.ts:44-85` for the replay test. Constants:
`BOT = "automata-ai-bot[bot]"`, `REPO = "o/r"`, `PR = 208`, `HEAD = "head-sha"`,
`OLD = "old-sha"`.

Write exactly the five tests enumerated in §8. Nothing else; no snapshot tests, no
helpers beyond the two copied ones.

**Verification for phase 2** — run from the worktree ROOT
`/Users/senior/.superset/projects/automata-platform/.claude/worktrees/213`:

```bash
pnpm turbo tsc-check --force --filter=@terragon/www && pnpm --filter @terragon/www exec vitest run --no-file-parallelism
```

Proves: all five new scenarios hold and nothing regressed. The run must report the new
file with 5 passing tests and zero failures across the suite.

---

## 7. API Contract

**No API surface — no aplica.** This ticket adds no HTTP endpoint, no server action,
no ORPC procedure and no webhook handler. It changes one internal function's return
union inside `apps/www/src/server-lib/`. No sibling `api-contract.md` is written.

The only external contract touched is GitHub's, consumed through the existing
`ReviewGitHubClient` seam, and it is **read-only and unchanged**:

| Call | Where | Shape relied on | Verified |
|:--|:--|:--|:--|
| `listReviews(repo, prNumber)` | `octokit-review-client.ts:49-58` → `GET /repos/{owner}/{repo}/pulls/{n}/reviews`, paginated `per_page: 100` | `GitHubReview[]` with `user: { login } \| null`, `state`, `submittedAt: string \| null`, `dismissedAt: string \| null`, `commitId: string \| null`, `body: string` (`review-github-client.ts:16-33`) | Yes — read in this worktree |
| `submitReviewWithComments(repo, pr, commitSha, "COMMENT", body, [])` | `octokit-review-client.ts:71-93` → `POST .../pulls/{n}/reviews` with `commit_id` | returns `Promise<void>`; throws on non-2xx | Yes — unchanged by this ticket |

`commitId` is nullable in the type. `findBotReviewAtHead` compares
`r.commitId === opts.headSha`, so a `null` `commitId` never matches a non-empty
`emitted.commit` — correct by construction, no extra narrowing needed.

---

## 8. Criterios de éxito / Success criteria

### Verifiable checkboxes

- [ ] A replay of a verdict already delivered for the same `(bot, commit)` produces no
      second GitHub review. Re-running `executeReviewFromIntent` N times against a
      stateful GitHub yields exactly one `submitReviewWithComments` call.
- [ ] A stale-but-first delivery (no review by us at `emitted.commit`) still posts, as
      `COMMENT`, at `emitted.commit`, carrying the intent's summary text (what the stale
      body actually contains today — see test 2 for why it is the summary, not the
      per-finding bodies).
- [ ] A fresh verdict at the current head still posts as the real verdict, byte-for-byte
      the behaviour of today.
- [ ] A failing `listReviews` on the replay guard posts anyway, and logs a warning.
- [ ] A stale intent never produces a formal `APPROVE`/`REQUEST_CHANGES`
      (`github.submitReview` is never called on the stale path).
- [ ] The degraded "could not be parsed" path is untouched: the pre-existing degraded
      tests pass without modification.
- [ ] No file outside the two named in §6 is modified (`git -C <worktree> status
      --porcelain` lists only those two plus `docs/specs/213/spec.md`).
- [ ] `packages/shared/src/db/schema.ts` is unmodified.

### Required tests — file and scenario

All five live in
`/Users/senior/.superset/projects/automata-platform/.claude/worktrees/213/apps/www/src/server-lib/review/execute-review-from-intent.replay.test.ts`.

1. **`the same (thread, commit) delivered twice posts exactly ONE review`**
   Stateful GitHub (reviews array grows on submit). `currentHeadSha = HEAD`, intent
   `commit = OLD`, verdict `request_changes`. Call `executeReviewFromIntent(opts)`
   twice with the identical `opts`.
   Assert: first → `{ outcome: "posted_stale_comment" }`; second →
   `{ outcome: "skipped_duplicate_at_commit", commit: OLD }`;
   `github.submitReviewWithComments` called **once**; the non-dismissed review list has
   length 1 with `commitId === OLD`. Assert the logger received the
   `"replay of an already-delivered verdict"` message (inject a `logger` spy) — this is
   the DoD's "skipped with a logged reason".
   *Strengthened beyond the DoD: also loop the call 12 times and assert
   `submitReviewWithComments` is still 1, reproducing the #208 shape.*

2. **`a stale-but-first delivery still reaches the PR as a COMMENT`**
   `makeGithub([])` — no reviews at all. Intent at `OLD` with a distinctive `summary`
   and a `findings` entry; `currentHeadSha = HEAD`.
   Assert: `{ outcome: "posted_stale_comment", intendedVerdict: "request_changes" }`;
   `submitReviewWithComments` called once with `commitSha === OLD` and
   `event === "COMMENT"`; the body contains `"has since advanced"` **and** the intent's
   **summary** text; `github.submitReview` **not** called.
   **Do not assert the finding body here.** The stale body is
   `<preamble> + execIntent.body` (`execute-review-from-intent.ts:201`), and
   `toExecutorIntent` (`parse-review-intent.ts:97-111`) sets `body = emitted.summary`
   while findings go to `comments`; line 209 then passes `[]` as the comments array, and
   the helper that folds findings into a body (`foldFindingsIntoBody`,
   `packages/review/src/review/state/review-intent-executor.ts:145-158`) is module-local
   and unreachable from this branch. The two pre-existing stale tests
   (`execute-review-from-intent.test.ts:117-144` and `:273-293`) assert exactly this
   shape. Carrying per-finding bodies into the stale COMMENT would be a production
   change, and it is **out of scope** for this ticket (§2: the stale path stays
   unchanged).
   *This is still the regression that would be worse than the bug — the test must fail
   if the guard is widened into a blanket stale drop.*

3. **`a fresh verdict at the current head posts the real verdict, unchanged`**
   `makeGithub([])`, intent `commit === HEAD === currentHeadSha`, verdict
   `request_changes`.
   Assert: `{ outcome: "posted", verdict: "request_changes" }`; `github.submitReview`
   called once with `"REQUEST_CHANGES"`; `submitReviewWithComments` **not** called; the
   replay guard did not fire (no `skipped_duplicate_at_commit`).

4. **`a failing replay lookup posts anyway (duplicate risk accepted, lost verdict not)`**
   `listReviews` rejects with `new Error("gh 502")`. Intent at `OLD`,
   `currentHeadSha = HEAD`.
   Assert: `{ outcome: "posted_stale_comment" }`; `submitReviewWithComments` called
   once at `OLD`; the injected logger received a `warn` containing
   `"replay lookup failed"`. Add a second case with a non-2xx-shaped rejection
   (`Object.assign(new Error("Not Found"), { status: 404 })`) and assert the same
   outcome, so the decision is pinned for both network and HTTP failures.

5. **`a stale intent is never a formal verdict (guard 1 regression)`**
   Intent at `OLD` with verdict `approve`, `currentHeadSha = HEAD`, `makeGithub([])`.
   Assert: `github.submitReview` **not** called; the single
   `submitReviewWithComments` call has `event === "COMMENT"`.

Plus, implicitly required to keep passing (not re-written):
`execute-review-from-intent.test.ts` ("STALE intent + a newer bot review at HEAD →
skipped_superseded" proves ordering did not break supersession; the degraded suites
prove §5's claim), `exactly-once-redelivery.test.ts`, `review-sweep.test.ts`,
`review-tolerance.integration.test.ts`, `execute-review-from-intent.floor.test.ts`.

### Exact verification commands for this project

From the worktree ROOT
`/Users/senior/.superset/projects/automata-platform/.claude/worktrees/213`:

```bash
pnpm turbo tsc-check --force --filter=@terragon/www && pnpm --filter @terragon/www exec vitest run --no-file-parallelism
```

- `--force` is mandatory: a cached `tsc-check` replays another worktree's result and is
  not evidence.
- Run it from the ROOT, never from inside `apps/www` — running the package script
  directly skips turbo's cross-package dependency build (`packages/*` dist output) and
  has previously produced false "module not found" failures for correct code.
- `format-check` is deliberately **not** part of this command: `apps/www` is not covered
  by it in this repo (~30 pre-existing non-conforming files). Do not add it; do not
  reformat.
- Docker must be running — the suite brings up a throwaway Postgres via docker compose.
  It is slow; let it finish rather than interrupting and re-running.

---

## 9. Criterios de UX / UX criteria

**Not applicable — this ticket has no user interface.** It changes a server-side
single-writer function in `apps/www/src/server-lib/`; nothing renders, no form exists,
no navigation changes, no password or auth input is involved, and there is no
accessibility surface.

The nearest thing to a "user experience" here is what a human reads on the pull
request, and the one rule that governs it is stated in §10, D1: a reader must be able
to tell which opinion is live, so a verdict already on the PR is never re-posted, and a
verdict never yet on the PR is always posted.

---

## 10. Decisiones tomadas / Decisions made (locked)

The implementer must not change these.

**D1 — Idempotency key is `(botLogin, repo, prNumber, commitId)`, read from GitHub.**
Why: the issue forbids a new DB column (prod schema migration is manual, the prod
`DATABASE_URL` is a write-only Cloudflare Worker secret, and merging schema-dependent
code without the manual push leaves production reading columns that do not exist).
GitHub already stores this fact durably, and stores it on the exact surface where a
duplicate would appear. No new persisted state is needed, and none is added.
*This answers the ticket's "if you become convinced idempotency cannot be done without
new persisted state, STOP and say so": it can, and here is how.*

**D2 — The separating signal is "a non-dismissed review by us already exists at
`emitted.commit`", not head movement and not age.** Why: head movement is true for both
a replay and a late first delivery — it is the condition the broken code already tests.
Age cannot separate them either (the twelve replays were hours old; so is a slow first
review). See §5 for the full argument.

**D3 — A failed replay lookup posts anyway.** Why: the ticket is explicit that dropping
a first-and-only delivery is a worse bug than the one being fixed. A `listReviews`
failure is transient and independent of replay, so post-anyway bounds the damage to the
rare-failure window, whereas skip-on-failure would silently lose a finding with no
record anywhere. It is also the decision this module already made at the adjacent probe
(`execute-review-from-intent.ts:186-188`, "read failure → fall through and post (missed
verdict worse than rare dup)") and at `review-intent-executor.ts:174` ("A failed
idempotency read does NOT drop a real review"). Consistency across the three guards in
this path matters more than shaving the last duplicate. The decision is carried in a
code comment and asserted by test 4.

**D4 — `(bot, commit)` is accepted as a coarsening of `(thread, commit)`.** Why: GitHub
reviews carry no thread identity, and the only alternative is persisted state (forbidden
by the hard constraint). The coarsening can never miss a duplicate we posted; its only
cost is suppressing a second, different review at an *already-reviewed old* commit —
which is the same one-review-per-commit invariant this module already enforces at head.

**D5 — The replay guard runs before the supersession probe.** Why: "we already said
this at this commit" is the more specific and more actionable reason, and it is the one
that explains #208. Both orderings prevent the twelve; only this one logs the truth.

**D6 — `skipped_duplicate_at_commit` carries no `workFailed: true`.** Why: a correctly
suppressed replay is the system working. `review-single-writer-finish.ts` pages an
operator on `degraded_comment | post_failed | skipped_stale_degrade`; adding this
variant there would page on every worker restart.

**D7 — Guard (1) is scoped to "an off-head intent is never a formal verdict", which is
already true, and is pinned by test 5 rather than re-implemented.** Why: §0(b). The
literal reading contradicts acceptance criterion 2. No blanket stale drop is added.

**D8 — `packages/review` is not modified.** `findBotReviewAtHead` is called with
`emitted.commit`. Why: ownership (the map assigns only
`execute-review-from-intent.ts` to #213), and the function is already correctly
parameterised — a rename would be churn across `review-sweep.ts`,
`review-intent-executor.ts` and `packages/review/tests/`, all unowned.

**D9 — New tests go in a new file; no existing test file is edited.** Why: surgical
changes only, and the existing files are shared with other concerns (floor, tolerance,
sweep).

---

## 11. Edge cases

- **Datos inválidos — intent fails to parse.** Takes the `!parsed.ok` branch at line
  104 and never reaches the guard. Degraded COMMENT or `skipped_stale_degrade` exactly
  as today. Covered by the existing suite.
- **Datos inválidos — `emitted.commit` is a sha that is not on the PR.** The guard
  finds no matching review (correct: we never reviewed it) and falls through; the post
  then fails with GitHub 422 → `post_failed` + `workFailed`, exactly as today. Not a
  new behaviour and not in scope.
- **Datos inválidos — `commitId` is `null` on some listed review.** `=== emitted.commit`
  is false for a non-empty string, so such a review never matches. No narrowing needed.
- **Datos inválidos — `user` is `null` on a review (ghost/deleted author).**
  `r.user?.login === botLogin` is false. Never matches. Inherited from
  `head-review-guard.ts:54`.
- **API error 401 / 403 on `listReviews`** (expired App installation token, revoked
  install): guard throws → warn + post anyway (D3). The subsequent post will likely also
  401/403 → `post_failed` + `workFailed`, which pages. Correct.
- **API error 404 on `listReviews`** (PR or repo gone): same as above — post anyway, the
  post 404s, `post_failed`. Asserted by test 4's second case.
- **API error 422 on the post** (`commit_id` not part of the PR, e.g. after a
  force-push rewrote history): `post_failed` + `workFailed`. Today's behaviour, kept.
- **API error 429 / secondary rate limit on `listReviews`**: guard throws → post anyway.
  Acceptable: the stale path is rare, and the guard adds exactly one extra
  `listReviews` per stale execution.
- **API error 5xx on `listReviews`**: same as 429. Asserted by test 4's first case.
- **Sin conexión / network error (`ECONNREFUSED`, DNS):** the thrown error is caught by
  the guard's `catch`, warned, and the post is attempted; it will throw too and surface
  as `post_failed` + `workFailed`. Never a silent drop.
- **Timeout:** octokit's own request timeout surfaces as a rejected promise, handled
  identically to the network error above. No timeout is added in this ticket.
- **Respuesta vacía / inesperada — `listReviews` returns `[]`** on a PR that does have
  reviews (eventual consistency right after a post): the guard finds nothing and posts,
  producing one duplicate. This is the residual window D3 explicitly accepts; it is
  bounded to one extra review, not twelve, because the next redelivery will see the
  list populated.
- **Respuesta vacía — the prior review at `emitted.commit` was DISMISSED.**
  `dismissedAt !== null` → not a match → we post again. Deliberate and inherited: a
  dismissed review is withdrawn, so re-stating the finding is correct. In practice
  GitHub does not allow dismissing a `COMMENTED` review, so the stale COMMENTs this
  ticket is about are never dismissed.
- **Doble submit — the finish hook and the hourly sweep fire for the same thread.**
  The sweep's 10-minute grace plus its own `findBotReviewAtHead` pre-flight
  (`review-sweep.ts:124-131`) make this rare; when it happens with a stale intent, the
  new guard converges it to `skipped_duplicate_at_commit`. When it happens with a fresh
  intent, `executeReviewIntent`'s `(headSha, verdict)` guard converges it to
  `skipped_existing`. Both paths are now covered.
- **Doble submit — 12 redeliveries in 63 seconds (the #208 shape).** First one posts (or
  skips, if the original is still there — which it was on #208, so all twelve skip);
  every subsequent one skips. Asserted by test 1's 12-iteration loop.

---

## 12. Estados de UI requeridos / Required UI states

**Not applicable — no UI.** This ticket adds no component, page, or rendered state.

For completeness, the equivalent server-side outcome states of
`executeReviewFromIntent` after this change, since they are what telemetry and the
on-call operator see:

| State | Outcome value | `workFailed` | Meaning |
|:--|:--|:--|:--|
| success (fresh) | `posted` | no | Real verdict posted at head. |
| success (late first) | `posted_stale_comment` | no | Marked COMMENT posted at the reviewed commit. |
| idempotent no-op (head) | `skipped_existing` | no | Same verdict already at head. |
| idempotent no-op (superseded) | `skipped_superseded` | no | A newer bot review already sits at head. |
| **idempotent no-op (replay) — NEW** | `skipped_duplicate_at_commit` | no | We already reviewed this exact commit. |
| withheld warning | `skipped_stale_degrade` | yes | Unparseable intent from a run that cannot speak for head. |
| degraded | `degraded_comment` | yes | Unparseable intent; marked COMMENT posted. |
| error | `post_failed` | yes | GitHub rejected the write. |

---

## 13. Validaciones / Validations

**Validaciones de cliente: not applicable — no form, no client input.**

**Validaciones de servidor:** no new validation is introduced. The only input this
ticket reads is `emitted.commit`, already validated upstream by
`emittedReviewIntentSchema` in `parse-review-intent.ts:27-37`
(`commit: z.string().min(1)`), so the guard can never be called with an empty sha —
and `findBotReviewAtHead` additionally returns `null` on a falsy `headSha`
(`head-review-guard.ts:50`), which is a second, inherited floor.

There is no `api-contract.md` to defer to (§7: no API surface).

---

## 14. Seguridad y permisos / Security & permissions

- **No new credential is read, stored, or transmitted.** The guard reuses the
  already-constructed `ReviewGitHubClient`, which is built from the App-scoped octokit
  (`getOctokitForApp`) by the caller. The review agent itself holds no GitHub token —
  that is ADR-004's credential fence, and this ticket does not weaken it.
- **No new permission scope.** `listReviews` is already called on this path (twice now
  on the stale branch instead of once); it needs only the pull-request read the App
  already has.
- **401 / 403 flow:** an expired or revoked installation token surfaces as a thrown
  error from `listReviews` → warn + post-anyway (D3) → the post throws too →
  `post_failed` + `workFailed: true` → `review-single-writer-finish.ts` captures it to
  PostHog and pages. No silent swallow.
- **No sensitive payload.** The guard reads review metadata (id, state, commit, author)
  and never writes anything new to GitHub.
- **Secret handling:** nothing in the new code touches a token, header, or URL that
  could carry one. Note the adjacent repo hazard recorded in memory — *git auth headers
  leaking via `execFile` failure text* — does not apply here: this path shells out to
  nothing, and the only interpolated value in a log line is a sha, a review id, a state
  string, and an `Error.message` from octokit (which does not embed the installation
  token).
- **No PII.** Review ids, shas and states only. `botLogin` is a bot account name, not a
  person.

---

## 15. Observabilidad y logging

The project's real mechanism on this path is the **injected optional
`ReviewLogger`** (`packages/review/src/review/state/review-github-client.ts:73-77`),
which `review-single-writer-finish.ts:230-237` wires to
`console.log/warn/error` prefixed `[review-single-writer]`, and which the sweep leaves
undefined (its own `console.log` carries the outcome). Outcomes additionally reach
**PostHog** as `review_single_writer_outcome` (finish hook) and
`review_sweep_backstop` (sweep), both with `outcome` as a property.

**Log on the new path:**

- `logger?.info("review-from-intent: replay of an already-delivered verdict at this commit; skipping", { repoFullName, prNumber, intentCommit, currentHeadSha, existingReviewId, existingReviewState })`
  — `info`, not `warn`: a suppressed replay is the guard working. `existingReviewId`
  is what an operator needs to open the review that already exists and confirm the
  reader has the finding.
- `logger?.warn("review-from-intent: replay lookup failed; posting the stale COMMENT anyway", { repoFullName, prNumber, intentCommit, error })`
  — `warn`, because a duplicate may now appear and that is worth noticing, but the run
  itself did not fail.

**Telemetry:** `skipped_duplicate_at_commit` flows into the existing PostHog
`outcome` property with no code change at either call site. A spike in it is the
signal that redelivery is happening — which is the *other* ticket, and this is how it
stays visible after this one silences its symptom. Do not suppress it.

**Never log:** tokens, `Authorization` headers, full octokit request objects, the
review body text, or any thread/user content. The new log lines carry only ids, shas,
a review state, and an `Error.message`.

---

## 16. i18n / textos visibles

**Not applicable — no translation keys are required.** This ticket adds no
user-facing UI string. The two strings it adds are English log messages, which are
developer-facing operational output and are correctly not translated (matching every
other `logger?.*` call in this file).

The one string that reaches a human reader — the stale COMMENT body built at
`execute-review-from-intent.ts:201` — is **unchanged** by this ticket. It is a GitHub
review body in English, consistent with `DEGRADED_INTENT_MARKER` (line 35-36), and
this repo has no i18n layer for GitHub-posted text.

| Key | Required | Note |
|:--|:--|:--|
| — | none | No visible UI string added or changed. |

---

## 17. Performance

- **Renders:** not applicable, no component.
- **Repeated API calls:** the guard adds **exactly one** `listReviews` call, and only
  on the stale branch (`emitted.commit !== currentHeadSha`). The fresh path — the
  overwhelming majority — is unchanged at one call inside `executeReviewIntent`. The
  stale path therefore goes from one `listReviews` to two.
  - This is deliberate and locked. The alternative — one `listReviews` and two local
    filters — would duplicate `head-review-guard`'s matching rules (author, commit,
    dismissed, all-states) inside an unowned-logic-shaped helper in `apps/www`, and a
    drifting copy of a correctness filter is a worse failure mode than one extra read.
    Recorded as a deliberate non-optimisation.
  - Budget check: the GitHub App limit is 5000 requests/hour. The #208 storm was 12
    stale executions in 63 seconds = 24 `listReviews` calls where there used to be 12,
    against a limit three orders of magnitude higher. Irrelevant.
  - And the guard *removes* 12 write calls (`createReview`) from exactly that storm,
    so the net request count goes down, not up.
- **Debouncing / cancellation:** none added. Debouncing a correctness guard would
  reintroduce the window it closes.
- **Caching:** none. The guard must read GitHub's live state — a cached review list is
  precisely the stale premise that caused the bug. Do not memoize `listReviews`.
- **Pagination:** `listReviews` paginates at `per_page: 100` through
  `octokit.paginate`, so a PR with 29 (or 300) reviews is fully scanned. Verified at
  `octokit-review-client.ts:51-57`.

---

## 18. Restricciones / Restrictions — hard "do not" rules

1. **Do NOT add a database column, table, or migration.** Not to
   `packages/shared/src/db/schema.ts`, not to `deploy/assert-schema-ready.ts`, not
   anywhere. Prod migration is manual and the prod `DATABASE_URL` is unreadable.
2. **Do NOT modify any file in `packages/review/`.** Including
   `head-review-guard.ts`. Call it with a different argument instead.
3. **Do NOT modify `review-sweep.ts`, `review-single-writer-finish.ts`,
   `octokit-review-client.ts`, or `parse-review-intent.ts`.** None is owned by #213.
4. **Do NOT modify any existing test file.** New tests go in the new file only.
5. **Do NOT make the guard drop a stale post when no review exists at that commit.**
   That is the regression the DoD calls worse than the bug.
6. **Do NOT make the guard skip on a lookup failure.** D3 is locked; the comment
   explaining it must be in the code.
7. **Do NOT touch the `!parsed.ok` / degraded path**, or add the guard to
   `postDegradedComment`, or to the `ReviewGitHubClient` implementation. The hourly
   sweep and box reboots depend on it.
8. **Do NOT add `workFailed: true` to the new outcome.**
9. **Do NOT run prettier over `apps/www`** or add `format-check` to the verification
   command. ~30 files are pre-existing non-conforming; reformatting them is unrelated
   churn.
10. **Do NOT scope verification into `apps/www/`.** Run the turbo command from the
    worktree root, with `--force`.
11. **Do NOT cache or memoize `listReviews`.**
12. **Do NOT use `any`, `@ts-ignore`, or `!` without a justifying comment.** Catch
    `unknown` and narrow with `instanceof Error`.
13. **Do NOT "improve" adjacent code**, comments, or formatting in the owned file
    beyond the four edits listed in phase 1. If something else looks wrong, report it;
    do not fix it inline.
14. **Do NOT attempt to deploy, push schema, or restart the worker** as part of this
    ticket.

---

## 19. Entregables / Deliverables

- [ ] `apps/www/src/server-lib/review/execute-review-from-intent.ts` — replay guard in
      the `isStale` branch, new `skipped_duplicate_at_commit` outcome, updated
      `Guarantees:` docstring, both decision comments (the separating signal; the
      post-anyway-on-lookup-failure choice) present in the code.
- [ ] `apps/www/src/server-lib/review/execute-review-from-intent.replay.test.ts` — the
      five tests of §8, including the 12-iteration #208 reproduction and the
      stale-but-first regression (COMMENT event, reviewed commit, summary text in the
      body — not the per-finding bodies).
- [ ] `docs/specs/213/spec.md` — this file.
- [ ] Verification command green from the worktree root, with `--force`.
- [ ] `git status --porcelain` shows only those three paths.
- [ ] A one-paragraph note in the PR body stating the two ticket-vs-code disagreements
      from §0(b) and §0(a), so the reviewer is not surprised that guard (1) needed no
      new logic.

---

## 20. Checklist final para el agente / Final agent checklist

- [ ] I read `execute-review-from-intent.ts:166-234` before editing, and built the fix
      around what is actually there (not around the ticket's line numbers).
- [ ] The guard calls `findBotReviewAtHead` with `headSha: emitted.commit`, and
      `packages/review/` is unmodified (`git diff --stat -- packages/review` is empty).
- [ ] No DB column, table, migration, or `assert-schema-ready.ts` entry was added
      (`git diff --stat -- packages/shared deploy` is empty).
- [ ] The separating signal is written in a code comment and matches §5 verbatim in
      substance: *a non-dismissed review by `botLogin` already exists at
      `emitted.commit`*.
- [ ] The lookup-failure decision (post anyway) is justified in a code comment and
      asserted by test 4, for both a network error and an HTTP-status error.
- [ ] Test 2 (stale-but-first still posts as a COMMENT at the reviewed commit, carrying
      the intent's summary text — not the per-finding bodies) passes — and I confirmed it
      **fails** if I temporarily make the guard drop all stale posts, proving the test
      actually guards the worse-than-the-bug regression.
- [ ] Test 1 includes the 12-iteration loop and asserts exactly one
      `submitReviewWithComments`.
- [ ] Test 5 asserts `github.submitReview` is never called on the stale path.
- [ ] The pre-existing degraded tests in `execute-review-from-intent.test.ts:215-295`
      pass **unmodified**, and I did not touch `postDegradedComment` or the `!parsed.ok`
      branch.
- [ ] The pre-existing "STALE intent + no newer review" and "STALE intent + a newer bot
      review at HEAD" tests pass unmodified.
- [ ] `skipped_duplicate_at_commit` has no `workFailed` and no caller was changed to
      handle it.
- [ ] I ran, from `/Users/senior/.superset/projects/automata-platform/.claude/worktrees/213`,
      with Docker up:
      `pnpm turbo tsc-check --force --filter=@terragon/www && pnpm --filter @terragon/www exec vitest run --no-file-parallelism`
      and both halves exited 0 (checked the exit code, not the scrollback).
- [ ] `git -C /Users/senior/.superset/projects/automata-platform/.claude/worktrees/213 status --porcelain`
      lists only the two source paths plus `docs/specs/213/spec.md`.
- [ ] I did not run prettier over `apps/www` and did not add `format-check`.
- [ ] Anything else I noticed as worth fixing is written in the PR body, not fixed
      inline.

---

## Open questions

1. **Should the duplicate-skip be surfaced anywhere beyond logs and the existing
   PostHog `outcome` property?** This spec says no (§15) on the grounds that a rising
   `skipped_duplicate_at_commit` count is exactly the signal for the *redelivery*
   ticket, and the existing telemetry already carries it. If the team wants a dedicated
   alert, that is a follow-up, not this ticket.
2. **Should the 29 stale reviews already on PR #208 be cleaned up?** Explicitly out of
   scope here (§2). Flagged for a separate decision — note that GitHub does not allow
   dismissing `COMMENTED` reviews, so "cleanup" may not be mechanically possible.
3. **Was the #208 batch entirely stale COMMENTs?** The incident report says each review
   "carried the sha it was originally computed for", which can only come from the
   `submitReviewWithComments(..., emitted.commit, "COMMENT", ...)` path at line 203 —
   consistent with the stale branch and with the fix placed there. Not independently
   confirmed against the live PR from this worktree (no GitHub read was performed while
   writing this spec); if the implementer has access, confirming that all twelve are
   `COMMENTED` with distinct `commit_id`s would close the loop. It does not change the
   fix either way, because a replay at head is already caught by
   `executeReviewIntent`'s existing guard.
