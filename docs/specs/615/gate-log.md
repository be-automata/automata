# #615 gate log

Branch `fix/615-forged-capability-flake`, base `origin/main` @ `c596e47f` (unchanged at ship
time, so `git merge --no-ff origin/main` was a no-op). Machine: macOS, Node 22.23.4, vitest
3.2.7, Docker Postgres for www tests. Run 2026-11-17.

## Before: the old forgery was sometimes the real capability (AC-4)

### Measured false-accept rate

A scratch script signs fixed claims with N random 16-byte secrets using the real
`signCallbackCapability`. It applies each tamper and counts how often `verifyCallbackCapability`
accepts the result (`sameBytes` counts how often the tampered signature decodes to the real bytes).

```
N=200000
old tamper slice(0,-2)+"AA": accepted=180 rate=0.00090 (1/256=0.00391) sameBytes=180
new tamper flip s[0]:        accepted=0 sameBytes=0

N=1000000
old tamper slice(0,-2)+"AA": accepted=1015 rate=0.00102 (1/256=0.00391) sameBytes=1015
new tamper flip s[0]:        accepted=0 sameBytes=0
```

Expected rate is 1/1024 = 0.00098, not the 1/256 first estimated. The 43rd character of a
32-byte base64url value carries 4 significant bits (256 = 42 × 6 + 4), and Node writes the 2
spare bits as zero. So the old tamper keeps the bytes only when the real signature already ends
in `AA` (1/64 × 1/16), and in that case the "forgery" is the unchanged capability. The test file
forges twice (unit test and route test), so a file run fails about 1 in 512.

### A replayable constructed case

Fixed claims, secrets `s-1`, `s-2`, ... until the old forgery verifies:

```
claims={"callId":"c1","groupId":"g1","organizationId":"o1","expiresAt":4102444800000}
secret="s-21"
capability=eyJjIjoiYzEiLCJnIjoiZzEiLCJvIjoibzEiLCJlIjo0MTAyNDQ0ODAwMDAwfQ.0GYCZt4swEssk2QYvTU1ZCAFzopp3jh9nY0-ie8IgAA
old forgery = identical string -> verifyCallbackCapability returns the claims (accepted)
new forgery = eyJj…fQ.AGYCZt4swEssk2QYvTU1ZCAFzopp3jh9nY0-ie8IgAA -> null (refused)
```

### Route-level reproduction

A temporary test (not committed) recorded a call, picked a secret whose capability ends in `AA`
(440 secrets tried), and posted both forgeries to the real route:

```
[repro-615] secrets tried=440 sig=zfDSkNReZa6DXfFKmoK1M-JMcOfx3NEgFviAQe0DoAA oldForgery===cap: true
[repro-615] old forgery status=200
[repro-615] new forgery status=401
```

This matches the CI failure on #613 (run 43650292577, `expected 200 to be 401`).

## After: the new forgery always fails (AC-1, AC-2, AC-3)

- AC-1: both forgeries go through `forge()` in `route.test.ts`, which flips the first signature
  character. That character holds the top 6 bits of the MAC's first byte.
- AC-2: the new unit test "forges a different signature every time, and the forgery never
  verifies" signs 1000 capabilities with random secrets, and asserts for each that the forgery
  decodes to different bytes and fails verification. Mutation check: with `forge` pointed back at
  the old tamper, this test failed 3 of 5 runs (`expected true to be false`), close to the
  expected 1 − (1 − 1/1024)^1000 ≈ 62%.
- AC-3: the route test "refuses a forged, foreign-key, expired or disabled capability with 401
  and stores nothing" ran with a temporary `{ repeats: 999 }` and a run counter (both reverted
  before commit). Each run had a fresh org, call and signature:

  ```
  [615] forged-route runs=1000 passed=1000
  ✓ POST /api/addon-callback/[capability] > refuses a forged, foreign-key, expired or disabled capability with 401 and stores nothing  28826ms (repeat x999)
  Tests  1 passed | 9 skipped (10)
  ```

## Gates (AC-5), on the final tree

| Gate                                                                                             | Exit | Detail                                                                      |
| :----------------------------------------------------------------------------------------------- | :--- | :-------------------------------------------------------------------------- |
| `pnpm turbo tsc-check`                                                                           | 0    | 21/21 tasks                                                                 |
| `pnpm turbo lint`                                                                                | 0    | 2/2 tasks                                                                   |
| `pnpm turbo format-check`                                                                        | 0    | 18/18 tasks                                                                 |
| `pnpm --filter @terragon/www exec vitest run --no-file-parallelism "src/app/api/addon-callback"` | 0    | 10/10 tests                                                                 |
| `pnpm --filter @terragon/www exec vitest run --no-file-parallelism` (full)                       | 0    | 335 files passed, 1 skipped; 4459 tests passed, 9 skipped, 0 failed (970 s) |

The full www suite needed 3 runs. The machine was shared with other agents' test suites (load
average 17-37). Two earlier runs failed in files this change does not touch:
`src/server-lib/audit/loop-breaker.test.ts` hit 5000 ms timeouts in 3 tests, and one run also
had a `supersede-sweep.order.test.ts` failure. Both files pass alone: `loop-breaker.test.ts` 35/35
in 3 of 3 runs, `supersede-sweep.order.test.ts` 3/3. The third full run passed with exit 0.

## Scope (AC-6)

`git diff --stat origin/main`: `apps/www/src/app/api/addon-callback/[capability]/route.test.ts`,
`docs/specs/615/spec.md`, `docs/specs/615/gate-log.md`. No production file changed.
