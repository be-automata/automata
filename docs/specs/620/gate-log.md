# #620 gate log

Every command was run from the worktree root on 2026-11-15. The worker suites ran unsandboxed, because the brokers bind 127.0.0.1. Every command below exited 0.

## Final gates (at f543e908)

| Command                                                                                                                                  | Exit | Result                             |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------- |
| `pnpm turbo tsc-check --force`                                                                                                           | 0    |                                    |
| `pnpm turbo lint --force`                                                                                                                | 0    |                                    |
| `pnpm exec prettier --no-editorconfig --config .prettierrc --check <changed files>`                                                      | 0    |                                    |
| `pnpm --filter @terragon/utils exec vitest run --no-file-parallelism src/receive-pack-refs.test.ts`                                      | 0    | 38 tests                           |
| `pnpm --filter @terragon/worker exec vitest run --no-file-parallelism --reporter=verbose`, over the six files named in the spec          | 0    | 6 files, 292/292 passed, 0 skipped |
| RF-1 grep (`includes("..")`, `endsWith(".lock")`, `startsWith("refs/heads/")` in `workflow.ts` and `git-broker.ts`)                      | n/a  | 0 hits                             |
| `git diff --stat origin/main` over `packages/worker/deploy`, `abnormal-end.ts`, `knowledge/mirror.ts` and `self-heal-acceptance.test.ts` | n/a  | empty (AC6, AC7)                   |

## Skip evidence (RF-3)

The verbose run reports 292 passed, with no test skipped. It includes:

- the FENCE-01 real-push cases (`skipIf(!hasGit)`);
- the `skipIf(!hasGh)` blocks;
- `broker-integration.test.ts`;
- `self-heal-acceptance.test.ts`.

## Mutation checks

- **AC4, "refuses before listening":** the `Server.prototype.listen` spy fires on a valid boot. I checked this in a temporary edit and then reverted it. So the assertion that `listen` is never called on a refusal is meaningful.

## Review passes

- **Validate:** PASS_WITH_WARNINGS. A fuzz of 2,000,000 samples found 0 differences between the old rule and the new one. Fixes RF-1 to RF-4 are folded into the spec.
- **Refinement:** the AC4 test now pins the full error message, including `got:`.
- **`/simplify`:**
  - the sweep that duplicated the name table was dropped;
  - the two drift tests share one `readSource` helper and match the template fragment;
  - the comment on the suffix rule was corrected.
- **roborev, three rounds:**
  - Round 1, two low findings: the "before listening" claim was unproven, and the spec still described the sweep.
  - Round 2, one low finding: the spy was restored without `finally`.
  - Round 3: pass, no issues.
