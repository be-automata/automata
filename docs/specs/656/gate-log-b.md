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
