# Research: harness orchestration + company knowledge (2026-10-17)

Benchmarks for the "pilot gaps" session (spikes 002–006). The GitHub bottleneck and the GitAgent baseline are covered in `RESEARCH.md`.

## Agent37 (agent37.com): infrastructure layer
- **What it is:** per-minute sandboxes ("instances") for agent harnesses: Hermes (the default), OpenClaw, Claude Code, Codex, OpenCode, or your own image. It is YC-backed.
- **Pricing:**
  - $0.0011 per vCPU-hour, $0.00096 per GB-hour of RAM, $0.00012 per GB-hour of disk.
  - An always-on 2 vCPU / 4 GB instance is about $4.76/mo; idle (disk only) is about $0.36/mo.
  - Billing is a prepaid wallet. The cap on instance count grows with total top-ups (10, then 50 at $100, then 200 at $250).
  - The LLM router passes cost through with no markup.
  - Source: https://www.agent37.com/docs/agents-api/billing.md
- **Templates** (https://www.agent37.com/docs/agents-api/templates.md):
  - Fields: `{name, scope: system|workspace, image_ref|cloud build from a Dockerfile, default_port (3737), entrypoint[], revision, revisions[{revision,image_digest}]}`.
  - Instances pin to `name@N`. An update is explicit (`POST /v1/instances/{id}/update`), so a PATCH never moves running instances.
  - **Not template fields:** env (set per instance: 64 keys, 64 KB max), MCP, skills, packages, resources (four fixed shapes). Boot hooks live on disk (`~/.agent37/hooks/post-restart.sh`).
- **Lifecycle:**
  - States: provisioning … sleeping, waking, failed.
  - Disk persists across stop/start. `update` resets the OS layer but keeps `/home/node`.
  - Auto-sleep is opt-in (300–86400 s). Memory survival on wake is "usually, not guaranteed"; a cold rebuild takes about 2 minutes.
  - Nightly backups, 7 slots.
  - Crons are external to the box and wake it (max 50; missed runs are skipped, not backfilled).
  - Files API with `X-Expected-Mtime` optimistic locking.
  - Messaging (about 30 chat apps) and webhooks are **Hermes-only** features, reached via exec into localhost.
- **White-label** (https://www.agent37.com/docs/agents-api/white-label.md):
  - It is a forkable Next.js + Supabase starter kit (branding.ts).
  - No sub-accounts, no per-tenant keys, no billing pass-through, no outbound webhooks; clients poll.
- **Minions** (github.com/agent37-platform/minions, MIT, ~650 stars, v0.1.26):
  - A local Kanban "mission control" for Hermes sessions: Express plus SQLite, with a Python worker that imports Hermes `AIAgent`.
  - Only a human moves a card to `done`. Skills come from ClawHub with sha256 checks.
- **Takeaways:**
  - Copy: revision-pinned templates with explicit update; external crons that wake the box; disk-only idle billing; backups.
  - Beat it on: declarative templates, real tenancy and billing, harness-neutral triggers, and outbound events.

## OpenWiki (github.com/langchain-ai/openwiki, MIT, ~17k stars): docs drift
- **Format:**
  - Markdown pages with OKF frontmatter (`sources[]`, `generated`, `verified`).
  - A sidecar `.claims/<page>.json` holds atomic claims with evidence `repo://file#Lx-Ly`, pinned by sha256.
- **Update path:** `--update` rechecks evidence hashes first. If nothing changed, **zero LLM calls**. Only stale claims go to the worker, which returns a sparse payload (confirm, update, add or retract) with stable IDs.
- **Agent access:**
  - `INSTRUCTIONS.md` is the human steering file and survives regeneration.
  - Read MCP (`openwiki_search`, `openwiki_read`) runs with no LLM.
  - Writes go through a lifecycle driven by the host agent (`begin → plan → next_page → submit_page → finish`).
  - A cron CI job opens docs-only PRs.
- **Gaps:**
  - Evidence is `repo://` only; Slack, Notion and support content have no grounding.
  - No tenancy or ACL.
  - No reconciliation when a human edits a page (unverified).

## qm (github.com/yc-software/qm, MIT, ~15k stars): a harness for a whole company
- **Architecture:**
  - A Postgres "session tape" WAL, with turns claimed by workers (pg-boss).
  - Swappable harnesses (Pi, Claude Code).
  - **One durable sandbox per scope**, with about 10 backends.
  - Slack and web are projections of the same sessions.
- **Scopes:**
  - personal / channel / group / team / org, each owning its memory, files, keychain, crons and sandbox.
  - Crossing scopes needs an audited *grant*. Security posture can only tighten in narrower scopes.
- **Memory:**
  - Records carry stable IDs, provenance and sensitivity (`ordinary|unknown|sensitive|restricted`).
  - Every read checks disclosure and fails closed.
  - Consolidation is revision-checked, so a concurrent human edit wins.
  - Recall is pgvector, capped at 6 k characters per turn.
- **Org knowledge:** a pluggable MCP provider (`search_knowledge`/`write_knowledge`). The spec admits "org memory is an unsolved problem".
- **Skills:** a governed lifecycle (create → review → publish), loaded from git packs pinned to a ref.
- **Docs for the agents that build qm:**
  - SPEC.md is written by humans; agents may only append to its "Wall of shame".
  - Each anti-pattern lens gets its own fresh-context reviewer on every PR, and CI enforces it.
- **Gaps:** no browsable wiki, no drift detection; single-org deployment.

## GitAgent knowledge (deltas only)
- `knowledge/index.yaml`: entries carry `{path, tags, priority, always_load}`. `always_load` entries are inlined into the prompt; the rest are listed for on-demand reads. This acts as a cheap context budget.
- Memory overflow does FIFO truncation into `archive/YYYY-MM.md`, which loses information.
- Per-skill confidence: success adds 0.1·(1−c), failure subtracts 0.2, and up to 10 negative examples are kept.
- `extends`: RULES are unioned, SOUL is replaced, memory is isolated.

## Automata today (verified in the code, 2026-10-17)
- **Has:**
  - Live skills, versioned per org and repo, with last-known-good fallback and a `.automata/skills` override.
  - Batteries manifest (pinned packs).
  - `Dockerfile.hbs` renderer.
  - Per-user/repo environments (setupScript, MCP, encrypted env) plus org env vars.
  - R2 client.
  - Slack mention intake.
  - YouTrack post-merge audit.
  - Self-heal and audit tables.
- **Missing:**
  - Any knowledge base, memory or RAG.
  - A template entity; ADR-002 R3.8 only says `FROM automata/worker`.
  - Persistent agents; only E2B and Daytona hibernate.
  - A per-run artifact store.
  - Login other than GitHub; `repoFullName` keys everything.

## Posture
Agent37 runs boxes, qm runs a company harness, OpenWiki writes code docs. **Automata is the governed orchestration plane**:
- declarative, revision-pinned box templates;
- scoped knowledge that humans and agents co-edit and that stays grounded against *any* source;
- every change landing through a reviewed, self-healing loop.

The wedge for pilots is **grounded company knowledge across departments**, which none of the three solves.
