---
spike: 020
name: real-connector-snapshots
type: standard
validates: "Given a real connector (Jira/Confluence planned, Slack as fallback) as a ticket:// / doc:// source read-only, when the source changes between revisions, then stable revision ids pin evidence and statuses match spike 010"
verdict: PARTIAL
related: [010-grounded-knowledge-claims, 014-knowledge-self-heal-loop]
tags: [knowledge, connectors, slack, atlassian, revisions, provenance]
---

# Spike 020: Real connector snapshots

## What This Validates
Spike 010's `ticket://` and `doc://` resolvers read local fixture files. This spike asks whether a **real** source can feed the same engine. That requires two things:
- a revision id we can re-read (reproducible snapshots);
- statuses that still match what actually changed between revisions.

## Research
| Source | Stable identity | Revision id | Edit/delete history via API | Reachable here | Status |
|---|---|---|---|---|---|
| Jira issue | issue key / id | changelog history id (monotonic) | changelog lists field from→to | Only a third-party org's site (`read:jira-work`) | **Not used**: third-party data must not enter this repo |
| Confluence page | page id | `version.number` (1, 2, …) | full version history | No Confluence scope granted | **Not reachable** |
| Confluence ADF block | `localId` on some node types | n/a | n/a | — | Unverified |
| Slack message | `(channel, ts)` | — (message is immutable unless edited) | **none** in read API; only `message_changed`/`message_deleted` events | Yes, BeAutomata workspace | **Used** |
| Slack channel view | `(channel, view)` | `asOfTs`, replayed with `conversations.history?latest=asOfTs&inclusive=true` | reproducible unless a message was edited/deleted | Yes | **Used** |
| Slack canvas (doc-like) | canvas id + section ids | — | — | 0 canvases found | Not available |

**Chosen approach:**
- A connector materializes a Slack channel *as of a revision* into 010's resolver layout. 010's `checkPage` / `reconcile` / `applyDraft` then run unchanged.
- The data is real: daily "production PR-review audit found N gap(s)" bot posts, 7 revisions from 09-11 to 10-09.
- Redactions: the channel id, bot id and audit hostname are redacted. Message text is verbatim.

## How to Run
```bash
cd .planning/spikes/020-real-connector-snapshots
node --experimental-strip-types --no-warnings scenarios.ts   # 8 self-verifying checks, exit 0/1
```
The data comes from `fixtures/slack-capture.json`, captured once via the claude.ai Slack MCP (read-only). Re-capturing is manual.

## What to Expect
8 PASS lines, then `8/8 passed`.

## Observability
- `events.jsonl` holds one event per check.
- `results.json` holds every check's detail.
- The capture file records the probes too: the Atlassian site and scopes, the canvas search, and the edited-marker check.

## Investigation Trail
1. **Atlassian first.** `getAccessibleAtlassianResources` returned one site, owned by a third-party organization, with Jira scopes only and no Confluence. I didn't snapshot it, because this repo is public and the data isn't ours. So Jira changelog ids and Confluence version numbers remain **unproven live**.
2. **Slack fallback.**
   - The only BeAutomata channel with history holds a daily audit bot. That's a real "current state" fact that changes over time: 4→3→3→3→2→1→1 gaps.
   - No canvases or files exist, so there is **no live doc:// source**. The conflict check pairs real Slack data with a synthetic ops doc.
3. **A revision id needs a reproducible read.** Two independent reads (full page vs `latest=T`) agreed byte-for-byte on both shared `ts` values (C1).
4. **Discovery: `latest` is EXCLUSIVE.** The real read with `latest=1789545835.706929` did *not* return that message (C2). A connector that replays "the view as of T" without `inclusive=true` resolves to the *previous* revision. That's an off-by-one that silently pins the wrong fact.
5. **Discovery: the revision belongs in provenance, not in the URI.**
   - The directive's form `ticket://jira/KEY@<changelogId>` names an immutable snapshot. Such a URI resolves to the same bytes forever and **can never go stale**.
   - C6 proves the Slack analogue: a claim pinned to one message `ts` stayed `fresh` while the live view said 1 gap, not 2.
   - So evidence URIs name a **logical view** (`latest-from/<bot>`, an issue field, a page section). The revision it was observed at is stored *next to* the pin. Message-ts pins are right only for immutable facts: decisions, quotes, "on 09-16 we saw 2 gaps".
6. **Same fact in a newer message.** The count stayed 3 while the ts advanced (C3). The claim stays `fresh` with 0 calls, but the observed revision moves forward. Production should record that as a provenance refresh ("re-verified at rev X"), which costs nothing.
7. **Everything passed on the first run, so I distrusted it.** Checks done:
   - I inspected the materialized view and the drafts.
   - C4's proposal text is "…reports 2 gaps." The C8 page ends at the true count of 1.
   - Strict `tsc` is clean.

## Results
**PARTIAL.** 8/8 checks pass on real Slack revisions, but Jira and Confluence couldn't be exercised.

| # | Check | Result |
|---|---|---|
| C1 | same ts → same bytes across independent reads | ✓ (2 shared) |
| C2 | `latest` is exclusive by default | ✓, so views must pass `inclusive=true` |
| C3 | 3→3, newer message | fresh, 0 calls, rev re-observed |
| C4 | 3→2 | `update` proposal, 1 call, needs approval |
| C5 | Slack 2→1, doc still 2 | `conflict`, 0 calls |
| C6 | message-ts pin for a current-state fact | stays fresh (the trap) |
| C7 | [synthetic] message deleted | `retract` proposal, not auto |
| C8 | replay of 7 real revisions | 3 updates = 3 count changes, **0 FP / 0 FN**, 3 model calls, final page true |

About 6 read-only MCP calls in total. No rate limit was hit; Slack `conversations.history` is Tier 3 (about 50/min), per its docs.

**Signal for the build:**
- **Pin model:** `{ uri: logical view, hash, observedRev, observedAt }`.
  - `observedRev` is the Slack `asOfTs` with `inclusive=true`, the Jira changelog id or the Confluence `version.number`.
  - A hash-equal re-check at a newer rev is a free provenance refresh.
- **Webhooks a production connector subscribes to:**
  - Slack Events: `message`, `message_changed` (carries `previous_message`, the only edit history Slack gives) and `message_deleted`.
  - Jira: `jira:issue_updated` (with `changelog.id`) and `jira:issue_deleted`.
  - Confluence: `page_updated` (with `version.number`), `page_trashed` and `page_removed`.
- **Edits break replay.** Slack returns *current* text for an old `ts`, so `asOfTs` replay is exact only for unedited and undeleted messages. The connector must **store snapshots at event time** (from `message_changed.previous_message`), not re-read history later.
- **Still to prove:**
  - live Jira changelog and Confluence version pinning, on a BeAutomata-owned Atlassian site with a Confluence scope;
  - Confluence ADF `localId` stability across edits (would give heading-rename-proof `doc://` anchors);
  - Slack canvases as a doc source.
