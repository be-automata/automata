# Verification evidence: #367 criterion 8 (task lane under the enforced loopback fence)

Requested by issue #390. Commands run from the repository root, Node v24.21.0.

**Setup note.** The first attempt at commands 1 and 2 ran before `node_modules`
existed in this checkout and failed with `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "vitest" not found`
(exit=254 for both). That is an environment gap, not a fence result. I ran
`pnpm install --frozen-lockfile --prefer-offline` (exit 0) and re-ran; the
outputs below are from the re-runs.

**Fence strings.** The full output of command 2 was searched for `ECONNREFUSED`,
`EPERM` and `Connection refused`. None appear in any of the three commands, so
there are no fence lines to quote.

## 1. DB-backed suite

```bash
pnpm --filter @terragon/shared exec vitest run --no-file-parallelism src/db 2>&1 | tail -20; echo "exit=${PIPESTATUS[0]}"
```

```
> @terragon/shared@1.0.0 drizzle-kit-push-test /usr/local/automata/runs/c07e484c-fbc6-400f-90ae-68a7d33819dd/repo/packages/shared
> drizzle-kit push --config drizzle.config.ts

Reading config file '/usr/local/automata/runs/c07e484c-fbc6-400f-90ae-68a7d33819dd/repo/packages/shared/drizzle.config.ts'
Using 'pg' driver for database querying
[⣷] Pulling schema from database...
[✓] Pulling schema from database...
[✓] Changes applied

Seeding feature flags into test database...
Feature flags seeded.
 ✓ src/db/schema-columns.test.ts (3 tests) 103ms
 ✓ src/db/pool-errors.test.ts (2 tests) 20ms

 Test Files  2 passed (2)
      Tests  5 passed (5)
   Start at  14:29:40
   Duration  10.66s (transform 537ms, setup 0ms, collect 2.66s, tests 123ms, environment 1ms, prepare 263ms)

Dropped isolated test database: test_90286_mvfcp466_wu9wxi
```

Exit code: `exit=0`

Result: the throwaway database was created, pushed to and dropped over TCP. Passed.

## 2. Loopback TCP server suites

```bash
pnpm --filter @terragon/worker exec vitest run --no-file-parallelism src/agent-run/egress-proxy.test.ts src/agent-run/git-broker.test.ts 2>&1 | tail -20; echo "exit=${PIPESTATUS[0]}"
```

```
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
   Start at  14:29:53
   Duration  17.22s (transform 285ms, setup 0ms, collect 350ms, tests 16.00s, environment 1ms, prepare 281ms)

undefined
/usr/local/automata/runs/c07e484c-fbc6-400f-90ae-68a7d33819dd/repo/packages/worker:
 ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command failed with exit code 1: vitest run --no-file-parallelism src/agent-run/egress-proxy.test.ts src/agent-run/git-broker.test.ts
```

Exit code: `exit=1`

Result: 111 of 114 tests passed, and `git-broker.test.ts` passed in full. The 3
failures are all in `egress-proxy.test.ts`. No `ECONNREFUSED`, `EPERM` or
`Connection refused` appears in the output. A second, separate run of the same
command (full output saved, 3 failed again) showed what the failures are:

- 3 tests time out at 5000ms: the two `#108 observe mode` tests and the
  `#367 ... a NAME that resolves to a local address is refused ...` test.
- 3 unhandled `TypeError`s thrown by Node's own HTTP client
  (`validateRequestAuthority`, `node:_http_client`), for example:
  `The property 'Host in options.headers' must match the request authority (denied.example.com). Received '127.0.0.1:34423'`
  with `code: 'ERR_INVALID_ARG_VALUE'`.

Interpretation (not verified further): the test client sends a request to the
loopback proxy with a `Host` header that differs from the request authority, and
Node v24.21.0 rejects that before the request leaves the process. The proxy was
reachable (111 tests, including all the connect-and-proxy ones, passed), so this
looks like a test-client incompatibility with this Node version and not the
loopback fence. I have not confirmed that on another Node version.

## 3. DNS from the run

```bash
getent hosts github.com; echo "getent exit=$?"
```

```
140.82.121.3    github.com
getent exit=0
```

Exit code: `getent exit=0`
