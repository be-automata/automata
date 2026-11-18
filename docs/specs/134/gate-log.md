# #134 (log part) gate log

Branch `fix/134-webhook-skip-log` off `origin/main` @ `a6996533`, then `git merge --no-ff origin/main`
@ `39a663fa` before ship. Run on 2026-11-17 on macOS (pnpm 10.14.0). Each line is the command and its
real exit code, on the merged head.

## Verification gates

| Gate      | Command                                                             | Exit                         |
| --------- | ------------------------------------------------------------------- | ---------------------------- |
| install   | `CI=true pnpm install --frozen-lockfile --prefer-offline`           | 0                            |
| typecheck | `pnpm turbo tsc-check`                                              | 0                            |
| lint      | `pnpm turbo lint`                                                   | 0                            |
| format    | `pnpm turbo format-check`                                           | 0                            |
| www       | `pnpm --filter @terragon/www exec vitest run --no-file-parallelism` | 0 (337 files, 4529 tests)    |
| webhooks  | `vitest run src/app/api/webhooks/` (the touched directory, alone)   | 0 (21 files, 316 tests)      |
| red first | `vitest run route.test.ts -t 134` without the `route.ts` change     | 1 (one `console.error` call) |

An earlier full www run (before the validate fix) failed one case, the new `isOnlyWebhookSkips` unit
test: the run loaded the new test file while the helper was still being written. The same file
passed on its own right after, and in the run above.

## Review

- Validate (fresh agent, adversarial): PASS_WITH_WARNINGS. Its main finding was real: `findWebhookSkip`
  in `onError` would also silence a genuine error raised by another hook of the same delivery. Fixed
  with `isOnlyWebhookSkips` and a route test on `issues.labeled` (two hooks: a skip plus an error).
- `/simplify`: run inline on the 5-line diff (reuse, simplification, efficiency, altitude); nothing to
  change. The helper sits next to `findWebhookSkip` in `webhook-skip.ts`.
- roborev (`roborev-guard review --branch --wait`, job 1266): exit 0, "Pass, no issues found".

## Acceptance

| AC   | Evidence                                                                                                | Verdict |
| ---- | ------------------------------------------------------------------------------------------------------- | ------- |
| AC-1 | `route.test.ts` "an unmapped-installation skip answers 2xx and logs 'skipped', with no console.error"   | PASS    |
| AC-2 | `route.test.ts` "#134: a genuine error from another hook ...", `webhook-skip.test.ts` "#134: isOnly..." | PASS    |
| AC-3 | The gate table above                                                                                    | PASS    |

The production check (no `[github webhook] error` for a skip delivery in `wrangler tail`) needs a www
deploy. The limiter part of #134 stays open for the operator (`REDIS_URL`/`REDIS_TOKEN`).
