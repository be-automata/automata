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

## Refinement

There were no High findings: 3 Medium and 4 Low.

**Fixed:**

- **M1:** One live bearer per attempt is now atomic. The mint replaces the attempt's other bearers in one transaction, under the open's lock.
- **M2:** A half-set Access config turns cells off everywhere (`opensandboxConfigured`).
- **M3:** A teardown 404 counts as done only with a `SANDBOX_NOT_FOUND` body. A bare 404 falls through to the `exists` check.
- **L4:** A transient error in the `exists` poll is retried within the remaining budget.
- **L5:** `openStep` now has a doc note that it is test-only and does not clear `open_nonce`.
- **L6:** A refused origin raises a distinct `origin_refused` code, which is not retried.

**Skipped:** L7. When the branch and the base branch are both empty, dispatch now returns `undefined` instead of the task branch. That is cosmetic.

**Gates after the fixes** (outside the Claude sandbox), all exit 0:

- sandbox: 590 passed;
- shared: 1734 passed;
- www: 4500 passed;
- the live `OPENSANDBOX_IT` suite: 10/10;
- tsc, `tsc-check --force`, `lint --force`, `lint-migrations`.

## `/simplify`

**Applied:**

- The adapter imports `isCellLabelValue`; its copied label pattern and the test that kept the two copies equal are gone.
- `mintBearer` uses `SelfHealTx`.
- The dead `revokeAttemptBearers` is removed.
- `exists` goes through `send404AsDone`.
- `openNextAttempt`'s nonce is required: its only production caller always sends one, so the no-nonce SQL path is gone.
- A redundant `IS NOT NULL` is dropped.
- One `resolveOpenSandboxEnv()` reads the OpenSandbox and Access env once.

**Skipped:**

- `.for("update")` stays. It is redundant under the advisory lock, but costs nothing and is a second guard.
- The OAuth lookup stays outside `Promise.all`, because it may refresh a token.
- `replayed` stays, because the replay tests read it.

**Race-test probe:** with the nonce required, an open blocks on its `SELECT … FOR UPDATE` before it reaches the upsert. `waitUntilBlocked` now matches any `cell_step` statement waiting on a lock. Its deadline is 3 s, below vitest's 5 s test timeout, which also closes PR-A's roborev 1235 follow-up about this helper hanging.

**Gates after the pass** (outside the Claude sandbox), all exit 0:

- sandbox: 589 passed;
- www: 4500 passed;
- shared: 1732 passed plus 6a, which failed on the stale probe; after the fix, `cell-authority` passed 59/59 three runs in a row;
- the live `OPENSANDBOX_IT` suite: 10/10;
- tsc, `tsc-check --force`, `lint --force`.

## Roborev job 1253 (08c1b19..b0eddd5)

Verdict: **Pass**, one Medium, no High, no Low (the log lists no other finding, so there are no new follow-ups from it).

**Medium (fixed):** with `replaceOthers`, a slow request R1 that finishes after its retry R2 (same `requestId`) replays the open and deletes B2, the bearer the worker received, so every broker call from that cell is refused. **Fix: an open sequence fence.** `cell_step.open_seq` (same unapplied migration, `NOT NULL DEFAULT 0`) is incremented by every `openNextAttempt` under the step lock and returned as `openSeq`. `mintBearer({ replaceOthers: { openSeq } })` refuses with `superseded` (no delete, no insert) once a newer open exists. `cell-plan` answers `409 superseded` for it. DB tests cover the reviewer's scenario, the in-order replay and a non-replay advance.

**Gates after the fence**, outside the Claude sandbox, all exit 0:

- migrate: 45
- shared: 1736
- www: 4500
- lint-migrations, tsc, `tsc-check --force`, `lint --force`

The adapter is unchanged, so the live suite from the `/simplify` run (10/10) still stands.

## Roborev job 1254 (final range `08c1b19..18ef348`)

**Pass**, with one Low: a test title said 409 for `invalid_run_key`, while the route and the spec answer 403. The title is renamed; no code changed.

## Rebase onto main `85b07e6c`

Main had moved on with three commits:

- #680, PR-A's roborev 1235 follow-ups in `cell-authority.ts` and its test;
- #681, a dependency patch;
- #679.

**Resolution:** both sides are kept in the authority.

- From #680: `attempt_limit` only at the cap, any other refused state throws, and the hang-proof `holdAndCommit` and `BLOCK_WAIT_MS` helpers.
- From PR-C: the nonce, the sequence fence, and the `cell_step` lock probe.

#680's new test 6c compared the open's result with `toEqual`. It now uses `toMatchObject` like its siblings, because the result carries `openSeq`.

**Gates after the rebase** (outside the Claude sandbox), all exit 0:

- frozen install, build, `lint-migrations`, `tsc-check --force` (21/21), `lint --force`;
- suites: migrate 45, sandbox 589, www 4501, shared 1736 plus 6c fixed, `cell-authority` 63/63;
- the live `OPENSANDBOX_IT` suite: 10/10.

**`format-check`** fails on this machine for files identical to main (`package.json`, `tsconfig.json`, `src/sandbox.ts`). Prettier is picking up an `.editorconfig` from outside the repo; CI has none. PR-C's own files pass `prettier --no-editorconfig --config .prettierrc --check`, and CI's `format-check` is the gate.
