# #634 S1+S2 gate log

Branch `feat/634-cell-contract`, gates run on the code at `3506a538` (2026-11-16), from the worktree root.

| #   | Command                                                                             | Exit | Observed                                                                                          |
| --- | ----------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------- |
| 0   | `pnpm exec prettier --no-editorconfig --config .prettierrc --check docs/specs/634/` | 0    | all files formatted                                                                               |
| 1   | `pnpm --filter @terragon/docs exec fumadocs-mdx`                                    | 0    | types generated                                                                                   |
| 2   | `pnpm turbo tsc-check`                                                              | 0    | 21/21 tasks                                                                                       |
| 3   | `pnpm turbo lint`                                                                   | 0    | 2/2 tasks (`@terragon/shared`, `@terragon/types` and `@terragon/sandbox` define no `lint` script) |
| 4   | every package's `format-check` with `--no-editorconfig`                             | 0    | no failures                                                                                       |
| 5   | `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism`              | 0    | 94 files, 1596 tests                                                                              |
| 6   | `pnpm --filter @terragon/sandbox exec vitest run --no-file-parallelism`             | 0    | 16 files passed, 5 skipped; 444 passed, 135 skipped; `opensandbox-cell.test.ts` 148               |

Notes:

- Gate 4 stands in for `pnpm turbo format-check`, which a home-directory `.editorconfig` (`indent_style = tab`) overrides on the machine that ran it; CI has no such file.
- Gate 6 needs `@terragon/bundled` and `@terragon/sandbox-image` built in a fresh worktree (`pnpm turbo run build --filter=@terragon/bundled --filter=@terragon/sandbox-image`). The 135 skipped tests are the existing environment-gated integration suites (four `*.integration.test.ts` files and `sandbox-image.test.ts`); none touch this change.
- Coverage: no coverage gate is recorded for this repo yet (#605).

## Acceptance evidence

- **AC-1**: `packages/shared/src/model/cell-create-plan-compose.test.ts` (a refused profile makes zero fetch calls; the `POST /sandboxes` body's `networkPolicy` deep-equals the rendered policy), `packages/shared/src/model/cell-create-plan.test.ts` (S1-a, S1-c), gates 5 and 6.
- **AC-2**: `packages/sandbox/src/providers/opensandbox-cell.test.ts` › "create guards (AC-2)" (no policy, non-deny default, non-runc runtime, wrong provider, TTL under 60 s, invalid identity tags or resources: zero fetch calls), `cell-create-plan.test.ts` S1-b, gate 6.
- **AC-4** (simulated, as the criterion states): `opensandbox-cell.test.ts` › "self-check fails closed (AC-4)" (only exit 3 passes; exit 0, other codes, an error event without an exit code, a 5xx, a truncated or over-cap stream all quarantine and delete the cell, never write the vault, and fail with `egress_not_enforced`), gate 6.

## Review history

roborev jobs 1159-1168 on this branch; every finding of Medium or higher was fixed (commits `c62304f2` … `3506a538`). Job 1168 passed with four Low findings, listed as follow-ups in the PR.
