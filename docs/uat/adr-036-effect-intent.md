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

## S12 — Burst reliability (replaces OLD capacity-gate) — ✅ PASS (invariant proven live; BUG-EXEC-01 closed)
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
- **Expected + where:** every burst issue gets a bot reply within the settle window; zero unanswered. Cross-check the OLAP for **exactly one** dispatched run **per distinct issue** (no collapse, no under-dispatch).
- **Verdict rubric:** PASS iff **all N issues answered, one run per issue**. Currently **FAIL (real concurrency bug)**.
  - **Investigation history (three attempts — read as a caution against premature root-causing):**
    1. **Attempt 1 (issues #6-9, test-framed fixtures):** 3/4 "silent". I mis-diagnosed it as mid-run **token revocation / worker laundering a 401/403 into COMPLETED** — WRONG, retracted. My theory + team-lead's premature-`handleThreadFinish` theory both fell.
    2. **Attempt 1 re-triage (team-lead, full transcripts):** the "silent" runs ended `result: success` and the agents had **explicitly declined to reply** because the fixtures were titled/worded as a test / "(do not action)" — correct instruction-following, not a bug. That attempt = **INVALID-FIXTURE**. (Pitfall now documented; harness fixtures neutralized.)
    3. **Attempt 2 (issues #15-18, NEUTRAL fixtures):** still FAIL (1/4 answered) — and I again over-committed to a wrong root cause ("mis-routing / two runs collapsed onto #15" / shared-sentinel), **DISPROVEN by team-lead's www routing trace**. Routing and thread creation were CORRECT; the sentinel is not involved. The real trace (below).
  - **2026-07-18 (post-fix) VERDICT: ✅ PASS.** On the fixed plane (BUG-EXEC-01 closed), a 4-mention over-cap burst: every mention thread PROMOTED out of `queued-tasks-concurrency` and got answered — all 4 issues reached full 2 replies (research+mention). No silent loss. ~13 min wall-clock = concurrency=1 pilot throughput (ADR-002 §6 known-limitation, not a defect). The FAIL history below is retained as the investigation record.
  - **2026-07-18 (pre-fix) VERDICT: FAIL — QUEUED WORK STARVES (capacity gate engages, nothing dequeues).** Root cause (team-lead, from www logs — authoritative):
    - **Fixture confound (harness bug, now fixed):** creating each issue fresh ALSO fires the issue-research automation (`8304af2f`, on issue-open) IN ADDITION to the mention → **8 intents from 4 issues**. That is why #15 "double-replied" (one research response + one mention answer — both legitimate) and why a run "posted nothing" (an issue-research run that researches without commenting). So there was NO dispatch collapse and NO duplication bug — my attempt-2 read was confounded by the second automation.
    - **REAL defect:** the per-user capacity gate (`MAX_CONCURRENT_TASKS_PER_USER=3`) engaged CORRECTLY — the first 3 intents dispatched (threads `14aeb04c`, `4620eed5`, `7eed4c86`), intents 4-8 transitioned `[system.concurrency-limit] queued → queued-tasks-concurrency` (threads `361538f8/b6148530/bc248f0e/61404487/a393188b`) — **but NOTHING EVER DEQUEUES them.** They starve forever, with no user feedback. The queue counter was already **10 before this burst** (silently accumulating across all prior testing) and is **14 now**. tenancy-coder is investigating the missing drain mechanism (likely quarantined Redis/cron; `evalsha` TypeError fingerprint).
    - This is a BETTER-EVIDENCED version of exactly what the OLD orch-agents S12 tested (over-capacity work must not silently vanish) — here it's queue starvation + no "at capacity" feedback.
  - **Flip to PASS when:** the queue-drain fix deploys AND a clean mention-burst (post-harness-fix, mention path isolated) shows all N eventually replied. Note the pre-existing 14-deep starved queue must also clear.
  - **LESSON (three wrong root causes on one observable):** the observable (over-capacity work unanswered) was right every time; my ROOT CAUSES (token-revocation, then mis-routing/sentinel) were wrong twice. As the GitHub-side validator I can only see the observable — report it crisply and DEFER root-cause to whoever holds the www/OLAP trace. Also: isolate one automation path per case (the issue-research automation confounded the mention burst), and use neutral fixtures.

---

## Phase-2 acceptance set (UN-PARKED 2026-07-19 — review-package single-writer effect channel)

**Status: PREP — do NOT run until team-lead signals the phase-2 flag is live.** These assert the
inline-comment / formal-review-thread surface + the single-writer posting model that phase-2 introduces.

**Single-writer world — how the model changes (applies to ALL cases below + the S1-S3 regression):**
- **The CONTROL PLANE (executor) posts the formal review AFTER thread-finish — NOT the agent mid-run.** Today the agent posts via raw `gh` during the run; phase-2 moves posting to a single writer in the control plane, keyed on the emitted review intent. This is the durable close of the S1 no-dup gap (the INTERIM-RECONCILER becomes a structural SINGLE-WRITER).
- **"Who posted" assertions expect the App/executor identity**, not the agent's ambient gh identity. Assert the review/comment author is `$BOT_LOGIN` posted by the executor (App-installation), and that the agent's run shows the `emit_review` INTENT with NO raw `gh pr review` in its tool calls.
- **Settle windows shift LATER**: the review lands at/after thread-finish (post-run), so poll from thread-finish, not from mid-run. Size the settle to the executor's post-finish latency.
- **No-dup becomes structural**: exactly one review object per commit+verdict by construction (single writer), so a same-verdict retry cannot double-post — assert the reconciler is NO LONGER needed (0 `dup_reconciled` because 0 dups produced).

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
- **Precondition:** phase-2 formal-review surface. **Single-writer note:** with one writer, S14's "exactly one review object per cycle" becomes structural (not a reconciler side-effect) — assert one review object AND zero inline `COMMENTED` wrappers with the flag default-off.

---

## PHASE-2 ACCEPTANCE PLAN (prep; execute only when team-lead signals the flag live)

**Order once the flag is live:**
1. **Regression first — S1/S2/S3 via `pnpm uat S1` on the single-writer path.** Proves the executor preserves the proven review lifecycle (opened→CR, partial→still-CR, full→APPROVE+dismiss) with posting moved to the control plane. On PASS, the record's **INTERIM-RECONCILER mechanism note flips to SINGLE-WRITER** for S1-S3. Watch: the agent run shows `emit_review` intent + NO raw `gh pr review`; the review author is the executor/App identity; no-dup holds structurally (0 `dup_reconciled`).
2. **Then the new surface — S10, S11, S13, S14** (inline threads, reply-then-resolve reviewer-voice, stale-thread re-raise guard, one-review-object). Fixtures per each case above; settle windows sized to post-thread-finish executor latency.

**FLAG-FLIP ACCEPTANCE GATE (the single go/no-go for the flag):**
> One real review run where the **agent posts NOTHING** (its tool calls contain NO `gh pr review` / no direct review post) **AND the executor posts EXACTLY ONE formal review** (correct verdict, `$BOT_LOGIN`/App identity, at HEAD, no-dup=1).
- Verify agent-posts-nothing: pull the run's tool calls (OLAP/tail) — zero raw review posts; only the `emit_review` intent.
- Verify executor-posts-one: `gh api repos/$REPO/pulls/<PR>/reviews` = exactly one bot review for the cycle, authored via the App installation, correct verdict.
- FAIL if the agent still posts (dual-writer — flag not truly cutover) OR the executor posts zero (intent dropped) OR more than one (single-writer invariant broken).

**ADVERSARIAL DESIGN-REVIEW PROBES (run against tenancy-coder's design note when it lands — team-lead-directed).**
Goal: find the run that PASSES their tests but FAILS the flag-flip gate. Four attack surfaces:
1. **Residual agent posting paths** — can the agent still reach ANY posting path the design doesn't close? Probe: raw `gh` in review runs, direct GitHub API via `curl`, or the interim reconciler RACING the executor (double-post). The design must close every path, not just the emit_review one.
2. **Intent survival across transport hops** — does the review intent survive sink → daemon-event → www parse with a LOUD failure at each hop, never a silent drop? Probe each hop for a dropped/malformed intent → does it fail loudly (surfaced, retried) or vanish (executor posts 0)?
3. **Zero-effects fallback vs reviews-count==1** — when the agent emits zero effects and the fallback posts the agent's text, does that preserve or VIOLATE the "exactly one review" gate? Probe: a run that produces no emit_review → is the fallback a formal review (counts as 1, OK) or an extra comment/second object (violates no-dup)?
4. **Version skew (flag-ON + OLD worker)** — flag on, but a worker build that doesn't expose the emit tool. Probe: does the agent fall back to posting itself (dual-writer regression) or does the plane detect the skew and fail closed? This is the [[project_prod_sdk_0_3_199]] / worker-un-pinning risk class.

**Harness:** `scripts/uat/cases.ts` `phase2()` currently self-reports `SKIPPED(phase-2-gated)`. When the flag lands, wire S10/S11/S13/S14 as real cases (fixtures above) + add the flag-flip gate as a dedicated assertion (agent-tool-calls-have-no-gh-review + reviews-count==1). Keep them SKIPPED until then.

---

## Cleanup (after a run)
```bash
for pr in <fixture PRs>; do gh pr close "$pr" --repo "$REPO" --comment "Closing UAT artifact." --delete-branch; done
for iss in <burst issues>; do gh issue close "$iss" --repo "$REPO"; done
# NEVER merge a fixture PR; NEVER delete the repo.
```

## PHASE-2 DESIGN-REVIEW FINDINGS (adversarial read of tenancy-coder's single-writer note, 2026-07-19)

Acceptance criteria the phase-2 impl must satisfy (runs that pass their tests but fail the gate). GAP 1-2 break the guarantee as written; 3-6 are correctness hardening. Design strengths acknowledged: stale-intent "post with commit_id, never silent-drop"; read-failure "post anyway"; pure-core port + App-only executor.

1. **[BLOCKER] handleThreadFinish-never-fires → silent no-review.** All fallbacks (zero-effects/malformed/stale) trigger AT thread-finish; a thread stuck 'working' (S12/BUG-EXEC-01 class) or a lost finish event → executor never runs → 0 reviews, silently. "Posted zero impossible" assumes finish always fires. FIX: watchdog/timeout forcing finish→fallback, or a sweep for PR threads finished-but-no-review. This is the outright silent-drop.
2. **[BLOCKER] curl/direct-API residual posting path.** Tool-policy denies `gh` review-writes, but the review run holds the installation token (for clone) + network to api.github.com → agent can `curl POST .../reviews` past a gh-scoped denylist. FIX: allowlist (deny ALL github mutation) or block egress to the GitHub API host; the spike must show a raw curl POST DENIED, not just `gh pr review`.
3. **[HARDENING] zero-effects COMMENT-fallback downgrades the verdict.** A lost request_changes → non-blocking COMMENT that reads like a normal review → defective PR not blocked. reviews-count==1 holds but verdict wrong/unsafe. FIX: fallback COMMENT visibly marked degraded ("⚠️ intent unparsed — verdict NOT applied") + loud WorkFailed page. Gate clause added: "verdict-correct OR visibly-degraded."
4. **[GATE REFINEMENT] straddle runs are measured separately.** The flag-flip gate (agent posts nothing + executor posts one) is valid ONLY on a FRESH run started after BOTH box+www deploys. Straddling runs (old gh-resolution + new flag) transient-dual-post; acceptable IF reconciler cleans to 1. So "0 dup_reconciled because 0 dups produced" is aspirational — holds on fresh runs; reconciler backstops straddle dups. Straddle runs asserted on reconcile-to-1 + no-silent-loss, not the gate.
5. **[HARDENING] mis-ordered flip guard.** If www flag flips BEFORE the box skill+policy lands → agent posts real gh review + executor posts zero-effects COMMENT = dual-post. FIX: flag-flip preflights that the emit-skill is installed on the box resolution path (ordering can't be silently violated).
6. **[DEPENDENCY #1] emit-skill must install to the SDK's ACTUAL resolution path.** tenancy-coder's root finding: emit-only github-ops resolves NOWHERE → automation falls to generic gh-posting github-code-review (the real S1 root, at the resolution layer). Install must land where the deployed SDK resolves (settingSources user/project → HOME=/home/orch/.claude on prod — NOT a dev ~/ or the /Users/senior/... generic pack; see [[project_sdk_plugin_loading]] / [[project_global_skill_invocation]]). Acceptance datum: transcript shows the agent READING the emit-skill before emitting; reading the generic skill instead is the tell.

### Design-review FOLDS (tenancy-coder accepted all 6, 2026-07-19)
All findings folded before the executor-seam freeze — the acceptance criteria are now addressed-in-design:
1. **No-finish silent-drop — CONFIRMED net-new + fixed.** `stopStalledThreads` marks status='complete' via a bare `db.update`, NOT through `handleThreadFinish` → stalled review thread = zero review/COMMENT/WorkFailed. FOLD: a second executor entry point — a **periodic PR-review SWEEP** (reuses the S12 cron infra) that finds terminal PR review-threads with no bot review at HEAD and runs the fallback. One writer, two idempotent triggers (finish-hook + sweep), HEAD-guard makes double-fire safe — mirrors the S12 finish-hook+cron-sweep pattern.
2. **curl residual — fixed defense-in-depth:** (i) installation token WITHHELD from the review agent's env (review threads don't push; aligns with the buildDaemonEnv safe-env whitelist from the identity-leak fix) → curl POST has no auth; (ii) block egress to api.github.com for review runs where feasible. Spike acceptance now REQUIRES a raw `curl POST .../reviews` denial artifact, not just `gh pr review`.
3. **verdict-downgrade — fixed:** fallback COMMENT body leads with "⚠️ Review intent could not be parsed — verdict NOT applied. This is NOT a clean pass." + loud WorkFailed page. "verdict-correct OR visibly-degraded" is now a hard requirement.
4. **straddle — accepted verbatim:** "0 dups on FRESH (post-rollout) runs; reconciler backstops straddle dups"; straddle runs measured on reconcile-to-1 + no-silent-loss, not the gate.
5. **mis-order — fixed:** REVIEW_SINGLE_WRITER flip gets an ordering-guard preflight (emit-skill installed on the box's actual resolution path before flag-ON).
6. **skill-install path — CORRECTION (my error, tenancy-coder right):** I wrongly applied the orch-agents VPS fact `HOME=/home/orch/.claude` to automata — automata runs on **Cloudflare Workers**, and the pilot daemon may run elsewhere (the S12 transcript's `/Users/senior/...` path suggests the pilot execution plane may be a DEV box, not a deployed one). Correct requirement: **identify the daemon's ACTUAL SDK skill-resolution path** (folded into boot-coder's spike — he owns the worker/daemon seam). Acceptance datum LOCKED: the run transcript shows the agent READING the emit-skill before emitting; reading the generic `github-code-review` instead = the tell that install landed on the wrong path. (Lesson: don't port an orch-agents runtime fact into the automata/Workers context — different execution plane.)

Revised executor/fallback + tool-policy allowlist come back for re-read before the seam freezes.

### Pre-code re-read RESIDUALS RESOLVED (design converged, 2026-07-19)
Two residuals from the revised-design re-read, both accepted + resolved; design frozen for step-2 code.
- **A — sweep/finish-hook TOCTOU → grace-period.** The sweep only considers threads whose terminal transition is older than a GRACE window (> the finish-hook's worst-case completion; a few min, configurable). Finish-hook owns the normal path; the sweep fires only for genuinely-STALLED threads. **Honest claim (recorded verbatim):** "structurally single-writer on the normal (finish-hook) path; the sweep fires only past the grace window for stalled threads; the HEAD-guard + reconciler backstop the rare residual race." Test: swept-past-grace thread with a persisted intent gets its REAL review; finish-then-sweep on the same thread = no-op (skipped_existing).
- **B — no-credential-anywhere (worktree half already in code).** provision.ts clones with a command-scoped one-shot `git -c http.extraHeader=<base64 basic x-access-token:TOKEN>`; the remote is clean `https://github.com/${repo}.git` — token NOT in the remote URL, NOT persisted to `.git/config` (URL-embedded creds persist, the header form does not). So `git config --get remote.origin.url` is already token-free. **GAP-2 acceptance = 3-part no-credential assertion:** (i) review-agent env has no `GH_TOKEN`/`GITHUB_TOKEN`; (ii) worktree `remote.origin.url` has no embedded token; (iii) no `credential.helper` reachable to the review run (box-level env/git-config isolation, pairs with the isolated `GH_CONFIG_DIR` from the identity-leak fix; boot-coder owns).
- **FRAMING (locked):** the GUARANTEE is no-credential-anywhere (token-withhold + worktree-clean + no-helper). The tool-policy denylist (`--disallowedTools "Bash(gh:*)"`, no `--dangerously-skip-permissions`) is DEFENSE-IN-DEPTH (fast local denial + UX) and explicitly does NOT block `python`/`node`/`curl` HTTP posts — those die on 401 for lack of any credential. curl-401 spike artifact = the direct-API half of the evidence.

**Status: design CONVERGED → step-2 code in progress (pure-core port + executor + grace-period sweep + degraded fallback + permissionMode="review" + flag-flip preflight).** Final pre-freeze read pending the code + curl-401 artifact + the 3-part no-credential assertion.
