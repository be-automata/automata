# #606 gate log

- HEAD: `62e711ff` (branch `feat/606-cell-broker-routes`)
- Date: 2026-11-14
- Scope: L3 PR 2 of ADR-014, the remote-cell broker routes (git smart-HTTP and read-only GitHub API), now in `packages/cell-broker` with thin routes in `apps/www`.

## Gates

Each command was run from the worktree root with the sandbox disabled (the worker and www suites bind local ports and run real `git` and `gh`). Every exit code below is the literal one observed.

| #   | Command                                                                                                        | Exit | Counts                                                                        |
| :-- | :------------------------------------------------------------------------------------------------------------- | :--- | :---------------------------------------------------------------------------- |
| 1   | `pnpm install --frozen-lockfile --prefer-offline`                                                              | 0    | lockfile in sync                                                              |
| 2   | `pnpm turbo tsc-check --force`                                                                                 | 0    | 21 of 21 tasks, includes `@terragon/cell-broker`                              |
| 3   | `pnpm turbo lint`                                                                                              | 0    | 2 of 2 tasks                                                                  |
| 4   | `pnpm exec prettier --no-editorconfig --config .prettierrc --check $(git diff --name-only origin/main...HEAD)` | 0    | 43 changed files, all formatted                                               |
| 5   | `pnpm --filter @terragon/utils exec vitest run --no-file-parallelism`                                          | 0    | 10 files, 80 tests passed                                                     |
| 6   | `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism`                                         | 0    | 88 files, 1445 tests passed                                                   |
| 7   | `pnpm --filter @terragon/www exec vitest run --no-file-parallelism`                                            | 0    | 329 files passed, 1 skipped; 4384 tests passed, 9 skipped; 0 unhandled errors |
| 8   | `pnpm --filter @terragon/worker exec vitest run --no-file-parallelism`                                         | 0    | 75 files passed, 11 skipped; 1884 tests passed, 42 skipped                    |
| 9   | `pnpm audit --prod --audit-level critical`                                                                     | 0    | no critical advisories (108 found: 10 low, 56 moderate, 42 high)              |

The 11 skipped worker files are all `*.integration.test.ts` suites that run only on opt-in (the Hatchet ones with `HATCHET_IT=1`); none of them is part of this change.

## Acceptance criteria and the tests that prove them

Where `spec.md` amendments differ from the ticket, the amendments win. AC5 covers non-transient rejections only; transient failures release the claim (amendment 4 and the roborev rounds) and are covered by AC12. Test files are in `apps/www/src/server-lib/cell-broker/` unless a path is given.

### AC1 clone and fetch through the git route

- `git-read.test.ts`: "AC1 forwards the upload-pack advertisement and POST to github.com, bytes and status intact, gzip kept"
- `git-read.test.ts`: "a dotted repo name works and the upstream URL uses the step's repo"
- `real-git.test.ts`: "AC1 clone and fetch succeed, and GitHub only ever sees the injected installation token"

### AC2 fence: other repo, unlisted endpoint or method, malformed path

- `git-read.test.ts`: "AC2 refuses another repo, unlisted endpoints, bad queries and unsafe segments without an upstream call"
- `common.test.ts`: "refuses dot segments, backslash and control characters in both modes"; "git also refuses empty, slash and percent; gh allows them"; "refuses a %2e%2e segment once decoded"; "is not ok for a bad escape or a different prefix"
- `gh.test.ts`: "refuses backslash and control-character segments without an upstream call"; "never lets a dot segment reach GitHub: the URL parser resolves it first, so the call stays under /api/v3"; "answers 400 for a malformed percent escape"

### AC3 every bearer refusal, on the git and gh routes

- `git-read.test.ts`: "AC3 maps every bearer refusal and challenges a missing credential, with no upstream call"
- `gh.test.ts`: "AC3 maps every refusal and rejects a missing credential, with no upstream call"; "AC3 accepts both `token` and `Bearer` schemes"
- `common.test.ts`: "maps revoked, expired, fenced, step_done and unknown bearers to their refusal"; "a thread of another organization reads as an unknown bearer"
- `packages/shared/src/model/cell-authority.test.ts`: the PR 1 authority cases for unknown, revoked, expired, fenced and finished steps (for example "AC3 refuses unknown, revoked and expired bearers; revocation is sticky")

### AC4 a push is one recorded, budgeted effect

- `git-push.test.ts`: "AC4 forwards a push once, stores it and replays an identical retry; a different push uses a second unit"
- `git-push.test.ts`: "AC4 answers 429 without calling GitHub once the budget is spent"
- `real-git.test.ts`: "push of a small commit lands in the bare repo with one completed effect"; "push of a >1 MiB commit sends git's 0000 probe first: it lands, and the probe is not an effect"
- `git-push.test.ts`: "probe: a bare 0000 is forwarded with the write token and no effect; 0000 plus bytes is 400"

### AC5 a rejected push is stored and replayed (non-transient only)

- `git-push.test.ts`: "AC5 stores a 200 whose report-status says ng, and a 4xx, and replays both"
- `git-push.test.ts`: "a 200 with a non-transient ng is stored and replayed as before"
- `git-push.test.ts`: "a stale-ref ng is final even though it says 'cannot lock ref': stored and replayed"
- `git-push.test.ts`: "a 403 that is git's own report-status is stored and replayed as before"
- `git-push.test.ts`: "a stored rejection is replayed without looking at the refs"
- Verify-before-replay for a stored success: "a stored success whose ref has since moved back is claimed anew under the next generation"; "a stored success whose ref still shows the pushed sha is replayed after one advertisement check"

### AC6 the gh routes

- `gh.test.ts`: "AC6 forwards reads to api.github.com, bytes, status and query intact; HEAD works"; "AC6 keeps compare ranges and an encoded slash inside one segment; an empty path is the API root"; "AC6 refuses writes on /api/v3 without calling GitHub"; "AC6 forwards a query with the same body"; "AC6 refuses a mutation, including one after a string mentioning query"; "AC6 refuses a mutation hidden behind a quote inside a comment"; "AC6 answers 413 over the cap (declared or streamed), 400 for non-JSON or a non-string query, 403 for GET"
- `real-gh.test.ts` (real `gh`, `GH_HOST` and `GH_ENTERPRISE_TOKEN`): "AC6 `gh api user` reaches /api/v3/user with `token <bearer>` and returns the canned login"; "AC6 `gh api graphql` of a read query works"; "AC6 `gh api -X POST repos/o/r/issues` is refused with a 403 and never reaches GitHub"
- `packages/utils/src/graphql-mutation.test.ts`: "refuses the quote-in-a-comment bypass"; "refuses a mutation on the line after a comment holding a quote"; "refuses a mutation after an unterminated string"; "ignores the word in a regular string, a block string argument and a comment"; "accepts a plain query and refuses a plain mutation"; "refuses a subscription, which is not a read"; "refuses a document that does not parse"; "refuses a document with two operations when one is a mutation"; "refuses a document with no operation (fragments only, or empty)"; "passes the shorthand query and a query with variables and fragments"
- `packages/worker/src/agent-run/gh-broker.test.ts`: "403s a GraphQL mutation, an absent query, and an unparseable body (fail closed)" (the box broker, same check)

### AC7 the installation token never leaves the broker

- `git-read.test.ts`: "AC7 the installation token only reaches GitHub, in Authorization, never the cell"; "AC7 nothing logged carries the installation token or the bearer"
- `gh.test.ts`: "AC7 the installation token reaches GitHub only as `authorization: token <sentinel>`"; "AC7 nothing logged carries the installation token or the bearer"
- `real-git.test.ts`: the AC1 test asserts GitHub only ever sees the sentinel token.

### AC8 switch off means 404 and no side effects

- `git-read.test.ts`: "AC8 answers 404 and touches neither the database nor GitHub when disabled"
- `gh.test.ts`: "AC8 answers 404 and touches neither the database nor GitHub when disabled" (covers `/api/v3` and `/api/graphql`, which share the handler)
- `common.test.ts`: "follows CELL_BROKER_ENABLED (default false)"

### AC9 the parser lives in `@terragon/utils`

- `packages/utils/src/receive-pack-refs.test.ts`: "parses one update with capabilities and reports where the PACK starts" (plain `Uint8Array` input)
- `packages/utils/src/package-exports.test.ts`: the generic `it.each(Object.entries(exportsMap))` check that every export target exists, which covers `./receive-pack-refs`, `./graphql-mutation` and `./broker-headers`
- `packages/worker/src/agent-run/receive-pack-refs.test.ts` (import path only changed): all parser and fence cases, for example "parses a real git push command list (one update, caps after NUL)", "a truncated length prefix → ok:false (incomplete)", "malformed command lists are rejected", "refs/heads/main → ref_not_allowed"
- `packages/worker/src/agent-run/git-broker.test.ts`: the box broker cases, including "a push to the exact attempt branch is forwarded byte-identically and its sha recorded" and "a 70 KiB command section → 413, nothing forwarded"

### AC10 the 32 MiB push cap

- `git-push.test.ts`: "AC10 refuses a declared length over the cap before any claim"; "AC10 aborts a streamed body over the cap, releases the claim and answers 413"; "AC10 a cap crossed while GitHub's early answer is still being read is a 413 that releases the claim"
- `real-git.test.ts`: "AC10 end to end: a push over the cap fails, nothing lands, the claim is released"

### AC11 token scopes

- `git-read.test.ts`: "AC11 upload-pack legs mint the read token, the receive-pack advertisement the write token, scoped to the step's repo"
- `git-push.test.ts`: "AC11 push side: the POST mints the write token and never the read token"
- `gh.test.ts`: "mints the read token for the step's owner and repo, and 502s on a 3xx or a thrown fetch"
- `packages/shared/src/github-app.test.ts`: "write: requests a single-repo token with exactly the required permissions and returns token + expiresAt"; "write: adds workflows:write when the installation grants it, omits it when read-only or absent"; "cell read: includes pull_requests and issues when granted, omits them when not"; "read-only preset: all four are required, a missing one throws naming it and nothing optional is added"; "a failed permissions read fails a push closed, with no token request"; "a failed permissions read falls back to exactly the required permissions for the read presets"; "a missing required permission throws MissingInstallationPermissionError naming it, with no POST"

### AC12 a transient failure releases the claim; an identical retry claims afresh

- `git-push.test.ts`: "AC12 a cell disconnect after the command section is a 502 that releases the claim"; "AC12 a GitHub 503 releases the claim; an identical retry is forwarded and uses a second unit"; "AC12 a network error and a 3xx also release the claim"
- `git-push.test.ts`: "a GitHub %i is a transient failure: 502, the claim is released and an identical retry is forwarded" (408 and 429); "a GitHub %i that is not a report-status is about our token: 502, claim released, an identical retry is forwarded" (401 and 403); "a 200 whose every ng is transient returns GitHub's bytes but releases the claim, so a retry is forwarded"; "a 200 whose unpack failed returns GitHub's bytes but releases the claim, so a retry is forwarded"; "a push GitHub never answers is abandoned at the timeout: 502, claim released, and a retry is forwarded"; "a response over the 1 MiB read cap is released with a 502"
- `git-push.test.ts` (claim cleanup outlives a disconnect): "registers the whole continuation with waitUntil while the upstream call is still pending, and it ends the claim after the handler is abandoned"; "registers the continuation with waitUntil when the cell disconnects, and the claim is gone once it settles"; "registers the continuation with waitUntil on a normal push, and the answer is stored once it settles"
- `packages/shared/src/model/cell-authority.test.ts`: "drops an unanswered claim without refunding the unit, and an identical retry claims afresh (AC12)"; "leaves a completed effect alone"; "matches nothing for the wrong attempt, and rejects a non-positive attempt"; "after a takeover, the older attempt's release returns false and the claim stays with the newer attempt"; "waits for a transaction that holds the step row lock"

## Deferred

- **T1b preview measurement (OD-1).** Whether OpenNext buffers a large streamed request body before the handler runs ([opennextjs-cloudflare#1008](https://github.com/opennextjs/opennextjs-cloudflare/issues/1008)). This needs a non-production deploy of the Worker, so it runs after merge: stream a push larger than 1 MiB and watch the memory metric or `wrangler tail`. If OpenNext buffers it, the 32 MiB cap is revisited.

## Known limits and follow-ups

- A hard runtime kill between a push claim and its release can leave a same-attempt claim pending. The next attempt takes it over, and the reconciler (L3 PR 3) is the backstop. On workerd, `waitUntil` only buys a short grace (about 30 s) after the client disconnects, not the full push timeout.
- Releasing after a GitHub 5xx or a network error, once the pack was sent, can deliver a push twice (at-least-once). git re-reads the refs before re-pushing, and a ref that already moved makes GitHub reject the stale update. Repeated transient failures can also exhaust the step budget (429) although no push landed.
- The routes stay off in production (`CELL_BROKER_ENABLED` defaults to false) until L3 PR 4.
- `workflows: write` is requested only when the installation grants it. The App does not hold that permission today: add it to the App and have installations approve it to allow workflow-file pushes.
- Follow-up work is tracked in [#607](https://github.com/be-automata/automata/issues/607).
