# ADR-008: Tracker effects are emit-only — the tracker token never leaves the control plane

- **Status:** Accepted
- **Date:** 2026-10-01
- **Context source:** the post-merge acceptance-criteria audit for YouTrack-tracked repos.
  `packages/worker/src/agent-run/gh-broker.ts` (read-only method/path allowlist),
  `packages/worker/src/agent-run/daemon-env.ts` (`SAFE_ENV_KEYS` whitelist + secret-pattern scrub),
  `apps/www/src/server-lib/review/resolve-permission-mode.ts` (a thread with no automation row is
  uncapped), `apps/www/src/app/api/webhooks/github/mirror-intake.ts` (`pr-merged` intake),
  `apps/www/src/server-lib/review/review-single-writer-finish.ts` (`handleReviewEffectAtFinish`),
  `apps/www/src/server-lib/tracker/*` (the implementation).
- **Deciders:** operator + 2026-10-01 architecture pass
- **Relates to:** ADR-004 (the review lane is emit-only — this ADR applies the same shape to a
  second effect surface), ADR-002 (credential placement), ADR-006 (planes receive shapes, never
  credentials they do not need).
- **Supersedes / superseded by:** —

## Context

A merged pull request should be reconciled against the ticket it references: was every acceptance
criterion delivered, and if not, was the miss consciously accepted? The reconciliation has two
write surfaces — a comment on the PR and, on the issue tracker, a comment plus a stage move.

The obvious design hands the agent a tracker token and lets it call the tracker and `gh pr comment`
itself. Three facts in this codebase rule it out:

1. **The agent cannot write to GitHub.** On the worker plane `gh` goes through a per-run broker
   that allows `GET`/`HEAD` and non-mutation GraphQL only. `gh pr comment` returns 403.
2. **A merged-PR thread runs uncapped.** It is created by mirror-intake with no automation row, so
   the permission floor does not treat it as PR-family and it runs `allowAll`. Its input is a PR
   title, a PR body and ticket text — all written by third parties.
3. **No per-repo secret reaches a worker-plane agent.** The run input carries none, and the child
   environment is a whitelist with a secret-pattern scrub.

Giving an uncapped agent that reads attacker-influenceable text a permanent tracker token is the
confused-deputy case ADR-004 exists to prevent: a prompt-injected PR body could move or comment on
any ticket the token can reach.

## Decision

1. **The agent emits judgement; the control plane performs every effect.** The post-merge skill
   (`github-pr-merged` lane) is read-only. It ends with one fenced-JSON `pr-merged-audit` intent: a
   verdict per criterion (`met` / `partial` / `not_met` / `not_verifiable`), any recorded conscious
   acceptance, deviations, and whether the ticket is finished by this merge. The intent has **no**
   field naming a stage, a transition or a comment target.
2. **The control plane fetches the tickets.** At intake it extracts ticket keys from the webhook's
   PR fields, reads those tickets with the repo's tracker token, and appends them to the task as
   data. The agent needs no tracker access to do its job.
3. **The finish hook is the single writer.** `executeMergeAudit` re-derives the ticket keys from
   GitHub's own PR fields (never from the intent), re-reads each ticket, upserts one marker comment
   on the PR with the App octokit, and — only when the repo opts in — writes to the tracker.
4. **Stage writes go through a closed allowlist.** The only reachable targets are `In Progress`,
   `PR Merged` and `To Do` (`ALLOWED_STAGE_TARGETS`). `Done`, `Staging (TF)` and `Won't do` are
   unreachable from this code path whatever the agent emits. The ticket summary and description are
   never written.
5. **Tracker credentials live in the repo environment and are control-plane only.** `YOUTRACK_URL`,
   `YOUTRACK_TOKEN`, `YOUTRACK_PROJECTS` and `AUTOMATA_TRACKER_WRITES` are stored in the org owner's
   repository environment (the existing encrypted, org-fenced store). Stored variables are decrypted
   in exactly one module, `apps/www/src/server-lib/env-audience.ts`, which makes every reader pick
   an audience: the execution-plane getters drop `CONTROL_PLANE_ONLY_ENV_KEYS` (`YOUTRACK_TOKEN`),
   the control-plane getters return the raw set.
6. **Writes are opt-in per repo.** `AUTOMATA_TRACKER_WRITES` defaults to off: all reads happen, the
   PR comment shows what a live run would do, and no tracker write is made. Only the exact value
   `live` enables writes.
7. **The lane name is tracker-agnostic.** Mirror-intake looks up the fixed skill name
   `github-pr-merged`; what a repo does after a merge is the body pushed under that name. A repo
   with no such skill keeps the previous fixed prompt.

## Anti-deviation invariants (what must always hold)

- **I1 — The tracker token never reaches an agent.** Anything handed to a sandbox, worker, setup
  script or terminal is read through the `getExecutionPlane…` getters of `env-audience.ts`. No
  other module may import the shared decrypt functions (a test enforces it), so a new consumer
  cannot skip choosing an audience. Adding a field to `AgentRunInput` that carries tracker
  credentials violates this ADR.
- **I2 — The intent is never the authority for a write target.** Which tickets may be commented on
  or moved is decided from GitHub's PR fields, re-read by the control plane: the tickets the PR
  **delivers** (named in the title or head branch, or by a closing keyword). A ticket the agent
  names that the PR does not deliver is ignored, and a ticket the PR merely mentions is listed on
  the PR comment and nothing more — never fetched for audit, commented on or moved. Measuring a
  ticket against a PR that is not about it reports someone else's pending work as this PR's misses
  (observed on a real merge during UAT: a Backlog ticket would have received "0% complete").
- **I3 — The stage allowlist stays closed.** `applyStage` is the only function that writes a stage,
  and `ALLOWED_STAGE_TARGETS` never gains `Done`, `Staging (TF)` or `Won't do`. Stage names are
  code, not per-repo configuration: an owner-settable "merged" stage could be pointed at `Done`.
- **I4 — Never demote, never re-move.** A ticket at or past `PR Merged`, or resolved, is commented
  on and left where it is.
- **I5 — Safe under re-runs.** The finish hook fires on every terminal turn of the thread (a
  retry, a follow-up question, a redelivered webhook's second thread). A ticket is never moved
  twice; a tracker comment is skipped when the ticket already carries this feature's own record of
  the PR (matched on the bot's line, not a bare URL); a notice never replaces an existing audit
  comment; and a re-run that changes nothing leaves the posted audit alone. The PR comment is
  matched on marker **and** bot author.
- **I6 — Bot-authored text is sanitised.** Agent- and ticket-authored strings rendered into a
  comment are single-lined, truncated, have `<` escaped (so they cannot forge the marker, and so
  text such as `<sha>` is not dropped by the renderer as an HTML tag) and cannot `@`-mention
  anyone.
- **I7 — The tracker base URL is https and a hostname.** A bearer token is sent to it, so plain
  http, IP literals, loopback and internal suffixes are rejected, and redirects are not followed
  (`redirect: "manual"` — the Workers runtime does not accept `"error"`). This is a string-level
  check: it cannot see what a public-looking name resolves to. The value is set by the org owner
  in their own environment.
- **I8 — A stage write is only reported after a read-back.** `applyStage` re-reads the ticket and
  compares; a command the tracker's workflow rejects or ignores is reported as not applied, for
  the audited ticket and for a promoted dependant alike.

## Options considered

- **Token in the agent environment** (extend the credential pull into `credentialEnv`). Rejected:
  exposes a permanent token to an uncapped agent, needs `WORKER_BOX_TRUST=owner` plus an egress
  entry, and still cannot post the PR comment.
- **A control-plane proxy the agent calls.** Rejected: the same write surface with more moving
  parts, and every stage rule would have to be re-implemented as request filtering.
- **Box-level environment passthrough (ADR-002 R3.4).** Rejected: box-global, so one org's token
  would be visible to every org's runs on a shared box.
- **An `on.merged` automation trigger.** Rejected for now: it touches the trigger schema, the
  automation form and the matching code, and makes the thread PR-family, where the permission cap
  is `review` and `gh` is stripped entirely.
- **A dedicated tracker-credentials table.** Deferred: the environment-variables store is already
  encrypted, org-fenced and dashboard-editable, and a new table needs a manual production schema
  push for no behavioural gain.

## Consequences

**Positive**

- No worker, wire-contract, broker or egress change, and no schema change.
- Both execution planes behave the same; the agent has nothing to leak.
- The rules a team cares about (never `Done`, never edit the ticket) are code with unit tests.
- A new tracker is a new `TrackerClient` (one case in `createTrackerClient`) plus a new skill body.
  The executor depends only on the client interface (`getIssue`, `getStage`, `setStage`,
  `addComment`). The stage vocabulary and the `Depend` / `Subtask` link names are still one
  board's; a second board is a `StagePolicy` value passed into the decide functions.

**Negative / watch**

- Ticket text is fetched once at intake and again at finish. A ticket edited mid-run is audited
  against the older text but moved according to its current stage.
- The repo-file override (`.automata/skills/github-pr-merged.md`) refines a pushed skill but cannot
  enable the lane: opt-in is a DB skill row, checked first so that repos without the skill cost no
  GitHub request and no error log.
- A mirror-intake thread still runs `allowAll`. This ADR removes the tracker token and the write
  path from that agent; capping the lane itself is tracked by #83.
- Two finish hooks running at the same instant are check-then-write with no lock, so each could
  create a comment. The window is one request wide and the result is a duplicate, not a wrong
  write.
- Environment variables are attributed to the org owner. If ownership changes, the new owner must
  set the tracker variables on their own repository environment.

## Testing

- `apps/www/src/server-lib/tracker/execute-merge-audit.test.ts` — I2, I3, I4, I5, I8; writes-off
  makes zero tracker writes.
- `apps/www/src/server-lib/env-audience.test.ts` — I1, structurally: `env-audience.ts` is the only
  module that references the shared decrypt functions, and the three execution-plane consumers use
  the stripped getters.
- `merge-audit.test.ts` — the allowlist, every transition decision, the anti-vacuous promotion
  guard, scoring, and I6.
- `youtrack-client.test.ts` — I7, exact request shapes, and that a failure surfaces only a status.
- `tracker-config.test.ts` — the `live`-only write switch and URL validation at config time.
- `parse-merge-audit-intent.test.ts` — the tracked skill's example parses against the executor's
  schema and passes the lane validator (anti-drift).
- `apps/www/src/app/api/webhooks/github/mirror-intake.test.ts` — skill present / absent, tracker
  failure at intake, shadow installation.
