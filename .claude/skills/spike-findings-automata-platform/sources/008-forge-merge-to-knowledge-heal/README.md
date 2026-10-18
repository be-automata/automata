---
spike: 008
name: forge-merge-to-knowledge-heal
type: integration
validates: "Given forge merges at burst rate, when each triggers 014's self-heal, then coalescing keeps up, model calls stay proportional to coherent change, and no merge is missed or double-processed"
verdict: VALIDATED
related: [004-server-side-merge-no-clone, 010-grounded-knowledge-claims, 014-knowledge-self-heal-loop]
tags: [knowledge, heal, events, coalescing, re-anchor, integration]
---

# Spike 008: Forge merges feeding knowledge self-heal

## What This Validates
Spike 014 reconciles knowledge once per GitHub merge webhook. With the forge as the source of truth, merges arrive in bursts (spike 004 does 40 merges/s).
This spike asks whether the heal loop can **coalesce** a burst into one reconcile per wake (a cursor over the ref history, instead of webhooks) without losing correctness.

## How to Run
```bash
cd .planning/spikes/008-forge-merge-to-knowledge-heal
node --experimental-strip-types --no-warnings bus.ts   # local; imports the spike-010 engine
```

## Fixture
- **300 merges** built with git plumbing:
  - 85% code-only;
  - 8% insert a new fact into `docs/PRICING.md`, which shifts every fact below it;
  - 7% change a fact's price, concentrated on 12 facts so that the same fact is edited repeatedly inside a burst.
- 46 merges touch the document, and the tip has 64 facts.
- Each fact carries an identifier (`Fact AC: … 25 dollars …`), so the **oracle is exact**: a claim is right iff its statement equals its fact's final paragraph.

## Investigation Trail
1. **Per-event works, but it's the expensive baseline.** 300 wakes, 46 engine runs, 19 model calls, 19 approval items, 0 wrong. Repeated edits to one fact cost one model call and one human decision each.
2. **Naive coalescing silently corrupts facts.** With one reconcile per 20 merges, 2 claims ended up wrong.
   Example: claim AC took **111**, the price of a *newly inserted neighbour* (99 plus later edits), not its own 25. The line-pinned evidence pointed at a span that now held a different fact.
   The engine saw the span as "stale", and the model "updated" the claim from the wrong paragraph. That's the worst failure mode: confidently wrong, with no error.
3. **Blame-style line mapping alone isn't enough.** Translating spans through `git diff -U0` fixed 1 of the 2. The other survived because git **fuses an adjacent insert and edit into one hunk** (`-a,1 +a,3`), so position inside the hunk is meaningless.
4. **Content-aware re-anchoring inside changed hunks fixes it.** Inside a fused hunk, the claim moves to the most similar new line (Jaccard on tokens, floor 0.5, the same rule as 014's re-anchor). That gives 84 in-hunk re-anchors, 0 below the floor, and **0 wrong claims** in every coalesced variant.
5. **Crash and replay.** The consumer is killed after reconciling, before it advances its cursor, and the same range is processed again. The approval queue is keyed `op:claim@tip`, so the replay produces **no duplicate items**, the cursor reaches the tip, and 0 claims are wrong.
6. **One wake for the whole burst** (300 merges): 1 engine run, 1 model call, 8 approval items, 0 wrong, 86 ms.

## Results
**VALIDATED, provided the loop uses content-aware re-anchoring.**

| strategy | wakes | engine runs | model calls | approval items | wrong |
|---|---|---|---|---|---|
| per-event (014 today) | 300 | 46 | 19 | 19 | 0 |
| coalesced-20, naive | 15 | 15 | 9 | 15 | **2** |
| coalesced-20, line-map | 15 | 15 | 10 | 17 | **1** |
| **coalesced-20, content re-anchor** | 15 | 15 | 10 | 17 | **0** |
| coalesced-40, content re-anchor, crash | 9 | 9 | 7 | 17 | 0 |
| one wake (300 merges), content re-anchor | 1 | 1 | **1** | **8** | 0 |

**Signal for the build:**
- **Drive heal from a cursor over forge ref history, not from per-merge webhooks.**
  - It keeps up at any burst rate: about 300 merges in 2 s even per-event, and much less work when coalesced.
  - Model calls and human decisions scale with *coherent change*, not with merge count.
- **Re-anchoring must be content-aware wherever a hunk changed.** This isn't only a coalescing problem: a single merge that both inserts and edits produces the same fused hunk. Spike 014's per-merge replay never hit it because its merges didn't mix the two. The re-anchor floor from 014 applies here too.
- Queue items need stable keys (`op:claim@tip`) so that crash replays are idempotent. Each item lists **all** merges in its range that touched the document (provenance across the coalesced window).
- **Gap:** facts added during a burst are not claims yet (40 claims against 64 facts at the tip). Seeding claims for new content (atomic claims, an open item from 014) has to run in the same wake.
