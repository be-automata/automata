# #670: high-severity advisories in production dependencies

Ticket: be-automata/automata#670 (supersedes #289 axios, #346 fast-uri). Base: `origin/main` @ `c596e47f`.
The ticket body is the contract (scope, ACs 1-4, T0 tests, risks, DoD). This file adds the ground
truth verified in the worktree on 2026-11-17.

## Ground truth (verified at c596e47f)

`pnpm audit --prod --json` at c596e47f: `{low: 9, moderate: 56, high: 44, critical: 0}`.
The ticket title says 14 packages; the table, and the re-run, list **13 distinct modules**.
pnpm audit prints one path per (module, version); the full consumer list comes from the lockfile.

| Module                    | Resolved now (pnpm-lock.yaml)                               | Needs                                                           | Advisory path(s) at HEAD                                                                                                         | Fix lever                                                                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| undici                    | 6.29.0, 8.11.2 (also 7.30.0/7.30.1, not flagged)            | ≥6.29.1, ≥8.12.2                                                | broadcast > @e2b/code-interpreter > e2b; shared > @opennextjs/cloudflare > @dotenvx/dotenvx                                      | overrides `undici@<6.29.1` → `>=6.29.1 <7`, `undici@>=8.0.0 <8.12.2` → `>=8.12.2 <9`                                                                                                        |
| follow-redirects          | 1.16.0                                                      | ≥1.16.2                                                         | www > @daytonaio/sdk > axios                                                                                                     | override `follow-redirects@<1.16.2` → `>=1.16.2 <2`                                                                                                                                         |
| axios                     | 1.18.1, 1.19.0                                              | ≥1.20.0                                                         | www > @daytonaio/sdk                                                                                                             | override `axios@>=1.0.0 <1.20.0` → `>=1.20.0 <2` (#289)                                                                                                                                     |
| fast-uri                  | 3.1.5                                                       | ≥3.1.7                                                          | cli > @modelcontextprotocol/sdk > ajv                                                                                            | override `fast-uri@>=3.0.0 <3.1.7` → `>=3.1.7 <4` (#346)                                                                                                                                    |
| @modelcontextprotocol/sdk | 1.30.0                                                      | ≥1.32.0                                                         | apps/cli (direct `^1.0.6`, apps/cli/package.json:23); packages/mcp-server (direct `^1.0.6`, packages/mcp-server/package.json:30) | bump both direct ranges to `^1.32.2` + override `@modelcontextprotocol/sdk@<1.32.0` → `>=1.32.0 <2`                                                                                         |
| body-parser               | 2.3.0                                                       | ≥2.4.0                                                          | cli > @modelcontextprotocol/sdk > express                                                                                        | override `body-parser@>=2.0.0 <2.4.0` → `>=2.4.0 <3`                                                                                                                                        |
| @grpc/grpc-js             | 1.14.4                                                      | ≥1.14.5                                                         | www > @daytonaio/sdk > @opentelemetry/sdk-node > otlp-grpc-exporter-base                                                         | override `@grpc/grpc-js@>=1.14.0 <1.14.5` → `>=1.14.5 <2`                                                                                                                                   |
| prosemirror-view          | 1.40.0                                                      | ≥1.42.3                                                         | www > @tiptap/\* > @tiptap/pm (2.14.0 declares `^1.37.0`)                                                                        | override `prosemirror-view@<1.42.3` → `>=1.42.3 <2`                                                                                                                                         |
| markdown-it               | 14.3.0                                                      | ≥14.3.3                                                         | www > @tiptap/pm > prosemirror-markdown                                                                                          | override `markdown-it@<14.3.3` → `>=14.3.3 <15`                                                                                                                                             |
| zod                       | 4.1.11 (exact pin in 7 workspace packages), 3.25.76, 3.22.4 | ≥4.6.6 (**no 3.x fix exists**; npm's newest 3.x is 3.25.76)     | www (direct); docs > fumadocs-mdx 11.6.9 (dep `zod: 3.25.76`)                                                                    | bump the 7 exact pins `4.1.11` → `4.6.7`; bump `fumadocs-mdx` `11.6.9` → `11.10.1` (same major; 11.8.0+ depends on `zod ^4`), apps/docs/package.json:17 (no zod override; see correction 6) |
| js-yaml                   | 4.3.1                                                       | ≥4.3.2                                                          | docs > fumadocs-mdx                                                                                                              | override `js-yaml@>=4.0.0 <4.3.2` → `>=4.3.2 <5`                                                                                                                                            |
| vite                      | 6.4.3                                                       | ≥6.4.4                                                          | docs > fumadocs-mdx (peer `vite 6.x`)                                                                                            | override `vite@<=6.4.3` → `>=6.4.4 <7`                                                                                                                                                      |
| picomatch                 | 2.3.2, 4.0.5                                                | **no patched version** (≤4.0.7 vulnerable; 4.0.7 is the newest) | www > @daytonaio/sdk > fast-glob > micromatch; docs > fumadocs-mdx > tinyglobby                                                  | none; residual (below)                                                                                                                                                                      |

The 7 zod pins: apps/www/package.json:132, packages/types/package.json:20,
packages/cli-api-contract/package.json:13, packages/agent/package.json:24,
packages/shared/package.json:57, packages/daemon/package.json:31, packages/sandbox/package.json:42.
They move together: the packages pass zod schemas to each other, so two zod 4 minors in one graph
would split `instanceof`/type identity.

zod 3 consumers outside the prod audit (dev tools: miniflare, vercel-cron, eslint-plugin-react-hooks,
yup/zod-validation-error, @google/gemini-cli-core) are not touched: no 3.x fix exists and moving a
zod-3 consumer onto zod 4 changes its API. If the after-audit shows another **prod** path to zod 3,
that is a decision for the person (see Open questions), not something to override.

Already done (do not redo): the root `package.json` already carries older overrides for every module
above except prosemirror-view, prosemirror-model, zod and e2b; they fixed earlier advisories one
at a time.

## Validate cycle 1 corrections (binding; supersede the table's "Fix lever" column where they differ)

1. **undici 8.11.2 is an npm alias.** `e2b@2.52.1` (via `@e2b/code-interpreter` 2.7.1, in broadcast,
   www, sandbox, debug-scripts) has `optionalDependencies: undici8: npm:undici@8.11.2`
   (pnpm-lock.yaml at c596e47f, entry `e2b@2.52.1`). pnpm matches override selectors on the dependency key, so an
   `undici@…` selector never touches `undici8`. Fix: `e2b@>=2.39.0 <2.56.0` → `>=2.56.0 <3`
   (e2b 2.56.0+ drops the alias and depends on `undici ^8.12.x` directly; same major, inside
   code-interpreter's `^2.39.0`). The `undici@>=8.0.0 <8.12.2` override is kept as a floor.
2. **Override order is load-bearing.** pnpm 10.14 picks the last-listed intersecting selector, so a
   new entry beside an old one can lose to a later old target that the vulnerable version still
   satisfies (today the MCP SDK importer specifier is the last old entry's `>=1.25.2 <2`). Fix: for the
   modules below, **delete the superseded same-package ranged entries** and keep exactly one selector
   per vulnerable range. Kept: bare `vite`, bare `@daytonaio/sdk`, and `undici@>=7.0.0 <7.29.0`
   (undici 7 is a different major, not superseded). Each new selector is at least as wide as the
   union of the ones it replaces, so no version an old entry forced up can come back.
3. **prosemirror-model.** prosemirror-view 1.42.5+ requires `prosemirror-model ^1.25.12`; the lockfile
   has 1.25.1 (pnpm-lock.yaml at c596e47f, entry `prosemirror-model@1.25.1`). Add `prosemirror-model@<1.25.12` → `>=1.25.12 <2` so the editor
   keeps one model copy. Gate: `pnpm why -r prosemirror-model` and `prosemirror-view` each one version.
4. **Audit gate.** `pnpm audit --prod --audit-level high` cannot exit 0 while picomatch (no fix) remains.
   Gate instead: the set of high/critical `module_name`s in `pnpm audit --prod --json` is exactly
   `{picomatch}`. `pnpm audit --prod --audit-level critical` stays a real exit-0 gate (ci.yml:40).
5. **More suites.** axios also reaches prod via packages/worker > @hatchet-dev/typescript-sdk. Add the
   worker, `@terragon-labs/cli`, knowledge and migrate vitest suites (ci.yml run_pkg list) and
   `pnpm --filter @terragon/docs build` (fumadocs-mdx moves 4 minors). The CI `e2e` lane is required
   (AC3); locally `e2e:build` runs, the full lane is proven by CI on the PR.

6. **zod override dropped in implementation.** `zod@>=4.0.0 <4.6.6` rewrote the MCP SDK's
   `zod: ^3.25 || ^4.0` spec to `>=4.6.6 <5` and broke the zod-3 peer that `@google/gemini-cli-core`
   (packages/daemon) supplies (new `pnpm install` peer warning). The 7 direct pins plus fumadocs-mdx
   11.10.1 already put every production path on zod 4.6.7 (`pnpm why -r --prod 'zod@3'` is empty).
   Residual: a future production dependency pinning zod 4 below 4.6.6 is not forced up, and nothing
   automated would catch it: CI's audit gate is `--audit-level critical` (ci.yml:40) and these
   advisories are high. The same holds for versions no selector here matches (axios 0.x, e2b <2.39,
   @grpc/grpc-js <1.14); none is in the lockfile today. A CI step failing on any high/critical prod
   module outside an allowlist (`{picomatch}`) would close it; proposed as a follow-up, not built here.
7. **Workers bundles.** e2b 2.63 is now on the production paths of www (OpenNext on Cloudflare) and
   broadcast (PartyKit). Gates: `opennextjs-cloudflare build` in apps/www, and an esbuild bundle of
   broadcast's `src/server.ts` + `src/sandbox.ts` with workerd conditions. A live e2b sandbox smoke
   needs deploy credentials and is deferred to after merge.

Final override set (replacing every older entry for these names, except those kept in item 2):

| Selector                            | Target         |
| ----------------------------------- | -------------- |
| `undici@<6.29.1`                    | `>=6.29.1 <7`  |
| `undici@>=8.0.0 <8.12.2`            | `>=8.12.2 <9`  |
| `e2b@>=2.39.0 <2.56.0`              | `>=2.56.0 <3`  |
| `follow-redirects@<1.16.2`          | `>=1.16.2 <2`  |
| `axios@>=1.0.0 <1.20.0`             | `>=1.20.0 <2`  |
| `fast-uri@>=3.0.0 <3.1.7`           | `>=3.1.7 <4`   |
| `@modelcontextprotocol/sdk@<1.32.0` | `>=1.32.0 <2`  |
| `body-parser@>=2.0.0 <2.4.0`        | `>=2.4.0 <3`   |
| `@grpc/grpc-js@>=1.14.0 <1.14.5`    | `>=1.14.5 <2`  |
| `prosemirror-view@<1.42.3`          | `>=1.42.3 <2`  |
| `prosemirror-model@<1.25.12`        | `>=1.25.12 <2` |
| `markdown-it@<14.3.3`               | `>=14.3.3 <15` |
| `js-yaml@>=4.0.0 <4.3.2`            | `>=4.3.2 <5`   |
| `vite@<=6.4.3`                      | `>=6.4.4 <7`   |

`undici@<6.29.1`, `markdown-it@<14.3.3` and `vite@<=6.4.3` keep the old selectors' cross-major reach
(`undici@<6.23.0`, `markdown-it@>=13.0.0 <14.1.1`, `vite@<=6.4.2` already forced undici 5, markdown-it
13 and vite 5 consumers up); narrowing them while deleting the old entries would let those versions
back. Every target is bounded to the patched major.

Picomatch reachability, corrected: inside `@daytonaio/sdk` 0.205.1, fast-glob is used only by
`Image.extractCopySources` (Dockerfile COPY sources); the repo imports only `Daytona`, `Sandbox`,
`DaytonaConflictError` and never builds an `Image`. No repo source imports fast-glob, micromatch,
tinyglobby, picomatch, minimatch or glob. fumadocs-mdx > tinyglobby is build-time over
`apps/docs/content` with patterns from `source.config.ts`. MCP citation corrected to
apps/cli/src/mcp-server/index.ts:1-6.

AC4 smoke command: build the CLI and packages/mcp-server, pipe `initialize`,
`notifications/initialized` and `tools/list` JSON-RPC lines over stdio into each, assert a non-empty
`result.tools`. DoD: PR body has `Fixes #670`, `Fixes #289`, `Fixes #346`.

### MCP SDK API surface

Both servers use only the low-level API: `Server` (`@modelcontextprotocol/sdk/server/index.js`),
`StdioServerTransport` (`server/stdio.js`), `ListToolsRequestSchema`/`CallToolRequestSchema`
(`types.js`), `setRequestHandler`, `connect` — apps/cli/src/mcp-server/index.ts:1-6,91-251 and
packages/mcp-server/src/index.ts:2-125. No `McpServer`, OAuth or HTTP transport is used, so the
1.30 → 1.32 advisories (OAuth credential leak, unbounded bodies on HTTP transports, task/session
binding) are fixed by the version and need no code change. Expected code diff: none.

CLI practices (automata-cli-practices) checked for this change: rule 10 (MCP never depends on PATH)
is not regressed because no CLI source changes; AC4's smoke covers "starts and answers `tools/list`".
Rules 1-9 and the command design rules are not exercised: no command, output or contract changes.

### picomatch residual (accepted-risk candidate, decision is the person's)

GHSA-fc5q-39xc-vjpf: ReDoS on a single-branch repeated extglob **pattern** (`+(*)`); the attacker must
control the glob pattern, not the path. Reachability evidence: the "Picomatch reachability, corrected"
paragraph above and docs/specs/670/gate-log.md (no user-controlled pattern reaches picomatch in a
production path).

## Phases (binding, from the validator)

1. zod pins 4.1.11 -> 4.6.7 in apps/www, packages/types, packages/cli-api-contract, packages/agent.
2. zod pins in packages/shared, daemon, sandbox; fumadocs-mdx 11.6.9 -> 11.10.1 (apps/docs);
   `@modelcontextprotocol/sdk` `^1.0.6` -> `^1.32.2` (apps/cli, packages/mcp-server).
3. Root overrides per the final table (superseded same-package entries deleted); regenerate
   pnpm-lock.yaml; `pnpm why -r` per package; no `undici8` alias left.
4. Full gates, MCP smoke, picomatch evidence, `docs/specs/670/gate-log.md`.

## Gates (each a real exit 0 unless stated)

- `CI=true pnpm install --frozen-lockfile --prefer-offline`
- `pnpm --filter @terragon/docs exec fumadocs-mdx`; `pnpm --filter @terragon/docs build`
- `pnpm turbo tsc-check`; `pnpm turbo lint`; `pnpm turbo format-check`
- vitest `--no-file-parallelism` for utils, knowledge, agent, shared, www, daemon, sandbox, migrate,
  worker, `@terragon-labs/cli`; `pnpm --filter @terragon/review test`
- audit assertion: high/critical module set of `pnpm audit --prod --json` is exactly `{picomatch}`
  (`pnpm audit --prod --audit-level high` itself exits 1 by construction while picomatch remains)
- `pnpm audit --prod --audit-level critical` (CI gate, ci.yml:40)
- `pnpm turbo build --filter='@terragon/www^...'`; `pnpm --filter @terragon/www e2e:build`
  locally; the CI `e2e` lane on the PR (AC3)
- AC4 MCP smoke for both servers

Notes for the PR: e2b >=2.56 declares `engines.node >=22.19.0` (2.52.1: >=20.18.1); CI and the box
run Node 24 and there is no `engine-strict`, so this is safe. e2b 2.64 adds glob ^14,
@e2b/dockerfile-utils and undici ^8.12.3; the after-audit confirms they add no high advisory.

## Open questions

- Accepting the picomatch residual: the person's call (ticket AC1 lists it as expected).
