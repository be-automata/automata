# Grounded company knowledge (claims engine + self-heal loop)

## Requirements
- **Ground non-code sources, not just code.** Evidence resolves from `repo://`, `ticket://` and `doc://` sources (and later Slack and Notion connectors).
- **Agents propose and humans approve.** A human edit always wins over agent output.
- **Only content-identical repins apply automatically.** Every op that changes what a page *says* goes to a human approval queue, and that queue lives outside GitHub. Each item carries provenance: merge sha, PR, evidence URIs and confidence.
- **Below the re-anchor confidence floor, an update becomes a review.** Ambiguous spans never resolve automatically.
- **Git output parsing always uses `--no-color`.** Prefer `-c color.ui=never` as well.
- The repo is public, so no customer names may appear in fixtures, seeds or examples.

## How to Build It

### 1. Data model (Drizzle, `packages/shared/src/db/schema.ts`)
- **`knowledge_page`:** `(id, orgId, scope, slug, markdown, pageVersion sha256, ownerUserId, updatedBy kind: human | agent)`.
- **`knowledge_claim`:** `(id, pageId, statement, evidence jsonb: EvidencePin[], status, lastCheckedAt)`.
- **`knowledge_op`:** `(id, pageId, claimId, op: repin | update | conflict | retract | review, auto bool, before, after, why, confidence, provenance jsonb {commit, pr, ticket, doc}, decision: pending | approved | rejected, decidedBy, decidedAt)`. Store the decision the same way as the post-merge ticket audit's `auditEffects`, so the loop can be audited.
- Every new column also goes in `deploy/assert-schema-ready.ts` `REQUIRED`. The prod push happens manually, *before* the deploy.

### 2. Evidence pins (spike 010, `claims.ts`)
```ts
interface EvidencePin { uri: string; sha256: string }          // sha of NORMALIZED text (whitespace-collapsed)
interface Claim { id: string; statement: string; evidence: EvidencePin[] }
interface Sidecar { page: string; pageVersion: string; claims: Claim[] }
```
URI grammar and resolvers:
- **`repo://path#La-Lb`:** a line range. If its hash no longer matches, relocate it through a `(file, width, content-sha) → start lines` window index. Cache the index per file; it took the worst case on 50k lines and 200 claims from 9071 ms to 526 ms.
- **`ticket://ID#/json/pointer`:** RFC 6901 pointer into the ticket JSON snapshot.
- **`doc://slug#heading-slug`:** a heading section. If the heading was renamed, relocate it to the section whose *body hash* still matches.
- **Two identical spans:** the result is `ambiguous`. Never guess.

### 3. Status lattice per claim (aggregate of its evidence)
| status | meaning | op | auto? | model call |
|---|---|---|---|---|
| fresh | all evidence hashes match | — | — | 0 |
| relocated | text identical, moved | `repin` | **yes** | 0 |
| stale | all changed evidence agrees on a new value | `update` | no | **1 batched** |
| conflict | some evidence still holds, some changed (code says 30, marketing says 14) | `conflict` → owner of the *stale* source | no | 0 |
| degraded | some evidence gone, rest holds | `review` | no | 0 |
| missing | *every* source gone | `retract` | no | 0 |
| orphaned | statement no longer in page (human rewrote it) | `review` | no | 0 |

### 4. Reconcile and apply
- `checkPage(root, md, sidecar)` uses no model. `reconcile(...)` makes **one batched** `Updater.rework(staleItems)` call, and only for `stale`.
- **Human-edit guard:** a page sha that differs from `pageVersion` sets propose mode.
  - `applyDraft` throws `HumanEditedPageError` on any content op.
  - In propose mode, repins **must not bump `pageVersion`**. Bumping it would launder the human edit into "agent-verified".
- **Idempotence check:** after applying the approved ops, a re-check must yield zero repins or updates and zero model calls. Assert this in tests.

### 5. Self-heal trigger (spike 014, `heal.ts`)
- Hook into the existing **`github-pr-merged` mirror-intake intent**, and add ticket-closed and doc-edited webhooks.
- Run one reconcile job per page whose evidence touches the changed paths. When nothing intersects, it costs zero model calls.
- Re-anchor the updater against the new file's blocks:
  - Score candidates with token Jaccard.
  - **`REANCHOR_FLOOR = 0.5`:** anything below it becomes `review` ("a human must locate this fact").
- **Queue surface:** a dashboard page plus a Slack DM to the source owner. Each item shows before/after, evidence, merge sha, PR and confidence, with Approve and Reject.

### 6. Oracle test to keep in CI
- Replay real merges of a real doc. In the spike that was `deploy/PILOT-RUNBOOK.md` from 75f6af8 through 1d81d00, a13c5f3, 672bda2, 0ef37d4 and ca56092.
- Assert `flagged == claims whose pinned span intersects git diff --no-color -U0 old-side hunks`.
- Report `ambiguous` separately, not as a false positive.
- Expected result: 0 FP, 0 FN, 2 model calls, 3 approvals, 137 automatic repins.

## What to Avoid
- **Rewriting a claim when only one department's source changed.** That hides a cross-department contradiction. It is a `conflict`, never an `update`.
- **Retracting on a heading rename.** Relocate by body hash.
- **Retracting a claim that a remaining source still supports.** That is `degraded`, not `missing`.
- **Auto-applying retractions or updates.** The first cut did, and it violated "agents propose".
- **Parsing git output without `--no-color`.** This machine's git config forces color. The ANSI codes in the `@@` headers made the oracle return 0 everywhere.
- **Splitting sentences before stripping list markers.** That produced the statement `"3."`, re-anchored at score 0, and proposed the page title as the "fix".
- **Paragraph-level claims.** They are too coarse: a label rename re-verified a sentence that never mentioned the label. Generate **atomic claims** (one fact each) with the model at seed time.
- **Embedding-similarity drift detection.** It is nondeterministic, costly and unexplainable, and was rejected.
- **A docs-only GitHub PR as the approval surface.** That is OpenWiki's choice. Marketing and support approvers don't work in PRs.

## Constraints
- A no-op check of 50k lines with 200 claims takes 232 ms. The worst case, where every pin moved, takes 526 ms with the window index.
- Statement-in-page matching is a normalized substring, so formatting-only human edits (bold, links) false-flag as `orphaned`. The build needs markdown-to-text normalization before matching.
- `ticket://` and `doc://` resolve local fixture files in the spike. Production needs connector snapshots with **stable revision ids** (Slack edit ts, Notion block ids). This is unproven.
- The model is needed only for `update`, so cost scales with coherent change, not corpus size.
- Agent read access is proven by spike 011 (see `references/knowledge-access-mcp.md`): real Claude leaked 0 canaries.

## Session 3 additions (spikes 008, 017, 019, 020, 021-B)

### Atomic, model-seeded claims with a coverage oracle (019)
- **Seed with a model, then validate every claim before pinning:**
  - span in bounds and at most 4 lines;
  - quoted identifiers appear verbatim;
  - support ≥ 0.5;
  - deterministic span repair within ±2 lines.

  The model's errors are imprecise spans and skipped facts, rarely invented ones.
- **Two passes plus sentinels:** a fact pass, a gap pass over unclaimed prose, then sentinels watching the rest.
- **Coverage is a third oracle,** next to FP/FN: every changed prose line must be covered by a claim or a sentinel.
- **Incremental seeding is mandatory.** Every merge seeds the text it inserted. Spike 014's 0 FN missed 6 changed lines in text added after the seed, including #304's real `runs/<id>/` change.
- **Re-anchor through the merge's own diff hunks,** not by similarity. Location becomes exact; the support floor still guards content.
- **Queue UX:** 131 of 138 decisions were `add` ops. Batch them as one decision per merge with spot-check; keep `update`, `reverify` and `review` individual.
- **Cost:** 502 claims plus 60 sentinels took 7 Sonnet calls ($0.52 list). Merge-time cost was $0.17 across 5 merges.
- **Next:** pin `repo://` evidence to stable **symbol IDs** (entire-graph `compound-v1`) or character ranges. Line pins over-flag facts that share a line.

### Burst-rate heal: cursor plus coalescing (008)
- **Drive heal from a cursor over forge ref history, not per-merge webhooks.** 300 burst merges cost 1 model call, with 0 wrong ops once content-aware re-anchoring was in place.
- **Content-aware re-anchoring is required inside every changed hunk.** git fuses an adjacent insert and edit into one hunk, so line arithmetic alone mis-pins claims. This happens within a single merge too, not only when coalescing.
- **Queue keys must be stable** (`op:claim@tip`) so crash replays are idempotent. Each item lists *all* merges in its coalesced range that touched the doc.
- **Seed claims for content added during the burst in the same wake** (019's incremental seeding). Otherwise new facts stay unclaimed (40 claims against 64 facts at tip).

### Forge-native trigger and storage-layer enforcement (017)
- **Trigger:** the forge's `reference-transaction` hook (`committed`, `refs/heads/main`). `post-receive` never fires for server-side merges. Skip events whose diff misses grounded files.
- **Knowledge lives in a forge repo** (`pages/` + `.claims/`), with decisions in Postgres. Every agent write is a commit with `Knowledge-Op`, `Source-Commit` and `Approved-By` trailers. The pre-receive gate enforces:
  - **K1:** trailers present.
  - **K2:** the source commit is reachable on the source main.
  - **K3:** the ledger approval matches (op, source commit, approver).
  - **K4:** every changed claim is covered by an approved op.
  - **K5:** `auto:repin` moves pins only.
  - **K6:** the page equals the render of its claims, so nothing is smuggled in.
- **Results:** 10/10 bad writes refused, gate p50 46 ms, merge→knowledge p50 ~300 ms.
- **Gotchas:**
  - Strip the `GIT_*` environment inside hooks before running git against another repo.
  - `%(trailers:valueonly)` needs `separator=`.
  - A new page needs its own `seed:<page>` decision.
- **Not covered:**
  - racing heals (needs rebase-and-retry);
  - a durable per-event job;
  - a human edit path for pages (K6 binds only agent commits).

### Connectors (020, PARTIAL)
- **Pin shape:** `{ uri: logical view, hash, observedRev, observedAt }`. The revision lives **beside** the URI, never inside it: a URI that names a fixed snapshot can never go stale.
  - `observedRev` is the Slack `asOfTs` read with `inclusive=true` (the `latest` parameter is exclusive by default), the Jira `changelog.id`, or the Confluence `version.number`.
- **Snapshot at event time.** Re-reading history returns current text, so edits and deletes can't be replayed.
  - Slack: `message_changed.previous_message`.
  - Jira: `jira:issue_updated`.
  - Confluence: `page_updated` / `page_trashed`.
- **Ingest only from orgs we own.** The only reachable Atlassian site was third-party, and it was not touched.
- **Proven on 7 real Slack revisions:** 0 FP / 0 FN, 3 model calls. A Slack-vs-doc conflict was caught with 0 calls.
- **Unproven:** live Jira/Confluence and the stability of ADF `localId`s.

### Memory → claim promotion (021-B)
- **Agent memory becomes a claim only when all three hold:**
  - a source grounds it;
  - a human approves it;
  - the text is the human-current text.
- **Contradictions** go to the memory owner and the source owners. **Restricted memory is never promotable.**
- A promoted claim joins the 010/014 loop. In the spike, a code change flipped it to `conflict` and the memory record was not rewritten.

## Origin
Synthesized from spikes: 008, 010, 014, 017, 019, 020, 021
Source files:
- `sources/010-grounded-knowledge-claims/`: `claims.ts` is the engine.
- `sources/014-knowledge-self-heal-loop/`: `heal.ts` holds the oracle and re-anchor.
- `sources/017-forge-merge-drives-knowledge-heal/`: `knowledge-pre-receive.mjs` is the K1–K6 gate.
- `sources/019-atomic-claims-by-model/`: `seed.ts` (validator) and `replay.ts` (coverage oracle).
- `sources/020-real-connector-snapshots/`: `connector.ts`. The real Slack fixtures stay local.
- `sources/021-agent-memory-context-persistency/`: `promote.ts`.
