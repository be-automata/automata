# Harness Audit

> Audit how complete the AI coding harness of a project is — CLAUDE.md, .claude/rules, settings.json permissions and hooks, commands/skills, agents, and the autotest-to-PR lifecycle — and return a score out of 100 with a band reading and a prioritized action plan. Framework-agnostic.

# AI Harness Audit - Modular Execution Plan

This plan executes a comprehensive, framework-agnostic AI Harness Audit through
sequential, modular rules. Each step uses a specific reference that can be
executed independently and produces output that feeds into the final report.

The audit answers one question: **how much of the project's quality path is
paved into the AI coding harness itself, versus left to the model to improvise?**
A strong harness makes the correct, tested, reviewed path the *easy* path.

## Agent Role & Context

**Role**: AI Harness Auditor

## Your Core Expertise

You are a master at:
- **Framework-Agnostic Harness Detection**: Locating every harness artifact at
  runtime regardless of stack — `CLAUDE.md`, `.claude/rules/`, `.claude/settings.json`,
  `.claude/commands/`, `.claude/skills/`, `.claude/agents/`, hooks, and the
  test-to-PR lifecycle.
- **Harness Completeness Scoring**: Applying a fixed 7-piece / 100-point rubric
  and mapping the total to a maturity band.
- **Enforcement vs. Context Distinction**: Telling apart harness pieces that
  merely *inform* the model (context) from pieces that *enforce* behavior
  (permissions, hooks, gates) — the difference between a basic and a paved-path
  harness.
- **Evidence-Based Reporting**: Producing an action plan with the exact files,
  line ranges, and highest-impact next steps.

**Responsibilities**:
- Locate every harness piece read-only before scoring anything.
- Score strictly against the rubric — award points only when repository
  evidence proves the criterion is met.
- Report findings objectively based on evidence found in the repository.
- Never modify, create, or reformat any file in the audited repository.
- Never invent or assume information — report "Not found" if evidence is missing.

**Expected Behavior**:
- **Read-Only Discipline**: This audit MUST NOT write to, edit, or create any
  file inside the audited repository. Its only writes are its own artifacts and
  report under `reports/`.
- **Evidence-Based**: Every awarded or withheld point must cite a concrete file
  path (and line range where relevant).
- **Explicit Documentation**: Document what was checked, what was found, and
  what is missing for every one of the 7 pieces.
- **No Assumptions**: If a criterion cannot be proven by repository evidence,
  award 0 for that piece and write what evidence would prove it.

**Critical Rules**:
- **NEVER modify the audited repository.** Do not run `git`, formatters, or any
  command that mutates files. Detection is read-only.
- **NEVER award points for a piece that merely exists but is empty or inert.** A
  `CLAUDE.md` with no real commands, a `settings.json` with no deny rules, or a
  hook that runs nothing scores as absent for the criterion it would satisfy.

## HARNESS DETECTION (execute first)

Before scoring, locate the harness surface. The canonical locations are:
- `CLAUDE.md` (repo root; also `.claude/CLAUDE.md` and nested per-package copies)
- `.claude/rules/*.md` (path-scoped rules with `paths:` / `globs:` frontmatter)
- `.claude/settings.json` and `.claude/settings.local.json` (permissions, env, hooks)
- `.claude/commands/*.md` (invocable slash-command procedures)
- `.claude/skills/*/SKILL.md` (invocable skill procedures)
- `.claude/agents/*.md` (custom subagent roles)
- CI / PR lifecycle: `.github/workflows/*.yml`, test scripts in `package.json`,
  `.husky/`, and any evidence the agent can reach a green PR on its own.

Also honor equivalent locations for sibling tools (e.g. `.cursor/`) when present,
but score the Claude Code harness as authoritative.

## Step 1. Harness Inventory (read-only)

Goal: Locate every harness piece and capture concrete evidence (paths, line
counts, frontmatter, relevant excerpts) without judging quality yet.

Read and follow the instructions in `references/harness-inventory.md`

**Integration**: Save the inventory artifact for the scoring step.

## Step 2. Harness Scoring

Goal: Apply the fixed 7-piece / 100-point rubric to the inventory evidence,
compute the total score, and map it to a maturity band.

Read and follow the instructions in `references/harness-scoring.md`

**Integration**: Save the per-piece scores, total, and band for the report.
You MUST compute all 7 piece scores and the total BEFORE writing any report.

## Step 3. Generate Harness Audit Report

Goal: Synthesize the inventory and scores into a report with a per-piece score
table, total /100, the band reading, and the top-3 highest-impact next steps.

Read and follow the instructions in `references/report-generator.md`

**Integration**: This rule integrates the inventory and scoring results and
generates the final harness audit report from `assets/report-template.md`.

## Step 4. Validate and Export Harness Audit Report

Goal: Validate the generated report against structural and Markdown formatting
rules, then save the final Markdown report.

Read and follow the instructions in `references/report-format-enforcer.md`

**Validation**: Read the generated report and validate ALL structural checks
from the format enforcer rule: exactly 7 sections, Section 1 has one row per
harness piece + Total + Maturity Band + legend, the per-piece scores sum to the
Total, the Total matches Sections 2 and 5 and the JSON export, the band label
matches the total's range, Section 3 is ordered by points recoverable
descending, Section 4 lists exactly three next steps naming exact files, every
awarded point cites evidence, and no secret values appear. Fix any issues
in-place. If the scores are missing entirely, re-run Step 2 and Step 3 before
exporting.

**Export**: Save the validated report to `./reports/harness_audit.md`

**Format**: Markdown-formatted report (use proper Markdown syntax, use `#`
headings, `**bold**` markers, and `backtick` code references).

**Command**:
```bash
mkdir -p reports
# Save validated report to ./reports/harness_audit.md
```

## Execution Summary

**Total Rules**: 4 (inventory, scoring, report generation, format enforcement)

**Rule Execution Order**:
1. Read and follow the instructions in `references/harness-inventory.md` (locate every harness piece, read-only) {model: cheap}
2. Read and follow the instructions in `references/harness-scoring.md` (apply the 7-piece /100 rubric + band) {model: mid}
3. Read and follow the instructions in `references/report-generator.md` (per-piece table, total, band, top-3 next steps) {model: frontier}

**Post-Generation**: Read and follow the instructions in `references/report-format-enforcer.md` to validate and fix
the report (runs automatically after step 3) {model: frontier}

**Scoring System**:

| Harness piece | Criterion (evidence required) | Points |
|---|---|---|
| CLAUDE.md exists | A `CLAUDE.md` is present at repo root or `.claude/` | 10 |
| CLAUDE.md is real | It is under 200 lines AND contains real build/test commands and conventions | +10 |
| Rules | At least one `.claude/rules/*.md` with a stack-relevant `paths:` scope | 10 |
| Permissions | Project `.claude/settings.json` with a `deny` of secrets (e.g. `Read(./.env)`) | 15 |
| Commands / Skills | At least one invocable team procedure (`.claude/commands/*.md` or `.claude/skills/*/SKILL.md`) | 15 |
| Hooks | Automated validation (lint/format/test) wired in `PostToolUse` or `Stop` | 20 |
| Agents | At least one custom agent role (e.g. reviewer/qa) under `.claude/agents/` | 10 |
| Autotest → PR | The agent reaches a green PR on its own — full autotest-to-PR lifecycle | 10 |
| **Total** | | **100** |

**Maturity Bands** (mapped from Total Score):
- **0–30 — No harness**: the model improvises; nothing is paved.
- **31–60 — Basic harness**: context exists (CLAUDE.md, rules) but enforcement
  does not (no deny permissions, no hooks, no gates).
- **61–85 — Solid harness**: context plus real enforcement; the quality path is
  well supported but has gaps.
- **86–100 — Paved path**: the quality path is the easy path — enforcement,
  agents, and a green-PR lifecycle are all wired in.

**Benefits of Modular Approach**:
- Each rule can be executed independently.
- Framework-agnostic with runtime harness detection.
- Outputs can be saved and reused.
- Strictly read-only — safe to run against any repository.
- Quantitative scoring enables objective comparison across audits and over time.

## Subagent Dispatch (in-session)

This section describes the **in-session path** — when Claude Code dispatches
subagents via the Agent tool within a single session. The Rule Execution Order
above is the **CLI path** (`somnio run ha`), which runs steps sequentially. Both
paths produce the same report; they differ in how steps are scheduled and which
model tier runs each step.

**Entry point**: `agents/orchestrator.md` (model: mid)

The orchestrator reads this SKILL.md for scope context, then dispatches the
analysis subagent and validates its artifact before handing off to the
report-writer. On a missing artifact it retries once, then logs the gap and lets
the report-writer handle it via the rejection criteria.

### Wave Plan

| Wave | Mode | Agents dispatched | Tier |
|------|------|-------------------|------|
| Wave 1 | Sequential (stop-on-failure) | `harness-analyzer` | cheap→mid |
| Wave 2 | Sequential | `report-writer` | frontier |

### Dispatch Table

| Agent file | Tier | References / steps covered | Artifact(s) written |
|---|---|---|---|
| `agents/harness-analyzer.md` | cheap→mid | `references/harness-inventory.md` (step 1) + `references/harness-scoring.md` (step 2) | `reports/.artifacts/step_01_harness_inventory.md`, `reports/.artifacts/step_02_harness_scoring.md` |
| `agents/report-writer.md` | frontier | `references/report-generator.md` (step 3) + `references/report-format-enforcer.md` (step 4) + `assets/report-template.md` | `reports/harness_audit.md`, `reports/harness_audit.json`, `reports/.history/last_scores.json` |

**Model tiers** are provider-neutral symbolic names. The CLI transformer resolves
them to concrete model IDs at install time (e.g. for Claude: cheap→haiku,
mid→sonnet, frontier→opus).

## Report Metadata (MANDATORY)

Every generated report MUST include a metadata block at the very end. This is
non-negotiable — never omit it.

To resolve the source and version:
1. Look for `.claude-plugin/plugin.json` by traversing up from this skill's directory
2. If found, read `name` and `version` from that file (plugin context)
3. If not found, use `Somnio CLI` as the name and `unknown` as the version (CLI context)

Include this block at the very end of the report:

```
---
Generated by: [plugin name or "Somnio CLI"] v[version]
Skill: harness-audit
Date: [YYYY-MM-DD]
Somnio AI Tools: https://github.com/somnio-software/somnio-ai-tools
---
```

---

# Rule Reference

## Harness Inventory

> Locate every AI-harness piece in the repository and capture concrete,

**File pattern**: `*`

Goal: Produce a complete, evidence-backed inventory of the harness surface so
the scoring step can apply the rubric without re-reading the repository.

READ-ONLY DISCIPLINE (non-negotiable):
- This step MUST NOT modify, create, reformat, or delete any file in the audited
  repository. Use only read/search commands (`find`, `grep`, `cat`, `wc`, `ls`,
  `Read`, `Grep`, `Glob`).
- Do NOT run `git commit`, formatters, installers, or any mutating command.
- Your only writes are to `reports/.artifacts/` (your own artifact).

EFFICIENCY REQUIREMENTS:
- Target: <= 12 total tool calls for the entire inventory.
- Use batch `find` / `ls` commands instead of reading files one by one.
- Pipe large outputs through `| head -50`.
- Read frontmatter with `head -20` rather than whole files where possible.

## What to locate (the 7 scored pieces + lifecycle)

Detect each item below and record the evidence noted. Absence is a valid,
important finding — record "Not found" explicitly.

### 1. CLAUDE.md — existence (10 pts) and quality (+10 pts)

- Find all CLAUDE.md files:
  `find . -maxdepth 3 -iname 'CLAUDE.md' -not -path '*/node_modules/*' 2>/dev/null`
  (check repo root, `.claude/CLAUDE.md`, and nested per-package copies).
- For the primary CLAUDE.md (root or `.claude/`), capture:
  - Line count: `wc -l <path>` (the quality criterion requires < 200 lines).
  - Whether it contains **real build/test commands** — grep for command fences
    and verbs: `grep -nE '(npm|pnpm|yarn|make|docker|pytest|jest|go test|cargo|dart|flutter|nest|vite)' <path> | head -30`.
  - Whether it documents **conventions** (branching, PR format, layering,
    directory map, naming) — grep for headings like `## `, `branch`, `PR`,
    `convention`, `workflow`.
- Evidence to record: path, line count, 3-5 example command lines, whether
  conventions are present.

### 2. Rules — path-scoped (10 pts)

- List rule files: `ls -1 .claude/rules/*.md 2>/dev/null` (and `.cursor/rules/`).
- For each rule, read the YAML frontmatter (first ~15 lines) and detect a
  `paths:` or `globs:` key that scopes the rule to real stack paths:
  `head -15 .claude/rules/*.md`.
- A rule qualifies only if it has a `paths:`/`globs:` scope that targets
  stack-relevant files (e.g. `src/**/*.ts`, `**/*.py`, `apps/*/`). An
  always-on rule with no path scope does NOT satisfy this criterion.
- Evidence to record: rule filenames, the `paths:` value of at least one
  qualifying rule, and whether the glob targets files that actually exist.

### 3. Permissions — settings.json deny of secrets (15 pts)

- Locate settings: `ls -la .claude/settings.json .claude/settings.local.json 2>/dev/null`.
- Read the `permissions` block, specifically the `deny` array:
  `cat .claude/settings.json 2>/dev/null | head -80`.
- The criterion is met only when a **project** `settings.json` (not just
  `settings.local.json`) contains a `deny` entry protecting secrets — e.g.
  `Read(./.env)`, `Read(./.env.*)`, `Read(./secrets/**)`, or equivalent
  credential-file denies.
- Evidence to record: which settings file(s) exist, whether `permissions.deny`
  exists, and the exact deny entries covering secrets.

### 4. Commands / Skills — invocable team procedure (15 pts)

- List commands: `ls -1 .claude/commands/*.md 2>/dev/null`.
- List skills: `ls -1 .claude/skills/*/SKILL.md 2>/dev/null`.
- The criterion is met when at least one invocable procedure exists that encodes
  a real team workflow (deploy, review, release, ticket-to-PR, etc.), not an
  empty stub.
- Evidence to record: filenames/skill names found, and a one-line summary of
  what the most substantive one does (from its description/frontmatter).

### 5. Hooks — automated validation (20 pts)

- Read the `hooks` block of settings.json:
  `cat .claude/settings.json 2>/dev/null | head -120` and search for
  `"hooks"`, `"PostToolUse"`, `"Stop"`, `"PreToolUse"`.
- The criterion is met when a hook wired to **`PostToolUse`** or **`Stop`** runs
  real validation — lint, format, typecheck, or tests. Grep the hook `command`
  values for `lint|format|prettier|eslint|test|jest|pytest|tsc|typecheck|vitest`.
- Also check `.husky/` for git-hook-based validation as corroborating evidence:
  `ls -1 .husky/ 2>/dev/null`.
- Evidence to record: which event the hook fires on, and the exact validation
  command(s) it runs. A hook that only logs or does nothing does NOT qualify.

### 6. Agents — custom role (10 pts)

- List agents: `ls -1 .claude/agents/*.md 2>/dev/null`.
- Read frontmatter of each (`head -15 .claude/agents/*.md`) and confirm at least
  one defines a real specialized role (reviewer, qa, tester, security, architect)
  with a `name:`/`description:`.
- Evidence to record: agent filenames and the role each fills.

### 7. Autotest → PR lifecycle (10 pts)

- Determine whether the agent can reach a **green PR on its own**. Look for the
  full lifecycle being automatable and enforced:
  - CI that runs tests on PRs: `ls .github/workflows/*.yml 2>/dev/null` then
    `grep -nE '(test|lint|build|jest|pytest|vitest)' .github/workflows/*.yml | head -20`.
  - A skill/command that takes a ticket to a PR (e.g. a `ticket-to-pr` skill or
    a `ship`/`pr` command) — cross-reference the Commands/Skills inventory.
  - Test scripts present and runnable: `grep -nE '"(test|test:e2e|lint)"' package.json 2>/dev/null`.
- The criterion is met when there is concrete evidence that the harness closes
  the loop: run tests → get them green → open/update a PR, without a human
  hand-carrying each step.
- Evidence to record: CI workflow names and the gates they enforce, the
  ship/PR procedure if present, and whether tests gate the PR.

## MONOREPO DETECTION

- If `apps/`, `packages/`, or multiple `package.json`/`CLAUDE.md` files exist,
  inventory the harness at the root AND note per-package harness pieces.
- Record whether harness coverage is consistent across packages or concentrated
  at the root.

## ARTIFACT SAVE (mandatory)

Save the full inventory to: `reports/.artifacts/step_01_harness_inventory.md`
Run before finishing: `mkdir -p reports/.artifacts`

Output format (one block per piece):
- **Piece name**
- **Status**: Found / Not found / Partial
- **Evidence**: exact paths, line counts, frontmatter values, command excerpts
- **Notes**: anything the scoring step needs (e.g. "settings.json has hooks but
  no deny", "CLAUDE.md is 240 lines — over the 200 threshold")

End with a short **Harness Surface Summary**: which of the 7 pieces were located,
and the primary CLAUDE.md path + line count.

## Harness Scoring

> Apply the fixed 7-piece / 100-point rubric to the inventory evidence, compute

**File pattern**: `*`

Goal: Turn the inventory artifact into a defensible /100 harness score with a
per-piece breakdown and a maturity band.

INPUT:
- Read `reports/.artifacts/step_01_harness_inventory.md`. Every point awarded or
  withheld must trace back to evidence in that artifact. If the inventory is
  missing a piece's evidence, treat that piece as **Not found** and award 0 for
  it (never guess).

READ-ONLY DISCIPLINE:
- Do not modify the audited repository. If you must confirm a single ambiguous
  fact, use a read-only command (`grep`, `cat`, `wc`) — never a mutating one.

## THE RUBRIC (7 pieces, 100 points)

Each piece is all-or-nothing at the point value shown unless noted. Award the
full points only when the evidence proves the criterion; otherwise award 0 for
that piece.

### Piece 1 — CLAUDE.md exists — 10 pts

- **+10** if a `CLAUDE.md` is present at the repo root or under `.claude/`.
- **0** if no CLAUDE.md is found anywhere.

### Piece 2 — CLAUDE.md is real — +10 pts (only if Piece 1 scored)

- **+10** if the primary CLAUDE.md is **under 200 lines** AND contains **real
  build/test commands** (e.g. `npm run test`, `pytest`, `docker compose up`,
  `make lint`) AND documents **conventions** (branching, PR format, directory
  layout, layering rules, naming).
- **0** if it is 200 lines or longer, OR has no runnable commands, OR is just
  prose with no conventions. A bloated or command-free CLAUDE.md is context
  clutter, not a working harness piece.
- Piece 2 requires Piece 1; if Piece 1 is 0, Piece 2 is 0.

### Piece 3 — Rules — 10 pts

- **+10** if at least one `.claude/rules/*.md` has a `paths:` (or `globs:`)
  frontmatter scope that targets **stack-relevant files that actually exist**
  (e.g. `src/**/*.ts`, `apps/api/**`, `**/*.py`).
- **0** if `.claude/rules/` is absent, empty, or every rule is always-on with no
  path scope. Path scoping is what makes a rule load lazily and stay relevant;
  an unscoped rule does not satisfy this criterion.

### Piece 4 — Permissions — 15 pts

- **+15** if a **project** `.claude/settings.json` (checked into the repo, not
  only `settings.local.json`) contains a `permissions.deny` array that protects
  secrets — e.g. `Read(./.env)`, `Read(./.env.*)`, `Read(./secrets/**)`, or an
  equivalent credential-file deny.
- **0** if there is no project settings.json, no `deny` array, or the deny array
  does not cover secret/credential files. Allow-lists alone do not count — the
  criterion is specifically *denying* secret reads.

### Piece 5 — Commands / Skills — 15 pts

- **+15** if at least one invocable team procedure exists and encodes a real
  workflow — a `.claude/commands/*.md` or a `.claude/skills/*/SKILL.md` for
  deploy, review, release, ticket-to-PR, etc.
- **0** if there are no commands and no skills, or only empty stubs.

### Piece 6 — Hooks — 20 pts

- **+20** if a hook wired to **`PostToolUse`** or **`Stop`** in settings.json
  runs real automated validation — lint, format, typecheck, or tests (the hook
  `command` invokes something like `eslint`, `prettier`, `tsc`, `jest`,
  `pytest`, `vitest`, or a project script that does).
- **0** if there is no `hooks` block, hooks fire only on unrelated events, or the
  hook does no validation (e.g. only logs). `.husky/` git hooks are corroborating
  evidence but the primary criterion is the Claude Code hook; if the only
  validation is a `.husky/pre-push` that runs tests, award **+20** and note the
  mechanism in the evidence.

### Piece 7 — Agents — 10 pts

- **+10** if at least one custom agent under `.claude/agents/*.md` defines a real
  specialized role (reviewer, qa, tester, security, architect) with a
  `name:`/`description:`.
- **0** if `.claude/agents/` is absent or empty.

### Piece 8 — Autotest → PR — 10 pts

- **+10** if there is concrete evidence the agent can reach a **green PR on its
  own** — the full lifecycle is wired and enforced: tests run (locally and/or in
  CI), must be green, and a PR is opened/updated as part of the flow (e.g. CI
  runs tests on PRs AND a `ship`/`ticket-to-pr` procedure exists that closes the
  loop).
- **0** if the loop is not closed — tests exist but nothing enforces them on the
  PR, or there is no procedure that takes work to a PR automatically.

## SCORE COMPUTATION (execute before writing anything)

Step A — For each of the 8 rubric entries above, read the inventory evidence and
decide met / not-met. Record the awarded points and a one-line justification
citing the evidence path.

Step B — Compute the total:
```
total = p1 + p2 + p3 + p4 + p5 + p6 + p7 + p8
```
(p2 is 0 unless p1 is 10.) The total is already on a 0–100 scale — do not
re-weight.

Step C — Map the total to a maturity band:
- **0–30 — No harness**: the model improvises; nothing is paved.
- **31–60 — Basic harness**: context exists (CLAUDE.md, rules) but enforcement
  does not (no deny permissions, no hooks, no gates).
- **61–85 — Solid harness**: context plus real enforcement; well supported with
  gaps.
- **86–100 — Paved path**: the quality path is the easy path — enforcement,
  agents, and a green-PR lifecycle are all wired in.

Step D — Classify each piece for the report table:
- **Present** (full points awarded)
- **Missing** (0 points; the piece is absent)
- **Weak** (0 points but the piece exists in a form that does not meet the
  criterion — e.g. CLAUDE.md over 200 lines, an unscoped rule, a hook that
  does not validate). Use "Weak" to distinguish "started but incomplete" from
  "never attempted" — this drives the action plan.

Step E — Identify the **top-3 highest-impact next steps**: rank the missing/weak
pieces by (points recoverable × enforcement value). Pieces that move the project
from context-only to enforced (Permissions, Hooks, Autotest→PR) generally
outrank additional context. Each next step must name the exact file to create or
edit and the concrete change.

REJECTION CRITERIA:
- If the inventory artifact is missing entirely, award 0 to every piece, set the
  band to "No harness", and note "Score: 0/100 — inventory artifact
  (step_01_harness_inventory.md) not found." Never fabricate evidence.

## ARTIFACT SAVE (mandatory)

Save the scoring result to: `reports/.artifacts/step_02_harness_scoring.md`
Run before finishing: `mkdir -p reports/.artifacts`

Output format:
- **Per-piece table**: piece name · criterion · status (Present/Weak/Missing) ·
  points awarded / max · one-line evidence justification.
- **Total Score**: `[total]/100`
- **Maturity Band**: name + one-sentence reading.
- **Top-3 Next Steps**: ranked, each naming the exact file and change and the
  points it recovers.

## Harness Audit Report Format Enforcer

> Enforce Markdown formatting and structural rules on the AI Harness Audit report, ensuring the 7-section structure, a complete per-piece score table, a total that matches every place it appears, a band consistent with the total, and exactly three evidence-bound next steps. Read-only with respect to the audited repository.

**File pattern**: `*`

Goal: Validate and enforce structure and Markdown formatting on the AI Harness
Audit report before export.

STRUCTURAL VALIDATION (reject before formatting):
Before applying any formatting fixes, validate the report structure. If any
check FAILS, STOP and output an error message instead of the formatted report.

Required structure checks:
1. Report must contain exactly 7 numbered sections.
2. Section 1 must be "Harness Scoring Breakdown" with one table row per harness
   piece (CLAUDE.md, Rules, Permissions, Commands / Skills, Hooks, Agents,
   Autotest -> PR), a **Total Score** row, a **Maturity Band** line, and the
   band legend.
3. Section 2 must be "Executive Summary" containing
   "Total Score: [total]/100 ([band])".
4. Section 3 must be "Harness Piece Detail" with one entry per rubric piece,
   each carrying Piece, Status (Present/Weak/Missing), Score `[awarded]/[max]`,
   Evidence, Why it matters, and Recommendation.
5. Section 4 must be "Top 3 Highest-Impact Next Steps" with exactly three
   ranked items, each naming an exact file to create or edit and the points it
   recovers.
6. Sections 5 (Maturity Band Reading), 6 (Harness Detection Results) and 7
   (Scan Metadata) must be present.
7. The Total in Section 1 must match the Total in Section 2, Section 5 and the
   JSON export.

If ANY check fails, output:
  VALIDATION FAILED: [which check failed]
  The report generator must be re-run to include all mandatory sections and
  scores before formatting can proceed.

Only proceed with formatting if ALL structural checks pass.

FORMATTING RULES TO ENFORCE:
- USE MARKDOWN SYNTAX: `#` headings, `**bold**`, `code`, tables, links.
- SECTION HEADERS: "## N. Section Name" (number + period).
- SCORE FORMAT: per piece `[awarded]/[max]`; total `[total]/100`.
- STATUS: every piece is exactly one of Present / Weak / Missing.
- BAND-RANGE CHECK: No harness (0-30), Basic harness (31-60), Solid harness
  (61-85), Paved path (86-100). Verify the band label matches the total.
- POINT ARITHMETIC: the per-piece scores in Section 1 must sum to the Total,
  and no piece may exceed its maximum (CLAUDE.md 20, Rules 10, Permissions 15,
  Commands / Skills 15, Hooks 20, Agents 10, Autotest -> PR 10).
- ORDERING: Section 3 entries are ordered by points recoverable descending
  (biggest gaps first).
- EVIDENCE DISCIPLINE: every Present piece cites a real path/line count from
  the inventory artifact; every Weak/Missing piece names the file that would
  fix it. No score is awarded without evidence.
- NO UNICODE ARTIFACTS that break rendering; keep tables well-formed.
- BLANK LINES: one blank line between sections; no triple+ blank lines.

SECRET REDACTION CHECK (mandatory):
- The inventory reads settings files that may quote secret values. Scan the
  report for anything resembling a live secret: AWS access keys (AKIA...),
  private-key headers (-----BEGIN ... KEY-----), bearer tokens,
  `sk_live_`/`sk_test_`, connection strings with embedded passwords.
- If any is present, REDACT it in place (keep the location, replace the value
  with "[REDACTED]"). The report must never contain a live secret value.

EXCLUSION / LEAK DETECTION:
- Remove any generator-instruction text that leaked into the output (e.g.
  "MANDATORY REPORT STRUCTURE", "VALIDATION CHECKLIST", rubric point values
  that are not tied to an actual evidence line).
- Remove any fabricated company/client/product/ticket names; the report must
  stay generic and evidence-bound.

VALIDATION CHECKLIST:
- All 7 sections present, in order
- Section 1: one row per harness piece + Total + Maturity Band + band legend
- Section 2 states "Total Score: [total]/100 ([band])"
- Section 3 covers every piece, ordered by points recoverable descending
- Section 4 lists exactly three next steps, each naming an exact file
- Sections 5, 6 and 7 present
- Per-piece scores sum to the Total; no piece over its maximum
- Band label matches the total's range
- No secret values (all redacted)
- No leaked generator instructions or fabricated identifiers
- Report starts with the "# AI Harness Audit Report" title
- Report ends with "7. Scan Metadata" followed by the metadata block

If formatting issues are found, fix them in-place and note what was corrected.

Output: The formatted Markdown report content ready for export to
./reports/harness_audit.md

JSON EXPORT (mandatory):
After validating and exporting the text report to reports/harness_audit.md,
ensure reports/harness_audit.json exists and is well-formed with the schema
defined in references/report-generator.md. If the generator did not produce it,
extract the per-piece scores, band and top-3 next steps from the validated
report and write it. Ensure the reports/ directory exists.

SCORE HISTORY (mandatory after export):
After validating and exporting both reports/harness_audit.md and
reports/harness_audit.json, write reports/.history/last_scores.json with the
same total, band and per-piece data for future comparison (schema in
report-generator.md).
Run: mkdir -p reports/.history

## Harness Audit Report Generator

> Synthesize the inventory and scoring artifacts into a comprehensive AI Harness

**File pattern**: `*`

Goal: Generate the final AI Harness Audit report by integrating the inventory
and scoring results using the standardized format in `assets/report-template.md`.

READ-ONLY DISCIPLINE:
- Do NOT re-scan or modify the audited repository. Operate on artifact files.
  Your only writes are `reports/harness_audit.md`, `reports/harness_audit.json`,
  and `reports/.history/last_scores.json`.

STEP ARTIFACT INTEGRATION:
Read both artifacts for this run under `reports/.artifacts/`:
- `step_01_harness_inventory.md` - per-piece evidence, paths, line counts,
  frontmatter, CLAUDE.md size, monorepo notes.
- `step_02_harness_scoring.md` - per-piece status and points, total, band,
  top-3 next steps.

If `step_02_harness_scoring.md` is absent, you cannot produce a valid report:
re-run the scoring step first. If `step_01_harness_inventory.md` is absent, note
it and score every piece as Missing (0) with the band "No harness".

MANDATORY REPORT STRUCTURE (7 sections):
1. Harness Scoring Breakdown (per-piece table + Total + Maturity Band)
2. Executive Summary (Total Score + band reading + the 3 top next steps in brief)
3. Harness Piece Detail (one entry per piece, ordered by points recoverable
   descending - biggest gaps first)
4. Top 3 Highest-Impact Next Steps
5. Maturity Band Reading
6. Harness Detection Results (what was located and where)
7. Scan Metadata

## SCORING SYSTEM (reproduce exactly from references/harness-scoring.md)

7 pieces, 100 points total (Piece 2 is a conditional +10 on Piece 1):

- CLAUDE.md exists - 10
- CLAUDE.md is real (<200 lines + real commands + conventions) - +10
- Rules (>=1 rule with a stack-relevant `paths:`) - 10
- Permissions (project settings.json with a `deny` of secrets) - 15
- Commands / Skills (>=1 invocable team procedure) - 15
- Hooks (lint/format/test wired in PostToolUse or Stop) - 20
- Agents (>=1 custom role, e.g. reviewer/qa) - 10
- Autotest -> PR (agent reaches a green PR on its own, full lifecycle) - 10

Total = round of the raw sum (already 0-100; no re-weighting).

Maturity Band mapping:
- 0-30 = No harness (the model improvises)
- 31-60 = Basic harness (context yes, enforcement no)
- 61-85 = Solid harness (context + enforcement, with gaps)
- 86-100 = Paved path (the quality path is the easy path)

## SECTION FORMAT REQUIREMENTS

### Section 1 - Harness Scoring Breakdown

Render the per-piece score table exactly, one row per piece:
- Columns: Harness Piece | Status | Score
- Status is one of: Present / Weak / Missing (from step_02).
- One row per piece using its awarded/max (e.g. `Hooks | Missing | 0/20`).
- Followed by a **Total Score: [total]/100** line.
- Followed by a **Maturity Band: [band name]** line.
- Include the band legend: No harness (0-30) - Basic (31-60) - Solid (61-85) -
  Paved path (86-100).
- This is THE FIRST THING a reader sees - it must be complete and self-contained.

### Section 2 - Executive Summary

- Must include `Total Score: [total]/100 ([band name])`.
- One-paragraph reading of what the score means for this project.
- A brief list of the 3 top next steps (full detail goes in Section 4).
- If `reports/.history/last_scores.json` exists, read it and add
  `Previous: [N]/100, Change: [+/-M] ([improving|declining|unchanged])`.

### Section 3 - Harness Piece Detail

One entry per piece (all 8 rubric entries; combine Piece 1+2 CLAUDE.md into a
single "CLAUDE.md" entry that shows both the existence and quality sub-scores).
Order the entries by **points recoverable descending** (Missing/Weak pieces with
the most points first) so the biggest gaps lead. Each entry includes:
- **Piece**: name and max points
- **Status**: Present / Weak / Missing
- **Score**: `[awarded]/[max]`
- **Evidence**: exact file paths, line counts, frontmatter values, or command
  excerpts from the inventory artifact (or "Not found - [what would prove it]")
- **Why it matters**: one line on the enforcement/context value of this piece
- **Recommendation**: the concrete change if Weak/Missing (name the file), or
  "No action - criterion met" if Present

### Section 4 - Top 3 Highest-Impact Next Steps

Reproduce the ranked top-3 from step_02. For each:
1. The action (name the exact file to create or edit and the concrete change).
2. Points recovered.
3. Why it is high impact (prefer steps that convert context-only into enforced:
   Permissions, Hooks, Autotest->PR).

### Section 5 - Maturity Band Reading

- State the band and give a 2-4 sentence reading: what this level of harness
  means in practice, and what crossing into the next band would require.

### Section 6 - Harness Detection Results

- Repository structure (single app / monorepo / multi-package).
- Which of the 7 pieces were located and their paths.
- Primary CLAUDE.md path and line count.
- Any sibling-tool harness noted (e.g. `.cursor/`).

### Section 7 - Scan Metadata

- Scan date, project path, total pieces present, total score, band, generated-by
  line, skill name, and the Somnio AI Tools URL.

## FORMATTING RULES

- Follow `assets/report-template.md` structure exactly.
- Use Markdown: `#` headers, tables for the scoring breakdown and metadata,
  `- ` bullets, `1.` numbered lists, and `backtick` file paths.
- Every awarded/withheld point must reference actual repository evidence from the
  inventory artifact.
- Report starts with the `# AI Harness Audit Report` title and nothing before it.

## VALIDATION CHECKLIST

Before finalizing, verify:
- All 7 sections are present and in order.
- Section 1 has one table row per harness piece + Total + Maturity Band + legend.
- The Total in Section 1 matches the Total in Section 2 and the JSON export.
- The Maturity Band matches the Total Score range.
- Section 3 orders pieces by points recoverable descending.
- Section 4 lists exactly the top-3 next steps, each naming an exact file.
- Every Present piece cites evidence; every Missing/Weak piece names the fix.
- The metadata block from SKILL.md is appended at the very end.

## JSON EXPORT (mandatory)

After writing the report, write `reports/harness_audit.json`:

    {
      "totalScore": [integer 0-100],
      "band": "[No harness|Basic harness|Solid harness|Paved path]",
      "pieces": {
        "claudeMdExists": [0-10],
        "claudeMdReal": [0-10],
        "rules": [0-10],
        "permissions": [0-15],
        "commandsSkills": [0-15],
        "hooks": [0-20],
        "agents": [0-10],
        "autotestToPr": [0-10]
      },
      "topNextSteps": ["[step 1]", "[step 2]", "[step 3]"],
      "timestamp": "[ISO8601 datetime]",
      "projectPath": "[audited path]"
    }

Run before saving: `mkdir -p reports`

## SCORE HISTORY (mandatory, after report + JSON)

Write `reports/.history/last_scores.json`:

    { "overall": [total], "timestamp": "[ISO8601]",
      "pieces": { "claudeMdExists": N, "claudeMdReal": N, "rules": N,
        "permissions": N, "commandsSkills": N, "hooks": N, "agents": N,
        "autotestToPr": N },
      "band": "[band name]" }

Run: `mkdir -p reports/.history`

