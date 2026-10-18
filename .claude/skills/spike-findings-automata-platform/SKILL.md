---
name: spike-findings-automata-platform
description: Implementation blueprint from spike experiments for Automata. Requirements, proven patterns and verified constraints for grounded company knowledge (claims, conflict detection, model-seeded atomic claims, connectors, self-heal approval queue and gate), scoped knowledge MCP, declarative box templates, long-lived sleep/wake agents (secrets, per-wake tokens, wake cost, memory persistence), and the Agent Forge git core with GitHub as a projection. Load when building any of these.
---

<context>
## Project: automata-platform

Automata is close to its first real client pilot. Prospects asked for the same gaps:
- a documentation and knowledge system that marketing, tech, support *and* agents keep improving;
- less dependence on GitHub;
- long-lived agents;
- box/environment templates and artifacts.

Two spike sessions answered them:
- **Agent Forge (001–008):** our own git core, an end-to-end pipeline, post-merge verify/revert, egress economics and burst-rate knowledge heal. GitHub becomes a projection for humans, and the trust plane is enforced at push time.
- **Harness and knowledge (010–014):** OpenWiki-style grounded claims extended to tickets and docs, with a cross-department conflict detector. Also Agent37-style revision-pinned templates made declarative, persistent per-scope agent boxes, and a post-merge self-heal loop with an approval queue outside GitHub.
- **Frontier (011, 015–021):** the integration seams and the real-world gaps:
  - scoped knowledge MCP, leak-tested with real Claude;
  - template → persistent box with tmpfs secrets;
  - per-wake push tokens;
  - forge-triggered knowledge heal with a storage-layer approval gate;
  - real Claude wake cost on the Hetzner worker;
  - model-seeded atomic claims with a coverage oracle;
  - real connector snapshots (Slack);
  - agent memory persistence and promotion.
- **Competitor research:** Entire (ex-GitHub CEO, $60M) is converging on forge + review + memory + code graph. See `sources/research_entire-graph_20261018.md` and `sources/research_entire-brain_20261018.md`. Our moat:
  - cross-department sources;
  - merge-triggered, oracle-verified drift with a conflict status;
  - enforced approvals;
  - sensitivity-scoped tenancy.

**Posture:** Agent37 runs boxes, qm runs a company harness, OpenWiki writes code docs. Automata is the **governed orchestration plane**. Research is in `sources/RESEARCH.md` and `sources/RESEARCH-harness.md`.

Spike sessions wrapped: 2026-10-17 (001–004, 010–014), 2026-10-18 (011, 015–021)

Agent Forge business case (pricing, unit economics, ARR scenarios, competitor map): Superset page "Agent Forge Blueprint", source `.planning/spikes/blueprint/agent-forge-blueprint.html` (local).
</context>

<requirements>
## Requirements

These are non-negotiable design decisions taken from `.planning/spikes/MANIFEST.md`.

**Agent Forge**
- GitHub stays where humans live. The forge never force-overwrites a human change on the GitHub side; it surfaces divergence instead.
- Agents never hold a GitHub credential. Push credentials are short-lived, scoped to one run, and refused when replayed.
- The projection lease for each branch is durable state (Postgres CAS). A lost lease falls back to the GitHub tip, never to "absent".
- The agent hot path runs on a git core we own, not Forgejo. Merges happen server-side with a per-repo lock and never use a clone.
- Push policy scans EVERY new commit (`git log -p`), never the net diff.
- Forge git runs hermetically (`GIT_CONFIG_GLOBAL=/dev/null`). Merge semantics are pinned, never inherited from the host.
- The conflict payload `{base, head, conflictTree, files[{path, base, ours, theirs, withMarkers}]}` is a versioned product API.
- Interop over lock-in: read OpenGAP `agent.yaml`, and emit Entire-compatible checkpoint trailers.

**Harness and knowledge**
- Knowledge must ground non-code sources (tickets, docs), not just code.
- Agents propose knowledge changes and humans approve them. A human edit always wins over agent output.
- Templates reference secrets by name. Secrets never enter an image or a template body.
- Persistent agents keep their state on a volume that survives stop/start. Artifacts persist on the volume and in R2.
- **Persistent box runtime:**
  - Durable state is the `$HOME` volume only.
  - Every box runs with an init (a PID-1 SIGTERM trap).
  - Wake is single-flight per box.
- **Knowledge approval queue:**
  - Knowledge edits that change meaning go to a human approval queue outside GitHub, with provenance.
  - A re-anchor below the confidence floor becomes a review.
  - Git output parsing always uses `--no-color`.

**Agent Forge frontier (005–008)**
- The projector re-checks gate provenance. Nothing reaches GitHub without it. (005)
- Post-merge verify reverts against the live tip, never by resetting to the last green. Only verified tips are projected. Approver ≠ author keys on gate provenance, not on commit metadata. (006)
- Agents check out from warm boxes, or bundle-uri plus a delta fetch when cold. Never a cold full clone. The forge runs where the agents run. (007)
- Knowledge heal is driven from a cursor over forge ref history with coalescing. Re-anchoring is content-aware inside changed hunks. Queue keys are stable (`op:claim@tip`). (008)

**Frontier (session 3)**
- **Knowledge MCP identity:** a control-plane-signed launch token, never a tool argument.
  - The knowledge store is never inside the box.
  - Unlabelled records are invisible, and a hidden record is indistinguishable from an absent one.
  - Agent writes are held proposals. (011)
- **Agent sessions get an isolated Claude config dir/HOME.** Otherwise they inherit the operator's skills, hooks and plugins, and scopes sharing `~/.claude` can resume each other's sessions. (011, 021)
- **Runtime manifest:** it carries `secretBindings` and `init` (default true, in the digest). Secret values reach a box only through a per-container tmpfs at `/run/secrets`, written over exec stdin on every wake, never via `-e`/`--env-file`/ARG/ENV. (015)
- **Push credentials live for one wake.** Mint on start AND unpause, revoke on sleep, and the edge refuses a token whose wakeId isn't current. (016)
- **Paused agents** (live harness process, about 130 MiB each) are capped and LRU-demoted to stopped. Keep the ~16k-token prompt prefix stable so wakes hit the cache. (018)
- **Knowledge claims are seeded incrementally:**
  - every merge seeds the text it inserted;
  - sentinels watch unclaimed prose;
  - coverage is verified alongside FP/FN;
  - model-seeded claims are validated before pinning;
  - re-anchoring uses the merge diff, never similarity. (019)
- **Self-heal trigger:** the forge `reference-transaction` hook (committed, refs/heads/main). Knowledge lives in a forge repo, and agent writes carry `Knowledge-Op`/`Source-Commit`/`Approved-By` trailers verified against the decision ledger. An agent-written page must equal the render of its claims. (017)
- **Connector evidence** pins a logical view URI, with the observed revision stored beside it. Connectors snapshot at event time and only ingest from orgs we own. (020)
- **Memory model:**
  - Structured scope memory (rev CAS, sensitivity, humanEdited, provenance) is the durable layer, re-injected at every wake; the harness session is best-effort, because compaction is lossy.
  - Restricted memory is store-enforced and never promotable.
  - Memory becomes a claim only when grounded and human-approved.
  - Session JSONL is excluded from artifact sync. (021)

**Repo hygiene**
- The repo is public: no customer names or secrets anywhere (keep this skill gitleaks-clean). `.planning/` stays local (git-excluded); this skill is tracked in the repo (user decision, 2026-10-17).
</requirements>

<findings_index>
## Feature Areas

| Area | Reference | Key Finding |
|------|-----------|-------------|
| Grounded knowledge + self-heal | references/grounded-knowledge.md | The `conflict` status catches "code says 30, marketing says 14" with no model call. Model-seeded atomic claims hit 0 FP / 0 FN on real merges, with full coverage ($0.69). The forge `reference-transaction` hook triggers the heal, and the K1–K6 gate refuses every unapproved write. Connectors pin a logical view plus the observed revision. |
| Knowledge access (MCP) | references/knowledge-access-mcp.md | Signed launch identity, fail-closed disclosure, no existence oracle. Real `claude -p` under 6 adversarial prompts leaked 0 canaries. |
| Box templates | references/box-templates.md | One YAML compiles byte-identical to `renderDockerfile()` plus a runtime manifest (needs `secretBindings` + `init`). Secrets are rejected anywhere in the template. Policy only tightens. Canonical digest; pins never move. |
| Persistent agents | references/persistent-agents.md | On Hetzner, a paused box with a live Claude process wakes in 162 ms; a cold stop→turn takes 1.3 s. Secrets go via tmpfs + exec stdin per wake. Push tokens are per wake. Each scope needs its own `~/.claude`. Compaction is lossy, so re-inject structured memory. `--init` is mandatory. |
| Agent Forge git core | references/agent-forge-git.md | Bare git with a per-repo lock is 67x faster than Forgejo. Merging is merge-tree + CAS with no clone (35x clone-merge-push). The push gate takes < 30 ms. GitHub projection never overwrites humans. React to merges via `reference-transaction`. |

## Source Files

The original spike source files are in `sources/NNN-name/`, each with its README (investigation trail and results). Run TypeScript spikes with `node --experimental-strip-types --no-warnings <file>.ts`.

## Not yet proven
- Live Jira changelog and Confluence version pinning; this needs a BeAutomata-owned Atlassian site (spike 020 is PARTIAL).
- Concurrent knowledge heals racing on knowledge main; a durable per-event heal job; the human edit path for pages (017).
- Symbol-ID or character-range evidence pins instead of lines (019 over-flags facts that share a line).
- Grounding memory → claims with a real model (021 used token matching).
- MCP servers, hooks and plugins inside a woken box (018 measured a bare CLI).
- Long test suites in post-merge verify (sharding or test impact analysis); semantically dependent reverts (006). Repos over 1 GB, and lazy blob fetches in blobless clones (007).
</findings_index>

<metadata>
## Processed Spikes

- 001-github-projection-mirror
- 002-forge-substrate
- 003-push-time-policy-gate
- 004-server-side-merge-no-clone
- 010-grounded-knowledge-claims
- 012-box-template-manifest
- 013-long-lived-agent-wake
- 014-knowledge-self-heal-loop
- 005-forge-pipeline-e2e
- 006-post-merge-verify-revert
- 007-clone-egress-economics (PARTIAL)
- 008-forge-merge-to-knowledge-heal
- 011-scoped-knowledge-mcp
- 015-template-boots-persistent-box
- 016-long-lived-agent-short-lived-token
- 017-forge-merge-drives-knowledge-heal
- 018-real-harness-wake-cost
- 019-atomic-claims-by-model
- 020-real-connector-snapshots (PARTIAL)
- 021-agent-memory-context-persistency
</metadata>
