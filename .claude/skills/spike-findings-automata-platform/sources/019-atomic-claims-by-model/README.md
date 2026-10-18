---
spike: 019
name: atomic-claims-by-model
type: standard
validates: "Given the 014 runbook replay oracle, when a real model seeds atomic (one-fact) claims, then 0 FP/0 FN holds, the label-rename case is caught precisely, seed cost measured"
verdict: VALIDATED
related: [014-knowledge-self-heal-loop, 010-grounded-knowledge-claims, 017-forge-merge-drives-knowledge-heal]
tags: [knowledge, claims, model, coverage, incremental-seeding]
---

# Spike 019: Atomic claims seeded by a real model

## What This Validates
Spike 014 left one gap: paragraph-level claims are too coarse. At #287 a label rename re-verified the sentence "Labels (created on first use by the writer):", which never mentioned the label. This spike tests three things against the same 5 real merges of `deploy/PILOT-RUNBOOK.md`:
- whether a **real model** can seed **atomic** claims (one fact each, pinned to the tightest line range);
- whether the git-diff oracle still scores 0 FP / 0 FN;
- whether the rename case becomes precise.

## Research
| Approach | Source | Pros | Cons | Status |
|---|---|---|---|---|
| Paragraph claims, first sentence as statement | spike 014 | No model at seed time | Too coarse: re-verifies sentences unrelated to the change | Baseline |
| Model-extracted atomic claims with line spans | OpenWiki (atomic claims, model at seed) | Precise flags; one fact per claim | Model is untrusted: wrong spans, invented identifiers, skipped facts | **Chosen + validator** |
| Similarity re-anchor (Jaccard over blocks) | spike 014 | Model-free | Guesses; needed a 0.5 floor after a bad match | Replaced by diff mapping |
| Re-anchor through the merge's own `git diff -U0` hunks | (new here) | Exact, no guessing: lines outside hunks shift by the net delta, lines inside map to the hunk's new range | Needs the diff (we always have it post-merge) | **Chosen** |

The model is the local `claude` CLI (`-p --model sonnet --output-format json --tools "" --setting-sources "" --strict-mcp-config`, subscription auth, `ANTHROPIC_API_KEY` stripped). Every response is cached by prompt hash in `cache/`, so reruns cost nothing and are deterministic.

## How to Run
```bash
cd .planning/spikes/019-atomic-claims-by-model
node --experimental-strip-types --no-warnings seed-run.ts   # seed.json (model calls only on a cold cache)
node --experimental-strip-types --no-warnings run.ts        # 10 self-verifying checks, exit 0/1
```
Run it outside the Claude sandbox on a cold cache, because the `claude` CLI needs network and keychain. With a warm cache it runs anywhere.

## What to Expect
- Five merge lines, each with `FP=0 FN=0` and `drift=0`.
- The model-vs-paragraph comparison as JSON.
- `10/10 checks passed`.

## Observability
- `events.jsonl` holds one event per merge (flagged, oracle, FP, FN, ambiguous, model calls, op ids, drift) and one per check.
- `results.json` holds the comparison, every op with before/after and support score, and the rejected seed claims with reasons.
- `seed.json` holds every accepted claim with its pass (`seed` or `gap`), support score and any span repair.

## Investigation Trail
1. **First seed pass: 421 claims kept, 33 rejected by the validator.**
   - The validator has 3 rules:
     - the span must be inside the chunk and at most 4 lines;
     - every identifier quoted in backticks in the statement must appear verbatim in the span;
     - content-token support must be ≥ 0.5.
   - Most rejections were *true facts with sloppy spans*. The model pointed one line off ("It defaults `true`" sits below the line that names the env var), or at the first line of a command wrapped with `\`.
   - **Deterministic repair** fixed these: widen to the smallest window within ±2 lines that satisfies every rule, and flatten `\`-newline and `**`. That repaired 14 spans; 13 claims (3%) stayed rejected.
2. **First replay: 4/6 checks.** Two real findings:
   - **Line granularity.** At #287 the claim "The lane never applies `bug` or `enhancement` labels" shares line 1100 with the label list, so it flags correctly at line level. The model's "update" returned the same sentence.
     - That is now a separate op, **`reverify`**: the page text stays identical, but it's still queued because it rests on a model judgement.
     - Sub-line (character-range) pins would remove it.
   - **Coverage miss.** #306 changed "As the org owner, open the repository environment…" to "As an org owner or admin, with the org active, open Environment…". The paragraph baseline caught it; atomic claims didn't, because the model had skipped this procedural step.
     - Of 752 prose lines, 157 (21%) had no claim.
     - **Gap pass:** one extra batched call over just the unclaimed lines, asking also for procedural WHO/WHERE facts. It added 61 claims, including the "org owner" step.
     - The 77 lines that still had none (narrative, or table rows without their header) became **sentinels**: watched spans with no page text. A change to a sentinel raises a review instead of drifting silently.
3. **Coverage oracle exposed a hole in spike 014 too.** Every changed prose line should belong to a claim or a sentinel. Without incremental seeding, 6 changed lines in #272, #287 and #304 had no claim. All 6 are text **inserted after the seed commit**. 014's "0 FN" was scored only over claimed spans, so paragraph seeding had the same blind spot.
   - The clearest example is #304. It moved the task run's `home/`, `gh-config/` and `tmp/` out of the checkout and rewrote the runbook lines that #259 had added. Without incremental seeding, that doc change was invisible.
   - **Fix: incremental seeding.** Each merge's inserted prose (new-side hunk lines not covered) gets one batched extraction call, and the new claims are `add` ops for approval. Leftovers become sentinels.
   - After the fix there are no holes, and #304's 2 real changes are flagged and correctly updated.
4. **Distrusting the all-pass:** I read every content-changing proposal.
   - All 6 updates are correct: path move, two label renames, the `runs/<id>/` layout, the clean-failure wording, and the org env step.
   - Two of them came back **compound**: the #306 update folded in "a repository environment may override single keys…".
   - Atomicity isn't enforced on updates. A real build should split or flag any update that brings in new quoted identifiers not present in the old claim.

## Results
**VALIDATED. 10/10 checks pass, and strict `tsc` is clean.**

| Merge | Flagged = oracle | FP/FN | Proposals (content) | Reverify | Adds (new text) | Model calls (update + add) |
|---|---|---|---|---|---|---|
| #259 self-heal fix loop (+189) | 0 = 0 | 0/0 | 0 | 0 | 65 | 0 + 1 |
| #272 benchmark (+141) | 1 = 1 | 0/0 | 1 (metrics path moved) | 0 | 51 | 1 + 1 |
| #287 label rename | 3 = 3 | 0/0 | 2 (**both mention the label**) | 1 | 0 | 1 + 0 |
| #304 task-run home move | 2 = 2 | 0/0 | 2 | 0 | 0 | 1 + 0 |
| #306 org env vars | 1 = 1 | 0/0 | 1 ("org owner" step) | 0 | 15 | 1 + 1 |

| | paragraph (014) | atomic (019) |
|---|---|---|
| Claims at base | 166 | 502 (441 first pass + 61 gap) + 60 sentinels |
| Seed model calls / tokens | 0 | 7 calls, 47.7k in / 33.2k out |
| Content proposals over 5 merges | 3 (one useless: the label sentence) | 6 updates, all correct, plus 1 reverify |
| Merge-time model calls | 2 | 4 update + 3 incremental-seed |
| Changed lines with no claim | 6 (unmeasured in 014) | **0** |
| Cost (Sonnet list price; notional on a subscription) | — | seed $0.52, updates $0.03, incremental $0.14: **$0.69 total** |

**Signal for the build:**
- **Seed with a model, but never trust it.** Validate every claim before pinning:
  - spans must be in bounds and at most 4 lines;
  - quoted identifiers must appear verbatim;
  - support must be ≥ 0.5;
  - repair spans deterministically within ±2 lines.

  The model's error mode is *imprecise spans and skipped facts*, not invented ones: 5 of the 28 rejections had an identifier that wasn't in the text.
- **Two passes plus sentinels give full coverage.** A first pass extracts facts, a gap pass covers unclaimed prose, and sentinels watch the rest. Measure coverage as its own oracle, alongside FP/FN.
- **Incremental seeding is mandatory.** Every merge seeds the text it inserted, otherwise later edits to it drift silently.
  - This is a hole in the 014 design as shipped, and the paragraph approach has it too.
  - Cost: about 1 call per merge that adds prose (about $0.05 each here).
- **Re-anchor through the merge diff, not by similarity.** It's exact and needs no confidence floor for *location*. The support floor still guards the *content* of the model's proposal.
- **Queue UX needs batching.** 131 of 138 decisions were `add` ops from 3 merges that inserted text. Present them as one decision per merge ("accept 65 new facts from #259") with spot-check, and keep individual decisions for `update`, `reverify` and `review`.
- **Gaps:**
  - Line-level pins over-flag facts that share a line (character ranges fix that).
  - Updates can turn compound.
  - Model choice (Sonnet) wasn't compared with Haiku for cost.
