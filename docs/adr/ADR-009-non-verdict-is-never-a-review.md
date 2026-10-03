# ADR-009: A non-verdict is never a review — the bot's silence is a notice in the PR conversation

- **Status:** Accepted
- **Date:** 2026-10-03
- **Context source:** a review run that had no git access reported "I could not review this PR"
  and it was posted as a `COMMENTED` review on a PR that was ready for review.
  `apps/www/src/server-lib/review/execute-review-from-intent.ts` (`reportNoVerdict`,
  `isBareCommentOnReadyPr`), `apps/www/src/server-lib/review/review-notice.ts` (the notice),
  `apps/www/src/server-lib/review/parse-review-intent.ts` (`unable_to_review`),
  `apps/www/src/server-lib/review/review-sweep.ts` (passes the draft state),
  `deploy/skills/github-ops/SKILL.md` ("If you cannot review").
- **Deciders:** operator + 2026-10-03 investigation
- **Relates to:** ADR-004 (the review lane is emit-only; the control plane is the single writer),
  ADR-008 (the same "one marked comment, owned by the bot" shape on the merged-PR lane).
- **Supersedes / superseded by:** amends the degraded-COMMENT behaviour described in
  [`../uat/adr-036-effect-intent.md`](../uat/adr-036-effect-intent.md); the single-writer channel
  itself is unchanged.

## Context

People wait on the bot's verdict. A review on the PR means "this commit was reviewed"; the
author, the teammates and every tool that reads the PR's review state take it that way.

Two paths posted a review that carried no verdict:

1. **The agent could not review.** The skill told an agent that could not obtain a diff to choose
   `comment`. The control plane posted it as a `COMMENTED` review. Our own guards then counted it
   as a verdict at that commit: the hourly sweep skipped the thread, and the replay guard treated
   the commit as delivered.
2. **The control plane could not read the run.** An unparseable intent was posted as a marked
   `COMMENTED` review. Three separate guards had to learn to read that review as silence (#213,
   #221, #224), each after it had lost or hidden a real verdict.

A `COMMENTED` review is also the one review state GitHub cannot dismiss. Once posted it stays on
the PR's timeline as a review.

## Decision

**A run that produced no verdict never posts a review.** It posts one marked comment in the PR
conversation (the notice) and returns a `workFailed` outcome so an operator hears about it. The
PR's review state stays empty, which is the truth.

A run has no verdict when any of these holds:

| Cause                            | What happened                                                           |
| :------------------------------- | :---------------------------------------------------------------------- |
| `unparseable`                    | The control plane could not read an intent out of the run's output.     |
| `agent_unable`                   | The agent emitted `{"verdict": "unable_to_review", "reason": …}`.       |
| `agent_comment_without_findings` | The agent chose `comment` with no findings on a PR that is not a draft. |

The third cause is enforced server-side on purpose. Skill bodies are stored per repository and can
lag the tracked file, so the guarantee must not depend on which body a repo runs.

The notice:

- starts with `<!-- automata:review-notice sha=<sha> -->` and is authored by the App bot; both are
  checked, and the marker is matched as a prefix;
- **at most one live notice per PR**, about the newest commit without a verdict — a notice for a
  new commit is created first, then the older one is deleted;
- **at most one notice per commit** (#220's key, now read from the conversation);
- **is deleted when a verdict posts at HEAD**, so a PR never shows "no verdict" beside a verdict;
- is withheld when the run cannot speak for HEAD (abandoned, dispatched at an older commit, or
  naming an older commit) — the `workFailed` signal still fires.

`comment` stays a review in two cases: on a draft PR, and when it carries findings (the agent
surfacing findings below the repository's block floor, or the approve floor downgrading an
`approve`).

## Options considered

- **Keep the degraded `COMMENTED` review, fix the skill wording only.** Rejected: it leaves the
  guarantee in a prompt, and it leaves a non-dismissable review on ready PRs.
- **Alert the operator only, post nothing on the PR.** Rejected: the author keeps waiting for a
  verdict that is not coming.
- **Allow the non-verdict review on drafts only.** Rejected: two behaviours for one condition, and
  a draft that is marked ready keeps the review.
- **A GitHub check run instead of a comment.** Deferred: it needs a new App permission and a
  status lifecycle; the notice needs neither.

## Consequences

Positive:

- A bot review on a PR always carries a verdict or findings.
- A new silent run cannot satisfy any review guard, because it leaves no review. The
  `isDegradedComment` filters remain only for degraded reviews posted before this ADR.
- The author is told why there is no verdict and what to do next.

Negative / watch:

- One extra `listComments` call after each posted verdict (to retire a notice) and on each
  no-verdict run (dedup).
- For up to six hours after rollout, a thread whose commit already carries a legacy degraded
  review can also receive a notice from the hourly sweep. It happens once per commit.
- A no-verdict run is still not retried. A bounded automatic re-run is tracked in #107.

## Anti-deviation invariants

1. No code path may call `submitReview` or `submitReviewWithComments` for a run without a verdict.
2. `unable_to_review` is not a member of the verdict enum and never reaches the review executor.
3. Notice matching always checks the author and matches the marker as a prefix.
4. An absent draft flag is read as "ready for review".
5. A failure to publish, dedup or retire a notice never throws and never costs a verdict.

## Testing

`execute-review-from-intent.test.ts` ("ADR-009 — a non-verdict is never posted as a review"),
`execute-review-from-intent.replay.test.ts` ("#220 no-verdict dedup"), `review-notice.test.ts`,
`parse-review-intent.test.ts` ("unable_to_review"), `review-sweep.test.ts` (draft state reaches
the executor), `skill-contract-drift.test.ts` (the skill's unable example parses).
