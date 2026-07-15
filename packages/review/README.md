# @terragon/review

The **Verified pillar** — orch-agents' review pipeline is the platform's moat
(the terragon-oss chassis shipped zero verification). This package mounts the
**pure review kernel + SQLite state layer** ported from orch-agents; the
pipeline/executors (event bus, github-client, Claude Agent SDK reviewer) wire up
in the Hatchet / GitHub-App phase. See `PORT-MAP.md` for the full ported/deferred
map and the phase-2 integration work list.

## What's here

- **severity-policy** — verdict/severity decision + tolerance→policy mapping.
- **diff-review-parser** — parses the reviewer's structured diff-review output.
- **state/break-glass-matcher** (+ types) — break-glass comment matching.
- **audit/review-audit-log** — append-only, non-blocking review-state store:
  submission, work-blocked, and inline-resolution events (SQLite).
- **settings/** — per-repo review tolerance store + change audit + approve-floor
  resolver (SQLite).

All logic is pure or SQLite-backed; nothing here depends on GitHub, the event
bus, or the SDK executor.

## Tests

Ported **unmodified** from orch-agents — they are the ~164-case guarantee we're
importing. They use **`node:test` + `node:assert`** (NOT vitest — do not convert
them) and run via `tsx`:

```bash
pnpm --filter @terragon/review test        # node --import tsx --test 'tests/**/*.test.ts'
pnpm --filter @terragon/review tsc-check    # tsc --noEmit
```

## Runtime constraints

- **Node ≥ 22** — the SQLite state stores use `node:sqlite` (`DatabaseSync`).
- Env vars are unchanged from orch-agents: `REVIEW_STATE_DB_PATH`,
  the per-repo settings + audit DB paths, etc. All persistent state defaults
  under `data/`.
- `tsconfig.json` disables `noUncheckedIndexedAccess` (orch-agents compiles this
  code under `strict` without it) so the ported code + tests build unmodified.
