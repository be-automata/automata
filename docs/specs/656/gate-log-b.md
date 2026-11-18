# #656 PR-B gate log

Branch `feat/656-b-cell-contract`, off `main` at `2b8409e1`. Run on 2026-11-17 on macOS arm64 with Docker. Spec: `docs/specs/656/spec-b.md` (validate: BLOCK, then PASS_WITH_WARNINGS; every fix folded in).

## Live gate: the daemon token through the sidecar vault (#656 Scope 9, AC-13 gate half)

Command, run outside the Claude sandbox: `OPENSANDBOX_IT=1 pnpm --filter @terragon/sandbox exec vitest run --no-file-parallelism src/providers/opensandbox-cell.integration.test.ts`. Exit 0, **10/10 in 241 s**. No `osbit` container was left afterwards.

**Binding:** the production binding shape: `apiKey` auth, header `X-Daemon-Token`, the fixed placeholder, an exact path, and `substitutions` in the header. The test uses `httpbin.org` and `/anything/daemon-event` with a synthetic canary. The guest POSTs, as the daemon does, and only per-marker booleans leave the guest.

| Check                                                                                                                                                                  | Result                                                                                                                                                                                 |
| :--------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST to the exact path **with** the placeholder header                                                                                                                 | 200; the canary was received and the placeholder absent. **The sidecar replaces the placeholder and does not append.**                                                                 |
| POST to the exact path **without** the header                                                                                                                          | 200; the canary was received. **The sidecar adds the header when it is absent**, so the guest needs no placeholder at all. This is recorded evidence only; the test does not assert it |
| POST to `/anything/daemon/cell-plan`, `/anything/daemon-event/x` and `/anything/daemon-eventx` with the placeholder                                                    | 200 each; placeholder only, no canary. **The binding is exact-path.**                                                                                                                  |
| Canary scan: guest `/proc/*/{environ,cmdline}`, `docker inspect` of workload and sidecar, server and sidecar logs (inputs non-empty: 18,967 B inspect, 371,676 B logs) | Nowhere in plaintext. The canary went into the probe's argv only base64-encoded, and execd's command log holds that encoding by design                                                 |

**Verdict:** OD-4 plan A holds with OpenSandbox 1.2.1's own vault. The fallbacks (spike 069's iron-proxy hop, or the token in the env) are not needed.

**First run (fixed):** a near-miss probe got **HTTP 429** from httpbin.org's rate limit, because the probes run concurrently, so it carried neither marker. Fixes:

- the guest's `https_headers` probe retries a 429 or 503 up to 3 times with backoff;
- every daemon check now also requires a 200, so a rate limit can neither pass nor fail silently.

The replacement check had already passed on that run.

The other scenarios (AC-3, live API, peer isolation, wildcard and 101 rules, AC-6, AC-5, AC-7, AC-8) passed on both runs with the `deployment` tag added.

## Suites (worktree root, with Docker)

| Gate                                                                                                                                                 | Exit          | Result                                                                                                                                             |
| :--------------------------------------------------------------------------------------------------------------------------------------------------- | :------------ | :------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile --prefer-offline`; build (sandbox, bundled, sandbox-image)                                                           | 0 / 0         |                                                                                                                                                    |
| `pnpm --filter @terragon/sandbox exec vitest run --no-file-parallelism`                                                                              | 0             | 507 passed, 145 skipped. The implementer's 9 `docker-cred-broker` timeouts came from the Claude sandbox's port binding and do not occur outside it |
| `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism`                                                                               | 0             | 1608                                                                                                                                               |
| `pnpm --filter @terragon/www exec vitest run --no-file-parallelism`                                                                                  | 0             | 4458 passed, 9 skipped; includes the `cell-plan` route's new TTL and deployment assertions                                                         |
| `pnpm --filter @terragon/docs exec fumadocs-mdx`; `pnpm turbo tsc-check --force`; `pnpm turbo lint --force`; prettier `--check` on the changed files | 0 / 0 / 0 / 0 | tsc 21/21. Re-run after the live-gate fixes, together with the sandbox suite (507) and the shared suite (1608), all exit 0                         |

## Refinement (static review of `30f95058`)

Two Mediums and four Lows; all fixed in the follow-up commit, each with a negative-control test.

| Severity | Finding                                                                                                                                              | Fix                                                                                      |
| :------- | :--------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------- |
| Medium   | `reconcileExpiredCells` with `deployment` undefined from an untyped caller dropped the filter and listed, so it could reap, every deployment's cells | A missing or blank `deployment` throws before listing                                    |
| Medium   | `listByTags` `maxPages`: 0 or NaN listed nothing and reported truncated; Infinity bypassed `MAX_LIST_PAGES`                                          | Anything other than an integer in `1..1000` is refused `invalid_argv`, with no HTTP call |
| Low      | `assertVault` let `auth: "basic"` or `"passthrough"` through as bearer, and sent an empty `paths: []`                                                | Both refused `invalid_plan`                                                              |
| Low      | A NaN or non-positive reconcile `limit` removed the per-run cap                                                                                      | Falls back to the default 20                                                             |
| Low      | A daemon token with surrounding whitespace was sent as is                                                                                            | Refused before mint                                                                      |
| Low      | The gate log overstated the header-absent row and the canary scan                                                                                    | Reworded (above)                                                                         |

After the fixes: sandbox 523 passed (145 skipped, exit 0), the plan-builder tests 40 passed, and tsc exit 0 on shared and sandbox.

## `/simplify` (4 reviewers: reuse, simplification, efficiency, altitude)

Applied:

- **Runtime import of a dev-only dependency** (altitude). `reconcile.ts` imported the runtime helper `wasTruncated` from `@terragon/types`, which `@terragon/sandbox` has only as a devDependency.
  - The flag is now part of the return type: `CellList = CellListEntry[] & { readonly truncated?: boolean }`. The reconciler imports types only, and `wasTruncated` is removed.
- **Daemon binding constants** moved to `@terragon/types` (`CELL_DAEMON_EVENT_PATH`, `CELL_DAEMON_TOKEN_HEADER`, `CELL_DAEMON_TOKEN_PLACEHOLDER`). The plan builder re-exports them, and the live gate now imports the production values instead of copying them.
- **The adapter's header-name regex** stays a local copy, because the adapter imports the contract type-only. A sync test now asserts it equals `CELL_VAULT_HEADER_PATTERN`, following the precedent of `OPENSANDBOX_MIN_TTL_MS`.
- **Reconciler:** each cell is classified as expired once, not three times, and a `visited` counter enforces the limit.
- **Adapter:** one cast in `assertVault`; the duplicate `maxPages` check is gone.
- **Guest probe:** `fetch` and `fetch_headers` share one request path. The 429/503 retry has jitter, so parallel probes don't come back together.

Skipped, with reasons:

- Skipping `isDead` when expired cells already fill the limit: that would turn `dead` and `deferred` into estimates.
- Caching `cellBrokerHost()`: negligible.
- Un-exporting `cellKeyId`, `buildDaemonVaultEntry` and `CELL_DAEMON_EVENT_PATH`, and cutting the `isDead` and `daemonToken` options: they are the contract PR-C and PR-E consume.

**Final run on this tree, all exit 0:**

| Gate                                     | Result                          |
| :--------------------------------------- | :------------------------------ |
| fumadocs-mdx                             | pass                            |
| `pnpm turbo tsc-check --force`           | 21/21                           |
| `pnpm turbo lint --force`                | pass                            |
| prettier `--check` on every changed file | pass                            |
| sandbox                                  | 523 passed, 145 skipped         |
| shared                                   | 1609                            |
| www                                      | 4458 passed, 9 skipped          |
| `OPENSANDBOX_IT=1`                       | **10/10**, daemon gate included |

## Roborev

- **Job 1203 on `2b8409e..08a66e1`:** the agent's assessment is **Pass**. No correctness or security bugs. Two operational findings:
  - **Medium, fixed:** the reconciler's `truncated` result was never surfaced. The reconciler now warns once per truncated run with counts only (`listed`, `reaped`, `deferred`, `dead`), through its injected logger, so every host sees it. Two tests cover it: a warning when truncated, none when the listing completed.
  - **Low, no code:** cells created before the `deployment` tag existed would no longer be listed. None exist. No cell has run anywhere, because nothing executes a plan until PR-E (#656), and the S4 reconciler had nothing to reap in production. The PR records this.
- **After the fix, all exit 0:** sandbox 525 passed (145 skipped), `tsc-check --force` 21/21, `lint --force`, and prettier on the changed files. The change is a 10-line log and its tests, and touches neither the guest probe nor the adapter, so the live gate's 10/10 on `08a66e1` still holds.
- **Job 1205 on `2b8409e..2b9147b` (the final range):** **Pass**, with two Lows.
  - **Low, follow-up:** with more than 5 pages and a server that lists in a stable order, cells after page 5 are never reached. Fix: rotate the start page, or list until `limit` reapable cells are found. No deployment has a cell today, and the new warning shows when it happens. Listed in the PR.
  - **Low, fixed (doc only):** `spec-b.md` still described the removed `wasTruncated`; it now describes `CellList.truncated`.

## Addendum (2026-11-18, #693): what the sidecar matches on

By the upstream code, the exact-path result above also holds under path confusion. The live run of the new variants is deferred (see #693). The rule is in `docs/specs/693/gate-log.md` and `docs/specs/693/spec.md`:

- the authority gate runs first;
- then the raw path, with the query stripped, is matched for string equality;
- a request that matches no binding passes through untouched.

The new live-gate scenario is `daemon apiKey under path confusion (#693)`. Since #693, the token in the daemon binding is the cell's own event-only token. www refuses it everywhere except `/api/daemon-event`.
