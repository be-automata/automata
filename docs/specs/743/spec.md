# Spec #743: a timed-out cell task run continues its session in a new cell

- Ticket: be-automata/automata#743. Its Decisions table (OD-1 to OD-5) is binding.
- Ground truth re-verified at `c8b242c0` (origin/main, after #742), worktree `gh-743`, on 2026-11-21.
- Design source: spike 048 (session checkpoints; a local record, not in this repo). This spec takes
  its format and rules and writes new code in the repo's style. No spike file is copied.
- Decisions made in the spec session, in addition to OD-1 to OD-5:
  - **Q-1 (amends OD-1).** The checkpoint leaves the cell because the **worker pulls it** with the provider's `copyOut`.
    - When: on a new turn seen in its lease poll, else every 60 s, plus once at teardown.
    - The cell's reachable surface does not change: it still reaches only `/api/daemon-event` (#693).
    - The worker writes through a **new authenticated www route** that uses its own run token.
    - Redaction runs in the worker, before anything leaves the box.
  - **OD-3 as built.**
    - Pointers: one new Postgres row next to the thread chat, moved by a conditional UPDATE (CAS on a `version` column).
    - Blobs: in R2, written create-only.
    - Shipped as a migration in `deploy/migrations/` plus the drizzle schema.
  - **Flag.** `cellSessionContinuation` (default false) gates capture, restore and re-dispatch.
- Amended 2026-11-22 after validation (PASS_WITH_WARNINGS) and the owner's decisions on OQ-1 to OQ-8.
  Section 11 lists every change. The body below already reads as amended.

## 1. Ground truth

### 1.1 Facts this design stands on

"Holds" means the file and line say what the ticket or the briefing says. "Drift" means it holds at other
lines. "Does not hold" means the claim is wrong or incomplete, and the design follows the code.

| # | Claim | Verified at | Status |
|---|---|---|---|
| 1 | A cell run writes settings, `.claude.json` and a placeholder login into `/home/agent/.claude`. It has no session copy-out, no R2 write and no timeout salvage | `packages/worker/src/agent-run/cell-run.ts:1111-1223` (bootstrap), `HOME_CLAUDE_DIR` `:133`; no `salvage`/`checkpoint` in `cell-run.ts` or `cell-teardown.ts` | Holds |
| 2 | A follow-up in a new cell passes the old `sessionId` through | `buildCellMessage` `cell-run.ts:204-216` spreads the pulled body; `PulledDaemonMessage.sessionId` `types.ts:343`; www sets it from `threadChat.sessionId` `apps/www/src/server-lib/remote-daemon-message.ts:81` | Holds (the ticket's `:185-196` drifted to `:204-216`) |
| 3 | The daemon looks for `<sessionId>.jsonl` and falls back to `--continue` silently | `isValidSessionId` `packages/daemon/src/claude.ts:38-60` (`find ~/.claude/projects -name <id>.jsonl`, any depth); fallback `:289-301` | Holds |
| 4 | `maybeFixLogsForSessionId` rewrites the restored file | `claude.ts:66-175`. It only **appends** one error `tool_result` per `tool_use` that has no result. Called pre-spawn `daemon.ts:766-768` and at process end `:391-399` | Holds. It is safe on a restored copy, see 2.4 |
| 5 | No per-turn event in the daemon | `isCompleted` is set only on `type === "result"` (`daemon.ts:896-900`) or on a held result (`:850-855`). Session id tracking `:814-845` | Holds |
| 6 | The worker's lease poll carries no turn signal | `ThreadStatusPoll` = `{status, terminal, lease?}` (`packages/worker/src/agent-run/www-client.ts:579-581`). The cell poll runs one `pgrep` exec per poll in `beforeStatusRead` (`cell-run.ts:1245-1265`), awaited before the status read (`www-client.ts:881`). Poll interval 7 s (`config.ts:532`) | Holds. Turns are inferred from the file (2.3) |
| 7 | The cell workspace is `/workspace`, and the daemon runs there | `CELL_WORKSPACE` `cell-image.ts:159`; `WORKDIR /workspace` `deploy/images/cell/Dockerfile:69`; the daemon spawns `bash -lc` with no `cwd` (`packages/daemon/src/runtime.ts:326-330`) | Holds |
| 8 | The session path is `~/.claude/projects/-home-agent-<workspace>/<id>.jsonl` (ticket Scope 4) | Claude Code names the project dir after the cwd with `/` turned into `-`. The repo encodes the same rule for control-plane sandboxes in `claude-session-internal.ts:31-39` (`"-" + homeDir + "-" + repoDir`). For cwd `/workspace` that gives **`/home/agent/.claude/projects/-workspace/<id>.jsonl`** | **Does not hold.** `-workspace` is the expected dir. The probe still finds the dir by session id instead of hard-coding it (F6), and the IT and AC-8 record the real one |
| 9 | The daemon is baked into the cell image | `COPY ... daemon/index.js /opt/automata/daemon.js` `deploy/images/cell/Dockerfile:60` | Holds. A daemon change needs a cell image rebuild and a digest switch. This design changes **no daemon code** (2.4) |
| 10 | Teardown revokes the broker bearer FIRST | `packages/worker/src/agent-run/cell-teardown.ts:5-17` (R → T → B → A → P) | Holds |
| 11 | The teardown worst case is 80 s inside onFailure's 120 s wait | `CELL_TEARDOWN_DEADLINE_MS` 70 s, worst case `+2×5 s` (`cell-teardown.ts:19-30`); `ON_FAILURE_TYPED_TERMINAL_WAIT_MS` 120 s, onFailure `"3m"` (`workflow.ts:384-386`, `:402-405`); the wait `:1916-1930`; pin `cell-ttl.test.ts:72-84` (worst case + 30 s ≤ 120 s) | Holds. Today that leaves 40 s before the teardown, 30 of them pinned as margin. The owner raises the wait to **150 s** and onFailure to `"4m"` (2.5, OQ-4) |
| 12 | `ICellProvider` has no pause; exec has no env or stdin | `packages/types/src/cell.ts:233-265`; `CellExecOptions` `:181-188` | Holds |
| 13 | copyIn and copyOut caps | `OPENSANDBOX_MAX_COPY_IN_BYTES` 16 MiB, copyOut 64 MiB / 120 s (`packages/sandbox/src/providers/opensandbox-cell.ts:36-44`, `:743-751`) | Holds. They bound the native transcript (3.3) |
| 14 | The daemon spawns each agent in its own process group | `spawn("bash", ["-lc", ...], { detached: true })` `runtime.ts:326-330`; `killProcessGroup` `utils.ts:17-25` | Holds. The freeze signals those groups (2.5) |
| 15 | Box timeout salvage: freeze, commit, push to the work branch | `salvageWorkBranch` `abnormal-end.ts:518-674` (scripts `:318-375`, `SALVAGE_BUDGET_MS` 60 s `:309`); called from `workflow.ts:1774-1812`. It needs a `docker exec` runner with env and a broker bearer (`:417-461`) | Holds. Not callable as is for a cell (no exec env, no bearer in the worker) |
| 16 | `timeout` is classified at limit − 15 s; the cell claims its end inside `tearDown` | `TIMEOUT_CANCEL_TOLERANCE_MS` `abnormal-end.ts:36`, classifier `:80-95`, `claimAbnormalEnd` `:238-252`; the cell claims in `tearDown` `cell-run.ts:1327-1355`; `owns = ownsAbnormalTerminal(input)` `workflow.ts:674` | Holds. The claim moves before the capture (2.5) |
| 17 | OD-5 predicate | `refreshesRunBudget` `packages/worker/src/agent-run/run-budget.ts:44-50` = task lane ∧ no self-heal ∧ `cell`. Lane rules `run-lane.ts:15-39` | Holds. Inside the cell executor `cell` is given, so `r.abnormal.owns` is the same predicate. A **mention on an issue** is task lane. A mention on a **PR** is `pr` lane and is not covered |
| 18 | The cell push fence is the cell broker's exact-ref check | `checkRefFence(..., { exactRef: context.allowedRef })` `packages/cell-broker/src/git.ts:663-671`; `allowedRef = refs/heads/<taskRunPushBranch>` `apps/www/src/app/api/daemon/cell-plan/route.ts:205-212`, `:232` | Holds |
| 19 | A continued run starts from the pushed work branch | `CELL_CHECKOUT_WORK_BRANCH_SH` `cell-image.ts:166-172`: `checkout -B <work> origin/<work>` when the branch exists on the remote; wired `:260-271` | Holds |
| 20 | `put` in `packages/r2` has no `onlyIf` | `R2BucketLike.put` `packages/r2/r2.ts:30-34`; `putObject` `:185-205`; `downloadData` throws on a missing key `:355-398` | Holds. No create-only write, no "absent" read |
| 21 | The private bucket | `r2Private` (`R2_PRIVATE_BUCKET`, `automata-private`) `apps/www/src/server-lib/r2.ts:20-28`; binding `apps/www/wrangler.jsonc:48-51` | Holds |
| 22 | No local R2 or MinIO in the test stack | No `getPlatformProxy` or `Miniflare` usage. `wrangler` ^4.148 is a www devDependency (`apps/www/package.json:160`); lockfile `wrangler@4.160.1` and `miniflare@5.20261110.1-beta` | Holds. The conformance test uses wrangler's local proxy (Phase 1) |
| 23 | Redaction to reuse | `redactSecrets` and `createValueRedactor` `packages/utils/src/redact.ts:8-63`; the cell's value scrub `cell-run.ts:318-323` | Holds. Missing from 048's set: `sk-ant-`, `AKIA`, PEM keys, email, account/org UUID fields, home paths. `redactSecrets` returns no hit count |
| 24 | `run-terminal` has no re-dispatch hook | `apps/www/src/app/api/daemon/run-terminal/route.ts:116-148`: `markThreadTerminal`, `retireHatchetRun`, `maybeRecheckOnComplete` (always), `replyToMentionsAtTerminal` (only when `applied`). A **redelivered** terminal of the same run returns early at `:60-77` (the `superseded` branch: the thread already has a cause), running only the recheck | Holds. The hook goes in both places (F1) |
| 25 | Re-dispatch precedents | Prompt-too-long queues `"Continue"` with `sessionId = null` (`handle-daemon-event.ts:463-491`); invalid-token retry (`:551-570`); drain `maybeProcessFollowUpQueue` (`:931`, `process-follow-up-queue.ts:9-110`); `queueFollowUpInternal` queues and drains unless shadow (`apps/www/src/server-lib/follow-up.ts:115-187`) | Holds |
| 26 | Ledgers with UNIQUE bounds | `supersede_recheck` UNIQUE(pr_key, desired_head_sha) `schema.ts:2108-2131`; `review_rerun` UNIQUE(pr_key, head_sha, attempt) + UNIQUE(failed_thread_id) `:2143-2185` | Holds. `review_rerun` is the closer model (two bounds) |
| 27 | A terminal stays fenced until a new run is stamped | `decideThreadGeneration` treats any `terminalCause` as `superseded` (`packages/shared/src/model/threads.ts:1198-1236`); `setThreadActiveRun` clears it (`:1142`); terminal = `status "complete"` + cause (`:1730-1737`) | Holds |
| 28 | The mention reply fires from `run-terminal` | `replyToMentionsAtTerminal` `apps/www/src/server-lib/review/mention-terminal-reply.ts:21-36`; text `renderMentionTerminalNotice` `mention-reply-finish.ts:94-121` ("…Mention me again to retry.") | Holds |
| 29a | A cell step is keyed by the run token | `cellStepKey(apiKeyId)` `packages/types/src/cell.ts:138`, used by cell-plan (`route.ts:127`); `openNextAttempt` / `leaseRefusal` / `finishStep` read `cell_step` by key (`packages/shared/src/model/cell-authority.ts:243`, `:386-405`, `:415`); the step's effect budget is `CELL_TASK_EFFECT_BUDGET = 50` (`cell-plan/route.ts:77`) | Holds. A box run's token has no `cell_step` row (F5) |
| 29b | A capped body read precedent | `MAX_BODY_BYTES` 1 MiB, `request.text()` then a byte check → 413 `body_too_large`, before `JSON.parse` (`apps/www/src/app/api/addon-callback/[capability]/route.ts:39`, `:63-66`) | Holds (F3 follows it, and adds a `content-length` check first) |
| 29 | Daemon routes and the token classes | `parseDaemonRequest` `apps/www/src/lib/daemon-route.ts:21-63`; retired tokens only on cell-teardown, event-scoped only on daemon-event (`daemon-api-key.ts:47-58`, `:94`); matrices over `apps/www/src/test-helpers/daemon-route-matrix.ts` | Holds. The new route must join the matrix |
| 30 | Legacy checkpoint table | `claude_session_checkpoints` `schema.ts:1462-1477` | Holds (OD-4: untouched) |
| 31 | Add-on callback receiver | `addon_call` / `addon_call_delivery` `schema.ts:3342-3390`; `ADDON_CALLBACK_SECRET` defaults to `""` (`packages/env/src/apps-www.ts:178`), and the route refuses everything while it is empty | Holds. Scope 6 is a no-op reconcile (2.8) |
| 32 | Migration rules | `deploy/lint-migrations.ts:13-27` (L1-L6); the newest file is `2026-11-24-repo-egress-audit-log.sql`, and files apply in name order (`deploy/migrate.ts:23`) | Holds. The new file is **`2026-11-25-…`** so it sorts last |
| 33 | Feature flags reach the worker in the pulled message | `featureFlags` is built per user `remote-daemon-message.ts:122`, `:164`; `PulledDaemonMessage.featureFlags` `types.ts:346` | Holds. The worker reads the flag from there |

### 1.2 What does not exist yet

- A checkpoint format, a store, a pointer table or a continuation ledger for remote-plane sessions.
- A create-only write or a nullable read in `@terragon/r2`.
- Any www route the worker can write session data through.
- Any turn signal the worker can observe without reading the transcript.
- A cell timeout salvage, and a freeze for a cell.
- A dispatcher that records add-on calls before dispatch. Only the receiver exists, and it is off.
- An OPENSANDBOX_IT that restores a session into a second cell.

## 2. Design per scope item

### 2.1 Storage (Scope 1, OD-3)

**R2, blobs only, create-only.** `@terragon/r2` gains:

- `putObjectIfAbsent(key, body, contentType?) : Promise<R2ConditionalPut>`, where
  `type R2ConditionalPut = { status: 201 } | { status: 412 }`.
  - Native binding: `put(key, body, { onlyIf: new Headers({ "If-None-Match": "*" }), httpMetadata })`.
    A `null` return is a failed precondition and becomes `{ status: 412 }`.
  - S3: `PutObjectCommand({ IfNoneMatch: "*" })`. An HTTP 412 becomes `{ status: 412 }`. A 409 (a
    concurrent conditional write) is retried once, then becomes 412. Any other error throws.
- `getObjectOrNull(key) : Promise<Buffer | null>`. `null` only for a missing key; every other
  error throws, unlike `downloadData`.
- `R2BucketLike.put` gets the `onlyIf` option and returns `Promise<unknown | null>`.

R2 needs no CAS: the head lives in Postgres. Correctness rests on content addressing plus the
Postgres CAS. A backend that ignores create-only, such as Garage, would rewrite identical bytes
under the same key, and nothing would be lost.

**Postgres: one pointer row per thread chat, `cell_session_checkpoint`.**

- The key is UNIQUE(`thread_id`, `thread_chat_id`). `thread_chat_id` alone is not unique: the
  legacy sentinel is shared across threads (`daemon-route.ts:15-18`).
- The **head** (`head_manifest_id`, `head_turn`) and the **call index** (`call_index_sha256`, kept
  null in v1, 2.8) move **together** in one conditional UPDATE:

```sql
UPDATE cell_session_checkpoint
   SET session_id = $s, head_manifest_id = $m, head_turn = $t, native_bytes = $b,
       call_index_sha256 = $c, last_run_external_id = $r,
       version = version + 1, updated_at = now()
 WHERE thread_id = $th AND thread_chat_id = $tc AND version = $expected
RETURNING version;
```

- When `$expected = 0`, the first write is `INSERT … ON CONFLICT DO NOTHING RETURNING version`.
- No row returned means the head moved. The writer stops (3.4).

**Postgres: the continuation ledger, `cell_session_continuation`** (2.6). It ships in the same
migration, and its model code comes in Phase 9.

**Write order, as rule 1 of spike 048 has it:**

1. Redact.
2. Normalize.
3. Create-only blobs (native chunk, then events chunk).
4. Create-only manifest.
5. CAS the head.

The server hashes every byte. The worker's hash is only a check.

**Deviation from 048, decided by the owner (OQ-3): a chunked native transcript.**

- 048's v0 stores one `native` blob per checkpoint. Done per turn, that re-uploads the whole growing
  transcript at every turn: O(n²) bytes sent and stored.
- Here each pull uploads **only the new bytes** as one create-only, content-addressed chunk. The
  manifest lists the chunks in order, and a restore concatenates them.
- When the list would pass `CELL_SESSION_MAX_CHUNKS` (32), the writer rewrites the whole transcript
  as fresh chunks.
- Every object is still immutable, and only the head moves.

### 2.2 The www checkpoint route (the worker's write path)

`POST /api/daemon/cell-checkpoint`, authenticated by `parseDaemonRequest`:

- It takes the worker's **run token**. The cell's event-scoped token is refused (#693), and so is a
  retired token.
- It has four actions (contract C5): `put-blob`, `commit`, `read-head` and `read-blob`.
- Every action except `read-blob` takes `runExternalId` and passes the generation fence
  (`checkThreadGeneration`): a stale attempt can neither write a head nor read one.
- **The body is capped before it is parsed (F3).** The route refuses a `content-length` above
  `CELL_CHECKPOINT_MAX_BODY_BYTES` (6 MiB: a 4 MiB chunk inflated by base64, plus the envelope)
  with 413 `body_too_large`. It then reads the body with a capped read and refuses the same way
  past the cap, before `JSON.parse`. This follows the addon-callback route (row 29b), with the
  header check added first. `parseDaemonRequest` is called on the parsed body afterwards.
- **Only a cell run's token can write (F5).**
  - A token with a null `threadId` or `threadChatId` binding (the legacy pass-through,
    `daemon-route.ts:14-19`) is refused with 403 `binding_required`.
  - Every action takes the cell `attempt`. The route then requires an **open cell step** through a
    new `cell-authority` read, `isOpenCellAttempt({ db, stepKey: cellStepKey(ctx.apiKeyId),
    threadId, attempt })`. Open means the row exists, belongs to the thread, is not done, and
    `attempt` is its current attempt and is not revoked.
  - Anything else is 403 `no_open_cell_step`. A box run's token has no `cell_step` row, so it can
    never write or read a checkpoint (row 29a).

The route runs no feature-flag check. The worker's gate (2.9) decides whether it is ever called.

It is added to `daemon-route-matrix.ts`, so the retired-token and event-scoped-token matrices cover it.

### 2.3 Per-turn capture (Scope 1, Q-1)

The cell's `pollContext.beforeStatusRead` already runs one exec per poll. It now runs a **probe**
too, a second exec. It does not hard-code the project dir (F6):

```
/usr/bin/find -P /home/agent/.claude/projects -mindepth 2 -maxdepth 2 -type f -name '*.jsonl' -printf '%s %T@ %P\n'
```

- **Which file.** Each line is `<size> <mtime> <projectDir>/<name>.jsonl`. The worker chooses **by
  session id**: the file named `<pulled.sessionId>.jsonl`, else, on a fresh run, the newest file
  whose name is a UUID (3.3). Names that are not UUIDs are ignored. The `projectDir` it found is
  kept and recorded in the manifest (C3). The 2.4 restore writes back into that same dir, and AC-8
  records which dir a real run uses (`-workspace` expected, row 8).
- **Only a regular file is read (F9).** `find -P … -type f` neither follows nor lists a symlink.
  The pull itself re-checks the chosen path in the same exec that reads it:
  `/usr/bin/find -P <path> -maxdepth 0 -type f -print -quit`. Only on a match is the file read,
  through `copyOut`. A file swapped for a symlink between the probe and the read is refused with
  `cell: checkpoint skipped (not a regular file)`. One residual gap is left: a swap in the
  milliseconds between that re-check and `copyOut`. Closing it means reading the bytes through an
  exec as the agent user (`/bin/cat`, base64 on stdout, under the 16 MiB exec cap), which is the
  fallback if review rejects the gap. The agent can only point a link at files it can already read
  as uid 10001, and everything read is redacted before it leaves the box.
- **When to pull.** When the probe shows the file **grew** since the last pull. When the probe fails,
  pull if 60 s have passed since the last pull. This is Q-1's "new turn, else every 60 s": the size
  is the turn signal the worker can observe (row 6).
- **The pull** is `copyOut` of the file, raced against `live` and bounded by
  `CELL_CHECKPOINT_POLL_BUDGET_MS` (15 s). It runs **inside** `beforeStatusRead`, before the status
  read. So the last turn of a run that completes is captured before the terminal read retires the
  token: no checkpoint route ever needs `allowRetired`.
- **Is it a turn?** The worker cuts the bytes at the last `\n`, so a torn line is never stored. It
  normalizes them, and writes a checkpoint **only when the completed-turn count went up**.
  - A completed turn is one assistant API response (a distinct `message.id`) whose every `tool_use`
    has its `tool_result`.
  - That makes OD-1's "after every completed turn" at poll granularity: at most one checkpoint per
    7 s poll.
  - Every key is new (content-addressed), so R2's 1 write/s per key is never reached.
- **Failures.** Every failure is one journal line, and the run continues. A head CAS loss
  (`head_moved`) or a fence refusal stops capture for the rest of the run.

Native size: when the redacted transcript passes `CELL_SESSION_NATIVE_MAX_BYTES` (12 MiB),
checkpoints stop with `checkpoint: skipped (over cap)`. The head stays at the last checkpoint under
the cap. Why 12 MiB: copyIn is capped at 16 MiB (row 13), and a Workers isolate has 128 MB.

### 2.4 Restore into a new cell (Scope 4)

Restore runs between `nextMessage` (`cell-run.ts:520`) and the message write (`:547-561`). The daemon
spawns Claude only when a message arrives, so the file is in place before `isValidSessionId` runs.

1. **Read the head.** Gated (2.9): read `read-head` with `{ sessionId: pulled.sessionId }` once per
   run. Capture needs the head version even when nothing is restored.
2. **Fetch and verify.** When the row's session matches, fetch each chunk (`read-blob`, at most 32)
   and verify each sha256 against its address. Then verify the whole transcript against
   `native.sha256` and `native.bytes`.
3. **Copy in** to `/home/agent/.claude/projects/<projectDir>/<sessionId>.jsonl` (mode 600, uid
   agent), after a `mkdir -p -m 700`. `projectDir` is the one the manifest recorded (F6), accepted
   only if it matches `^-[A-Za-z0-9-]{1,200}$`; otherwise `-workspace` is used. Confirm with
   `test -s`.
4. **On success,** the message keeps `sessionId`, and the daemon runs `--resume <sessionId>`
   (`claude.ts:289-292`). The writer continues the chain (parent = the restored head, expected =
   its version).
5. **On any failure,** `buildCellMessage` gets **`sessionId: null`**, so the daemon never reaches its
   silent `--continue` branch (`claude.ts:293-300`). The failures are: no row, another session, a
   bad id, a missing blob, a hash mismatch, over the cap, a copyIn failure, and the flag off while
   `pulled.sessionId` is set. On a failure the worker also:
   - logs `cell: session restore: none (<reason>); started fresh`;
   - puts one platform note before the prompt: "[automata] The earlier conversation could not be
     restored (<reason>); you are starting without its history. Check the work branch for earlier
     commits."

Replacing the silent fallback this way needs **no daemon change**, so no cell image rebuild
(row 9). The daemon's fallback stays for other planes (OQ-8).

**`maybeFixLogsForSessionId` is safe.** It appends one error `tool_result` per open `tool_use`, and
only to the cell's local copy. The R2 objects are immutable. That closes a tool call left open by a
mid-call cut, which `--resume` would otherwise trip on. The error text says "STOP … wait for the
user", but the continuation user message comes right after it in the same resume. The next capture
sees the appended lines as growth and stores them, which is the truth of the session.

A redacted transcript resumes: spike 048 c1 and c4. A compaction keeps `sessionId = null`
(`remote-daemon-message.ts:81-93`), so nothing is restored and the compaction summary stands.

If `--resume` writes to a new session id (OQ-7), the probe lists the new file. The writer starts a
chain whose `parent` is the restored head, and it moves the pointer's `session_id`.

### 2.5 Capture on timeout: freeze, final flush, WIP push (Scopes 2 and 3)

**Order.** In `runCell`, after `decideExit` and before `tearDown`, which revokes first (row 10):

1. **Claim the end early.** `claimAbnormalEnd` moves out of `tearDown`. `tearDown` takes the claimed
   end, and the salvage result goes into `postAbnormal`'s info.
2. **Skip** fenced, conflict, completed and nothing-to-run ends. Their token is retired, or the
   attempt is not theirs.
3. **On every other end,** await any in-flight pull, then run one **final flush**.
4. **On `timeout`,** do more:
   - **a. Freeze.** One exec: find the daemon by `pgrep -o -f '[/]opt/automata/daemon.js'`, then send
     `kill -STOP -- -<pgid>` to every child process group of the daemon. These are the agent groups
     (row 14). The daemon and execd keep running. Agent processes that called `setsid` are not frozen
     (a known limit). Fails open.
   - **b. Final flush** of the frozen transcript.
   - **c. WIP push** (`salvageCellWorkBranch`), with the box's step sequence:
     - It uses the box's guards: config guard, ref format, HEAD on the work branch, no
       merge/rebase, no submodules, stale locks, `add -A`, commit, unpushed check, no secret file
       names, one refspec.
     - That sequence is extracted from `salvageWorkBranch` as an exported `runSalvageSteps` that both
       paths call. The box's behaviour and its tests are unchanged.
     - The cell runner execs `/usr/bin/env <hardening and identity pairs> /bin/sh -c <script> sh
       <args>` in `/workspace`. Those values hold no secret: the vault puts the broker bearer on
       the wire.
     - The push URL is the clone's broker URL,
       `https://<deployment>/api/cell/git/<owner>/<repo>.git`, never `origin`.
     - The cell broker allows only `refs/heads/<pushBranch>` (row 18). A work branch that does not
       match is refused and logged as `salvage: failed (push failed)`.
     - A push also spends one effect of the step's budget (`CELL_TASK_EFFECT_BUDGET` = 50, row
       29a). An agent that spent it gets a 429 from the broker on the salvage push, which is logged
       the same way, `salvage: failed (push failed)` (F8, risk in section 7).
     - A read-only run has nothing staged and nothing unpushed, so it logs
       `salvage: nothing to save`.

**Budget (owner decision OQ-4, folds in F2).**

- `ON_FAILURE_TYPED_TERMINAL_WAIT_MS` goes **120 s → 150 s**, and onFailure's
  `ON_FAILURE_EXECUTION_TIMEOUT` goes **`"3m"` → `"4m"`** (`workflow.ts:384-386`). The 4 minutes
  cover the wait plus the generic post.
- Steps 3 and 4 run under `CELL_TIMEOUT_CAPTURE_BUDGET_MS` = **40 s**, measured from the moment the
  poll loop returns. **The in-flight per-turn pull is inside it (F2):** the capture first awaits that
  pull for at most the budget left, then abandons it, then runs its own steps on what is left.
- Every step uses fresh signals. The run's signal is already aborted, so `raceLive` and `ensureLive`
  are not used.
- Split: in-flight pull ≤ 15 s (its own poll bound, 2.3), freeze ≤ 3 s, final flush ≤ 12 s, push
  gets the rest (≥ 10 s, more when no pull was in flight).
- The pin (Phase 7b, `cell-ttl.test.ts`): `CELL_TIMEOUT_CAPTURE_BUDGET_MS` (40 s) +
  `CELL_TEARDOWN_WORST_CASE_MS` (80 s) + 30 s of slack ≤ `ON_FAILURE_TYPED_TERMINAL_WAIT_MS` (150 s).
  The existing M3 pin (teardown + 30 s ≤ wait) still holds.
- If the capture runs over, onFailure posts the generic failure first, and the typed `timeout`
  terminal (and with it the continuation) is lost. So the budget protects the decision itself.
- The longer wait only delays onFailure's **generic** post, and only for a task run still live in
  this process (`workflow.ts:1916-1930`). Review and pr runs do not wait.

**Every step fails open.** A failed freeze, flush or push never changes the cause and never delays
the teardown past the budget.

### 2.6 Re-dispatch on `timeout` (Scope 5, OD-2, OD-5)

**Ledger `cell_session_continuation`.**

- Bound 1: UNIQUE(`thread_id`, `ordinal`). `ordinal` is 1-based and at most
  `CELL_SESSION_CONTINUATION_BUDGET = 1` (OD-2).
- Bound 2: UNIQUE(`source_run_external_id`). One timed-out run hands off at most once, however
  often its terminal is redelivered.
- This is `review_rerun`'s two-bound pattern (row 26).

**The decision.** `maybeContinueAfterTimeout({ threadId, threadChatId, runExternalId, cause })` in
`apps/www/src/server-lib/cell-session/continuation.ts`. It never throws. It continues only when
every check below passes, in order, and each refusal returns `{ continued: false, reason }`:

| Check | Refusal reason |
|---|---|
| The flag is on for the thread's user (2.9) | `flag-off` |
| `cause === "timeout"` | `not-timeout` |
| No ledger row has this `source_run_external_id` | `already-continued` |
| **The budget, BEFORE the checkpoint checks (F4):** the number of ledger rows for the thread is below `CELL_SESSION_CONTINUATION_BUDGET`. So a second timeout names the limit (AC-3) even when the continued run wrote no checkpoint | `budget-spent` |
| A pointer row exists with `last_run_external_id === runExternalId`. Only an OD-5 run writes one, so the row is the lane proof | `no-checkpoint` |
| The row has `head_turn ≥ 1` | `no-completed-turn` |
| **Done check** (spike 033): the thread still shows this run's timeout terminal (`terminalCause = "timeout"`, `activeRunExternalId = runExternalId`) and is not archived | `thread-moved-on` |
| The thread is not a shadow thread | `shadow` |
| The claim insert wins against both UNIQUE bounds. Losing a race maps to `already-continued` or `budget-spent` | `already-continued` / `budget-spent` |
| The add-on reconcile (2.8) succeeds | (none) |

**OQ-1 (owner decision): no re-dispatch without a checkpoint.** A timeout with no checkpoint of this
run (`no-checkpoint`, `no-completed-turn`) is not continued. It logs
`continuation: none (no-checkpoint)` (or `(no-completed-turn)`) and keeps today's terminal reply.
Every refusal logs one `continuation: none (<reason>)` line with the thread id, never a body.

When every check passes, it queues the **continuation message** (C7) through `queueFollowUpInternal`
(`source: "www"`), which drains it. The dispatch is the ordinary follow-up path, so the cell marker
is computed as for any follow-up.

**The claim's life (F7).**

1. Insert the row with `state = 'claimed'`.
2. Queue the message.
3. Set `state = 'dispatched'` right after the queue write returns. That is the marker that the
   message exists.

A throw **before** the queue write deletes the claim, as `releaseRecheck` does, so a redelivered
terminal can retry. A throw **after** the queue write (in the drain, or in the `dispatched`
update) keeps the claim: the message is queued and drains with the thread's next activity. Never
releasing at that point is what prevents a second continuation. A row left at `claimed` with no
queued message is the only stuck case, logged as `continuation: claimed, not dispatched`. It still
counts against the budget (fail closed on cost).

**Hook in `run-terminal`, in both places (F1).** It runs off the response (`waitUntil`):

- **After the terminal write** (`route.ts:116-148`), whatever `applied` is.
- **In the early-return branch for a redelivered terminal** (`route.ts:60-77`, `superseded` with this
  run's generation, which today runs only `maybeRecheckOnComplete`). That branch is the one a
  redelivered `timeout` actually takes, because the first write already stamped `terminalCause`.
  It calls `maybeContinueAfterTimeout` and posts **no reply** there.

Both repair a dispatch lost after the first write, and the ledger keeps the whole thing
at-most-once (AC-4).

```ts
// after the terminal write
waitUntil((async () => {
  const c = await maybeContinueAfterTimeout({ threadId, threadChatId, runExternalId, cause });
  if (applied && !c.continued) {
    await replyToMentionsAtTerminal([
      { threadId, threadChatId, continuationLimitReached: c.reason === "budget-spent" },
    ]);
  }
})());
// in the redelivered-terminal branch (:60-77): continuation only, no reply
waitUntil(maybeContinueAfterTimeout({ threadId, threadChatId, runExternalId, cause }));
```

**The mention reply waits for the final run.** When the run is continued, no terminal reply is
posted. The continued run's own finish or terminal answers the mention, and the existing reply
marker keeps it at one reply. When the budget is spent, the reply names the limit (C7). An error in
the decision counts as "not continued", so the mention is never left silent.

### 2.7 Lanes (OD-5)

- **Capture and restore** run only when `r.abnormal.owns` (= `ownsAbnormalTerminal(input)`, which
  equals `refreshesRunBudget` inside the cell executor) and the flag is on.
- **The re-dispatch** needs the pointer row written by that run.
- **Self-heal, review and pr-lane runs** never write a row, so they are never continued.

### 2.8 Reconcile in-flight add-on calls (Scope 6)

`reconcileAddonCalls({ threadId })` runs inside the decision, before the dispatch.

- **While `ADDON_CALLBACK_SECRET` is empty** (today), it returns `{ reason: "receiver-off" }`
  without a query.
- **With the secret set,** it lists the thread's unexpired `addon_call` rows and their deliveries.
  - It **never re-dispatches** a call (048 rules 5 and 6: neither RAP nor third-party MCP servers
    dedup a re-send).
  - Each call that has no result yet is listed by id in the continuation message: "accepted, no
    result yet: poll it, do not send it again".
- **`call_index_sha256`** stays null until a dispatcher that records calls exists. The column is
  there so OD-3's joint move needs no later migration.

### 2.9 The flag (rollback)

`cellSessionContinuation` (default `false`) is defined in `feature-flags-definitions.ts`. It is read:

- **in the worker,** from `pulled.featureFlags.cellSessionContinuation === true` (row 33), through an
  injected `deps.sessionContinuation(pulled)`. That one value gates capture and restore.
- **in www,** by `getFeatureFlagForUser(…, "cellSessionContinuation")` in the decision.

Until Phase 11 both gates are injected as `() => false`. Every earlier phase merges inert.

Turning the flag off brings back today's behaviour at once, with one difference that is safe: a cell
follow-up whose session was not restored now gets `sessionId: null` instead of the silent
`--continue` on an empty HOME. Checkpoints left behind are inert.

## 3. Contract

### C1 `@terragon/r2`

```ts
export type R2ConditionalPut = { status: 201 } | { status: 412 };
putObjectIfAbsent(key: string, body: Buffer | Uint8Array | string, contentType?: string): Promise<R2ConditionalPut>;
getObjectOrNull(key: string): Promise<Buffer | null>;
```

### C2 Postgres (migration `deploy/migrations/2026-11-25-cell-session-checkpoint.sql`, `-- migrate:expand`)

`cell_session_checkpoint`:

| Column | Type |
|---|---|
| `id` | text PK, default `gen_random_uuid()` |
| `thread_id` | text NOT NULL, FK → `thread`, ON DELETE cascade |
| `thread_chat_id` | text NOT NULL |
| `organization_id` | text, FK → `organization`, ON DELETE cascade |
| `session_id` | text NOT NULL |
| `head_manifest_id` | text NOT NULL (sha256 hex) |
| `head_turn` | integer NOT NULL |
| `native_bytes` | integer NOT NULL |
| `call_index_sha256` | text, null |
| `version` | integer NOT NULL |
| `last_run_external_id` | text NOT NULL |
| `created_at`, `updated_at` | `timestamp(3)` NOT NULL, default `now()` |

Index: UNIQUE(`thread_id`, `thread_chat_id`).

`cell_session_continuation`:

| Column | Type |
|---|---|
| `id` | text PK |
| `thread_id` | text NOT NULL, FK, cascade |
| `thread_chat_id` | text NOT NULL |
| `ordinal` | integer NOT NULL |
| `source_run_external_id` | text NOT NULL |
| `checkpoint_manifest_id` | text NOT NULL |
| `checkpoint_turn` | integer NOT NULL |
| `state` | text NOT NULL, default `'claimed'`; values `claimed` and `dispatched` (`dispatched` = the message is queued, F7) |
| `created_at`, `updated_at` | `timestamp(3)` |

Indexes: UNIQUE(`thread_id`, `ordinal`) and UNIQUE(`source_run_external_id`).

The file's rules:

- Idempotent DDL (L5): `CREATE TABLE IF NOT EXISTS`, and FKs inside `DO … duplicate_object`.
- Plain `CREATE UNIQUE INDEX IF NOT EXISTS`, allowed by L3 because the tables are created in the
  same file.
- No `BEGIN`/`COMMIT` (L6), no backfill, nothing dropped.
- Names and types match `schema.ts` (schema-drift CI).

### C3 Checkpoint format (`packages/types/src/cell-session-checkpoint.ts`)

```ts
export const CELL_SESSION_SCHEMA = "automata.cell-session-checkpoint/v1";
export interface BlobRef { sha256: string; bytes: number }
export interface CellSessionManifest {
  schema: typeof CELL_SESSION_SCHEMA;
  id: string;                       // sha256 hex of canonicalJson(manifest without id)
  threadId: string; threadChatId: string;
  sessionId: string;                // Claude session id (UUID)
  parent: string | null;            // previous head, or the restored head
  turn: number;                     // completed turns in the whole transcript
  runExternalId: string;
  createdAt: string;
  harness: { name: "claude-code"; nativeFormat: "claude-jsonl" };
  projectDir: string;               // the ~/.claude/projects/<dir> the probe found (F6), e.g. "-workspace"
  git: { commit: string } | null;   // `git rev-parse HEAD` at capture; null on failure
  native: { sha256: string; bytes: number; chunks: BlobRef[] };   // sha256 of the concatenation
  events: { count: number; chunks: BlobRef[] };                    // normalized NDJSON
  redaction: { rulesDigest: string; hits: number };                // counts only, never values
}
export const CELL_SESSION_CHUNK_MAX_BYTES = 4 * 1024 * 1024;
export const CELL_SESSION_NATIVE_MAX_BYTES = 12 * 1024 * 1024;
export const CELL_SESSION_MAX_CHUNKS = 32;
export const CELL_SESSION_CONTINUATION_BUDGET = 1;
export function canonicalJson(value: unknown): string;   // sorted keys, no whitespace
export function cellSessionKeys(threadId: string): { blob(sha: string): string; manifest(id: string): string };
```

Each side hashes with `node:crypto` (`createHash("sha256")`). www has `nodejs_compat`, and other www
modules already use it.

The normalized event is 048's `{ seq, id, parentId, role, kind: message | tool_call | tool_result,
text, toolName?, toolCallId?, ts }`, plus `messageId` for turn counting. Unknown line types are
skipped, never guessed.

### C4 R2 layout (private bucket)

- `cell-sessions/<threadId>/blobs/sha256/<hex>`
- `cell-sessions/<threadId>/manifests/<id>.json`

Dedup happens only inside one thread. A thread-scoped prefix makes any later deletion a prefix
delete (OQ-5).

### C5 `POST /api/daemon/cell-checkpoint` (run token)

Every action's body also carries `attempt` (the cell attempt). Before anything else the route checks:

- a `content-length` or a capped read above 6 MiB → 413 `body_too_large` (F3);
- a token with a null binding → 403 `binding_required` (F5);
- `isOpenCellAttempt` false → 403 `no_open_cell_step` (F5).

| Action | Body (besides `threadId`, `threadChatId`, `attempt`) | Answers |
|---|---|---|
| `put-blob` | `runExternalId`, `sha256`, `base64` (≤ 4 MiB decoded) | 200 `{ created }` (412 → `created: false`); 400 `hash_mismatch`; 413 `too_large`; 409 `superseded` |
| `commit` | `runExternalId`, `manifest`, `expectedVersion` | 200 `{ version }`; 409 `head_moved` `{ version }`; 409 `superseded`; 422 `blob_missing`; 400 `bad_manifest` (id, thread ids, sum of chunk bytes, cap, chunk count) |
| `read-head` | `runExternalId`, `sessionId` | 200 `{ found: false, reason: "none" \| "other_session" }` or `{ found: true, manifest, version }`. The manifest is re-verified against its id |
| `read-blob` | `sha256` | 200 `{ base64 }`; 404 |

The route never logs a body. It logs the action, the thread id, the version and sizes.

### C6 Worker journal lines (numbers and enums only)

- `cell: checkpoint turn=<n> native=<bytes> chunks=<k> hits=<h> v=<version> in <ms>ms` (with `final` on the teardown flush)
- `cell: checkpoint skipped (<over cap | copy-out failed | www <code> | head moved; capture stopped>)`
- `cell: freeze: <k> groups` | `cell: freeze failed (<reason>)`
- `salvage: …` (the box's four shapes)
- `cell: session restore: restored turn=<n> native=<bytes> dir=<projectDir> in <ms>ms` | `cell: session restore: none (<reason>); started fresh`
- `cell: checkpoint skipped (not a regular file)` (F9) | `cell: checkpoint skipped (redactor error)` (OQ-2, fail closed)

www logs `continuation: none (<reason>)`, `continuation: dispatched (ordinal 1)` and
`continuation: claimed, not dispatched`.

AC-8 reads its numbers from these lines.

### C7 Texts

- **Continuation message** (a queued user message, built only from constants, the turn number and
  the thread's branch name): "Automatic continuation 1 of 1: the previous run hit its time limit
  after {turn} completed turns. This conversation was restored from its checkpoint, and unfinished
  work was saved to the work branch `{branch}`. Continue the task from where it stopped. Do not redo
  steps you already completed; check the work branch and your earlier results first." When the
  receiver is on, one more line lists the pending add-on calls (2.8).
- **Mention reply, budget spent:** `renderMentionTerminalNotice("timeout", { continuationLimitReached: true })` →
  "I couldn't finish this: the run hit its time limit before it could answer, after 1 automatic
  continuation (the limit per thread). Mention me again to retry."

### C8 Flag

`cellSessionContinuation` (default false): "Captures a cell task run's session after each turn,
restores it into the next cell, and continues a run that timed out once (#743). Off: no capture, no
restore, no continuation."

## 4. Redaction (rule 4 of spike 048, AC-5)

`packages/worker/src/agent-run/cell-session-redact.ts` builds one redactor per run. It runs on the
raw text, line by line: a JSONL line escapes its newlines, so no rule spans a line. It returns
`{ text, hits }`:

1. **The cell's value scrub.** It reuses `createValueRedactor(repoValues)` (`cell-run.ts:318-322`):
   the owner's repo env values and the test database password.
2. **The secret patterns.** `redactSecrets`'s patterns, counted. Then 048's additions:
   - `sk-ant-…`, `AKIA[0-9A-Z]{16}`, and PEM private-key blocks;
   - **email**;
   - `accountUuid` and `organizationUuid` values;
   - **home paths** `/Users/<name>` and `/home/<name>`, except the image user's own `/home/agent`,
     which is fixed by the image and is not an identity. The lines' `cwd` stays `/workspace`.
3. **The system prompt and request blobs.** On a line that carries them, the field is replaced by
   `"[REDACTED:system-prompt]"` and the line is kept, so the `parentUuid` chain holds. Which fields
   carry them is pinned from a real cell capture in Phase 5 (OQ-2).
   - On resume, Claude rebuilds the system prompt from the new cell's files, so dropping the stored
     copy costs nothing.

The manifest stores `rulesDigest` (sha256 of the rule names and sources) and the hit count, never
the values. The events blob is normalized from the **redacted** text.

Rules may be added and never removed. A test pins the digest.

**Fail closed (OQ-2, an owner assumption).** The redaction is per field, and the field list is
pinned from one real cell capture.

- If the redactor throws on any line (unparseable JSON where a field rule applies, or any other
  error), **nothing from that pull leaves the box**.
- The pull is dropped with `cell: checkpoint skipped (redactor error)`, and the head stays where it
  was.
- A line is never stored unredacted, and a partly redacted chunk is never stored.

## 5. Phases

Each phase touches at most 5 files, tests included. Each leaves `pnpm turbo tsc-check`, `lint`,
`format-check` and the touched suites green. Every phase merges inert until Phase 11.

```yaml
phases:
  - id: 1
    name: "Storage: R2 create-only write and nullable read"
    files:
      - packages/r2/r2.ts                                   # putObjectIfAbsent, getObjectOrNull, R2BucketLike.put onlyIf
      - packages/r2/index.ts                                # export R2ConditionalPut
      - apps/www/src/lib/r2-client.test.ts                  # binding null -> 412; S3 412 -> 412; 409 then 201; missing -> null
      - apps/www/src/lib/r2-conformance.integration.test.ts # new, R2_CONFORMANCE=local|remote (AC-6)
    verify: "pnpm --filter @terragon/www exec vitest run --no-file-parallelism src/lib/r2-client.test.ts; R2_CONFORMANCE=local ... src/lib/r2-conformance.integration.test.ts"
  - id: 2
    name: "Storage: pointer row and ledger tables, head CAS model"
    files:
      - deploy/migrations/2026-11-25-cell-session-checkpoint.sql   # new, expand-only (C2)
      - packages/shared/src/db/schema.ts                           # cellSessionCheckpoint, cellSessionContinuation
      - packages/shared/src/model/cell-session-checkpoint.ts       # new: getCellSessionHead, advanceCellSessionHead (CAS)
      - packages/shared/src/model/cell-session-checkpoint.test.ts  # new
    verify: "node deploy/lint-migrations.ts; pnpm --filter @terragon/shared exec vitest run --no-file-parallelism src/model/cell-session-checkpoint.test.ts; schema-drift CI"
  - id: 3
    name: "Storage: checkpoint format and the www store"
    files:
      - packages/types/src/cell-session-checkpoint.ts                    # new (C3)
      - apps/www/src/server-lib/cell-session/checkpoint-store.ts         # new: keys, verify, put-blob, commit order, read-head, read-blob
      - apps/www/src/server-lib/cell-session/checkpoint-store.test.ts    # new
  - id: 4
    name: "Storage: the worker's write route (F3 body cap, F5 open cell step + bound token)"
    files:
      - apps/www/src/app/api/daemon/cell-checkpoint/route.ts       # new (C5): content-length + capped read -> 413, binding_required, no_open_cell_step
      - apps/www/src/app/api/daemon/cell-checkpoint/route.test.ts  # new
      - apps/www/src/test-helpers/daemon-route-matrix.ts           # joins the retired / event-scoped matrices
      - packages/shared/src/model/cell-authority.ts                # isOpenCellAttempt({ db, stepKey, threadId, attempt })
      - packages/shared/src/model/cell-authority.test.ts           # open / done / revoked / older attempt / other thread / no row
    verify: "www vitest: the route test, retired-daemon-token.integration.test.ts, cell-event-token.integration.test.ts; shared vitest cell-authority.test.ts"
  - id: 5
    name: "Capture: redaction and the checkpoint writer (pure)"
    files:
      - packages/worker/src/agent-run/cell-session-redact.ts            # new (section 4)
      - packages/worker/src/agent-run/cell-session-redact.test.ts       # new: canary set (AC-5), digest pin, line shape kept
      - packages/worker/src/agent-run/cell-session-checkpoint.ts        # new: line cut, delta/prefix check, normalize, turn count, chunks, manifest, writer
      - packages/worker/src/agent-run/cell-session-checkpoint.test.ts   # new
      - packages/worker/src/agent-run/__fixtures__/cell-session.jsonl   # new: a redacted-shape fixture from one real cell capture (OQ-2)
  - id: 6
    name: "Capture: per-turn pulls in the cell poll (F6 probe by session id, F9 regular file only)"
    files:
      - packages/worker/src/agent-run/cell-www-client.ts         # postCheckpointBlob / Commit / ReadHead / ReadBlob (with attempt), typed results, never throw
      - packages/worker/src/agent-run/cell-www-client.test.ts
      - packages/worker/src/agent-run/cell-run.ts                # deps.checkpoint + deps.sessionContinuation; projects/*/<id>.jsonl probe, -type f re-check, bounded pull in beforeStatusRead
      - packages/worker/src/agent-run/cell-run.test.ts
      - packages/worker/src/agent-run/cell-executor-default.ts   # wires the clients; sessionContinuation: () => false
  - id: 7a
    name: "Capture: the cell WIP salvage (Scope 3)"
    files:
      - packages/worker/src/agent-run/abnormal-end.ts        # extract runSalvageSteps; box behaviour unchanged
      - packages/worker/src/agent-run/abnormal-end.test.ts   # unchanged cases stay green; one case for the exported sequence
      - packages/worker/src/agent-run/cell-salvage.ts        # new: freeze script, exec runner, broker push URL, budgets
      - packages/worker/src/agent-run/cell-salvage.test.ts   # new
  - id: 7b
    name: "Capture: claim early, freeze, final flush, push, then teardown (Scope 2, OQ-4, F2)"
    files:
      - packages/worker/src/agent-run/cell-run.ts            # 40 s capture budget, the in-flight pull counted inside it
      - packages/worker/src/agent-run/cell-run.test.ts
      - packages/worker/src/agent-run/cell-ttl.test.ts       # 40 s capture + 80 s teardown + 30 s slack <= 150 s wait
      - packages/worker/src/agent-run/workflow.ts            # ON_FAILURE_TYPED_TERMINAL_WAIT_MS 150_000, ON_FAILURE_EXECUTION_TIMEOUT "4m"
      - packages/worker/src/agent-run/workflow.test.ts       # pins the two constants and the onFailure registration
  - id: 8
    name: "Restore into a new cell (Scope 4)"
    files:
      - packages/worker/src/agent-run/cell-session-checkpoint.ts        # assemble + verify chunks, writer init from a restored head
      - packages/worker/src/agent-run/cell-session-checkpoint.test.ts
      - packages/worker/src/agent-run/cell-run.ts                       # restore between nextMessage and the write; sessionId null + note on failure
      - packages/worker/src/agent-run/cell-run.test.ts
      - packages/worker/src/agent-run/cell-session.integration.test.ts  # new, OPENSANDBOX_IT (section 6)
  - id: 9
    name: "Re-dispatch: the ledger and the decision (F4 budget before no-checkpoint, F7 claim life)"
    files:
      - packages/shared/src/model/cell-session-continuation.ts        # new: claim (both UNIQUE bounds), markDispatched, release (pre-queue only)
      - packages/shared/src/model/cell-session-continuation.test.ts   # new
      - apps/www/src/server-lib/cell-session/continuation.ts          # new: maybeContinueAfterTimeout, reconcileAddonCalls, message text; gate injected, default false
      - apps/www/src/server-lib/cell-session/continuation.test.ts     # new
  - id: 10
    name: "Re-dispatch: the run-terminal hook in both branches (F1) and the mention reply"
    files:
      - apps/www/src/app/api/daemon/run-terminal/route.ts             # after the write AND in the :60-77 redelivery branch (no reply there)
      - apps/www/src/app/api/daemon/run-terminal/route.test.ts
      - apps/www/src/server-lib/review/mention-terminal-reply.ts      # target.continuationLimitReached
      - apps/www/src/server-lib/review/mention-reply-finish.ts        # renderMentionTerminalNotice option
      - apps/www/src/server-lib/review/mention-reply-finish.test.ts
  - id: 11
    name: "Flag wiring and docs"
    files:
      - packages/shared/src/model/feature-flags-definitions.ts        # cellSessionContinuation (C8)
      - apps/www/src/server-lib/cell-session/continuation.ts          # gate -> getFeatureFlagForUser
      - apps/www/src/server-lib/cell-session/continuation.test.ts     # flag off -> flag-off; on -> continues
      - packages/worker/src/agent-run/cell-executor-default.ts        # gate -> pulled.featureFlags.cellSessionContinuation === true
      - packages/worker/deploy/README.md                              # flag, the R2 prefix, retention, rollout and rollback
```

Gates after the last phase:

- `pnpm turbo tsc-check --force`, `lint` and `format-check`;
- the `shared`, `www`, `worker` and `utils` vitest suites;
- `node deploy/lint-migrations.ts` and the schema-drift job;
- the opt-in runs: `R2_CONFORMANCE=local` (and `remote` once, by the operator) and `OPENSANDBOX_IT=1` with the cell image.

## 6. Tests

**Unit and DB tests, per phase:**

- **R2 client** (P1): every mapping of C1. `putObject` is never called on the create-only path.
- **Head CAS** (P2):
  - the first insert gets version 1; a stale `expectedVersion` is refused;
  - **10 writers racing one head → exactly 1 wins**;
  - the head and the call index change in one statement (a forced error leaves both old).
- **Store** (P3):
  - a blob whose bytes do not match its claimed hash is refused;
  - a manifest whose id does not hash is refused;
  - a missing chunk → 422;
  - a tampered blob on read → `found: false`, which the worker reads as "started fresh";
  - the write order is put-blob, manifest create-only, CAS (call-order spy).
- **Route** (P4):
  - auth (401 / 403 / 503) and the F2 binding;
  - the fence: a stale `runExternalId` → 409, so a superseded attempt cannot write;
  - `head_moved` on a lost CAS;
  - the retired-token and event-scoped-token matrices;
  - **F3:** a `content-length` over 6 MiB → 413 without reading the body; a body without the header
    (or one that lies) that streams past 6 MiB → 413; neither reaches `JSON.parse`;
  - **F5:** a null-binding token → 403 `binding_required`; a box run's token (no `cell_step` row) →
    403 `no_open_cell_step`; a done step, a revoked attempt, an older attempt or another thread's
    step → 403; `isOpenCellAttempt`'s own cases in `cell-authority.test.ts`.
- **Redaction** (P5, AC-5): one fixture holds every canary:
  - a repo env value;
  - a fake `sk-ant-` key, a fake `AKIA` key and a fake `ghs_` token;
  - a PEM block, an email, an `accountUuid` and an `organizationUuid`;
  - `/Users/<name>`;
  - a CLAUDE.md marker inside the system-prompt field.

  No canary is found in any stored object (native chunks, events chunks or manifest). The hit count
  is right, every line still parses as JSON, and the `uuid`/`parentUuid` chain is intact.
- **Writer** (P5):
  - a torn last line is never stored;
  - turns count only completed responses;
  - no write when the turn count did not rise;
  - an append-only file sends only the delta; a changed prefix triggers a full rewrite;
  - more than 32 chunks → a full rewrite;
  - over 12 MiB → skipped;
  - `head_moved` stops the writer.
- **Per-turn** (P6):
  - growth → one pull per poll;
  - a failed probe → a pull every 60 s;
  - the pull is bounded and never fails the run;
  - the gate off → no probe at all;
  - **F6:** the probe argv searches `projects` at depth 2 with no hard-coded dir. The file named
    after `pulled.sessionId` wins over a newer file. A file in a dir other than `-workspace` is
    found, and its dir is recorded;
  - **F9:** a symlink in place of the session file is never listed or read (`find -P -type f`); a
    swap after the probe fails the re-check → `skipped (not a regular file)`, and `copyOut` is not
    called;
  - **OQ-2:** a redactor error drops the whole pull, and no put-blob is sent.
- **Salvage** (P7a):
  - a dirty tree → `wip` commit and push of `HEAD:refs/heads/<work>` to the broker URL;
  - a broker 403 (fence) → `salvage: failed (push failed)`;
  - a broker 429 (`effect_budget_exhausted`, F8) → `salvage: failed (push failed)`;
  - read-only → `nothing to save`;
  - a secret file name → `skipped (possible secret file)`;
  - the freeze argv signals only process groups;
  - the budget holds when a step's exec hangs.
- **Teardown order** (P7b):
  - on `timeout`, the order is freeze → final flush → salvage → `teardownCellRun` (whose first call
    is www revoke);
  - the salvage shows in the terminal info;
  - a fenced end skips the capture; a completed end skips the final flush;
  - **F2:** a per-turn pull still in flight at the cancel is awaited inside the 40 s budget and
    abandoned when the budget runs out, so the teardown still starts by 40 s (a fake clock with a
    hung `copyOut`);
  - **OQ-4:** the pin `40 s + 80 s + 30 s ≤ 150 s` (`cell-ttl.test.ts`), and `workflow.test.ts` pins
    `ON_FAILURE_TYPED_TERMINAL_WAIT_MS === 150_000` and onFailure's `executionTimeout === "4m"`.
- **Restore** (P8):
  - on success, `copyIn` to `/home/agent/.claude/projects/<projectDir>/<id>.jsonl` comes before the
    message write, and the message keeps `sessionId`. An unsafe recorded `projectDir` falls back to
    `-workspace`;
  - each failure (none, other session, bad id, hash, cap, copyIn) gives `sessionId: null`, the note
    and the journal line;
  - the written message **never** carries a `sessionId` whose file was not confirmed;
  - the writer's chain continues from the restored head.
- **Ledger** (P9):
  - the same source run twice → one row;
  - a second run on the same thread → `budget-spent`;
  - 10 concurrent claims → 1;
  - every reason in 2.6 has a test;
  - reconcile: secret empty → no query; secret set → pending calls listed, nothing re-sent.
- **F4** (P9): a second timeout whose run wrote **no checkpoint** returns `budget-spent`, not
  `no-checkpoint`.
- **F7** (P9):
  - a throw before the queue write deletes the claim;
  - a throw after it (drain or `dispatched` update) keeps the claim, and a retry is
    `already-continued`;
  - a successful dispatch ends at `state = 'dispatched'`.
- **OQ-1** (P9): no checkpoint → `continuation: none (no-checkpoint)`, and nothing is queued.
- **run-terminal** (P10):
  - a timeout with a checkpoint of this run → one queued continuation, and no mention reply;
  - **F1:** the **redelivery goes through the early-return branch** (`route.ts:60-77`). The first
    post stamps `terminalCause = "timeout"`, the second post of the same run gets
    `{ applied: false }` from that branch, and there:
    - a continuation lost after the first write (dispatch made to fail once) is dispatched exactly
      once;
    - an already dispatched one is not dispatched again;
    - no mention reply is posted from that branch;
  - a second timeout (the continued run's) → no continuation, and the reply names the limit;
  - a timeout with no checkpoint → today's behaviour (reply sent).

**ITs:**

- `r2-conformance.integration.test.ts` (P1, AC-6):
  - through wrangler's local proxy (miniflare) by default, and once by the operator against a
    throwaway real bucket over a remote binding, as spike 048 measured it;
  - second create → 412; stale `If-Match` → 412 (the second precondition, called on the binding
    directly, because the client never needs it);
  - 10 racing creates → 1 created; read after write.
- `cell-session.integration.test.ts` (P8, `OPENSANDBOX_IT=1`, the real cell image, spike 048 part B on
  the real adapter):
  1. Cell A: a **stub agent** script, copied in and exec'd, writes a 3-step transcript in Claude's
     JSONL shape, with steps 1-3 done and step 4 pending. It leaves one `tool_use` open.
  2. The worker writer captures it through `copyOut` into an in-memory store that applies the C5
     rules. Cell A is deleted, and the test asserts that it is gone.
  3. Cell B: restore. The daemon's own search (`find ~/.claude/projects -name <id>.jsonl`) finds the
     file.
  4. `maybeFixLogs`' append leaves it valid.
  5. The stub, given `--resume <id>`, runs step 4 only. Its step counter shows each step run once
     across both cells.

  The real `claude --resume` on the redacted file is spike 048 c1/c4 and AC-8.

**AC map:**

| AC | Proven by |
|---|---|
| 1 | P8 cell-run restore test (`--resume` path kept), P8 OPENSANDBOX_IT (new cell, steps not redone), P9 decision test, P10 route test (one continuation queued) |
| 2 | **Reworded (owner, OQ-1):** "a restore that fails (no or unreadable checkpoint at restore time) starts fresh, the reply or log says so, and `--continue` is never used silently". Proven by P8 restore negatives (null `sessionId` + note + `started fresh` journal line), P3 tamper read, P6 redactor fail-closed. Also, no re-dispatch without a checkpoint: P9 `no-checkpoint` and P10 no-checkpoint case |
| 3 | P9 `budget-spent`, checked before `no-checkpoint` (F4); P10 second timeout (no dispatch, limit named); P10 mention text test |
| 4 | P9 ledger races (same source run, 10 concurrent claims) and claim life (F7); P10 redelivered terminal through the `:60-77` branch (F1); P4 fence and open-step refusals |
| 5 | P5 canary test (all stored objects), plus a P8 IT assertion that no canary is in R2-bound bytes |
| 6 | P1 client + conformance IT (412 on both preconditions), P2 10-racer CAS, P3 create-only call-order spy |
| 7 | P7a salvage tests, P7b order test, `CELL_CHECKOUT_WORK_BRANCH_SH` (row 19) for the continued clone; end to end in AC-8 |
| 8 | **Production UAT, after deploy** (section 8): deferred, by the ticket |

## 7. Risks

- **Cost.** One more full run per timed-out thread at most (OD-2), on task-lane cells only.
  Storage: deltas only (2.1). A 60-minute session is a few MB; AC-8 measures it.
- **Leak.** The native transcript holds the customer's code and tool output.
  - It goes only to the private bucket, after redaction, under a thread prefix, and is read only by
    the same thread's next run. It is never shown.
  - Identity redaction is pattern-based. An email in the repo's own code is blanked too (lossy, as in
    048).
- **Duplicate side effects.** A resumed agent could repeat a push or a comment.
  - The work-branch fence bounds pushes. The continuation message says what is done, and add-on
    calls are reconciled, never re-sent.
  - A mention reply is idempotent by its marker.
- **A stale head.** Over the 12 MiB cap, or after a lost CAS, the head lags, and the continued run
  resumes from an earlier turn. The work branch still has the WIP commit, and the message tells the
  agent to check it.
- **The capture budget.** 40 s, with any in-flight pull counted inside it, may still not be enough
  for a large WIP push. The push then fails open with a journal line, and the checkpoint goes first.
- **The longer onFailure wait** (150 s, `"4m"`). A run that died without posting its own terminal
  now gets the generic failure 30 s later than today. The slot and the box lock are the run fn's,
  not onFailure's, so admission is not delayed.
- **The effect budget (F8).** The WIP push spends one of the step's 50 effects
  (`CELL_TASK_EFFECT_BUDGET`). An agent that spent them all makes the broker answer 429
  (`effect_budget_exhausted`, `packages/cell-broker/src/common.ts:83`), and the salvage logs
  `salvage: failed (push failed)`. The work stays only in the transcript, and the continued run
  starts from the last pushed commit. That is acceptable for v1: a run that pushed 50 times has
  most of its work on the branch already.
- **A symlink race (F9).** It narrows to the gap between the `-type f` re-check and `copyOut` (2.3).
  What could be read is limited to what uid 10001 can read, and it is redacted.
- **Freeze.** Agent processes that called `setsid` keep running during the push. The box has the
  same exposure for anything outside the container; there it is the stale-lock cleanup that copes
  with it.
- **The continued run lands on the box.** If cell eligibility changed, the box has no restore, and
  the agent starts without the history (OQ-6). The message is written to stay true in that case.
- **The harness's side state.** Claude's auto-memory directory is not captured (048 landmine). What
  the agent wrote there is lost between cells.
- **The miniflare simulator** may not honour `onlyIf`. The local conformance run then fails, and that
  is the finding. The remote run is the authority.

## 8. Rollout and rollback

| Step | What | Who | Rollback |
|---|---|---|---|
| 1 | Merge. `migrate.yml` applies `2026-11-25-cell-session-checkpoint.sql` on green main (expand-only); `assert-schema-ready` passes | CI | Leave the tables (unused) |
| 2 | Deploy www (route, store, decision; flag off) | Operator | Redeploy previous www |
| 3 | Deploy the worker (capture, salvage, restore, and the 150 s / `"4m"` onFailure; flag off) via `automata-worker-safe-restart` | Box operator | Redeploy the previous worker (back to 120 s / `"3m"`) |
| 4 | Operator, once: `R2_CONFORMANCE=remote` against a throwaway bucket; record the result on #743. Apply the **30-day R2 lifecycle rule** on `cell-sessions/` in `automata-private` (OQ-5, documented in `packages/worker/deploy/README.md`) | Operator | Remove the rule |
| 5 | Turn `cellSessionContinuation` on for the test org's user (admin page) | Owner | Flag off: no capture, restore or continuation from the next run on; checkpoints left behind are inert |
| 6 | **AC-8 UAT** (below) | Owner / operator | Flag off |
| 7 | Widen the flag | Owner | Flag off |

No cell image change: the daemon is untouched.

**AC-8 UAT**, on the platform's own test repo, in a cells org with the flag on:

1. **The task.** File a task built to need more than one 60-minute budget: several long steps, each
   shorter than the budget, with a marker file committed after each step.
2. **First run.** It times out. The journal shows per-turn `cell: checkpoint` lines, then `freeze`,
   `checkpoint … final`, `salvage: pushed …`, and `abnormal end → timeout terminal: applied`.
3. **The continuation.** The thread shows exactly one continuation message. The second run's
   journal shows `cell: session restore: restored turn=<n>`, and its first agent turn names the
   finished steps without re-running them: the markers are not recreated.
4. **The end.** The run completes, and a mention reply (if mention-triggered) is posted once, by the
   final run.
5. **Post on #743:** the native size, chunk count, checkpoint write count per run, restore latency
   (ms), capture duration at timeout (in-flight pull included), and push duration. Also post:
   - the real project dir from the `dir=` field (F6);
   - whether `--resume` kept the session id or wrote a new one (OQ-7).

## 9. Out of scope

- **Box (container) runs:** same mechanism, a follow-up ticket.
- **Cross-harness handoff** beyond what the `events` blob enables.
- **Forks**, and the `Automata-Checkpoint:` commit trailer.
- **The callback receiver.** Turning it on is not part of this ticket, and Scope 6 stays a no-op
  while `ADDON_CALLBACK_SECRET` is unset. There is also no call dispatcher, so `call_index_sha256`
  stays null.
- **The legacy `claude_session_checkpoints` copy** (OD-4).
- **The daemon's own `--continue` fallback** on other planes (OQ-8).
- **Deleting a thread's R2 objects** with the thread.
- A **thread UI** for continuations: the continuation is an ordinary user message, and no new system
  message type is added.
- **Long-session size and cost benchmarks:** they are measured in AC-8, not designed around.

## 10. Open questions (closed 2026-11-22)

The owner decided OQ-1, OQ-3 and OQ-4, and adopted OQ-2 and OQ-5 to OQ-8 as assumptions (section
11). Each is now part of the body. The original wording is kept below for the record.

- **OQ-1: AC-2's "with no checkpoint, the re-dispatch starts fresh".** Scope 5 re-dispatches only
  "with a checkpoint", and AC-1 needs at least one turn.
  - Recommendation: a timeout **with no checkpoint is not re-dispatched** (today's reply stands).
    AC-2 is proven at restore time: a checkpoint that cannot be restored starts fresh and says so,
    never `--continue`.
  - It would change if the owner wants a fresh re-dispatch with no checkpoint too: one more branch
    in 2.6, and it still spends the budget.
- **OQ-2: Which JSONL fields carry the system prompt and request blobs.** They are not documented.
  - Recommendation: Phase 5 captures one real cell session (CLAUDE.md marker planted), pins the
    field list from it in the fixture, and redacts by field, keeping the line.
- **OQ-3: Chunked native (2.1) instead of 048's single `native` blob.**
  - Recommendation: take chunking. It keeps 048's rules (content-addressed, create-only, only the
    head moves), and it turns O(n²) uploads and storage into O(n).
  - The fallback is one blob per checkpoint with a 60 s minimum spacing and a sweep of blobs no
    longer at the head.
- **OQ-4: The capture budget.** Option one: 25 s inside today's 120 s onFailure wait. Option two:
  raise the wait to 150 s and onFailure's `executionTimeout` to `"4m"`, which gives the push about
  50 s.
  - Recommendation: 25 s first. Raise the budget if AC-8 or production shows
    `salvage: failed (budget exceeded)`.
- **OQ-5: Retention of `cell-sessions/`.**
  - Recommendation: an R2 lifecycle rule that expires the prefix after 30 days. A restore after that
    starts fresh and says so ("blob missing").
  - Deleting with the thread is a separate ticket.
- **OQ-6: A continuation that lands on the box.**
  - Recommendation: accept it for v1. The message is written to hold either way, and the box ticket
    adds restore.
- **OQ-7: Does `claude -p --resume <id>` keep the same session id?** The Agent SDK documents forking
  as opt-in (`forkSession`).
  - Recommendation: the writer handles both (2.4). The IT and AC-8 record which one happens.
- **OQ-8: The daemon's silent `--continue` fallback** for other planes. The cell path never reaches
  it after this ticket.
  - Recommendation: a separate ticket. Changing it also needs a cell image rebuild (row 9).

## 11. Amendments (2026-11-22)

The validator's verdict was PASS_WITH_WARNINGS. The owner's decisions are binding, and the body
above is updated to match them.

**Owner decisions:**

| # | Change | Where in the body |
|---|---|---|
| OQ-1 | No re-dispatch without a checkpoint: it logs `continuation: none (no-checkpoint)` and keeps today's reply. AC-2 is reworded to: "a restore that fails (no or unreadable checkpoint at restore time) starts fresh, the reply or log says so, and `--continue` is never used silently" | 2.6, C6, AC map |
| OQ-3 | The transcript is stored as appended chunks. Each pull uploads only the new bytes as one create-only, content-addressed chunk, the manifest lists the chunks in order, and a restore concatenates them | 2.1 |
| OQ-4 | `ON_FAILURE_TYPED_TERMINAL_WAIT_MS` goes 120 s → 150 s, and onFailure's timeout goes `"3m"` → `"4m"`. The capture budget is 40 s, with the in-flight pull counted inside it. Pin: capture + 80 s + 30 s ≤ 150 s. In Phase 7b | Row 11, 2.5, Phase 7b, tests, risks, rollout |

**Adopted as assumptions:**

| # | Change | Where in the body |
|---|---|---|
| OQ-2 | Redaction is per field, pinned from one real cell capture. It fails closed on a redactor error: nothing from that pull leaves the box | Section 4, C6, P6 tests |
| OQ-5 | A 30-day R2 lifecycle rule on `cell-sessions/`, documented in the deploy README and applied by the operator | Rollout step 4 |
| OQ-6 | A continuation that lands on the box runs without history in v1 | Risks (unchanged) |
| OQ-7 | The writer handles both session-id cases, and AC-8 records which one happens | 2.4, UAT step 5 |
| OQ-8 | The silent `--continue` fallback on other planes goes to a separate ticket | Out of scope (unchanged) |

**Validator fixes:**

| Fix | Change | Where in the body |
|---|---|---|
| F1 | A redelivered terminal returns early at `run-terminal/route.ts:60-77`. `maybeContinueAfterTimeout` is called there too, with no reply. The P10 redelivery test goes through that branch | Row 24, 2.6, P10 tests |
| F2 | The in-flight pull is counted inside the 40 s capture budget | 2.5, P7b tests |
| F3 | The checkpoint route checks `content-length`, then does a capped read (6 MiB) before parsing, and returns 413 `body_too_large`. It follows the addon-callback route | Row 29b, 2.2, C5, Phase 4, P4 tests |
| F4 | The ledger budget is checked before `no-checkpoint`, so a second timeout names the limit | 2.6 table, AC-3, P9 tests |
| F5 | The route refuses a null-binding token and requires an open cell step for (thread, attempt) through a new `isOpenCellAttempt` in `cell-authority.ts`. A box run's token cannot write | Row 29a, 2.2, C5, Phase 4, P4 tests |
| F6 | The probe searches `~/.claude/projects/*/` at maxdepth 2 and chooses by session id, with no hard-coded `-workspace`. The manifest records `projectDir`, the restore writes back there, and AC-8 records the real dir | 2.3, 2.4, C3, Phase 6, P6/P8 tests, UAT |
| F7 | The claim is released only on a throw before the queue write. `state = 'dispatched'` marks that the message is queued | 2.6, C2, Phase 9, P9 tests |
| F8 | The WIP push can get a 429 on the step's effect budget (`CELL_TASK_EFFECT_BUDGET` = 50, broker `common.ts:83`). It is logged as `salvage: failed (push failed)` and listed as a risk | 2.5, risks, P7a tests |
| F9 | Only a regular file is read: `find -P … -type f` in the probe, plus a re-check in the read. One gap remains between that re-check and `copyOut`, with an exec-as-agent read as the fallback | 2.3, C6, risks, P6 tests |

**Final phases** (each ≤ 5 files):

| Phase | Files |
|---|---|
| 1 | R2 (4) |
| 2 | Postgres (4) |
| 3 | Format + store (3) |
| 4 | Route + F3 + F5 (5): `route.ts`, `route.test.ts`, `daemon-route-matrix.ts`, `cell-authority.ts`, `cell-authority.test.ts` |
| 5 | Redaction + writer (5) |
| 6 | Per-turn capture + F6/F9 (5) |
| 7a | Cell salvage + F8 (4) |
| 7b | Timeout capture + F2/OQ-4 (5): `cell-run.ts`, `cell-run.test.ts`, `cell-ttl.test.ts`, `workflow.ts`, `workflow.test.ts` |
| 8 | Restore (5) |
| 9 | Ledger + decision + F4/F7 (4) |
| 10 | run-terminal + F1 + mention (5) |
| 11 | Flag wiring (5) |
