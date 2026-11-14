# Spec #606 — broker routes in www for remote cells (ADR-014 L3 PR 2)

Source of truth: GitHub issue be-automata/automata#606 (body below, as published 2026-11-13 after the open-decisions walk; decision record in the run state).
Branch `feat/606-cell-broker-routes` off main `7e947fd3`.

## Ground truth (verified in this worktree at write time)

- Exists: `packages/shared/src/model/cell-authority.ts` — `openStep` :77, `mintBearer` :165, `verifyBearer` :286, `revokeAttempt` :305, `beginEffect` :337 (returns `{kind:"go", context}` incl. `attempt`), `completeEffect` :395, `markStepDone` :423; `Refusal` :37-44.
- Exists: `thread.github_repo_full_name` (`packages/shared/src/db/schema.ts:387`); `cell_step` :3303-3331 has no ref column.
- Exists: `normalizeRepo` at `packages/shared/src/model/repo-review-settings.ts:50`.
- Exists: `getReadOnlyInstallationToken` (`packages/shared/src/github-app.ts:150`), `READ_ONLY_TOKEN_PERMISSIONS` :132; no write-scoped helper exists.
- Exists: `packages/worker/src/agent-run/receive-pack-refs.ts` (+ test), imported by `git-broker.ts:14`; referenced by path in `packages/worker/deploy/linux/self-heal-acceptance.sh:154` and `self-heal-acceptance.test.ts:229` (so its test stays at `src/agent-run/receive-pack-refs.test.ts`).
- Exists: `graphqlHasMutation` (`packages/worker/src/agent-run/gh-broker.ts:99`); 1 MiB GraphQL cap :60. Worker does not depend on `@terragon/shared` (`git-broker.ts:100-103`).
- Exists: `packages/utils` with explicit exports only (`package.json:6-14`) and `package-exports.test.ts`.
- Exists: `packages/env/src/apps-www.ts` typed bools (`GITHUB_SIDE_EFFECTS_ENABLED` :106); tests flip env by direct assignment (`resolve-credential-broker.test.ts:43`).
- Exists: real-git-over-stub pattern `packages/worker/src/agent-run/broker-integration.test.ts:190-200` (`git upload-pack --stateless-rpc` on a bare repo).
- Does NOT exist yet: `apps/www/src/app/api/cell`, `apps/www/src/app/api/v3`, `apps/www/src/app/api/graphql`, `apps/www/src/server-lib/cell-broker`, `packages/utils/src/receive-pack-refs.ts`, `CELL_BROKER_ENABLED`.
- No rewrite/redirect touches `/api` (`apps/www/next.config.ts:19-46`); middleware matches only `/`, `/login`, `/invited` (`apps/www/src/middleware.ts:39`).
- gh 2.103.3 with `GH_HOST=<host>` + `GH_ENTERPRISE_TOKEN` calls `https://<host>/api/v3/<path>` and `https://<host>/api/graphql`, header `Authorization: token <x>` (run 2026-11-13).
- Already done: nothing for this ticket (no commit references #606; issue has no comments).

## Strategy (planner, 7 phases, cap 5 files each)

| Phase | Files                                                                                                                                                                                                                                                        | ACs                                  |
| :---- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------- |
| A     | new `packages/utils/src/receive-pack-refs.ts` (Uint8Array API); `packages/utils/package.json` export `./receive-pack-refs`; delete `packages/worker/src/agent-run/receive-pack-refs.ts`; `git-broker.ts` import; `receive-pack-refs.test.ts` import          | AC9                                  |
| B     | `packages/env/src/apps-www.ts` (`CELL_BROKER_ENABLED`, default false); `packages/shared/src/github-app.ts` (`WRITE_TOKEN_PERMISSIONS`, `getWriteInstallationToken`); `github-app.test.ts`; new `packages/utils/src/receive-pack-refs.test.ts`                | AC8, AC11, AC9                       |
| C     | new `apps/www/src/server-lib/cell-broker/common.ts` (+ `common.test.ts`): 404 switch, bearer extraction (Bearer / Basic password / `token`), refusal→status map, verifyBearer→thread repo (normalizeRepo), header strip mirrored from broker-common, no CORS | AC2, AC3, AC7, AC8                   |
| D     | new `cell-broker/git.ts` (factory with injectable fetch + token minters), `app/api/cell/git/[...path]/route.ts`, `git-read.test.ts`                                                                                                                          | AC1 (stub), AC2, AC3, AC7, AC8, AC11 |
| E     | `git.ts` push path (Content-Length 413, ≤64 KiB command buffer, key, beginEffect, counting TransformStream with `duplex:"half"`, report-status incl. side-band, completeEffect), `git-push.test.ts`                                                          | AC4, AC5, AC10, AC11                 |
| F     | new `cell-broker/gh.ts`, `app/api/v3/[...path]/route.ts`, `app/api/graphql/route.ts`, `gh.test.ts`                                                                                                                                                           | AC3, AC6, AC7, AC8                   |
| G     | new `apps/www/src/test-helpers/route-http-server.ts`, `cell-broker/real-git.test.ts`, `cell-broker/real-gh.test.ts` (skip when binary absent)                                                                                                                | AC1, AC6                             |

Gates after every phase: `pnpm turbo tsc-check`, `pnpm turbo lint`, the phase's vitest files; full `@terragon/www` and `@terragon/shared` suites after E and G; prettier with `--no-editorconfig --config .prettierrc`.

Known risks: Buffer→Uint8Array decode differences (decode pkt-line lengths as ASCII bytes); request-body streaming under vitest/Node (fallback: tests buffer, T1b decides); teeing report-status while streaming the response; local port binding for G.

## Amendments from validate (cycles 1–3, 2026-11-13) — these override the ticket text below where they differ

1. **Receive-pack advertisement uses the write token.** `GET info/refs?service=git-receive-pack` is the first leg of a push: GitHub checks push permission there. It mints with `getWriteInstallationToken`; `info/refs?service=git-upload-pack`, `git-upload-pack` and gh reads use the read-only token. AC11 reads: "fetch-side calls use the read-only token, both legs of a push use the write token".
2. **git's probe POST is not an effect.** A receive-pack body of exactly the 4 bytes `0000` (git sends it before a push larger than `http.postBuffer`) is forwarded without `beginEffect`. Zero commands followed by any further bytes (`0000PACK…`) is malformed: 400, nothing upstream. Phase G includes a real-git push over 1 MiB.
3. **`graphqlHasMutation` moves to `@terragon/utils`** (`./graphql-mutation`, explicit export); the worker's gh-broker and its test import it from there.
4. **Outcome of a recorded push (owner decision 2026-11-13: add `releaseEffect`).**
   - GitHub answered (any 2xx/4xx, including a rejected push or `ng` lines) → `completeEffect` with the stored response (amendment 5). Retry replays it.
   - Streamed body over 32 MiB after `go` → abort the upstream request, **`releaseEffect`**, answer 413 `overflow`. (Not stored as final: a smaller repack of the same commands must still be able to push.)
   - Accepted cost: repeated transient failures can exhaust the step budget (429) although no push landed; stated in the PR body.
   - Transient — cell disconnect / aborted body, network error to GitHub, GitHub 5xx, response over the 1 MiB read cap → **`releaseEffect`**: a new `cell-authority` function that, **inside a transaction holding the `cell_step` row `FOR UPDATE`** (the lock `beginEffect` takes; `resolveBearer(…, lock)` pattern, cell-authority.ts:262), deletes the pending claim of `(stepKey, idempotencyKey, attempt)` when its `result` is null and returns whether it did. The takeover in `beginEffect` (:356-369) runs under the same lock, so a release and a takeover serialize: a release after the takeover matches no row (attempt changed) and returns false. B2 includes a test that interleaves the two. The budget unit stays spent (no refund). The route answers 502 `upstream_error` (or the client is gone). An identical retry claims afresh and uses a new unit; this is safe because git re-reads the refs advertisement before re-pushing, and a ref already updated makes GitHub reject the stale update.
   - `completeEffect`/`releaseEffect` returning false (a newer attempt took the claim over): the route still returns GitHub's bytes and logs `effect_taken_over`. If the DB write throws, the claim stays pending (same attempt then gets `effect_in_progress`; a newer attempt takes it over) — logged, not hidden.
5. **Stored result = the raw response.** Buffer the receive-pack response fully (cap 1 MiB), store `{httpStatus, contentType, bodyB64, refs}` (`refs` parsed for logs/assertions only, by new `cell-broker/report-status.ts`: side-band bands 1–3, pkt-lines spanning packets, report-status and report-status-v2), call `completeEffect`, then return the bytes. Replay validates the stored field types before rebuilding the Response; an invalid stored value answers 500 `corrupt_effect_result`. No tee, no `waitUntil`. (The Contract's `{status, refs}` is superseded by this.)
6. **Upstream URLs are built, never resolved.** Origins are fixed (`https://github.com` for git, `https://api.github.com` for gh) and asserted on the built URL before fetch.
   - git: request path shape is `/api/cell/git/<owner>/<repo>.git/<endpoint>`. Each segment is refused (403) when it equals `.` or `..` or contains `/`, `\`, `%` or a control character (dots inside a name, e.g. `next.js`, are fine). Strip `.git` once from the repo segment, compare `normalizeRepo(owner/repo)` with the thread's repo (repo-review-settings.ts:50), then rebuild the upstream URL from the thread's repo + the allowlisted endpoint (git-broker.ts:121,174 pattern).
   - gh: segments come from `new URL(request.url).pathname` split on `/`, each decoded with `decodeURIComponent` in a try (a `URIError` → 400); never Next's decoded `params`. Refuse a segment that equals `.` or `..`, or contains `\` or a control character (403); rebuild the path with `encodeURIComponent` on each decoded segment (so a decoded `/` or `%` stays inside its segment, e.g. `branches/feat%2Fx`, `compare/main...feat`); pass `url.search` through verbatim.
7. **415 for an encoded receive-pack body** — any `content-encoding` other than absent or `identity` (as the box, git-broker.ts:274-276), before parsing or any upstream call. Upload-pack bodies keep their `content-encoding` (git gzips fetch RPCs); the real-git fetch test proves it.
8. **401 challenge on git.** No credential → 401 with `WWW-Authenticate: Basic realm="automata-cell"`.
9. **Pushes honor the global GitHub side-effects switch** through `apps/www/src/lib/github-side-effects.ts` (not a direct env read). Off → both legs of a push answer 503 `side_effects_disabled` before any mint or `beginEffect`; reads unaffected. Tests account for its default (true).
10. **Request header denylist** = box `HOP_BY_HOP`/`REQUEST_OWNED` (mirrored with a comment) plus `cookie`, `cf-*`, `x-forwarded-*`, `x-real-ip`, `true-client-ip`, `expect`, `te`, `proxy-authorization`.
    10b. **Response headers** back to the cell drop `set-cookie`, hop-by-hop headers and `content-length`/`content-encoding`/`transfer-encoding` (as the www proxies do). On the gh routes, `Link` URLs on `https://api.github.com/` are rewritten to `https://<request host>/api/v3/` so `gh --paginate` stays on the broker. A replayed push rebuilds headers from the stored `contentType` only.
11. **gh catch-all is optional:** `app/api/v3/[[...path]]/route.ts`. gh reads stay unfenced by repo, as on the box (the token is scoped to the step's repo).
12. **Order on a push POST** (nothing that can fail for a local or GitHub-App reason runs after `go`): 404 switch → credential/401 → `verifyBearer` → path/endpoint fence → side-effects switch → 415 → declared `Content-Length` > 32 MiB → 413 → buffer and parse the command section (probe → forward, no effect) → mint the write token → `beginEffect` → stream to GitHub through the 32 MiB counter → amendment 4 outcomes.
13. **AC8 test** spies on the www `db` import and the upstream fetch.
    14a. **AC12 (new):** after a transient failure or a streamed overflow, the claim row is gone, `effects_used` stays +1, and an identical retry claims afresh, is forwarded, and uses a second unit.
    14b. `graphqlHasMutation`'s tests stay in the worker's `gh-broker.test.ts` (import-only change); `package-exports.test.ts` asserts `./receive-pack-refs` and `./graphql-mutation` explicitly. ADR-004:336 and ADR-010:294 name the worker test file, which does not move.
14. Test config is `apps/www/vite.config.ts:26-71`. Only ADR-010:179 cites the moved source path: add "moved to `@terragon/utils` (#606)". `CELL_BROKER_ENABLED` is documented in `deploy/WORKERS-ENV-MAP.md`.
15. Phase G skips cleanly when the binary is missing or local port binding fails.

15b. **Final-validate clarifications (PASS_WITH_WARNINGS):**

- The probe POST (`0000`) is forwarded with the **write** token: mint the write token before the probe check (both legs of a push and its probe use it).
- Size wins: a GitHub response over the 1 MiB read cap is released (502), whatever its status. A 3xx under `redirect: "manual"` → 502 + `releaseEffect`.
- git segments come from the raw `new URL(request.url).pathname` (as gh), decoded in a try; `<endpoint>` (`info/refs`, `git-upload-pack`, `git-receive-pack`) is matched as the joined tail after `<repo>.git` against the allowlist.
- Releasing after a GitHub 5xx / network error once the pack was sent can deliver a push twice (at-least-once); git re-reads refs before re-pushing, and a ref already moved makes GitHub reject the stale update. The PR body names this window next to the budget cost.
- `report-status.ts` cases live in `git-push.test.ts` (Phase E). The explicit lock in `releaseEffect` is kept for consistency with the module.

## Amendments from roborev (fix round 1, 2026-11-14)

- **Verify before replay.** A stored push success (2xx, every pushed ref `ok`) is replayed only while the receive-pack advertisement still shows each ref at its `newSha` (absent for a delete). Otherwise the push is claimed anew under the key generations `<key>:g2` … `:g20`; past g20 the answer is 409 `push_generations_exhausted`. The advertisement is fetched once per request with the write token, capped at 8 MiB; a failed or unparseable fetch is 502 with no claim. Stored rejections (`ng`, unpack error, 4xx) replay without verification.
- **Redirects.** Only 301, 302, 303, 307 and 308 are redirects (502). A 304 passes through to the cell.
- **GraphQL encoding.** A request body with a `content-encoding` other than identity is refused with 415 `unsupported_encoding` before it is read.
- **Write token.** The write token adds `workflows: write` only when the installation grants Workflows write (read first; a failed read mints without it). The App does not hold that permission today: add it to the App and have installations approve it to enable pushes of workflow files.
- **Test route server.** `route-http-server.ts` builds request bodies by hand: `Readable.toWeb` kept enqueuing into a closed controller after an over-cap cancel.

## Phases (validator cycle 3 + owner decision; supersedes the strategy table above)

| Phase    | Files (≤5 touches)                                                                                                                                                                                                                                                | ACs                                  |
| :------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------- |
| A1       | new `packages/utils/src/receive-pack-refs.ts`, `packages/utils/package.json`, delete `packages/worker/src/agent-run/receive-pack-refs.ts`, `packages/worker/src/agent-run/git-broker.ts`, `packages/worker/src/agent-run/receive-pack-refs.test.ts` (import only) | AC9                                  |
| A2       | new `packages/utils/src/graphql-mutation.ts`, `packages/utils/package.json`, `packages/worker/src/agent-run/gh-broker.ts`, `packages/worker/src/agent-run/gh-broker.test.ts` (import only)                                                                        | AC9                                  |
| B        | `packages/env/src/apps-www.ts`, `packages/shared/src/github-app.ts`, `packages/shared/src/github-app.test.ts`, new `packages/utils/src/receive-pack-refs.test.ts` (small), `packages/utils/src/package-exports.test.ts`                                           | AC8, AC9, AC11                       |
| B2       | `packages/shared/src/model/cell-authority.ts` (locked `releaseEffect`), `packages/shared/src/model/cell-authority.test.ts` (incl. release/takeover interleave)                                                                                                    | AC4, AC5, AC12                       |
| C        | `apps/www/src/server-lib/cell-broker/common.ts`, `common.test.ts`                                                                                                                                                                                                 | AC2, AC3, AC7, AC8                   |
| D        | `cell-broker/git.ts`, `app/api/cell/git/[...path]/route.ts`, `cell-broker/git-read.test.ts`                                                                                                                                                                       | AC1 (stub), AC2, AC3, AC7, AC8, AC11 |
| E        | `cell-broker/git.ts`, new `cell-broker/report-status.ts`, `cell-broker/git-push.test.ts`                                                                                                                                                                          | AC4, AC5, AC10, AC11, AC12           |
| F        | `cell-broker/gh.ts`, `app/api/v3/[[...path]]/route.ts`, `app/api/graphql/route.ts`, `cell-broker/gh.test.ts`                                                                                                                                                      | AC3, AC6, AC7, AC8                   |
| G        | `apps/www/src/test-helpers/route-http-server.ts`, `cell-broker/real-git.test.ts`, `cell-broker/real-gh.test.ts`                                                                                                                                                   | AC1, AC6, AC10                       |
| H (docs) | `docs/adr/ADR-010-audit-self-heal-single-writer.md` (:179 note), `deploy/WORKERS-ENV-MAP.md`                                                                                                                                                                      | —                                    |

---

# L3 PR2: broker routes in www for remote cells (git smart-HTTP, gh reads) (ADR-014)

Part of ADR-014, step 5: the Agent37 adapter needs the six remote-cell requirements. This is **L3 PR 2 of 4**: the broker routes in automata-www. PR 1 (#597, closed #598) added the durable authority model. Nothing calls it yet.

A remote cell (an Agent37 sandbox) has no GitHub credential and no network except the broker. Its `git` and `gh` must reach GitHub through www. www checks the cell's bearer against Postgres, adds the real installation token server-side, and records every write as a budgeted, idempotent effect. On the box this job is done by two heap brokers in the worker. A remote cell outlives the worker, so its broker has to live in the control plane.

Out of scope: who opens steps and mints bearers (the worker, PR 4), the reconciler and the Agent37 client (PR 3), the ref fence for self-heal fix runs (PR 4, see OD-3), and any change to the box path.

**Sensitive PR (OD-0):** this adds a public route that forwards with a real GitHub token. The TL reviews it explicitly before merge.

## Reality check on be-automata/automata@7e947fd3

- **Authority model (PR 1):** `packages/shared/src/model/cell-authority.ts`.
  - `verifyBearer({db, token})` (:286) returns `BearerContext {stepKey, attempt, organizationId, threadId}` (:46-51) or a `Refusal` (:37-44): `unknown_bearer | revoked | expired | fenced | step_done | effect_budget_exhausted | effect_in_progress`.
  - `beginEffect({db, token, idempotencyKey})` (:337) returns `go {context} | replay {result} | refused {reason}`. It checks the bearer under the step's `FOR UPDATE` lock and reserves one budget unit. The `attempt` that `completeEffect` needs comes from the `go` context.
  - `completeEffect({db, stepKey, idempotencyKey, attempt, result})` (:395).
  - The header (:26-28) says the routes set the effect budget "from the run type". That budget is passed to `openStep`, which this PR does not call (PR 4 does).
- **The step's repo:** `cell_step.thread_id` points to `thread`, whose `github_repo_full_name` column is at `packages/shared/src/db/schema.ts:387`. The route takes the repo from there, never from the request. The repo fence normalizes slugs the way `git-broker.ts:100` does.
- **Installation tokens** (`packages/shared/src/github-app.ts`):
  - GitHub caps installation tokens at one hour (:142-143).
  - `getReadOnlyInstallationToken(owner, repo, knownInstallationId?)` (:150) returns `{token, expiresAt}` scoped to one repo with `READ_ONLY_TOKEN_PERMISSIONS` (:132). It fits git reads and the gh route.
  - Neither existing helper explicitly requests write permission for a push. `getInstallationToken` (:94) asks for a 30-day `expires_at` and no `permissions`.
- **The box brokers this ports (worker heap, 127.0.0.1):**
  - `packages/worker/src/agent-run/git-broker.ts` (#65): byte-transparent smart-HTTP proxy. Fences, in order: bearer, repo path, then the method/endpoint allowlist (GET `info/refs?service=git-upload-pack|git-receive-pack`, POST `git-upload-pack`, POST `git-receive-pack`). The optional ref fence uses `receive-pack-refs.ts` (`parseReceivePackCommands(buf: Buffer)` :68, `checkRefFence` :124; 64 KiB command-section cap, 413/415).
  - `packages/worker/src/agent-run/gh-broker.ts` (#81): read-only gh API. GET/HEAD any path, POST `/graphql` only without a mutation, everything else 403. It uses an `http_unix_socket` transport, which a remote cell cannot use.
  - `broker-common.ts`: `HOP_BY_HOP` :13, `REQUEST_OWNED` :28, `timingSafeEqualStr` :30 (imports `node:crypto`, available under `nodejs_compat`).
  - **The worker does not depend on `@terragon/shared`, on purpose** (`packages/worker/package.json`; `git-broker.ts:100-103`). Both www and the worker depend on `@terragon/utils`, which has explicit (non-wildcard) exports (`packages/utils/package.json:6-14`).
- **www proxy routes** (`apps/www/src/app/api/proxy/{anthropic,openai,openrouter,google}/[[...path]]/route.ts`):
  - They **buffer** the request body (`await request.arrayBuffer()`, e.g. anthropic `route.ts:329`). Only the response streams.
  - No route in `apps/www/src` streams a request body (no `duplex`), and none sets `runtime`; they use `dynamic = "force-dynamic"`.
  - Request headers are copied minus host, content-length, connection, x-api-key and authorization, with `redirect: "manual"`. Response headers drop content-length, connection, transfer-encoding and content-encoding.
  - They set CORS, which the broker must not copy.
- **Runtime:** www is an OpenNext Worker (`apps/www/wrangler.jsonc`: `main: worker-entry.ts`, `nodejs_compat`). `worker-entry.ts` passes requests through, and the middleware matches only `/`, `/login` and `/invited` (`apps/www/src/middleware.ts:39`). No `app/api/cell`, `app/api/v3` or `app/api/graphql` exists.
- **Env switches:** typed booleans in `packages/env/src/apps-www.ts` (e.g. `GITHUB_SIDE_EFFECTS_ENABLED` :106), read as `env.X` from `@terragon/env/apps-www` and mocked in tests (`proxy/anthropic/route.test.ts:26`).
- **Route tests with a DB:** `apps/www/src/app/api/self-heal/fix-check/route.test.ts` (real `db`, `@terragon/shared/model/test-helpers` fixtures, direct `POST(new NextRequest(...))`). `cell-authority.test.ts` shows the `openStep`/`mintBearer` fixtures.
- **Behaviour proven first:** spike 033 (local 65/65, real Agent37 14/14), with a file-backed broker. Its authorization order is unknown/expired, then revoked, then fenced. The effect path is scope check, then replay, then budget.

## Decisions (settled 2026-11-13 by the owner/TL)

- **OD-0, review:** sensitive PR. Explicit TL review before merge.
- **OD-1, push bodies:** stream with a 32 MiB cap of our own. Only the command section (≤ 64 KiB) is buffered. The rest streams through a byte counter that aborts above the cap, and a declared `Content-Length` above it is refused with 413 before anything is sent upstream. Whether OpenNext buffers the upload before the handler runs ([opennextjs-cloudflare#1008](https://github.com/opennextjs/opennextjs-cloudflare/issues/1008)) is measured on a preview deploy. If it does, the cap is revisited.
- **OD-2, gh transport:** stock `gh` treats `GH_HOST=<www host>` as an Enterprise Server host. The cell sets `GH_HOST` to the www host and `GH_ENTERPRISE_TOKEN` to its bearer. Verified with gh 2.103.3: it calls `https://<host>/api/v3/<path>` and `https://<host>/api/graphql` with `Authorization: token <x>`, and sends no token with `GH_TOKEN` alone. So the gh routes live at the www root: `app/api/v3/[...path]` and `app/api/graphql`.
- **OD-3, self-heal fix runs:** no ref fence and no migration in this PR. Remote cells refuse self-heal fix runs until PR 4, which either stores the exact ref or keeps those runs on the box.

## Contract

- **Routes:**
  - `app/api/cell/git/[...path]/route.ts`: smart-HTTP for the step's repo only. git accepts a full URL, so this stays under `/api/cell`.
  - `app/api/v3/[...path]/route.ts` and `app/api/graphql/route.ts`: the read-only gh API (OD-2).
- **Auth:**
  - git: `Authorization: Bearer <cell bearer>`, or Basic with the bearer as password (git's credential helper).
  - gh: `Authorization: token <cell bearer>` (gh's scheme) or `Bearer`.
  - Every request runs `verifyBearer`. A refusal maps to a status: `unknown_bearer`/`expired`/`revoked` → 401, `fenced`/`step_done` → 409, `effect_budget_exhausted` → 429, `effect_in_progress` → 409. The body names the reason, and nothing is forwarded to GitHub.
- **Reads** (`info/refs`, `git-upload-pack`, gh GET/HEAD, gh GraphQL queries) are not effects. They are bearer-checked and streamed, use no budget, and use a token from `getReadOnlyInstallationToken`.
- **A push is an effect.** POST `git-receive-pack`:
  - The route buffers only the command section and parses it with `parseReceivePackCommands`. That function and `checkRefFence` move to `@terragon/utils`, which both packages already depend on, with a new explicit export. They are rewritten on `Uint8Array` if `Buffer` is not available on the route's runtime.
  - Idempotency key: `push:` + the sha256 of the canonical command list (`old new ref` per line).
  - It calls `beginEffect` and acts on the result:
    - `go`: stream the push (the buffered prefix plus the rest, through the 32 MiB counter) with `duplex: "half"`, then `completeEffect` (attempt from the `go` context) with `{status, refs}` from GitHub's report-status;
    - `replay`: answer from the stored result without contacting GitHub;
    - `refused`: return the mapped status.
  - A push GitHub rejects is still completed, with its status, so a retry replays the rejection instead of using a second unit.
- **Push token:** a new helper in `github-app.ts` mints a one-repo token with explicit permissions (`contents: write`, `metadata: read`) and no `expires_at`, following `getReadOnlyInstallationToken`.
- **Tokens in general:** minted per request, never logged, never returned, never put in a header sent back to the cell. Hop-by-hop and request-owned headers are stripped the same way as on the box. No CORS headers.
- **Off by default:** the routes answer 404 unless a typed env switch in `packages/env/src/apps-www.ts` (named in the spec) is set. PR 4 turns it on. No bearer is minted in production before then anyway.
- **No schema change and no migration.**

## Acceptance Criteria

- AC1: With a valid bearer for a step whose thread is `owner/repo`, `git clone` and `git fetch` through the git route succeed against a stubbed GitHub upstream, and the streamed bytes match the upstream's.
- AC2: A path for any other repo, an unlisted endpoint or method, or a malformed path returns 403. Nothing is sent upstream.
- AC3: Each of `unknown_bearer`, `expired`, `revoked` (after `revokeAttempt`), `fenced` (after a newer `openStep`) and `step_done` (after `markStepDone`) gets its mapped status with the reason in the body, on the git and gh routes, and the upstream stub records zero calls.
- AC4: A push forwards once and records the effect. Repeating the identical push returns the stored result, the upstream stub sees one call, and `effects_used` goes up by one. A different push uses another unit. Once the budget is exhausted the route answers 429 and the upstream is not called.
- AC5: A push GitHub rejects (non-2xx, or `ng` in report-status) is stored, and its retry replays without a second upstream call or budget unit.
- AC6: The gh routes (`/api/v3/*`, `/api/graphql`) forward GET/HEAD and mutation-free GraphQL. A GraphQL mutation, any write method, and an over-cap body are refused with 403 or 413 before any upstream call. A real `gh` run with `GH_HOST` and `GH_ENTERPRISE_TOKEN` against a local server wrapping the routes reaches them.
- AC7: The installation token never appears in a response body, a response header, or the captured logs (asserted in tests with a sentinel token).
- AC8: With the env switch off, all three routes answer 404 and touch neither the database nor the upstream.
- AC9: `parseReceivePackCommands`/`checkRefFence` live in `@terragon/utils`. The worker imports them from there (the worker still does not depend on `@terragon/shared`), and the existing worker broker tests pass unchanged except for import paths.
- AC10: A push whose body exceeds 32 MiB, by declared `Content-Length` or by streamed bytes, gets 413. With a declared length nothing is sent upstream, no effect is recorded and no budget unit is used. A streamed overflow aborts the upstream request and is not completed as a success.
- AC11: Reads use a read-only token and pushes use the write-scoped one, both scoped to the step's repo only (asserted on the token-mint calls).

## Tests

- AC1–AC8, AC10, AC11: route tests in `apps/www` against the throwaway Postgres, with real `openStep`/`mintBearer` fixtures, an injected upstream `fetch` stub, and the env switch mocked via `@terragon/env/apps-www`.
- AC1 and AC6: one test drives the real `git` binary, and one the real `gh` binary, over a local HTTP server that wraps the route handlers.
- AC9: `pnpm --filter @terragon/worker exec vitest run src/agent-run/git-broker.test.ts src/agent-run/receive-pack-refs.test.ts` and `pnpm --filter @terragon/utils exec vitest run --no-file-parallelism`.
- Suites: `pnpm --filter @terragon/www exec vitest run --no-file-parallelism`, `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism`, `pnpm turbo tsc-check`, `pnpm turbo lint`.

## Open decisions

All settled (see Decisions above). None remains open.

## UAT

| Tier        | What                                                                                                                                                                                              | Who                                          |
| :---------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------- |
| T0 local    | the suites above, plus the real-`git` clone/push and real-`gh` reads against the stub                                                                                                             | dev                                          |
| T1a CI      | full suites on the PR                                                                                                                                                                             | CI                                           |
| T1b preview | OD-1 measurement: a streamed push larger than 1 MiB through a deployed (non-production) Worker, checking with the memory metric or `wrangler tail` whether OpenNext buffers it before the handler | dev (deferred until a preview deploy exists) |

No production UAT. The routes stay off in production until PR 4.
