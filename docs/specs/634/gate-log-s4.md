# #634 S4 gate log

Branch `feat/634-s4-control-plane`, off `main` at `222d480d`. Run on 2026-11-17 on macOS arm64 with Docker 29.8.2.

## Gates (worktree root)

| Gate            | Command                                                                                                                                                                 | Exit                    | Result                                                                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| install / build | `pnpm install --frozen-lockfile --prefer-offline`; `pnpm turbo run build --filter=@terragon/sandbox... --filter=@terragon/bundled --filter=@terragon/sandbox-image`     | 0 / 0                   |                                                                                                                                                                                                 |
| docs codegen    | `pnpm --filter @terragon/docs exec fumadocs-mdx`                                                                                                                        | 0                       | Required before a forced `tsc-check` (CLAUDE.md verification)                                                                                                                                   |
| typecheck       | `pnpm turbo tsc-check --force`                                                                                                                                          | 0                       | 21/21 tasks                                                                                                                                                                                     |
| lint            | `pnpm turbo lint --force`                                                                                                                                               | 0                       |                                                                                                                                                                                                 |
| format          | `pnpm exec prettier --no-editorconfig --config .prettierrc --check <changed files>`                                                                                     | 0 on every file checked | Its exit was 1 only because the list still named the deleted `evidence.test.ts` (the file was moved to `src/cell/`). A home `~/.editorconfig` breaks `pnpm turbo format-check` on this machine. |
| migrations      | `node deploy/lint-migrations.ts`                                                                                                                                        | 0                       |                                                                                                                                                                                                 |
| sandbox         | `pnpm --filter @terragon/sandbox exec vitest run --no-file-parallelism`                                                                                                 | 0                       | 473 passed, 144 skipped (the opt-in suites)                                                                                                                                                     |
| shared          | `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism`                                                                                                  | 0                       | 1600                                                                                                                                                                                            |
| migrate         | `pnpm --filter @terragon/migrate exec vitest run`                                                                                                                       | 0                       | 45                                                                                                                                                                                              |
| worker          | `pnpm --filter @terragon/worker exec vitest run --no-file-parallelism`                                                                                                  | 0                       | 1886 passed, 42 skipped                                                                                                                                                                         |
| www             | `pnpm --filter @terragon/www exec vitest run --no-file-parallelism`                                                                                                     | 0                       | 4456 passed, 9 skipped                                                                                                                                                                          |
| **IT**          | `OPENSANDBOX_IT=1 pnpm --filter @terragon/sandbox exec vitest run --no-file-parallelism src/providers/opensandbox-cell.integration.test.ts`, outside the Claude sandbox | 0                       | 9/9 in 218 s, AC-7 included. `osbit-dind` was removed afterwards, and no canary appears in the log.                                                                                             |

## AC-7, live

The scenario runs after AC-5 and before AC-8:

1. A cleanup pass runs first and reaps nothing (`listed 0, expired 0`).
2. Cell X is created with `expiresAt` already in the past, and cell Y expires 10 minutes out.
3. `docker restart osb-server` runs inside dind, then the test waits for `/health`.
4. `reconcileExpiredCells` runs with the real adapter and a revoke that records its calls. No worker process is running: the test process is not one.

Results:

- X's revoke came before X's teardown.
- X is gone: `delete` returns `gone` and `listByTags` returns nothing.
- Y is still listed.
- `failed` is 0.

**OpenSandbox 1.2.1 keeps its sandboxes, and their sidecars stay reachable, across a server restart.** Nothing in the repo had shown this before.

## Evidence push

The test pushed the IT's own file to a local capture server; the full www dev stack needs env files that are not read here:

- `push-evidence.sh` refuses a `-dirty` platformSha.
- On a clean sha it posts to `/api/internal/profile-evidence/opensandbox`. The secret travels as a header read from stdin. The body has exactly `measuredAt`, `platformSha`, `artifactDigest` and `checks`, with all seven groups.

The route's own tests cover how the database side judges a report.

## Reviews before roborev

- **Validate:** PASS_WITH_WARNINGS. 14 binding adjustments were folded into `spec-s4.md`.
- **Refinement:** found 2 Medium and 10 Low. All were fixed except two, which move to S5:
  - a per-deployment cell tag;
  - the adapter refusing an empty guest image.
- **`/simplify`:** 10 items applied:
  - a dependency-light `cell-gate.ts` shared by dispatch and the routes;
  - the allowlist taken from the platform egress bundle;
  - Claude OAuth extraction moved next to the credential code;
  - the evidence builder moved to `src/cell/conformance-evidence.ts`;
  - parallel reads in `cell-plan`;
  - reconcile tags parsed once, and the per-run limit set to 20;
  - `try`/`finally` teardown;
  - a flat `*/10` chain;
  - one `forbid()` helper;
  - shared test fixtures, and a derived migration count.
- **Skipped, now follow-ups:**
  - a shared bounded-JSON helper and a parameterized measured-at window (both would change the box and addon-callback routes);
  - a page cap on the reconciler's listing (it needs an adapter change: S5);
  - `no-store` on the shared auth refusals (it would change `agent-credentials` responses).

## Roborev

- **Job on `786e27ac`:** Pass, with one Medium and two Lows.
  - **Medium, fixed: reconciler starvation.** Expired cells whose teardown keeps failing could fill the per-run limit forever. Expired cells are now shuffled every run (Fisher–Yates, injected `random`). A test shows a healthy expired cell queued behind 20 that always fail is reaped within 10 runs.
  - **Low #2, fixed: a regression from `/simplify`.** `getClaudeOauthAccessToken` throws when the lookup itself fails, so the route answers 5xx, not 422 `no_model_credential`. It returns null only when there is no OAuth credential.
  - **Low #3, follow-up:** run the profile and egress refusals before the credential lookup, which can refresh the token.
- **After the fixes, all exit 0:** live IT 9/9, sandbox 475 passed, www full suite, `tsc-check`, lint.
- **Job 1179 on `8930365d`:** Pass, with one Medium, fixed. On workerd the global `fetch` throws "Illegal invocation" when it is called with `this` bound to anything but the global scope, and the adapter called it as `deps.fetch(...)`. Once enabled, the www reconciler would have failed on every tick, and `runCellReconcilerSafe` would have swallowed the error. Node, the unit tests and the IT never enforce this rule.
  - **Fix:** the adapter detaches `deps.fetch` once, so no caller can hit this, and www passes an arrow function.
  - **Test:** a fetch that refuses any bound `this`, as workerd's does. Negative control: the test fails against the old call and passes with the fix.
  - **Re-run, all exit 0:** `tsc`, lint, sandbox 476 passed, www cell-control and cron 32 passed, live IT 9/9.
