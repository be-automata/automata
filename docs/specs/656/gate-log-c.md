# #656 PR-C gate log

Branch `feat/656-c-cell-plan`, off `main` at `08c1b194`. Spec: `docs/specs/656/spec-c.md`.

## Live gate (AC-12 client half, idempotent teardown): NOT RUN YET

The new scenario sits next to AC-8's negative control in
`packages/sandbox/src/providers/opensandbox-cell.integration.test.ts`: `provider.teardown(id)` on
the no-policy control must resolve (revoke and quarantine 502, delete, then `GET` 404), and a
second `teardown` must resolve with no `GET`. It needs Docker and the public internet, so it runs
outside the Claude sandbox:

```
OPENSANDBOX_IT=1 pnpm --filter @terragon/sandbox exec vitest run --no-file-parallelism src/providers/opensandbox-cell.integration.test.ts
```

Record here, from `NOTES` in the evidence JSON:

- `no_policy_teardown_ms` (expected about 2 x the 10 s retry budget);
- `no_policy_second_teardown_ms` (expected near 0);
- the real body shape of the upstream `GET /sandboxes/{id}` 404 (the adapter accepts a top-level
  or `detail` `code` ending in `::SANDBOX_NOT_FOUND`), and whether a deleted cell ever answers
  `GET` 200 inside the budget (delete may be asynchronous).

Results: pending.

## Implementation gates (outside the Claude sandbox, 2026-11-17)

| gate                                                                  |      exit       | result                                          |
| :-------------------------------------------------------------------- | :-------------: | :---------------------------------------------- |
| `tsc --noEmit` (types, sandbox, shared, www, env)                     |        0        |                                                 |
| `node deploy/lint-migrations.ts`                                      |        0        |                                                 |
| `fumadocs-mdx`, then `turbo tsc-check --force`                        |        0        | 21 tasks                                        |
| `turbo lint --force`                                                  |        0        |                                                 |
| migrate vitest                                                        |        0        | 45 passed                                       |
| sandbox vitest                                                        |        0        | 588 passed, 145 skipped                         |
| shared vitest                                                         |        0        | 1732 passed                                     |
| www vitest                                                            | 0 after the fix | 4498 passed, 9 skipped                          |
| `OPENSANDBOX_IT=1` live suite (OpenSandbox 1.2.1 in a throwaway dind) |        0        | 10/10, 284 s; runc conformance evidence written |

**The www fix:** `cell-plan/route.test.ts` still listed the vault names as `broker` and `model`. The new daemon entry made that list stale. The same test already checks the daemon entry itself.
