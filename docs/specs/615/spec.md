# #615: the forged-capability test is not always a forgery

Ticket: https://github.com/be-automata/automata/issues/615 (hardened 2026-11-17).
Base: `origin/main` @ `c596e47f0c077897f3c86d1dd391fd8c5d081252`.

## Problem

Two tests in `apps/www/src/app/api/addon-callback/[capability]/route.test.ts` forge a callback
capability as `${payload}.${signature.slice(0, -2)}AA` and expect it refused:

- `:120-123`, unit test "round-trips, and refuses tampering, another key, expiry and an empty
  secret": `expect(verifyCallbackCapability(SECRET, \`${p}.${s.slice(0, -2)}AA\`)).toBeNull()`.
- `:186` and `:199-206`, route test "refuses a forged, foreign-key, expired or disabled capability
  with 401 and stores nothing": `expect((await post(cap, result(f))).status).toBe(401)`.

The signature is `base64url(HMAC-SHA256(secret, payload))` (`apps/www/src/server-lib/addon/callback-capability.ts:31-33,63`):
32 bytes, 43 characters. 42 characters carry 252 bits; the 43rd carries the last 4 bits and 2 zero
padding bits (Node writes canonical base64url). The verifier decodes the signature and compares
bytes (`callback-capability.ts:76-78`).

The old tamper yields the same bytes exactly when character 42 is already `A` (1/64) and the 4
significant bits of character 43 are `0000` (1/16, and canonical encoding then makes it `A`): the
real signature already ends in `AA`, so the "forgery" is the unchanged capability. Rate 1/1024 per
forgery, two per file run, about 1/512 per run. CI run 43650292577 on #613 hit it
(`expected 200 to be 401`).

## Ground truth (verified in this worktree at write time)

| Fact                                                                                                                                                                                                           | Evidence                                                                |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------- |
| Only two uses of the tamper in the repo                                                                                                                                                                        | `git grep 'slice(0, -2)}AA'` → `route.test.ts:122`, `route.test.ts:200` |
| No tamper helper exists in the test file or under `apps/www/src` test helpers                                                                                                                                  | read of `route.test.ts` (284 lines); no `forge` identifier              |
| `signCallbackCapability(secret, claims)` and `verifyCallbackCapability(secret, cap, now?)` are exported and already imported by the test                                                                       | `route.test.ts:8-11`                                                    |
| The route answers 401 on a null verification                                                                                                                                                                   | `route.ts:57-61`                                                        |
| Measured: old tamper accepted 180 / 200,000 random secrets (0.00090), new tamper 0 / 200,000; first accepted case secret `749e6d763ffdf0f6eb6c4c4ac3f999fb`, sig `vGnA-PhtuF77p-gFjv4Q3WtrlScgR-fEJXRbZGRu6AA` | scratch script against the real module (see gate log)                   |
| Nothing is already done for this ticket                                                                                                                                                                        | branch `fix/615-forged-capability-flake` = `origin/main`                |
| The repo keeps specs in `docs/specs/<key>/`                                                                                                                                                                    | `git ls-files docs/specs`                                               |

## Change

One file: `apps/www/src/app/api/addon-callback/[capability]/route.test.ts`.

1. A module-level helper:

   ```ts
   /** `capability` with its first signature character changed. That character holds the top six
    * bits of the MAC's first byte, so the decoded signature always differs (#615). */
   function forge(capability: string): string {
     const [payload = "", signature = ""] = capability.split(".");
     const first = signature.startsWith("A") ? "B" : "A";
     return `${payload}.${first}${signature.slice(1)}`;
   }
   ```

2. `:120-123` → `expect(verifyCallbackCapability(SECRET, forge(cap))).toBeNull()`; drop the
   now-unused `[p, s]` split.
3. `:186` and `:200` → `forge(f.capability)` in the list; drop the unused split.
4. A new unit test in `describe("callback capability")`: for 1000 fresh secrets, sign `claims`,
   then decode the signature part (`cap.split(".")[1] ?? ""`) of `cap` and of `forge(cap)` with
   `Buffer.from(…, "base64url")`, assert `forged.equals(real)` is `false`, and assert
   `verifyCallbackCapability(secret, forge(cap))` is null. Pure HMAC work, well under a second.

No production code changes. The verifier accepting non-canonical encodings of the same bytes
is not a forgery and is out of scope.

## Acceptance (from the ticket)

AC-1 helper at both sites · AC-2 1000-signature check · AC-3 1000 consecutive route-test runs ·
AC-4 before proof in `docs/specs/615/gate-log.md` · AC-5 tsc-check, lint, format-check, www
vitest exit 0 · AC-6 diff limited to the test file and `docs/specs/615/`.

## Verification plan

- `pnpm --filter @terragon/www exec vitest run --no-file-parallelism "src/app/api/addon-callback"`.
- A temporary, uncommitted `{ repeats: 999 }` on the route test (1000 runs, fresh org, call and
  signature each), then revert. Vitest reports a repeated test as one test, so the count is
  recorded from `--reporter=json` (`repeatCount`) in the gate log.
- The scratch rate script before and after, plus a replayable case (fixed claims, secret and
  capability) whose old forgery verifies.
- `pnpm turbo tsc-check`, `pnpm turbo lint`, `pnpm turbo format-check`,
  `pnpm --filter @terragon/www exec vitest run --no-file-parallelism`.

## Phases

1. Phase 1 (1 file, `route.test.ts`): helper, the two call sites, the 1000-signature test.
2. Phase 2 (1 file, `docs/specs/615/gate-log.md`): before/after proof and gate exits.
