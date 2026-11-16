# #634 S1 — cell contract, OpenSandbox policy renderer, create-plan builder

Slice 1 of 5 (stack: S1 contract → S2 adapter → S3 IT harness → S4 control plane → S5 worker/box).
Ticket: be-automata/automata#634 (body as published 2026-11-16). Decisions: OD-1 split by plane, OD-2
upstream BOM by digest, OD-4 dind in IT / dedicated rootless on the box (see the ticket's Open decisions).

## Scope of S1

Library code only. No HTTP client, no DB schema, no migration, no wiring, no worker change.

1. **New `packages/types/src/cell.ts`** (no new dependencies; imported as `@terragon/types/cell`
   through the existing `"./*"` export, `packages/types/package.json`; `src/index.ts` is NOT edited):
   Object shapes are `interface` (repo TS rule: public contract); unions are `type`.
   - `interface OpenSandboxNetworkRule { action: "allow" | "deny"; target?: string; ports?: number[] }`
   - `interface OpenSandboxNetworkPolicy { defaultAction: "deny"; egress: OpenSandboxNetworkRule[] }`
   - `interface CellTags { automata: "cell"; worker: string; epoch: string; stepKey: string; attempt: string; expiresAt: string }`
     (all strings: OpenSandbox `metadata` is a string map; `expiresAt` is **epoch milliseconds as a decimal string**, as the spike used, `run.mjs:366`, so the value stays label-safe).
   - `type CellVaultAuth = "bearer"` (S2 narrowed it: OpenSandbox `apiKey` needs a header name and `basic` needs base64 `user:pass`, which this type does not model)
   - `interface CellVaultEntry { name: string; hosts: string[]; paths?: string[]; auth: CellVaultAuth; credential: string }` —
     maps 1:1 onto OpenSandbox's vault (`credentials[{name, source:{type:"inline", value: credential}}]` + `bindings[{name, match:{hosts, paths}, auth:{type: auth, credential: name}}]`, spike 058 `run.mjs:239-247,424-426`). The provider adds the `Bearer ` prefix itself, so `credential` is the raw secret. `credential` is a secret: never logged, never in an error message.
   - `interface CellResources { cpu: number; memoryMiB: number }`
   - `interface CellCreatePlan { runtime: "runc"; tags: CellTags; networkPolicy: OpenSandboxNetworkPolicy;
vault: CellVaultEntry[]; resources: CellResources; ttlMs: number; egressDigest: string; profileId: string }`.
     The plan carries raw secrets; **sealing it for transport is S4's** (the `@terragon/utils/payload-seal` pattern, #380). S1 adds no `toJSON`, no logging path.
   - Deviation from the ticket's `create({tags, egress, resources, ttlMs, bearer})`: `create(plan: CellCreatePlan)` carries the same inputs pre-rendered (OD-1). The type always has a policy; AC2's "create without a policy is refused" stays a runtime check in S2 (an untyped caller).
   - `ICellProvider` (implemented in S2, reused by #635):
     `create(plan) → Promise<{ cellId: string }>`, `exec(cellId, argv, opts?) → Promise<{ exitCode; stdout; stderr }>`,
     `copyOut(cellId, path) → Promise<Uint8Array>`, `revoke(cellId) → Promise<void>` (provider-side vault clear),
     `quarantine(cellId) → Promise<void>` (deny-all, drop established), `delete(cellId) → Promise<"deleted" | "gone">`
     (404 = gone), `listByTags(tags: Partial<CellTags>) → Promise<{ cellId: string; tags: Record<string,string> }[]>`.
     Types only; no implementation in S1.
2. **`packages/shared/src/model/cell-egress.ts`**: new pure `toOpenSandboxNetworkPolicy(set: CellEgressSet): OpenSandboxNetworkPolicy`
   beside `toAgent37Network` (`:389`) and `toProxyShape` (`:394`). It uses the same `assertRenderable(set)` list
   (`:287`; a wildcard emits `*.x` AND its apex, cap 100, empty refused) and renders
   `{ defaultAction: "deny", egress: [ ...names.map(n => ({ action: "allow", target: n })), { action: "deny", ports: [80] } ] }`.
   The trailing targetless port-80 deny is required: domain rules are not port-scoped, so :80 on an allowed host is
   open without it (spike 058 README:108; upstream `docs/architecture/network/egress.md:37,41` at `db708c21`).
   `shared` may import `@terragon/types` (check `packages/shared/package.json` deps; add `"@terragon/types": "workspace:*"`
   only if absent).
3. **New `packages/shared/src/model/cell-create-plan.ts`**: `async buildCellCreatePlan(input, deps): Promise<CellCreatePlan>`; pure apart from injected deps.
   - input: `{ stepKey: string; attempt: number; ttlMs: number; egressRefs: readonly string[]; egress: CompileCellEgressDeps; profile: CellPolicyProfile; tags: Pick<CellTags,"worker"|"epoch">; resources: CellResources; modelToken: string; runtime: string }` (`profile` non-null, so `profile.id` type-checks without `!`).
   - deps: `{ now: () => Date; mintBearer: (args: { stepKey: string; attempt: number; ttlMs: number }) => Promise<{ ok: true; token: string; expiresAt: Date } | { ok: false; reason: string }> }` —
     a structural type; at most an `import type` from `cell-authority`, never a value import (it imports `DB`, `cell-authority.ts:5`). The caller binds `db` to `mintBearer` (`cell-authority.ts:183`).
   - Order, each step only after the previous succeeded: 0. `ttlMs` not a positive finite number → throw `RangeError` (before the guard, so mint's own `RangeError` never fires after a guard pass).
     1. `runtime !== "runc"` → throw `CellPlanError("runtime_not_runc")` (ticket Contract › Runtime).
     2. `compileCellEgress(egressRefs, egress)` (`cell-egress.ts:313`) → `CellEgressError` propagates.
     3. `toOpenSandboxNetworkPolicy(set)`.
     4. `assertCellEgressEnforced({ profile, now: deps.now() })` (`cell-egress-guard.ts:49`) → `CellEgressNotEnforcedError` propagates.
     5. `deps.mintBearer({ stepKey, attempt, ttlMs })`; `{ ok:false, reason }` → throw `CellPlanError("bearer_refused", reason)`.
   - Output: a `CellCreatePlan` with
     `vault = [{ name: "model", hosts: [CELL_EGRESS_MODEL_HOST], paths: ["/v1/*", "/api/*"], auth: "bearer", credential: modelToken },
{ name: "broker", hosts: [egress.brokerHost], paths: ["/api/cell/*", "/api/v3/*", "/api/graphql"], auth: "bearer", credential: bearer.token }]`
     (model paths as spike 058 `run.mjs:426`; the broker serves git at `apps/www/src/app/api/cell/git/[...path]/route.ts:5` and the gh broker at `apps/www/src/app/api/v3/[[...path]]/route.ts:3` and `apps/www/src/app/api/graphql/route.ts:3`; a `*` glob spans segments, spike 058 `out/cred-after-vault.json`). S1 assumes the model credential is a Claude OAuth token (`bearer`); an API key is out of scope.
     `tags = { automata: "cell", ...input.tags, stepKey, attempt: String(attempt), expiresAt: String(bearer.expiresAt.getTime()) }`,
     `egressDigest = set.digest`, `profileId = profile.id`.
   - Guard before mint: a refused profile mints nothing (no bearer row); refusal before any provider call is S2's AC1 half.
   - `CellPlanError` carries `code: "runtime_not_runc" | "bearer_refused"` and `reason?: string`; message never contains a token.

## Ground truth (verified on origin/main 0fc79328, 2026-11-16)

- `compileCellEgress(refs, deps): CellEgressSet` at `packages/shared/src/model/cell-egress.ts:313`; `CellEgressSet` `:38`; `CompileCellEgressDeps` `:44`; `CELL_EGRESS_MODEL_HOST = "api.anthropic.com"` `:51`.
- `toAgent37Network` `:389`, `toProxyShape` `:394` (returns `{level:"domain", allowlist: names.map(n => n+":443")}`), `assertRenderable` `:287`, `renderedNames` `:277`.
- `assertCellEgressEnforced({profile, now})` at `cell-egress-guard.ts:49`, throws `CellEgressNotEnforcedError(reason)`; profile type `CellPolicyProfile` from `../cell-policy/cell-policy` (`:40` id, `:44` capabilities, `:45` evidence).
- `mintBearer({db, stepKey, attempt, ttlMs})` at `cell-authority.ts:183`, refusal reasons `ttl_exceeds_step_timeout | fenced | unknown_step | step_done | revoked`; throws `RangeError` for a non-positive ttl.
- Existing parity test `packages/shared/src/model/cell-egress-parity.test.ts` (Agent37 vs proxy via `matchEgress`); fixtures `./__fixtures__/cell-egress` (`BROKER`, `CATALOG`).
- `packages/types/src/` holds `broadcast.ts`, `index.ts`, `sandbox.ts`; no `cell.ts`. Nothing named `ICellProvider`/`CellCreatePlan`/`toOpenSandboxNetworkPolicy` exists in packages/ or apps/.
- `packages/types/src/sandbox.ts:2` `SandboxProvider` union is NOT changed (stored in the DB; cells resolve by profile).
- No production caller of the builder in S1 (S4 adds it). Already done: compiler, guard, bearer mint/verify/revoke (#597, #611).

## Acceptance (S1's share of the ticket)

- S1-a (AC1, refusal half): with a profile the guard refuses, `buildCellCreatePlan` throws `CellEgressNotEnforcedError` and `mintBearer` is never called (spy).
- S1-b (AC2, runtime half): `runtime: "runsc"` / `"gvisor"` / `""` → `CellPlanError("runtime_not_runc")` before compile and mint (spies).
- S1-c (AC1, render half): the plan's `networkPolicy` equals `toOpenSandboxNetworkPolicy(compileCellEgress(...))` exactly, ends with `{action:"deny", ports:[80]}`, and has `defaultAction: "deny"`.
- S1-d (parity): for the parity fixture set, the allow targets equal `toProxyShape(set).allowlist` with `:443` stripped, as sets; a wildcard yields both `*.x` and `x`.
- S1-e: an empty set and a set over the cap are refused by the renderer (same `CellEgressError` codes as the other renderers). The sets are hand-built, because `compileCellEgress` already refuses them (`cell-egress.ts:384`; pattern `cell-egress.test.ts:362`).
- S1-g: a non-positive `ttlMs` throws `RangeError` before the guard and mint (spies).
- S1-h: the vault holds exactly two entries, model (`/v1/*`, `/api/*`) and broker (`/api/cell/*`, `/api/v3/*`, `/api/graphql`), bound to their hosts; `tags.expiresAt` is the bearer's expiry in epoch ms.
- S1-f: bearer refusal → `CellPlanError("bearer_refused", reason)`; the thrown message contains neither token.
- Noted for S3 (not S1): wildcard targets (`*.x`) and a 101-rule policy were never sent to OpenSandbox in spike 058; the IT harness covers both.
- AC 3–8 and UAT: deferred to S2–S5 (adapter, IT harness, control plane, worker); listed in the PR.

## Gates (from the worktree root)

`pnpm turbo tsc-check`, `pnpm turbo lint`, `pnpm turbo format-check`, `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism src/model/cell-egress src/model/cell-create-plan` then the full shared suite. Coverage: GAP (#605).

## Phases (file cap 6)

- P1 (4 files): `packages/types/src/cell.ts` (new), `packages/shared/src/model/cell-egress.ts`, `cell-egress.test.ts`, `cell-egress-parity.test.ts` (+ `packages/shared/package.json` only if the types dep is missing — counted, cap 6 holds).
- P2 (2 files): `packages/shared/src/model/cell-create-plan.ts` (new), `cell-create-plan.test.ts` (new).

## Constraints

No new runtime dependencies. No `any`. No env reads. No logging of tokens. kebab-case files. Format with
`pnpm exec prettier --no-editorconfig --config .prettierrc`. runc only (ticket Contract › Runtime).
