# refactor(shared): one opaque-token helper for self-heal and cell-authority tokens

This is a follow-up to #597 / #598, raised by its `/simplify` reuse pass. Two places mint and hash bearer tokens in the same format, and each has its own copy of the code. If one copy changes its encoding or length and the other does not, the stored hashes stop matching and nothing reports it. This ticket moves the helpers into one shared module. Behaviour does not change.

**Depends on #597** (merge it first: it adds the second copy).

## Reality check on be-automata/automata@80ce4154 (+ #597 at d78486f)

- `apps/www/src/server-lib/audit/plan-self-heal-run.ts:96-113`:
  - `mintSelfHealToken()` is 32 random bytes as base64url;
  - `hashSelfHealToken()` is the sha256 hex of the token;
  - `selfHealTokenMatches()` hashes the presented token, then does a constant-time compare.
- **Callers today:**
  - in that same file, lines 230/238 (check token) and 423/429 (gate token);
  - `app/api/self-heal/audit-checks/route.ts`;
  - `app/api/self-heal/fix-check/route.ts`;
  - tests in `agent/hatchet/dispatch.test.ts`, both route tests, and `plan-self-heal-run.test.ts`.
- **#597** `packages/shared/src/model/cell-authority.ts` repeats the same format: `hashToken` (sha256 hex) and `randomBytes(32).toString("base64url")` in `mintBearer`. `packages/shared` cannot import from `apps/www`, which is why the code was copied.
- **Different formats, out of scope:**
  - `credential-broker/resolve-credential-broker.ts:127` uses hex, not base64url;
  - the content hashes in `knowledge`, `migrate` and `sandbox`.

## Contract

- New module `packages/shared/src/lib/opaque-token.ts` (or the nearest existing `lib` location in shared), exporting:
  - `mintOpaqueToken(): string`, which returns 32 random bytes as base64url;
  - `hashOpaqueToken(token: string): string`, which returns the sha256 hex digest;
  - `opaqueTokenMatches(presented: string, storedHash: string): boolean`, a constant-time comparison.
- `plan-self-heal-run.ts` re-exports or wraps these under its current names, or its callers switch to the new names. Either way, `mintSelfHealToken`/`hashSelfHealToken` do not keep their own implementation.
- `cell-authority.ts` uses `mintOpaqueToken`/`hashOpaqueToken`.
- No schema change and no migration. The stored hashes stay byte-identical.

## Acceptance Criteria

- AC1: One implementation of the mint/hash/match format exists in the repo, in `packages/shared`. A grep finds no other `randomBytes(32).toString("base64url")` paired with a sha256 hex token hash in `apps/www` or `packages/shared`.
- AC2: Hashes are compatible. Pinned vectors assert that `hashOpaqueToken(t)` equals the value the old `hashSelfHealToken(t)` produced.
- AC3: The minted format is unchanged: 43 characters, base64url alphabet, and a distinct token per call.
- AC4: `opaqueTokenMatches` returns true for the right token, false for a wrong token, and false for a stored hash of a different length (no throw).
- AC5: Existing behaviour holds. The self-heal route tests, `plan-self-heal-run.test.ts`, `dispatch.test.ts` and `cell-authority.test.ts` pass unchanged, apart from import paths.

## Tests

- AC2–AC4: new `packages/shared/src/lib/opaque-token.test.ts`.
- AC1: grep evidence in the PR description.
- AC5: `pnpm --filter @terragon/www exec vitest run` (self-heal, hatchet dispatch) and `pnpm --filter @terragon/shared exec vitest run src/model/cell-authority.test.ts`.
- Typecheck: `pnpm turbo tsc-check`.

## UAT

| Tier     | What                                            | Who |
| :------- | :---------------------------------------------- | :-- |
| T0 local | the suites above against the throwaway Postgres | dev |
| T1a CI   | full suites on the PR                           | CI  |

No deploy-tier UAT. Stored hashes do not change, so tokens already minted keep verifying.

---

## Ground truth (verified at write time against origin/main b90d6c5b, worktree .claude/worktrees/gh-599)

- Dependency #597 is MERGED (6e47bcc0). `packages/shared/src/model/cell-authority.ts` exists:
  - line 1 `import { createHash, randomBytes } from "node:crypto";`
  - lines 56-57 private `hashToken = (token) => createHash("sha256").update(token).digest("hex")`, used at lines 219 (mintBearer insert) and 263 (bearer lookup);
  - line 215 `const token = randomBytes(32).toString("base64url");` inside `mintBearer`.
- `apps/www/src/server-lib/audit/plan-self-heal-run.ts` line 1 imports `createHash, randomBytes, timingSafeEqual`; lines 96-113 hold `mintSelfHealToken`, `hashSelfHealToken`, `selfHealTokenMatches` exactly as the ticket says. Internal callers at 230/238/423/429.
- External importers of those names (all from `@/server-lib/audit/plan-self-heal-run`): `app/api/self-heal/audit-checks/route.ts` (+test), `app/api/self-heal/fix-check/route.ts` (+test), `agent/hatchet/dispatch.test.ts`, `plan-self-heal-run.test.ts`. `dispatch.ts`'s `splitSelfHealToken` is unrelated (name collision only).
- `packages/shared/src/lib` does NOT exist. The nearest existing location is `packages/shared/src/utils/` (git-diff.ts, sanitize-json.ts, thread-utils.ts, timezone.ts), importable as `@terragon/shared/utils/<name>` via the `"./*": "./src/*.ts"` export (www already imports `@terragon/shared/utils/git-diff`). New module: `packages/shared/src/utils/opaque-token.ts`.
- Other `randomBytes(32).toString("base64url")` in the repo: `packages/worker/dev/canary/run-input.ts:222` (`mintCanaryDaemonToken`, a dev canary stub, not paired with a sha256 hash, and outside AC1's `apps/www` + `packages/shared` scope). Left unchanged.
- No `@vitest/coverage-v8` (or any coverage provider) is installed in the workspace.

## Decisions

- Path: the module is `packages/shared/src/utils/opaque-token.ts` and its test `packages/shared/src/utils/opaque-token.test.ts` (the ticket's "nearest existing lib location"; `src/lib` does not exist). This supersedes `src/lib/` in the Contract and Tests sections above.
- The `node:crypto` imports left unused in both files are removed (noUnusedLocals).
- AC1 grep evidence is scoped: `git grep ... -- apps/www packages/shared`.

- `plan-self-heal-run.ts` keeps its exported names as re-export aliases of the shared helpers (`export { mintOpaqueToken as mintSelfHealToken, ... } from "@terragon/shared/utils/opaque-token"`), and its internal call sites use them via an import. No implementation remains there, so callers and tests are untouched (AC5 "unchanged").
- `cell-authority.ts` drops its private `hashToken` and inline `randomBytes`, using `hashOpaqueToken` / `mintOpaqueToken`.
- `opaqueTokenMatches` is moved verbatim (same utf8 buffers, length check before `timingSafeEqual`).
- Coverage gate (person's choice): `vitest run --coverage` on the new test, 100% on opaque-token.ts — no provider installed, so it is reported as a GAP, not added as a dependency. Branch completeness is shown by the tests covering both branches of the length check.

## Gates (from CLAUDE.md verification commands, worktree root)

- install `pnpm install --frozen-lockfile --prefer-offline`
- typecheck `pnpm turbo tsc-check` (with `pnpm --filter @terragon/docs exec fumadocs-mdx` first)
- lint `pnpm turbo lint`; format `pnpm turbo format-check`
- test `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism src/utils/opaque-token.test.ts src/model/cell-authority.test.ts` and `pnpm --filter @terragon/www exec vitest run --no-file-parallelism src/server-lib/audit/plan-self-heal-run.test.ts src/app/api/self-heal src/agent/hatchet/dispatch.test.ts`
