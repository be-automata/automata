---
spike: 010
name: grounded-knowledge-claims
type: standard
validates: "Given knowledge pages whose claims pin evidence to repo://, ticket:// and doc:// sources (hashed spans), when a source changes, then only the affected claims flip, unchanged pages cost zero model calls, and a human edit is never overwritten"
verdict: VALIDATED
related: [014-knowledge-self-heal-loop, 011-scoped-knowledge-mcp]
tags: [knowledge, docs, drift, claims, provenance, cross-department]
---

# Spike 010: Grounded knowledge claims across code, tickets and docs

## What This Validates
OpenWiki's "grounded claims" idea pins atomic facts to hashed evidence, so a page is rechecked without a model. This spike tests whether that idea extends beyond code to the sources marketing and support actually write: tickets and docs. It also tests whether drift detection stays exact when three departments edit independently, and whether a human edit always wins.

## Research
| Approach | Source | Pros | Cons | Status |
|---|---|---|---|---|
| OpenWiki claims + `repo://file#Lx-Ly` sha pins | langchain-ai/openwiki | Zero model calls on no-op; sparse rework | Code-only; no human-edit reconciliation found | **Base pattern** |
| qm memory records (provenance + sensitivity, revision-checked) | yc-software/qm | Human edit beats stale consolidation | Chat memory, not pages; no drift detection | Borrowed: "human wins" rule |
| GitAgent `knowledge/index.yaml` (always_load/priority) | open-gitagent | Cheap context budget | Static; no freshness | Later: context-loading policy |
| Embedding-similarity drift | (generic RAG) | Fuzzy | Nondeterministic, expensive, unexplainable | Rejected |

**Chosen approach:** OpenWiki-style claims with three evidence resolvers:
- `repo`: a line range, relocated by a content-window hash index.
- `ticket`: a JSON pointer into the ticket.
- `doc`: a heading section, relocated by its body hash when the heading is renamed.

On top of that, a stricter op model: only **repin** auto-applies. Everything that changes what a page *says* is a proposal.

## How to Run
```bash
cd .planning/spikes/010-grounded-knowledge-claims
node --experimental-strip-types --no-warnings scenarios.ts   # 15 self-verifying scenarios, exit 0/1
node --experimental-strip-types --no-warnings bench.ts       # 50k-line file, 200 claims
node --experimental-strip-types --no-warnings render.ts && open viewer.html
```
(`tsx` cannot run inside the Claude sandbox: its IPC pipe needs `listen`. Node 22's type stripping works.)

## What to Expect
- `viewer.html` lists the scenarios on the left. Click one to see each claim's chip (fresh, relocated, stale, conflict, degraded, missing or orphaned), each evidence line with its "now" text, and the draft ops tagged AUTO or NEEDS APPROVAL.
- There is an "Export event log" button.
- The console prints `15/15 passed; total model calls 3`.

## Observability
- `events.jsonl` holds one event per scenario: name, pass, llmCalls, mode and op ids.
- `results.json` holds full reports and drafts.
- The viewer exports the same log.

## Investigation Trail
1. **First cut** (statuses fresh, relocated, stale, missing, orphaned): 12/12 passed on the first run. That was suspiciously easy, and reading the drafts showed three design bugs that the tests had encoded as "expected":
   - **Silent cross-department overwrite.** With `TRIAL_DAYS` changed to 30 in code while the marketing doc still said 14, the claim went stale and the "model" rewrote the FAQ to 30. That hides a contradiction between departments. → New status **`conflict`**: some evidence still holds and some changed. It produces no model call; the owner of the out-of-date source decides.
   - **A renamed heading retracted a true fact.** Marketing renamed `## Trial` to `## Free trial` and the claim became `missing`, so it got retracted. → **Doc relocation**: find the section whose body hash still matches.
   - **One missing source retracted a claim that its other sources still supported.** → New status **`degraded`**: some evidence is gone but the rest holds. It becomes a review op. A claim is `missing` (and retracted) only when *every* source is gone.
2. **Retractions auto-applied.** That contradicts "agents propose, humans approve". → Every op carries an `auto` flag, and only `repin` is auto. `applyDraft(…, approved[])` applies auto ops plus approved ids. Scenarios now also assert that auto-apply never changes the page text.
3. **Human edits.**
   - A page whose sha differs from `pageVersion` puts the draft in `propose` mode. A claim whose sentence is no longer in the page becomes **`orphaned`** and goes to review.
   - `applyDraft` throws `HumanEditedPageError` on any content op.
   - Found and fixed: a repin on a human-edited page bumped `pageVersion`, which would have **laundered** the human edit into "agent-verified". The version marker is now kept in propose mode, and there's an assertion for it.
4. **Idempotence:** after approved ops are applied, a re-check must show no repins or updates and 0 model calls. This holds in every apply-mode scenario.
5. **Scale:** 50k lines with 200 claims takes **232 ms** on a no-op. The worst case, where every pin moves, took **9071 ms** with a full scan per claim. A (file, width, content-sha) window index brought it to **526 ms**.
6. **Ambiguity:** two identical spans mean relocation refuses to guess (`ambiguous`, counted as needing judgement). No silent wrong repin.

## Results
**VALIDATED.** All 15 scenarios pass, and strict `tsc` (`noUncheckedIndexedAccess`, `noUnusedLocals`) is clean.

| Scenario | Who | Result | Model calls |
|---|---|---|---|
| noop, whitespace edit, unrelated doc section | eng/mkt | all fresh | 0 |
| code moved; doc heading renamed | eng/mkt | auto **repin** | 0 |
| code says 30 while marketing says 14 (either direction) | eng or mkt | **conflict**, needs approval | 0 |
| code and marketing both say 30 | both | **update** proposal "30 days" | 1 |
| ticket fix version corrected | support | **update** proposal | 1 |
| ticket deleted | support | **retract** proposal for both claims | 0 |
| heading renamed and body rewritten | mkt | **degraded** review (code still holds) | 0 |
| human rewrites a sentence | support | **orphaned** review; page byte-identical | 0 |
| human edit plus code change or move | mixed | propose mode; repins only; human text intact | 0 |

**Key discoveries:**
- **The product insight is the conflict detector.** Grounding claims across departments mechanically surfaces "engineering changed X, marketing still says Y" with no model call. That is a support and marketing feature, not just docs hygiene.
- **Model cost scales with *coherent* change, not with corpus size.** It was 3 calls across 15 scenarios, and 0 for every no-op, move, rename, conflict and deletion.
- **Only content-preserving ops may auto-apply.** Everything else needs a human queue (spike 014), and a human edit must never be re-verified by a mechanical op.
- **Gaps for the real build:**
  - Statement-in-page matching is a normalized substring, so formatting-only human edits (bold, links) show up as `orphaned`. That's a false positive; it needs a markdown-to-text normalization.
  - Ticket and doc resolvers here read local files. Real ones need connector snapshots with stable revision ids (Slack edits, Notion block ids).
  - The stub updater only swaps numbers. A real model call is needed only for the `update` op.
