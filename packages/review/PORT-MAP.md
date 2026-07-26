# PORT-MAP — review kernel mount (step 1)

Source: `orch-agents/src/review/` (+ `src/audit/`, `src/settings/`, `src/shared/`).
orch-agents is **READ-ONLY** — it serves two production orgs. This package mounts
only the **pure kernel + SQLite state layer**; the pipeline/executors (event bus,
github-client, SDK reviewer) integrate in the Hatchet / GitHub-App phase.

Layout is mirrored (`src/review/`, `src/audit/`, `src/settings/`, `src/shared/`)
so the ported modules' internal relative imports resolve **unchanged**. Tests are
mirrored under `tests/` at the same depth so their `../../src/...` imports also
resolve unchanged. The only source adaptations were the two external type reaches
(see "Adaptations").

## Ported (13 modules + local types) — all with their tests, 164 cases green

| Source file                                  | Ported to                                    | Notes                                                                                                                                             |
| -------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/review/severity-policy.ts`              | `src/review/severity-policy.ts`              | Verdict/severity decision + tolerance→policy. The "verdict-decision" logic lives here.                                                            |
| `src/review/diff-review-parser.ts`           | `src/review/diff-review-parser.ts`           | Pure parser (node:crypto only).                                                                                                                   |
| `src/review/state/types.ts`                  | `src/review/state/types.ts`                  | Break-glass / review-state types.                                                                                                                 |
| `src/review/state/break-glass-matcher.ts`    | `src/review/state/break-glass-matcher.ts`    | Pure matcher (+ property test).                                                                                                                   |
| `src/shared/sqlite.ts`                       | `src/shared/sqlite.ts`                       | `openDatabase` (node:sqlite) — the SQLite state seam.                                                                                             |
| `src/audit/review-audit-log.ts`              | `src/audit/review-audit-log.ts`              | The review-state store: submission + work-blocked + inline-resolution audit events (append-only, non-blocking).                                   |
| `src/audit/redact-secrets.ts`                | `src/audit/redact-secrets.ts`                | Helper for the audit log.                                                                                                                         |
| `src/audit/audit-writer-queue.ts`            | `src/audit/audit-writer-queue.ts`            | Async write queue for the audit log.                                                                                                              |
| `src/settings/types.ts`                      | `src/settings/types.ts`                      | Per-repo review-tolerance types.                                                                                                                  |
| `src/settings/repo-review-settings-store.ts` | `src/settings/repo-review-settings-store.ts` | Per-repo review tolerance SQLite store (`feat/repo-review-tolerance`).                                                                            |
| `src/settings/repo-review-settings-audit.ts` | `src/settings/repo-review-settings-audit.ts` | Settings-change audit log (SQLite).                                                                                                               |
| `src/settings/review-floor-resolver.ts`      | `src/settings/review-floor-resolver.ts`      | Resolves the per-repo approve-severity floor.                                                                                                     |
| `src/types.ts` (global, 481 lines)           | `src/types.ts` (NEW, minimal)                | Only `Finding` is reached by the ported set; copied verbatim rather than dragging the global types file (which pulls webhook/intake/kernel deps). |

Tests ported (unmodified): `severity-policy`, `diff-review-parser`,
`state/break-glass-matcher` (+ `.property`), `audit/review-audit-log` (base +
`.append-only` + `.work-blocked` + `-nonblocking`), `settings/repo-review-settings-store`,
`settings/repo-review-settings-audit`, `settings/review-floor-resolver`.

## Phase-2 ported (single-writer effect channel, ADR-036) — pure core

The single-writer review executor + its two GitHub-state finders, ported as PURE
logic (dependency-injected on a narrow `ReviewGitHubClient`; www implements it via
octokit). The only source adaptation: `botLogin` is a REQUIRED param (the
orch-agents originals defaulted it via `kernel/agent-identity` — an env/identity
dependency the pure package must not carry; the www caller passes the resolved bot
login, as `reconcile-pr-reviews.ts` already does).

| Source file                                       | Ported to                                        | Notes                                                                                           |
| ------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `src/integration/github-client.ts` (subset)       | `src/review/state/review-github-client.ts` (NEW) | Minimal `ReviewGitHubClient` (5 methods) + `GitHubReview` + `ReviewLogger` + `getErrorMessage`. |
| `src/review/state/head-review-guard.ts`           | `src/review/state/head-review-guard.ts`          | `findBotReviewAtHead`; `botLogin` now required.                                                 |
| `src/review/state/outstanding-review-finder.ts`   | `src/review/state/outstanding-review-finder.ts`  | `find(All)OutstandingBotChangesRequested`; `botLogin` now required.                             |
| `src/execution/effects/review-intent-executor.ts` | `src/review/state/review-intent-executor.ts`     | `executeReviewIntent` + `dismissOutstandingBotChangeRequests`; DI on `ReviewGitHubClient`.      |

Tests ported (adapted for required `botLogin` + explicit `commitId` on fixtures):
`state/head-review-guard`, `state/outstanding-review-finder`,
`state/review-intent-executor`. Verified: 203/203 `node:test` pass, `tsc-check` clean.
The www octokit adapter + the thread-finish/sweep wiring + the emit-only skill +
tool-policy live in apps/www (control-plane I/O), not here.

## Deferred (phase-2 integration work list) — need executor / GitHub / event-bus / SDK wiring

| Source file                          | Why deferred                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/review/review-gate.ts`          | Pipeline orchestrator; depends on `shared/logger`, `shared/errors`, executor interfaces (DiffReviewer/TestRunner/SecurityScanner).                |
| `src/review/review-pipeline.ts`      | Pipeline; event-bus + executors.                                                                                                                  |
| `src/review/claude-diff-reviewer.ts` | Claude Agent SDK executor.                                                                                                                        |
| `src/review/finding-verifier.ts`     | verify-before-block; needs GitHub quote-at-HEAD.                                                                                                  |
| `src/review/break-glass-handler.ts`  | Handler; event-bus + GitHub.                                                                                                                      |
| `src/review/cli-test-runner.ts`      | Runs the target repo's test suite (child process).                                                                                                |
| `src/review/package-manager.ts`      | Target-repo PM detection; intentionally multi-PM (orch-agents CLAUDE.md keeps it out of scope).                                                   |
| `src/review/diff-review-prompts.ts`  | Pure-ish, but imports `ReviewContext` (a pipeline type) from `review-gate`; belongs with the reviewer executor.                                   |
| `src/review/types.ts` (review-local) | `ReviewOutcome`/`ReviewVerdict`; only consumed by deferred pipeline modules + their tests; imports `WorkBlockedReason` from `kernel/event-types`. |

(`state/head-review-guard.ts` + `state/outstanding-review-finder.ts` are no longer deferred — ported in the "Phase-2 ported" section above.)

Deferred tests (move with their modules): `review-gate`, `review-pipeline.*`,
`claude-diff-reviewer`, `finding-verifier`, `break-glass-handler.*`,
`cli-test-runner`, `package-manager`, `diff-review-prompts`,
`state/head-review-guard`, `state/outstanding-review-finder`, `state/state-paths`
(the last is a repo-tree `*.db`-location assertion, not a unit test).

## Named-but-absent modules (from the mount brief)

`finding-fingerprint`, `verdict-decision`, `review-body-composer`, and
`lifecycle-resolver` do **not** exist as separate files in this orch-agents
version. Their concepts are embedded: verdict/severity decision → `severity-policy`;
finding shape → `Finding` in `types`; the review-state store + submission/inline
logs → `audit/review-audit-log`. `src/execution/workspace/lifecycle-resolver.ts`
exists but is a **worktree** lifecycle (execution concern), not review — out of scope.

## Adaptations (only what mounting required)

1. `src/types.ts` — created minimal (just `Finding`) instead of importing the
   481-line global types file. Keep in sync with orch-agents `Finding`.
2. `tsconfig.json` sets `noUncheckedIndexedAccess: false`. orch-agents compiles the
   review code under `strict` WITHOUT that flag; the chassis base tsconfig enables
   it. Leaving it on would require editing proven code + tests, violating the
   "port unmodified" guarantee. All other base strictness (incl. `strict`,
   `noUnusedLocals`) is kept.
3. Import paths, env var names (`REVIEW_STATE_DB_PATH`, etc.), and logger
   interfaces: **unchanged** — the ported set has no logger dependency, and its
   internal relative imports resolve via the mirrored layout.

## Verification

- `pnpm --filter @terragon/review test` → `node --import tsx --test` → **164/164 pass**.
- `pnpm --filter @terragon/review tsc-check` → clean.
