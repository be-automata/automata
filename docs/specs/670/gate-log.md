# #670 gate log

Branch `fix/670-prod-dependency-advisories` off `origin/main` @ `c596e47f`, run on 2026-11-17 on macOS
(Node 24, pnpm 10.14.0). Env scrubbed as in `ci.yml` (`unset DATABASE_URL DB_DRIVER SANDBOX_PROVIDER
NODE_ENV NEXT_PUBLIC_APP_URL`). Each line is the command and its real exit code.

## Verification gates

| Gate                           | Command                                                                                                | Exit                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------ |
| install                        | `CI=true pnpm install --frozen-lockfile --prefer-offline`                                              | 0                        |
| docs codegen                   | `pnpm --filter @terragon/docs exec fumadocs-mdx`                                                       | 0                        |
| docs build                     | `pnpm --filter @terragon/docs build`                                                                   | 0                        |
| typecheck                      | `pnpm turbo tsc-check`                                                                                 | 0                        |
| lint                           | `pnpm turbo lint`                                                                                      | 0                        |
| format                         | `pnpm turbo format-check`                                                                              | 0                        |
| utils                          | `pnpm --filter @terragon/utils exec vitest run --no-file-parallelism`                                  | 0                        |
| knowledge                      | `pnpm --filter @terragon/knowledge exec vitest run --no-file-parallelism`                              | 0                        |
| agent                          | `pnpm --filter @terragon/agent exec vitest run --no-file-parallelism`                                  | 0                        |
| shared                         | `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism`                                 | 0                        |
| www                            | `pnpm --filter @terragon/www exec vitest run --no-file-parallelism`                                    | 0                        |
| daemon                         | `pnpm --filter @terragon/daemon exec vitest run --no-file-parallelism`                                 | 1 (host-only, see below) |
| daemon minus `runtime.test.ts` | `... vitest run --no-file-parallelism --exclude src/runtime.test.ts`                                   | 0 (13 files, 256 tests)  |
| sandbox                        | `pnpm --filter @terragon/sandbox exec vitest run --no-file-parallelism`                                | 0                        |
| migrate                        | `pnpm --filter @terragon/migrate exec vitest run --no-file-parallelism`                                | 0                        |
| worker                         | `pnpm --filter @terragon/worker exec vitest run --no-file-parallelism`                                 | 0                        |
| cli                            | `pnpm --filter @terragon-labs/cli exec vitest run --no-file-parallelism`                               | 0                        |
| review                         | `pnpm --filter @terragon/review test`                                                                  | 0                        |
| audit (CI gate)                | `pnpm audit --prod --audit-level critical`                                                             | 0                        |
| www deps build                 | `pnpm turbo build --filter='@terragon/www^...' --force` (0 of 4 cached)                                | 0                        |
| e2e build                      | `pnpm --filter @terragon/www e2e:build`                                                                | 0                        |
| www Workers bundle             | `opennextjs-cloudflare build` in apps/www, with the `e2eBuildEnv()` placeholder env                    | 0                        |
| broadcast Workers bundle       | esbuild `src/server.ts src/sandbox.ts --bundle --platform=neutral --conditions=workerd,worker,browser` | 0                        |
| CLI / mcp-server builds        | `pnpm --filter @terragon-labs/cli build`; `pnpm --filter @terragon/mcp-server build`                   | 0, 0                     |

The www Workers bundle needs the e2e placeholder env because page-data collection validates required
env vars (without it the build stops on `Missing environment variables`, before any bundling). A live
e2b sandbox smoke on the deployed Workers needs deploy credentials and is deferred to after merge.

### Proven by CI on the PR, not locally

- the full daemon suite (see below);
- the `e2e` lane (`.github/workflows/ci.yml:253`), which runs `e2e:build` then the Playwright suite;
- the `worker-e2e` job (`ci.yml:215`, the `HATCHET_IT=1` suites in CLAUDE.md), which exercises the
  worker's hatchet gRPC client on @grpc/grpc-js 1.14.7 and axios 1.21.1.

### zod

No zod override: it rewrote the MCP SDK's `zod: ^3.25 || ^4.0` spec and broke the zod-3 peer that
`@google/gemini-cli-core` supplies in packages/daemon. Direct pins (4.6.7) and fumadocs-mdx 11.10.1
already put every production path on 4.6.7.

### daemon: 4 host-only failures, identical on `origin/main`

`src/runtime.test.ts` spawns `bash -lc` with `env: {}` and asserts that stderr stays empty. On this
machine the login profile (`~/.bash_profile`) writes `Error: $HOME must be set to run brew.` when
`$HOME` is unset; `env -i bash -lc "echo hi"` reproduces it outside the test. A detached worktree at
untouched `origin/main` c596e47f gives the same result: `4 failed | 268 passed`, the same four tests.
This PR changes no daemon code. CI (Ubuntu, clean profile) runs the full suite on the PR.

## Audit (AC1)

|                                 | low | moderate | high | critical |
| ------------------------------- | --- | -------- | ---- | -------- |
| before (`origin/main` c596e47f) | 9   | 56       | 44   | 0        |
| after (this branch)             | 4   | 31       | 2    | 0        |

The two remaining high advisories are both GHSA-fc5q-39xc-vjpf (picomatch ≤4.0.7, no patched release):
`apps/www > @daytonaio/sdk > fast-glob > micromatch > picomatch@2.3.2` and
`apps/docs > fumadocs-mdx > tinyglobby > picomatch@4.0.5`. The set of high/critical module names in
`pnpm audit --prod --json` is exactly `{picomatch}`.
`pnpm audit --prod --audit-level high` exits 1 by construction while picomatch remains.

## Resolved versions (AC2, `pnpm why -r <pkg>`)

| Package                   | Versions in the graph                                                      | Needed                                                                             |
| ------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| undici                    | 6.29.1, 7.30.0, 7.30.1, 8.12.4                                             | ≥6.29.1 / ≥8.12.2 (7.30.0 is dev-only, via gemini-cli-core; not in the prod audit) |
| follow-redirects          | 1.16.3                                                                     | ≥1.16.2                                                                            |
| axios                     | 1.21.1                                                                     | ≥1.20.0                                                                            |
| fast-uri                  | 3.1.9                                                                      | ≥3.1.7                                                                             |
| @modelcontextprotocol/sdk | 1.32.2                                                                     | ≥1.32.0                                                                            |
| body-parser               | 2.4.0                                                                      | ≥2.4.0                                                                             |
| @grpc/grpc-js             | 1.14.7                                                                     | ≥1.14.5                                                                            |
| prosemirror-view          | 1.42.9 (one copy)                                                          | ≥1.42.3                                                                            |
| prosemirror-model         | 1.25.13 (one copy)                                                         | ≥1.25.12 (prosemirror-view's own range)                                            |
| markdown-it               | 14.3.3                                                                     | ≥14.3.3                                                                            |
| zod                       | 4.6.7; 3.22.4 and 3.25.76 dev-only (`pnpm why -r --prod 'zod@3'` is empty) | ≥4.6.6                                                                             |
| js-yaml                   | 4.3.2                                                                      | ≥4.3.2                                                                             |
| vite                      | 6.4.6                                                                      | ≥6.4.4                                                                             |
| e2b                       | 2.63.0 (no `undici8` alias left in pnpm-lock.yaml)                         | ≥2.56.0                                                                            |
| picomatch                 | 2.3.2, 4.0.5                                                               | no fix exists                                                                      |

## MCP smoke (AC4)

Both servers were built (`pnpm --filter @terragon-labs/cli build`, `pnpm --filter @terragon/mcp-server
build`, exit 0), then sent `initialize`, `notifications/initialized` and `tools/list` over stdio:

- `node apps/cli/dist/index.js mcp`: initialize ok (`terry-mcp-server`, protocol 2025-06-18);
  `tools/list` returned 3 tools (`terry_list`, `terry_create`, `terry_pull`). Exit 0.
- `node packages/mcp-server/dist/bundled.js`: initialize ok (`terragon-mcp-server`); `tools/list`
  returned 2 tools (`SuggestFollowupTask`, `PermissionPrompt`). Exit 0.

The CLI resolves `@modelcontextprotocol/sdk` to 1.32.2.

## picomatch reachability

No repo source imports fast-glob, micromatch, tinyglobby, picomatch, minimatch or glob. Inside
`@daytonaio/sdk` 0.205.1, fast-glob is loaded only by `Image.extractCopySources` (cjs/Image.js:508,
Dockerfile COPY sources). The repo imports only `Daytona`, `Sandbox` and `DaytonaConflictError`
(packages/sandbox/src/providers/daytona-provider.ts:1-5, apps/www/src/app/api/test/daytona/route.ts:1,
packages/debug-scripts/daytona-ssh.ts:2) and never builds an `Image`. fumadocs-mdx > tinyglobby runs at
docs build time over `apps/docs/content`, with patterns from `apps/docs/source.config.ts`. No
user-controlled glob pattern reaches picomatch in a production path.

## After merging `origin/main` (08c1b194)

Re-run on the merge commit c48a37c1, every gate exit 0: install (`--frozen-lockfile`), fumadocs-mdx,
`turbo tsc-check`, `lint`, `format-check`, the utils, knowledge, agent, shared, www, sandbox, migrate,
worker, cli and review suites, `pnpm audit --prod --audit-level critical`,
`turbo build --filter='@terragon/www^...'` and `e2e:build`. The prod audit is still exactly
`{picomatch}` (`high: 2, critical: 0`).

Local trap found on the way: the OpenNext build leaves `apps/www/.open-next/`, which
`apps/www/tsconfig.json` (`include: ["**/*.ts", …]`, `exclude: [".next/**/*", "node_modules"]`) pulls
into the www type-check. With it present, a cold www `tsc` doubles to 1.35M types and runs out of the
default 4 GB heap; without it the branch matches `origin/main` (592k types, about 2.6 GB). CI never has
`.open-next`. Adding `.open-next` to that exclude is a follow-up, not part of this change.
