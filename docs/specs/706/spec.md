# #706: deliver the owner's repo env vars to the agent in a cell

Ticket: be-automata/automata#706 (parent #634, follows #656). Base: `origin/main` @ `34c43ad8`.
The ticket body is the contract (scope, AC 1-5, tests, UAT). This file adds the ground truth
verified at that sha, the one place the ticket's suggested mechanism does not exist, and the design.

## Decision applied

**OD-1 (owner, 2026-11-19):** the repo env lives in the agent process env inside the cell, as on
the box. Platform credentials (model token, daemon token, broker bearer) stay vault-only.

## Ground truth (verified at 34c43ad8, 2026-11-19)

| Fact                                                                                                                                                                                            | Where                                                                                                                                                               |
| :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dispatch seals `repoEnv` only for a plain task run (`taskPlan` set, no self-heal, not a companion)                                                                                              | `apps/www/src/agent/hatchet/dispatch.ts:1146-1149`, `:1177`                                                                                                         |
| The cell marker is set only for a plain task run on an org thread                                                                                                                               | `dispatch.ts:1214-1219`                                                                                                                                             |
| The worker refuses a marked run that is not a task lane, a self-heal or a review                                                                                                                | `packages/worker/src/agent-run/run-executor.ts:78-85`                                                                                                               |
| The worker decodes `repoEnv` into `RunSecrets`                                                                                                                                                  | `packages/worker/src/agent-run/run-secrets.ts:65-100`                                                                                                               |
| **The cell executor already receives the secrets**: `RunExecutorInput.secrets: RunSecrets`                                                                                                      | `run-executor.ts:36-38`; `workflow.ts:673-676` passes them. There is no `CellRunInput` type; nothing in `cell-executor-default.ts` or `workflow.ts` needs to change |
| `cell-run.ts` never reads `secrets.repoEnv`                                                                                                                                                     | `grep repoEnv packages/worker/src/agent-run/cell-run.ts` → no hit                                                                                                   |
| The box writes repo env (plus test-service env) into the run env file, repo env FIRST so every platform key written after it wins; reserved names and non-identifier names dropped **silently** | `container-daemon-process.ts:563-575`, `container-policy.ts:102-107`, `daemon-env.ts:304-353`                                                                       |
| **The cell's daemon is not started by an exec.** It is the create entrypoint (`cell-entry.sh`), run under `env -i` with a vetted allowlist; the worker only waits for its socket                | `cell-image.ts:118-125` (`cellEntrypoint`), `deploy/images/cell/cell-entry.sh:50-52`, `cell-run.ts:787-804`                                                         |
| **The adapter's exec has no env, on purpose** (exec env lands in procfs and execd's logging of it was never measured; execd logs argv)                                                          | `packages/types/src/cell.ts:166-174` (`CellExecOptions` = `cwd`, `timeoutMs`)                                                                                       |
| The daemon's message schema is a `z.object` with no env field (unknown keys are stripped)                                                                                                       | `packages/daemon/src/shared.ts:17-36`                                                                                                                               |
| The daemon hands the agent `{...process.env, ...adapterEnv, DAEMON_TOKEN}`                                                                                                                      | `packages/daemon/src/daemon.ts:668-672`; adapter env `claude-adapter.ts:30-43,64-77` (`ANTHROPIC_*`, `BASH_MAX_TIMEOUT_MS`, `BASH_DEFAULT_TIMEOUT_MS`)              |
| The worker already writes the agent's user-level `~/.claude/settings.json` into the cell (copyIn, 0600, uid 10001)                                                                              | `cell-run.ts:747-756`                                                                                                                                               |
| A settings `env` block is already a platform channel on the box (run telemetry), and it **beats the process env**                                                                               | `container-policy.ts:222-224,255-257`; box caller `container-daemon-process.ts:535-545`                                                                             |
| copyIn bytes ride in the upload body; execd's request log does not record them                                                                                                                  | `packages/types/src/cell.ts:226-232`                                                                                                                                |
| Cell exec error tails are scrubbed with the pattern redactor only (no exact-value pass)                                                                                                         | `cell-run.ts:682-689`                                                                                                                                               |
| www's exact-value redactor (values >= 4 chars, plus their JSON-escaped form, longest first) is private to dispatch                                                                              | `dispatch.ts:732-757` (`scrubRunSecrets`)                                                                                                                           |
| `@terragon/utils` is `"type": "module"` and exports `./redact`                                                                                                                                  | `packages/utils/package.json:5,10`                                                                                                                                  |
| The worker cell IT (IT-E1, `OPENSANDBOX_IT`) scans `docker inspect` and `docker logs` of every container in the dind (server, egress sidecar, cell)                                             | `packages/worker/src/agent-run/cell-run.integration.test.ts:250-290`                                                                                                |

### Where the ticket's suggested channel does not exist

Scope 2 says "through the adapter's `exec` env for the daemon start". There is no daemon-start
exec (the daemon is the entrypoint, already running when bootstrap starts), and `exec` carries no
env by design. A new exec env field would also put the value in execd's request handling, which
was never measured for logging. So the channel is a different one, chosen below.

## Design

### Channel: the agent's `~/.claude/settings.json` `env` block

The worker already copies `~/.claude/settings.json` into the cell for every run. The filtered repo
env goes into its `env` block. The Claude CLI applies that block to its own process environment,
so the agent process, its Bash tool and its hooks see the variables (`printenv FOO_TOKEN` works).
The value travels only in the copyIn body: never in the create call (tags, labels, plan, entry
env), never in an exec argv, never in a log line. The cell is deleted at teardown, with the file.

Alternatives checked:

| Option                                                        | Why not                                                                                                                                                                                                                                                                                                                                                                           |
| :------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| exec env for the daemon start                                 | no such exec; `exec` has no env by design (ground truth above)                                                                                                                                                                                                                                                                                                                    |
| create env (`env` on the sandbox request)                     | lands in `docker inspect` (AC 2 fails) and the entry exits 78 on credential-shaped names                                                                                                                                                                                                                                                                                          |
| a `repoEnv` field on the daemon message, merged by the daemon | agent-agnostic and keeps the box's precedence, but it is a daemon change: it needs a new cell image digest, and a worker that ships before the image silently drops the field (zod strips it), the very failure this ticket removes. Kept as the follow-up if a non-Claude agent ever runs in a cell (cells are Claude-only today: the vault binds only the Anthropic model host) |
| an env file the entry sources                                 | the entry reads no run env on purpose (#656 Scope 9) and is in the image too                                                                                                                                                                                                                                                                                                      |

### Precedence: the cell's reserved set

A settings `env` block beats the process env, the opposite of the box, where the platform writes
its keys after the repo env. So the cell drops every name the box drops **plus** every name the
cell's own runtime sets for the agent and the box protects by ordering:

- `isReservedRepoEnvKey(name)` (the box rule, `daemon-env.ts:347-353`, unchanged);
- a name that is not a shell identifier (`/^[A-Za-z_][A-Za-z0-9_]*$/`, the box's `ENV_NAME`);
- `DAEMON_TOKEN`, `BASH_MAX_TIMEOUT_MS`, `BASH_DEFAULT_TIMEOUT_MS` (set by the daemon on the agent,
  `daemon.ts:668-672`, `claude-adapter.ts:30-43`);
- the `OPENSANDBOX_` prefix (set by OpenSandbox and the image: the MITM CA path, the transparent
  proxy switch, `cell-image.ts:53-60`);
- a value containing a NUL byte (no process env can carry it; the box refuses it too,
  `container-policy.ts:202-204`).

- every name the entry starts the daemon with (`CELL_DAEMON_ENV`, `cell-image.ts:47-97`), except
  the named build-tool settings `CELL_OWNER_OVERRIDABLE` (`CI`, `DEBIAN_FRONTEND`, `PUB_CACHE`,
  `FLUTTER_ROOT`, `FLUTTER_SUPPRESS_ANALYTICS`, `DART_SUPPRESS_ANALYTICS`). This reserves
  `SOMNIO_ROOT`, `VENDOR_SKILLS_ROOT` and `ROBOREV_TELEMETRY_ENABLED` (where the battery skills load
  from), and any name a future image adds, by default. A test keeps every `CELL_DAEMON_ENV` name
  either reserved or listed.

Matching is case-insensitive (as the box). The box itself does not reserve `SOMNIO_ROOT` or
`VENDOR_SKILLS_ROOT` today; that gap is reported as a follow-up, not changed here.

Dropped identifier names are logged once, in one line, by NAME only, sorted; a name that is not an
identifier is counted, never printed (it is free text):
`cell: repo env names not set (reserved): ANTHROPIC_API_KEY, DAEMON_TOKEN (+1 not an env name)`.
The box drops silently; the ticket's contract asks for the warn line, so the cell adds it (a
deviation from "exactly as the box does", named in the PR). No line when nothing is dropped.
Values are never logged; the count of delivered names is (`cell: repo env: 3 names`).

The settings `env` block is read by the Claude CLI only. Dispatch does not check the agent
(`dispatch.ts:1214-1219`), so after next-message a non-`claudeCode` agent with a non-empty repo env
logs `cell: repo env not delivered (agent=<agent>)` instead of losing it silently.

### Redaction

A new exact-value redactor in `@terragon/utils/redact`:

```ts
export function createValueRedactor(
  values: Iterable<string>,
  minLength = 4,
): (text: string) => string;
```

It blanks each value of `minLength`+ characters and its JSON-escaped form, longest first, then
applies `redactSecrets`. `cell-run.ts` builds one from every `repoEnv` value (the delivered and the
dropped ones: a dropped value can still be echoed). Exec stderr is scrubbed whole from 4 chars, then
cut to its 512-char tail (AC 4). The run's `step` logger also wraps every cell log line with one
from 8 chars (the box's token threshold), so a value echoed into any later line is blanked while a
common short value (`MODE=agent`, `CI=true`) does not blank the platform's own words. Moving `dispatch.ts`'s private copy onto it is a follow-up
(out of scope: www).

### Files

| Phase | File                                                                              | Change                                                                                                                                                                                                             |
| :---- | :-------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `packages/utils/src/redact.ts` (+ `redact.test.ts`)                               | `createValueRedactor`                                                                                                                                                                                              |
| 2     | `packages/worker/src/agent-run/cell-repo-env.ts` (new, + `cell-repo-env.test.ts`) | `cellRepoEnv(repoEnv) → { env, dropped }`, pure                                                                                                                                                                    |
| 2     | `packages/worker/src/agent-run/container-policy.ts`                               | rename `composeContainerSettings`'s third parameter to `settingsEnv` and document both callers (box telemetry, cell repo env); behaviour unchanged                                                                 |
| 2     | `packages/worker/src/agent-run/cell-run.ts` (+ `cell-run.test.ts`)                | compute `cellRepoEnv` and the redactor once per run, log the names line, pass `env` to `composeContainerSettings` (null when empty, so the file is byte-identical to today with no repo env), scrub `execOk` tails |
| 3     | `packages/worker/src/agent-run/cell-run.integration.test.ts`                      | IT-E1 case (e): copyIn the composed settings with a repo env canary; the file holds it (0600, agent); `docker inspect` and `docker logs` of every container (server, sidecar, cell) do not                         |

`cell-executor-default.ts` and `workflow.ts` do not change (the secrets already flow). No daemon,
image, schema, migration or www change.

## Acceptance criteria mapping

| AC                                                                    | Evidence plan                                                                                                                                                                                                                                                        |
| :-------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 `printenv FOO_TOKEN` in the agent's shell                           | unit: the settings file's `env.FOO_TOKEN` equals the value; live: UAT is a HARD gate before closing (needs the model vault; DEFERRED post-merge). That the CLI applies settings `env` to its Bash tool is the CLI's documented behaviour, not yet measured in a cell |
| 2 absent from `docker inspect`, server log, sidecar log               | unit: the value is in no create plan, exec argv or log line; IT-E1 (e) (DEFERRED: `OPENSANDBOX_IT`, post-merge canary)                                                                                                                                               |
| 3 reserved name not injected; warn names only the key                 | unit                                                                                                                                                                                                                                                                 |
| 4 error tails redacted for values of 4+ chars                         | unit (failing clone whose stderr echoes a value; a 3-char value is left)                                                                                                                                                                                             |
| 5 self-heal/companion never reach the cell; review never gets repoEnv | unchanged; existing tests cited (`run-executor` refusal, dispatch `isPlainTaskRun`)                                                                                                                                                                                  |

## Tests

- `redact.test.ts`: exact value, JSON-escaped value, longest-first, below `minLength` untouched,
  patterns still applied.
- `cell-repo-env.test.ts`: box-reserved names, cell-only names (`DAEMON_TOKEN`, `BASH_*`,
  `opensandbox_x` lower-case), invalid names, NUL values dropped; ordinary names kept; empty input.
- `cell-run.test.ts`: (a) settings `env` carries the kept names and not the reserved ones;
  (b) the value never appears in the create plan, any exec argv or any log line; (c) one warn line
  naming only the dropped keys, none when none dropped; (d) a failing clone's stderr echoing a value
  is logged redacted; (e) no repo env → settings identical to today (no `env` key).
- `cell-executor-node-load.test.ts` stays green (the new module is imported by `cell-run.ts`).

## Risks and rollback

- A repo secret is in the guest, in the agent env and in a 0600 file in HOME. OD-1 accepts this; the
  box already does it (`run.env`, 0600). The cell's egress is narrower than the box's.
- Claude-only: a non-Claude agent in a cell would not see the variables (logged, see above). Cells
  are Claude-only in practice: the vault binds only the Anthropic model host.
- Narrower reach than the box: there the repo env is in the daemon's process env too; in a cell it
  reaches the CLI and everything it runs (Bash tool, hooks, git hooks), not the daemon itself. The
  daemon runs nothing of the owner's outside the CLI, so AC 1 holds.
- The ticket's contract names a `CellRunInput` type; it does not exist. The executor already gets
  `RunExecutorInput.secrets.repoEnv`.
- UAT: the dummy value must not be sent in any outbound request (the MITM sidecar may log URLs).
- Rollback: revert the PR; the cell flag stays per user.
