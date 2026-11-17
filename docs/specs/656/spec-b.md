# #656 PR-B: cell contract, adapter and the daemon-token live gate

Ticket: be-automata/automata#656 (S5 of #634). This PR is "PR-B" of the 7-PR plan. Branch `feat/656-b-cell-contract`, off `main` at `2b8409e1`.

It covers:

- Scope items 5 (adapter half), 8, 9 (contract half and the live gate), 14 and 15 (cap, wildcard, untagged);
- AC-6, AC-7, AC-8, AC-16, and the gate half of AC-13.

Out of this PR:

- the migration and the liveness read (PR-A);
- wiring in www (PR-C);
- the run-end endpoint (PR-D);
- the cell image (PR-F);
- the worker (PR-E);
- the box (PR-G).

## Ground truth (verified in this worktree at `2b8409e1`)

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                                   | Where                                                        |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------- |
| `CellVaultAuth` is `"bearer"` only. Its comment says OpenSandbox `apiKey` needs a header name the type does not carry                                                                                                                                                                                                                                                                                                                  | `packages/types/src/cell.ts:30-34`                           |
| `CellVaultEntry` is `{ name, hosts, paths?, auth, credential }`                                                                                                                                                                                                                                                                                                                                                                        | `packages/types/src/cell.ts:36-43`                           |
| `CellTags` has no `deployment` key                                                                                                                                                                                                                                                                                                                                                                                                     | `packages/types/src/cell.ts:18-27`                           |
| `ICellProvider.listByTags(tags: Partial<CellTags>): Promise<CellListEntry[]>` takes no options                                                                                                                                                                                                                                                                                                                                         | `packages/types/src/cell.ts:134`                             |
| `CELL_MIN_TTL_MS = 60_000`. There is **no** run-TTL constant                                                                                                                                                                                                                                                                                                                                                                           | `packages/types/src/cell.ts:58`                              |
| The adapter's `vaultBody` emits `auth: { type: v.auth, credential: v.name }`                                                                                                                                                                                                                                                                                                                                                           | `packages/sandbox/src/providers/opensandbox-cell.ts:261-276` |
| `assertPlanFields` requires the tags `worker`, `epoch`, `stepKey`, `attempt`, `expiresAt`                                                                                                                                                                                                                                                                                                                                              | `opensandbox-cell.ts:224-233`                                |
| The adapter has no image guard: `config.image` goes straight into the create body                                                                                                                                                                                                                                                                                                                                                      | `opensandbox-cell.ts:626`                                    |
| Listing pages `LIST_PAGE_SIZE = 100` up to `MAX_LIST_PAGES = 1_000`                                                                                                                                                                                                                                                                                                                                                                    | `opensandbox-cell.ts:44-47`                                  |
| `reconcileExpiredCells({provider, revoke, now, logger, limit?, random?})`: expired means `expiresAt` is past or the tags are unreadable. There is no liveness input                                                                                                                                                                                                                                                                    | `packages/sandbox/src/cell/reconcile.ts:17-75`               |
| `buildCellCreatePlan` builds the vault with `model` and `broker` entries and no daemon entry                                                                                                                                                                                                                                                                                                                                           | `packages/shared/src/model/cell-create-plan.ts:74-95`        |
| `compileCellEgress` (`:334`) feeds both `toAgent37Network` (`:410`) and `toOpenSandboxNetworkPolicy` (`:428`)                                                                                                                                                                                                                                                                                                                          | `packages/shared/src/model/cell-egress.ts`                   |
| The live IT accepts a wildcard policy through the adapter, so a refusal in the adapter would break that IT                                                                                                                                                                                                                                                                                                                             | `opensandbox-cell.integration.test.ts:464`                   |
| **Upstream (OpenSandbox `release-1.2.1`)**, `specs/sandbox-lifecycle.yml:2900-2980`: binding auth `type` is one of `bearer`, `basic`, `apiKey`, `customHeaders`, `passthrough`. `apiKey` needs `name` (the header name) and `credential`. Every static kind accepts optional `substitutions: [{ credential, placeholder, in: [path\|query\|header\|body] }]`, a literal, case-sensitive placeholder replacement scoped to that binding | upstream spec, read via `gh api`                             |
| The daemon's only call to www is `POST <www>/api/daemon-event` with `X-Daemon-Token`                                                                                                                                                                                                                                                                                                                                                   | `packages/daemon/src/runtime.ts:219-235`                     |

## Contract

### 1. Types (`packages/types/src/cell.ts`)

- **`CellVaultAuth`** becomes a discriminated shape on `CellVaultEntry`:
  - `auth: "bearer"` stays as it is.
  - New: `auth: "apiKey"` with a required `header: string`. It must match the upstream pattern `^[A-Za-z0-9!#$%&'*+\-.^_\`|~]+$`.
  - Optional on both: `placeholder?: string`. When set, the adapter adds a `substitutions` entry replacing that literal in the header.
  - Update the comment.
- **`CellTags.deployment: string`**, a required tag.
- **Header comment:** update it at `cell.ts:1-5`. The module now exports a runtime helper (`wasTruncated`) alongside its constants.
- **`listByTags(tags, opts?: { maxPages?: number })`** keeps returning `CellListEntry[]`. That way every existing caller and mock is unchanged: `reconcile.ts:93`, the adapter's adoption at `opensandbox-cell.ts:692-697`, the IT at `integration.test.ts:434,697,728-729`, the adapter tests `opensandbox-cell.test.ts:1401-1807`, and the mocks at `reconcile.test.ts:17` and `cell-control.test.ts:99`.
  - **Truncation signal:** the returned array carries a non-enumerable `truncated` boolean (`Object.defineProperty`), exposed through the exported helper `wasTruncated(entries): boolean` in `@terragon/types/cell`. Without `maxPages`, the 1,000-page fail-closed behaviour is unchanged.
- **`CELL_RUN_TTL_MS`**, exported, and used by this PR for `ttlMs` in `cell-plan/route.ts` (replacing `CELL_STEP_TIMEOUT_MS` there, `route.ts:45,157`). `stepTimeoutMs` (`:144`) follows it too, so the step and its bearer share one bound (ADR-014). Value: `45 * 60 * 1000`, the run's 30-minute execution timeout plus a 15-minute teardown margin (#656 R6). The doc comment names `packages/worker/src/agent-run/definition.ts:200` as the source, which PR-E pins with a test.

### 2. Adapter (`packages/sandbox/src/providers/opensandbox-cell.ts`)

- **`vaultBody`:**
  - `bearer` gives `{ type: "bearer", credential }`.
  - `apiKey` gives `{ type: "apiKey", name: header, credential }`.
  - Either one, with `placeholder`, adds `substitutions: [{ credential: name, placeholder, in: ["header"] }]`.
  - A placeholder or header that is blank or doesn't match the pattern is refused in `guardPlan` with `CellProviderError("invalid_plan", "create")`, before any HTTP call. Neither value is ever echoed in the error.
- **Empty-image refusal:** a blank `config.image` makes `create()` throw `CellProviderError("invalid_config", "create")` before `guardPlan` and before any HTTP call. A new error code. It goes in `create`, **not** at construction: www builds the provider with an empty image for the reconciler and teardown (`cell-gate.ts:17-21`, `apps-www.ts:116`, `cell-control.test.ts:8,52`).
- **Deployment tag:** `assertPlanFields` also requires `deployment`.
- **Page cap:** `listByTags` honours `opts.maxPages`, defaulting to the existing `MAX_LIST_PAGES`. A server still paging at the cap returns what it has, marked truncated. Without `maxPages`, the current fail-closed behaviour is kept.
- **Client-side filter:** the existing filter at `opensandbox-cell.ts:518-519` also drops entries whose `deployment` differs from the requested one, so a server that ignores the metadata filter can never hand back another deployment's cells.

### 3. Reconciler (`packages/sandbox/src/cell/reconcile.ts`)

- **New inputs:**
  - `deployment: string`: list with `{ deployment }`, so untagged cells and other deployments' cells are never listed (ticket Scope 15).
  - `maxPages?: number`, default 5.
  - `isDead?: (keys: CellKey[]) => Promise<Set<string>>`, keyed `stepKey + "#" + attempt`. `CellKey` is exported. It returns only the keys it **positively knows are dead**, so an unknown or unread key is kept. A short, partial or empty answer can never reap a live cell.
- **When `isDead` is given,** a cell that has not expired is also reaped when its key **is** in the returned set.
- **If `isDead` throws,** the reconciler logs once and falls back to expiry only. That is fail-safe: a read error reaps nothing extra (AC-5's last clause).
- **`ReconcileResult`** gains `dead: number` and `truncated: boolean`.
- **Unchanged:** revoke-before-teardown order, shuffle and limit.

### 4. Plan builder (`packages/shared/src/model/cell-create-plan.ts`)

- **New input fields:** `deployment: string` (`tags`) and `daemonToken?: string`. A present `daemonToken` must pass `assertNonBlank`, before `mintBearer` (`cell-create-plan.ts:98-100,129`). The placeholder must be non-blank; upstream requires only `minLength: 1`, and it is not held to the header-name pattern.
- **Daemon vault entry,** when `daemonToken` is present: `{ name: "daemon", hosts: [brokerHost], paths: ["/api/daemon-event"], auth: "apiKey", header: "X-Daemon-Token", credential: daemonToken, placeholder: CELL_DAEMON_TOKEN_PLACEHOLDER }`.
  - The placeholder is a new exported constant, a fixed non-secret string.
  - The path is **exactly** `/api/daemon-event`, never a glob (ticket Scope 9).
- **`ttlMs`** must not exceed `CELL_RUN_TTL_MS`; longer is a `RangeError`.
- **Wildcards:** a compiled egress set holding any wildcard entry is refused with `CellPlanError("egress_wildcard")`.
  - **Fixtures:** `test/wild@1` (`*.example.org`, `__fixtures__/cell-egress.ts:8`) leaves the default plan inputs, `cell-create-plan.test.ts:52`, the order test `:262-265` and `cell-create-plan-compose.test.ts:18`. It stays only in the new refusal test. It goes in the plan builder only, so `toAgent37Network`, `compileCellEgress` and the IT's direct adapter policy are untouched (ticket Scope 15). `CellPlanErrorCode` gains it.
- **Order** still holds: every refusal happens before `mintBearer`.

### 5. Live gate (`packages/sandbox/src/providers/opensandbox-cell.integration.test.ts`, `OPENSANDBOX_IT=1`)

A new scenario, run before AC-8.

- **Binding:** the cell's vault gets the **production binding shape**, built with the plan builder's own daemon-entry function and `CELL_DAEMON_TOKEN_PLACEHOLDER`. Only the host is `httpbin.org` and the path `/anything/daemon-event`. The credential is `CANARY_C`.
- **New probe kind:** the harness's probe (`opensandbox-it/harness.ts:213-216,304-315`) only sends `user-agent` and returns one marker. In the new probe, `CANARY_C` goes into the argv only base64-encoded (`encodeSecret`, `marker_b64`, as `https` does at `harness.ts:215,424-427`), because execd logs the command (`cell.ts:88-91`). The non-secret placeholder `P` may stay plain. So `harness.ts` gains a `kind: "https_headers"` probe. It sends given request headers with **POST**, which is what the daemon sends. It returns booleans per marker, computed in the guest, never the body.
- **Why two markers:** httpbin joins a repeated header into one string, so an append (`P,CANARY_C`) contains `CANARY_C`. Every check therefore tests both markers.

1. **Replaced, not appended:** POST `/anything/daemon-event` with `X-Daemon-Token: P` shows `CANARY_C` present **and** `P` absent.
2. **Header absent:** the same POST without the header records what the echo shows. This is evidence, not a pass condition.
3. **Exact path:** POST to `/anything/daemon/cell-plan`, `/anything/daemon-event/x` and `/anything/daemon-eventx`, each with `X-Daemon-Token: P`, shows `P` present **and** `CANARY_C` absent.
4. **Canary scan:** the AC-6 machinery still finds `CANARY_C` nowhere in the guest's `/proc/*/environ` or `cmdline`, `docker inspect`, or the logs. The httpbin echo sending it back to the guest is the test's own reflection, as with `/bearer` in S3.

The IT `plan()` helper (`integration.test.ts:140-147`) and its reconciler calls (`:661,703`) gain `deployment`.

Each result goes into the evidence notes (`NOTES.daemon_apikey_*`). Checks 1 and 3 failing fails the test. That outcome is what sends PR-E to the fallback (ticket Scope 9).

## Acceptance (this PR)

- AC-6, AC-7, AC-8 and AC-16: unit tests in `opensandbox-cell.test.ts`, `reconcile.test.ts`, `cell-create-plan.test.ts`, `cell-create-plan-compose.test.ts` and `cell-egress`-adjacent plan tests.
- **Gate half of AC-13:** the live IT scenario above, run outside the Claude sandbox, with results in `docs/specs/656/gate-log-b.md`.

## Tests (each a negative control where it guards security)

- **Vault body:** apiKey and substitutions shape; bearer unchanged; an invalid header or placeholder refused with no fetch; no log, error or `JSON.stringify(error)` contains the credential or placeholder (canary test).
- **Image:** an empty or blank image is refused in `create()`, with no fetch. Construction with an empty image still succeeds.
- **Tags:** a plan missing `deployment` refused.
- **Listing:** `listByTags` with `maxPages: 2` against a fake server with 5 pages returns 200 entries, and `wasTruncated(out)` is true. Assert that with `wasTruncated`, never `toEqual`, which ignores a non-enumerable property. `wasTruncated([...out])` is false, which documents that copies drop the flag. Without `maxPages`, the 1,000-page fail-closed path is unchanged.
- **Reconciler:** it reads `wasTruncated` on the array `listByTags` returned, before any `.map` (`reconcile.ts:103`).
- **Reconciler:**
  - lists with `{ deployment }`;
  - reaps a dead-but-unexpired cell, revoke first;
  - leaves a live one;
  - an `isDead` throw reaps nothing beyond expiry;
  - **an empty or partial `isDead` set reaps nothing extra** (negative control);
  - `truncated` is passed through.
- **Adapter filter:** with a server that ignores the metadata filter, `listByTags({ deployment: "a" })` drops another deployment's cells (negative control).
- **Harness:** `https_headers` returns booleans only, never the body. Its `harness.test.ts` covers the request it builds and that it parses both markers.
- **Plan:**
  - the daemon entry's exact shape and exact path;
  - no daemon entry without `daemonToken`;
  - a wildcard egress refused before `mintBearer` (spy not called);
  - a TTL over `CELL_RUN_TTL_MS` refused.

## Gates (worktree root)

- `pnpm install --frozen-lockfile --prefer-offline`; build `--filter=@terragon/sandbox... --filter=@terragon/bundled --filter=@terragon/sandbox-image`.
- `pnpm --filter @terragon/docs exec fumadocs-mdx`, then `pnpm turbo tsc-check --force` and `pnpm turbo lint --force`.
- Prettier on the changed files: `pnpm exec prettier --no-editorconfig --config .prettierrc --check`.
- `pnpm --filter @terragon/sandbox exec vitest run --no-file-parallelism`.
- `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism`.
- `pnpm --filter @terragon/www exec vitest run --no-file-parallelism`: callers of `listByTags` or `reconcileExpiredCells` in www must compile and pass. `cell-control.ts` is PR-C's, so here only adapt the call shape it needs to keep compiling.
- `OPENSANDBOX_IT=1 pnpm --filter @terragon/sandbox exec vitest run --no-file-parallelism src/providers/opensandbox-cell.integration.test.ts`, outside the Claude sandbox.

## Risks

- **Breaking signatures.** Verified production callers:

  - `listByTags` is called only in `reconcile.ts:93` and the adapter's own `create` (`opensandbox-cell.ts:692`, which passes no `maxPages`).
  - `reconcileExpiredCells` is called only in `apps/www/src/server-lib/compute/cell-control.ts:92`.
  - `buildCellCreatePlan` is called only in `apps/www/src/app/api/daemon/cell-plan/route.ts`.
  - In www this PR changes only:

    - `cell-plan/route.ts`: `deployment: cellBrokerHost()` (via `cell-gate.ts`), plus `ttlMs` and `stepTimeoutMs` to `CELL_RUN_TTL_MS` (`:45,144,157`);
    - `cell-plan/route.test.ts`;
    - `cell-control.ts`'s reconciler call (`deployment`);
    - `cell-control.test.ts`.

    Everything else in those files belongs to PR-C, which rebases on this.

- **Upstream substitution semantics are untested until the live gate.** If check 1 shows an append or no replacement, this PR still merges with the type and adapter support, and the gate log records the failure for PR-E.

## Validate history

- **Cycle 2:** PASS_WITH_WARNINGS. Five small fixes, folded in: probe canary base64 in argv, image test wording, www change list, `cell.ts` header comment, and the truncation assertion and read order.
- **Cycle 1:** BLOCK. Eight required fixes, all folded in above:
  1. the TTL cap and the route;
  2. the `listByTags` shape;
  3. the image refusal moved into `create`;
  4. wildcard fixtures;
  5. a live-gate probe that tells replace from append;
  6. near-miss paths and POST;
  7. `isDead` keeps unknown keys;
  8. `daemonToken` non-blank, exported `CellKey`, and IT `deployment`.

## Phases (the validator's, 5 files at most each)

1. **Types and adapter:** `packages/types/src/cell.ts`, `opensandbox-cell.ts`, `opensandbox-cell.test.ts`.
2. **Reconciler and www call shape:** `reconcile.ts`, `reconcile.test.ts`, `cell-control.ts` (the `deployment` line), `cell-control.test.ts`.
3. **Plan builder:** `cell-create-plan.ts`, `cell-create-plan.test.ts`, `cell-create-plan-compose.test.ts`, `__fixtures__/cell-egress.ts`.
4. **www route:** `cell-plan/route.ts`, `cell-plan/route.test.ts` (deployment, `CELL_RUN_TTL_MS`).
5. **Live gate:** `opensandbox-it/harness.ts`, `harness.test.ts`, `opensandbox-cell.integration.test.ts`, `docs/specs/656/gate-log-b.md`.
6. **Full gates.**
