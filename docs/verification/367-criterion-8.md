# #367 criterion 8: task lane under the enforced loopback fence

Evidence for #390. The three commands were run unmodified from the repository root,
inside an automata task run on the execution box, on 2026-10-19 (Node v24.21.0, pnpm 10.14.0).
`pnpm install --frozen-lockfile --prefer-offline` was run first because the checkout had no
`node_modules`. Each command already pipes through `tail -20`, so its output below is the
last 20 lines, quoted as printed. Only ANSI colour codes were removed.

## Summary

| #   | Command                                                            | Exit code                      | Loopback fence errors (`ECONNREFUSED` / `EPERM` / `Connection refused`) |
| :-- | :----------------------------------------------------------------- | :----------------------------- | :---------------------------------------------------------------------- |
| 1   | shared `src/db` suite (throwaway DB over TCP)                      | **0**: 2 files, 5 tests passed | none                                                                    |
| 2   | worker `egress-proxy` + `git-broker` suites (own loopback servers) | **1**: 3 of 114 tests failed   | none                                                                    |
| 3   | `getent hosts github.com`                                          | **0**                          | none                                                                    |

None of the three outputs contains `ECONNREFUSED`, `EPERM`, or `Connection refused`.
I checked with `grep -nE "ECONNREFUSED|EPERM|Connection refused"` over the outputs and the full
command-2 log, and it found no matches. The run reached its test Postgres over TCP, the worker
suites bound and connected to their own loopback servers, and DNS resolved.

### Why command 2 failed (not the fence)

All three failures are `Test timed out in 5000ms`, each with an uncaught
`TypeError [ERR_INVALID_ARG_VALUE]: The property 'Host in options.headers' must match the
request authority (...)`. The stack runs from `egress-proxy.ts:669` (`httpRequest(...)` in
`handleRequest`) into Node's `rewriteForProxiedHttp` (`node:_http_client:301`).

The run's environment sets `NODE_USE_ENV_PROXY` and `HTTP_PROXY`/`HTTPS_PROXY`. With these
set, Node 24 sends the egress proxy's own upstream `http.request` through the run's
environment proxy. It then rejects the request because the forwarded `Host` header does not match
the rewritten authority. The failing tests:

- `#108 observe mode — allow-all AND audited > observe still fires onEvent for EVERY decision, marked mode:observe`
- `#108 observe mode — allow-all AND audited > observe counts distinct hosts for the step log`
- `#367 ... > a NAME that resolves to a local address is refused on the real CONNECT and GET paths (the lookup option is honoured), the upstream never sees a connection, and a host-local deny is audited`

As a check, I ran the same vitest command with only that variable removed
(`env -u NODE_USE_ENV_PROXY pnpm --filter @terragon/worker exec vitest run --no-file-parallelism src/agent-run/egress-proxy.test.ts src/agent-run/git-broker.test.ts`).
It exited 0 with `Test Files 2 passed (2)` and `Tests 114 passed (114)`. So the failure comes from
the env-proxy settings in the run environment, not from the loopback fence. This PR is evidence
only and does not try to fix it.

## 1. DB-backed suite

```bash
pnpm --filter @terragon/shared exec vitest run --no-file-parallelism src/db 2>&1 | tail -20; echo "exit=${PIPESTATUS[0]}"
```

```text
> @terragon/shared@1.0.0 drizzle-kit-push-test /usr/local/automata/runs/624cde02-8b6f-4594-b1a1-343d05d33cd3/repo/packages/shared
> drizzle-kit push --config drizzle.config.ts

Reading config file '/usr/local/automata/runs/624cde02-8b6f-4594-b1a1-343d05d33cd3/repo/packages/shared/drizzle.config.ts'
Using 'pg' driver for database querying
[⣷] Pulling schema from database...
[✓] Pulling schema from database...
[✓] Changes applied

Seeding feature flags into test database...
Feature flags seeded.
 ✓ src/db/schema-columns.test.ts (3 tests) 105ms
 ✓ src/db/pool-errors.test.ts (2 tests) 24ms

 Test Files  2 passed (2)
      Tests  5 passed (5)
   Start at  14:33:13
   Duration  10.62s (transform 614ms, setup 0ms, collect 2.70s, tests 129ms, environment 1ms, prepare 281ms)

Dropped isolated test database: test_93831_mvfctoan_kstjpa
```

Exit code: `exit=0`

## 2. Suites that start their own TCP servers on loopback

```bash
pnpm --filter @terragon/worker exec vitest run --no-file-parallelism src/agent-run/egress-proxy.test.ts src/agent-run/git-broker.test.ts 2>&1 | tail -20; echo "exit=${PIPESTATUS[0]}"
```

```text
 ❯ HTTPParser.parserOnHeadersComplete node:_http_common:125:17

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
Serialized Error: { code: 'ERR_INVALID_ARG_VALUE' }
This error originated in "src/agent-run/egress-proxy.test.ts" test file. It doesn't mean the error was thrown inside the file itself, but while it was running.
The latest test that might've caused the error is "a NAME that resolves to a local address is refused on the real CONNECT and GET paths (the lookup option is honoured), the upstream never sees a connection, and a host-local deny is audited". It might mean one of the following:
- The error was thrown, while Vitest was running this test.
- If the error occurred after the test had been completed, this was the last documented test before it was thrown.
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯


 Test Files  1 failed | 1 passed (2)
      Tests  3 failed | 111 passed (114)
     Errors  3 errors
   Start at  14:33:29
   Duration  17.29s (transform 306ms, setup 0ms, collect 377ms, tests 16.04s, environment 1ms, prepare 278ms)

undefined
/usr/local/automata/runs/624cde02-8b6f-4594-b1a1-343d05d33cd3/repo/packages/worker:
 ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command failed with exit code 1: vitest run --no-file-parallelism src/agent-run/egress-proxy.test.ts src/agent-run/git-broker.test.ts
```

Exit code: `exit=1`

## 3. DNS from the run

```bash
getent hosts github.com; echo "getent exit=$?"
```

```text
140.82.121.3    github.com
```

Exit code: `getent exit=0`
