# ADR-036 effect-intent parity — UAT cases (S1–S14)

Re-runnable acceptance cases. Read [`README.md`](./README.md) first: set `$REPO/$BASE/$BOT_LOGIN/$BOT_HANDLE/$WORKER_URL/$HATCHET_PG`, run the preflight, stage the fixture PR.
Each case: **Purpose/invariant → Preconditions → Trigger → Expected + where to look → Verdict rubric.**
Every recipe below was executed live on 2026-07-18 (evidence: `docs/triage/UAT-VALIDATION-MATRIX.md`).

Scoring is at the **effect-intent level** (which intent fired, verdict semantics, no-dup idempotency, severity). Surface deltas vs orch-agents are annotated as **known-gaps**, not FAILs. A case FAILs only if intent/verdict/idempotency diverges.

---

## S1 — Review lifecycle: opened → CHANGES_REQUESTED
- **Invariant:** a PR with real defects gets exactly ONE non-dismissed `CHANGES_REQUESTED` at HEAD naming the security + correctness issues. (no-dup)
- **Preconditions:** pull_request review automation on `$REPO`; fixture PR staged (`$PR`, HEAD `$SHA`).
- **Trigger:** open the fixture PR (the `pull_request.opened` webhook auto-dispatches).
- **Expected + where:**
  - Formal review, `state=CHANGES_REQUESTED`, author `$BOT_LOGIN`, body names off-by-one (`>` vs `>=`) AND the `console.log` secret, each with `file`.
    `gh api repos/$REPO/pulls/$PR/reviews --jq '.[]|{state,author:.user.login,commit:.commit_id[0:8]}'`
  - no-dup check (README) = count 1 at `$SHA`.
  - Run id: OLAP lookup (README).
- **Verdict rubric:** PASS if CHANGES_REQUESTED + defects named + no-dup=1 + `$BOT_LOGIN` identity + formal-review surface.
  - **KNOWN-GAP (INTERIM-RECONCILER):** the agent posts via raw `gh pr review` (0 `emit_review`); a tool-layer retry can double-post 2 identical CRs, dismissed to 1 by the www reconciler at thread-finish (`dup_reconciled` telemetry, `actionableCount:2 → keepId`). So no-dup holds *eventually*, not structurally. Upgrade: phase-2 single-writer emit_review. If you observe a transient 2 that never reconciles to 1 → FAIL.

## S2 — synchronize (partial fix) → still CHANGES_REQUESTED
- **Invariant:** fixing SOME issues keeps the PR blocked at the new HEAD; the fixed item is acknowledged, not re-raised; no-dup at new HEAD.
- **Preconditions:** S1 done on `$PR` (a CR exists).
- **Trigger:** push a partial fix (remove the `console.log` only; leave off-by-one) to the PR branch → `synchronize`.
  ```bash
  # edit scripts/uat/parity-fixture.ts: delete logKey's console.log; keep off-by-one
  git commit -am "uat S2: partial fix — remove console.log"; git push origin "HEAD:refs/heads/$BR"
  ```
- **Expected + where:** still `CHANGES_REQUESTED` at NEW HEAD; body has a **Fixed/Resolved** note for the security item and re-raises ONLY the outstanding items (off-by-one, attestation); no-dup at new HEAD = 1. `gh api repos/$REPO/pulls/$PR/reviews`.
- **Verdict rubric:** PASS if still-CR at new HEAD + fixed item acknowledged-not-reraised + no-dup=1. (prior-commit CR lingering non-dismissed is OK — dismissal is S3's job.)

## S3 — synchronize (full fix) → APPROVE + dismiss prior
- **Invariant:** fixing ALL issues flips to `APPROVED` at HEAD AND dismisses all prior `CHANGES_REQUESTED` — exactly one non-dismissed review, zero blocking verdicts. (supersede-dismiss on verdict change)
- **Preconditions:** S1/S2 done on `$PR`.
- **Trigger:** push the full fix (off-by-one → `>=`, remove false attestation) → `synchronize`.
- **Expected + where:** review at HEAD = `APPROVED`; all prior `CHANGES_REQUESTED` now `state=DISMISSED`; no-dup = 1 (the APPROVE).
  `gh api repos/$REPO/pulls/$PR/reviews --jq '.[]|{state,commit:.commit_id[0:7]}'`
- **Verdict rubric:** PASS if APPROVED at HEAD + prior CRs dismissed + non-dismissed-blocking=0. This is the interim reconciler's supersede-dismiss path (proven live 2026-07-18).

## S4 — Mention: ANSWER → one reply
- **Invariant:** an @-mention question gets exactly ONE reply that answers; idempotent on redelivery.
- **Preconditions:** github_mention automation; act-from identity OAuth-linked.
- **Trigger:** `CID=$(gh api repos/$REPO/issues/$PR/comments -f body="@${BOT_HANDLE} what does the isAdult function do?" --jq '.id')`
- **Expected + where:** exactly one new comment by `$BOT_LOGIN` that answers; eyes-reaction on the mention.
  `gh api repos/$REPO/issues/$PR/comments --jq "[.[]|select(.user.login==\"$BOT_LOGIN\" and .created_at>\"<mention-time>\")]|length"  # == 1`
- **Verdict rubric:** PASS if one answering reply + `$BOT_LOGIN`.
  - **KNOWN-GAP:** reply tags the author via `@mention`, NOT the OLD `reply-to:$CID` marker. Redelivery-dedup mechanism differs and is unverified here — to test, redeliver the webhook and assert still exactly one reply.

## S5 — Mention: RE-REVIEW (deduped verdict) → STILL replies
- **Invariant:** re-review when a non-dismissed verdict already exists at HEAD → the formal review is DEDUPED (no new verdict row) AND a reply still lands (mention-always-replies).
- **Preconditions:** `$PR` has a non-dismissed bot review at HEAD (e.g. after S3's APPROVE, or S1's CR).
- **Trigger:** `gh api repos/$REPO/issues/$PR/comments -f body="@${BOT_HANDLE} please re-review this PR"`
- **Expected + where:** non-dismissed verdict count UNCHANGED (still 1, same state); ≥1 new reply comment.
  `gh api repos/$REPO/pulls/$PR/reviews --jq '[.[]|select(.dismissed_at==null and (.state=="APPROVED" or .state=="CHANGES_REQUESTED"))]|length'  # stays 1`
- **Verdict rubric:** PASS if verdict deduped (no-dup stays 1) AND reply not silenced.

## S6 — Mention: CODE FIX → edit + push + reply
- **Invariant:** a "please fix X" mention makes the bot author a commit that fixes X and push it, plus one summarizing reply.
- **Preconditions:** a PR whose fixture still has the defect (use a fresh fixture PR or one where off-by-one is unfixed).
- **Trigger:** `gh api repos/$REPO/issues/$PR/comments -f body="@${BOT_HANDLE} please fix the off-by-one in scripts/uat/parity-fixture.ts — isAdult should use >= 18. Push the fix to this PR."`
- **Expected + where:** PR HEAD advances; last commit `author == $BOT_LOGIN` and changes `>`→`>=`; one reply.
  `gh api repos/$REPO/pulls/$PR/commits --jq '.[-1]|{author:.commit.author.name,msg:.commit.message[0:50]}'`
- **Verdict rubric:** PASS if bot-authored fix commit + reply. (The fix push is a synchronize → expect a follow-up review run; that's fine.)

## S7 — Slash command: `/request-changes` (registered command path)
- **Invariant:** `/request-changes` routes via the COMMAND path (always verdict `request_changes`) → a `CHANGES_REQUESTED` at HEAD; no-dup.
- **Preconditions:** github_mention automation; a `$PR`. Prefer a PR WITHOUT a pre-existing CR for a clean first-post (else the result is inferred from dedup).
- **Trigger:** `gh api repos/$REPO/issues/$PR/comments -f body="@${BOT_HANDLE} /request-changes <concern>"`
- **Expected + where:** `CHANGES_REQUESTED` at HEAD, no-dup=1, a reply lands. (ruleKey `command:request-changes` is only visible in the run internals / api/runs — behind Cloudflare Access; infer from the CR+reply outcome.)
- **Verdict rubric:** PASS if command → CR verdict + no-dup + reply.

## S8 — Verdict UPGRADE (the regression guard)
- **Invariant:** a STRONGER verdict on the same commit must NOT be swallowed as a duplicate — `/request-changes` over a non-dismissed `APPROVED` posts `CHANGES_REQUESTED` AND dismisses the APPROVED → no-dup=1.
- **Preconditions:** `$PR` has a non-dismissed `APPROVED` at HEAD (run S3 first, or a clean PR the bot approves).
- **Trigger:** `gh api repos/$REPO/issues/$PR/comments -f body="@${BOT_HANDLE} /request-changes <concern>"`
- **Expected + where:** `CHANGES_REQUESTED` at HEAD (non-dismissed); prior `APPROVED` now `DISMISSED`; no-dup=1.
- **Verdict rubric:** PASS if upgrade posts + prior APPROVED dismissed + no-dup=1. (Reverse — approve over a prior CR — also valid; S3 covers it.) This is the verdict-aware-idempotency guard.

## S9 — Unknown slash command fall-through: `/review`
- **Invariant:** `/review` is NOT a registered command → falls through to `github-mention-respond`; the mention gets SOME response (reply or fresh review), never a silent drop. no-dup holds.
- **Preconditions:** github_mention automation; a `$PR`.
- **Trigger:** `gh api repos/$REPO/issues/$PR/comments -f body="@${BOT_HANDLE} /review"`
- **Expected + where:** ≥1 new reply OR a new review after the mention; no spurious duplicate verdict.
- **Verdict rubric:** PASS if a response lands (no silence). (With GSD skills at `~/.claude`, the agent may semantically run the global `/review` skill — either way a response must land.)

## S12 — Burst reliability (replaces OLD capacity-gate) — currently FAIL
- **Invariant (NEW, burst-reliability):** N near-simultaneous @-mentions on N distinct work items → **ALL N eventually reply. No silent work loss.** ("What happens when more work arrives than the plane can run at once?")
- **Why the OLD assertion is replaced:** OLD S12 tested a per-ORG intake capacity gate (`maxConcurrentPerOrg=2` → drop + "at capacity" reply). NEW has **no per-org intake gate** — it uses a per-USER limit (`MAX_CONCURRENT_TASKS_PER_USER`, default 3) and the worker `agent-run` concurrency=1 **queues/serializes** over-limit work rather than dropping it. So there is no capacity-drop-reply to assert; the same underlying risk (overload) is tested by the burst-reliability invariant instead — arguably a stronger test.
- **Preconditions:** github_mention automation; linked identity.
- **Trigger (saturation burst — parameterize N):**
  ```bash
  for n in 1 2 3 4; do
    IU=$(gh issue create --repo "$REPO" --title "UAT S12 burst $n <RUN_ID>" --body x | grep -oE '[0-9]+$')
    gh api repos/$REPO/issues/$IU/comments -f body="@${BOT_HANDLE} analyze this repo structure in detail."
  done
  ```
- **Expected + where:** every burst issue gets a bot reply within the settle window; zero silent-no-reply. Scan each issue's comments for a `$BOT_LOGIN` reply; cross-check the OLAP for one dispatched+COMPLETED run per mention.
- **Verdict rubric:** PASS iff **all N reply**. Currently **FAIL**.
  - **2026-07-18 result: FAIL (burst reliability — silent work loss under concurrency).** 4-mention burst (issues #6-9): all 4 got eyes + a dispatched run, but only 1 replied; 3 ran to COMPLETED **with no reply**.
  - **Root cause (boot-coder, code-grounded classification — supersedes the earlier "shared key" hypothesis):** the silent siblings each got a **401/403 on a thread-status poll WHILE STILL WORKING**. The worker's `pollUntilTerminal` (`packages/worker/src/agent-run/www-client.ts`) applies the ADR-003 **revoke-race ruling**: any 401/403 AFTER at least one successful poll → **`terminal-inferred-from-revocation`, reported to Hatchet as a normal COMPLETION**. That is exactly why the signature is `status=COMPLETED` + no reply + no capacity message + NOT `SCHEDULING_TIMED_OUT`: the run was **cut off mid-work but the worker mislabels the cut-off as success**. (Contrast: socket contention → `ECONNREFUSED` → FAILED; agent error → FAILED. Only a 401/403 gets silently laundered into COMPLETED — which is itself a reliability bug in the revoke-race heuristic: it cannot tell "revoked because finished" from "revoked mid-work".)
  - **Correction:** the "thread-finish revocation uses a shared key" hypothesis is **not the whole story** — the burst-time www (`f03cf6f`) ALREADY contained the F2 threadId anchor (`44bfa7d`, ancestry-verified), so the sibling tokens were **per-run distinct**. WHY those distinct tokens got 401/403 mid-work is the open item (team-lead + tenancy-coder have the code-level detail). Two things to fix: (a) the worker must not launder a mid-work 401/403 into COMPLETED (distinguish revoked-after-`working-done` from revoked-during-`working`), and (b) whatever revoked the in-flight tokens under concurrency. FAIL stands regardless; independent of the per-org-vs-per-user capacity-model note.
  - **Flip to PASS when:** tenancy-coder's revocation-key fix deploys and a burst re-run has all N reply. Then the block closes 10/10.

---

## Parked — phase-2 surface re-check set (NOT run in the effect-intent block)
These assert the inline-comment / formal-review-thread surface that only exists once review-package
**phase-2** mounts the formal review path into the posting path. Run them at the phase-2 re-check.

## S10 — Inline review threads
- **Invariant:** a defect on a specific diff line gets a line-level INLINE comment (review thread), not just a summary. `gh api repos/$REPO/pulls/$PR/comments` shows a bot comment with `path`+`line`; GraphQL `reviewThreads` has one `isResolved:false`.
- **Precondition:** `REVIEW_POST_INLINE_COMMENTS=true` + phase-2 inline path mounted. Fixture: a PR with a line-pinnable defect (e.g. `parseInt(s)` missing radix).

## S11 — Reply-then-resolve (phase-2, reviewer voice)
- **Invariant:** pushing a commit that fixes an unresolved bot thread → the thread gets a bot REPLY in reviewer voice (`Verified: addressed by … (commit …)`) AND `isResolved` flips true. Voice check: must say `Verified:`, NOT `Fixed:`.
- **Precondition:** S10 done (an unresolved bot thread exists); phase-2 resolve path.

## S13 — Follow-up must NOT re-raise a fixed-but-unresolved finding
- **Invariant:** an unresolved thread is a candidate, not proof — the follow-up review must `Read` the referenced file at HEAD before re-raising; a fixed-but-unresolved item must be marked addressed (APPROVE or CR without it) + `emit_resolve_thread`, never re-raised.
- **Precondition:** an outstanding CR naming file:line, fixed by a commit that does NOT resolve the thread; phase-2 followup path.

## S14 — One review object per cycle (inline-comments default-OFF)
- **Invariant:** default `REVIEW_POST_INLINE_COMMENTS` unset → findings fold into the verdict body; a cycle produces exactly ONE review object (no separate empty-body `COMMENTED` wrapper). no-dup strengthened to "one review *object*".
- **Precondition:** phase-2 formal-review surface (the wrapper behavior only exists once inline comments can post). Parked here (not in the effect-intent block) because a single formal review posting does not exercise the wrapper.

---

## Cleanup (after a run)
```bash
for pr in <fixture PRs>; do gh pr close "$pr" --repo "$REPO" --comment "Closing UAT artifact." --delete-branch; done
for iss in <burst issues>; do gh issue close "$iss" --repo "$REPO"; done
# NEVER merge a fixture PR; NEVER delete the repo.
```
