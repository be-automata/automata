# Plan: Mode-Agnostic Per-Repo Review Tolerance

Status: **EXECUTED + VERIFIED + ARCHITECT-SIGNED-OFF** (2026-07-25). Authored from
first-hand context (the feature's original author diagnosed the gap live). The
`planner` agent stalled in this session; this plan was validated by two
`system-architect` passes (SOUND / SOUND-WITH-CHANGES) and proven by execution —
the strongest evidence a plan was sound is that it shipped and the live UAT passed.

## Goal
Make the per-repo review tolerance floor (error/warning/info) a real product
feature that governs the PR-review verdict regardless of `REVIEW_SINGLE_WRITER`.
Before: the tolerance was inert whenever the flag was off.

## Root cause
The tolerance has two enforcement points, both gated on `env.REVIEW_SINGLE_WRITER`:
1. the PROMPT DIRECTIVE (`buildReviewToleranceDirective`) — the PRIMARY mechanism,
   built inside `if (env.REVIEW_SINGLE_WRITER)` in `remote-daemon-message.ts`;
2. the SERVER FLOOR (`applyApproveSeverityFloor`) — a backstop that only downgrades
   a too-generous `approve`, on the single-writer finish path.
The directive is pure prompt guidance (WHAT verdict), independent of WHO posts, so
gating it on the flag was the bug.

## Design (decoupling WHAT from WHO)
Extract `computeReviewToleranceDirective` (`review-tolerance-directive.ts`) that
NEVER reads the flag; call it unconditionally for every review thread. Only
`applyReviewPolicy = env.REVIEW_SINGLE_WRITER && isReview` (→ permissionMode="review",
credential-strip, emit-only executor, server floor) stays flag-gated — it governs
WHO posts, not the tolerance verdict. Mirrors orch-agents' `buildEmitReviewDescription`.

## Tasks (all done)
1. Extract the directive helper; call unconditionally from remote-daemon-message. ✅
2. Unit tests pinning the mode-agnostic property (warning/error/info floors + non-review). ✅
3. Fix-forward (architect): pass the next-message route's already-fetched thread into
   the helper → zero extra reads; document latent-under-false. ✅
4. Deploy + live UAT + production-validator. ✅

## Test matrix
- Unit: `review-tolerance-directive.test.ts` (directive text per floor, mode-agnostic
  by construction); `severity-policy.test.ts` (directive builder); floor executor,
  routes, parity, webhook draft gate — 269 total green, 0 fail.
- Live (prod, single-writer=true): error floor → warnings COMMENT not block (PR#33);
  info floor → info-only finding REQUESTED_CHANGES, agent citing "info-floor policy"
  (PR#35 e4a5b5d); warning floor → same info findings APPROVE (5973d73). Floor-governed.

## Honest caveat — LATENT-UNDER-FALSE
Under `REVIEW_SINGLE_WRITER=false` the review POSTING path is unwired (emit-only skill
+ reconcile-only finish hook never parses the intent), so the tolerance-correct verdict
the agent chooses never reaches GitHub. The feature is FULLY FUNCTIONAL under `true`
(prod), CORRECT-BUT-LATENT under `false`. The directive is injected in both modes so
the tolerance is correct the day the flag flips. False-mode posting is a separate,
pre-existing gap (restore a gh-post skill, or run executeReviewFromIntent under false =
single-writer). Also: in-process runs (HATCHET off) bypass remote-daemon-message.

## Risk / rollback
Deploy is manual (`opennextjs-cloudflare build && deploy`); `wrangler rollback` reverts.
The change is additive + behavior-preserving under true (the directive was already
injected there). Do NOT flip prod `REVIEW_SINGLE_WRITER=false` to test — assert
false-mode injection via unit test (the helper has no flag input).

## Verification approach
- true-mode: proven end-to-end live on real PRs.
- false-mode: verified by construction + unit (the helper never reads the flag) — NOT
  live, because false-mode posting is unwired; do not imply a verdict lands under false.
