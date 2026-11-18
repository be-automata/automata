# #697: CODEOWNERS + a `main` ruleset requiring a human approval on sensitive paths

Ticket: be-automata/automata#697 (decision: #674, AC 3, TL, 2026-11-18). Base: `origin/main` @ `96c28905`.
The ticket body is the contract (scope, ACs 1-4, UAT, risks). This file adds the decision taken on
2026-11-18 about the bot account, the ground truth verified at HEAD, and the design.

## Decision (TL, 2026-11-18)

Agent-opened PRs move to a **GitHub App**, working name `automata-agent`, installed on
`be-automata/automata` only. Two steps belong to the TL and never to an agent:

1. creating the App in GitHub settings;
2. putting its private key in the macOS keychain (service `automata-agent-app-key`, account `automata`).

This PR prepares everything else and applies nothing to the live repo: no ruleset, no branch
protection, no App, no account.

## Ground truth (verified at 96c28905 and against the live repo, read-only, 2026-11-18)

| Fact                                                                                                                                                                                                                                                                                                       | How it was checked                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main` has no branch protection                                                                                                                                                                                                                                                                            | `gh api repos/be-automata/automata/branches/main/protection` → `404 Branch not protected`                                                                                                                                                     |
| The repo has no rulesets                                                                                                                                                                                                                                                                                   | `gh api repos/be-automata/automata/rulesets` → `[]`                                                                                                                                                                                           |
| There is no `.github/CODEOWNERS` (nor `CODEOWNERS`, `docs/CODEOWNERS`)                                                                                                                                                                                                                                     | `ls .github` at HEAD: `actions/`, `dependabot.yml`, `workflows/`                                                                                                                                                                              |
| The repo is public, owned by the org `be-automata` on the **free** plan                                                                                                                                                                                                                                    | `gh api repos/be-automata/automata` (`visibility: public`), `gh api orgs/be-automata` (`plan: free`). Repository rulesets are available on public repos on the free plan; organization rulesets are not, so this is a **repository** ruleset. |
| Org admins: `espinozasenior`, `mcones`. Repo admins: the same two                                                                                                                                                                                                                                          | `gh api 'orgs/be-automata/members?role=admin'`, `.../collaborators`                                                                                                                                                                           |
| Automata reviews as the GitHub App `automata-ai-bot` (app id 3211193, installation 147206841, all repos), login `automata-ai-bot[bot]`, `type: Bot`                                                                                                                                                        | `gh api orgs/be-automata/installations`; `gh api repos/be-automata/automata/pulls/698/reviews`                                                                                                                                                |
| Agent PRs are authored by `espinozasenior`                                                                                                                                                                                                                                                                 | `gh api repos/be-automata/automata/pulls/698 --jq .user.login`                                                                                                                                                                                |
| CI's jobs (the check-run names on a PR): `audit`, `check`, `test`, `schema-drift`, `worker-e2e`, `e2e`                                                                                                                                                                                                     | `.github/workflows/ci.yml:28,43,112,161,215,253`; no job has `name:` or a job-level `if:`, and the workflow has no `paths` filter, so all six run on every PR to `main`                                                                       |
| `synthetic.yml` also has a job called `test` that runs on PRs touching `deploy/smoke.ts`, `deploy/smoke.test.ts` or the workflow                                                                                                                                                                           | `.github/workflows/synthetic.yml:17-29`. Two check runs named `test` from the same app make a required `test` context ambiguous: the synthetic one passing could stand in for CI's `test`.                                                    |
| The other workflows add no PR check worth requiring: `cell-image.yml` and `batteries-image.yml` are path-filtered (a required path-filtered check never reports on other PRs and would block them), `migrate.yml` runs on `workflow_run`, `synthetic.yml`'s `smoke` only off PRs                           | `.github/workflows/*.yml` triggers                                                                                                                                                                                                            |
| Deploy-script tests run as `node --test 'deploy/*.test.ts'` in the `check` job; `deploy/` has no package.json                                                                                                                                                                                              | `.github/workflows/ci.yml:85-88`                                                                                                                                                                                                              |
| **Automata's PR-review trigger skips `opened`/`synchronize` events whose sender is a Bot** when the automation's `filter.excludeBotSenders` is set; `ready_for_review` is never skipped; unless `filter.includeAllAuthors`, the PR author must be the automation's user or listed in `filter.otherAuthors` | `apps/www/src/app/api/webhooks/github/handlers.ts:293-380`                                                                                                                                                                                    |
| The delivery loop treats every Bot-authored PR as `needs_human` (`app_authored_pr`), not only the review App's own                                                                                                                                                                                         | `apps/www/src/server-lib/delivery/decide-delivery-step.ts:143-146`, `evaluate-delivery-pr.ts:240`                                                                                                                                             |

### Sensitive paths, each verified at HEAD (`git ls-files <path>` non-empty)

| Area                    | CODEOWNERS pattern                                                                                                                                                                                                                                                                                           | What it holds                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrations, deploy      | `/deploy/`                                                                                                                                                                                                                                                                                                   | covers `deploy/migrations/`, `migrate.ts`, `assert-schema-ready.ts`, `provision-execution-box.sh`, `egress-pf.conf`, and the new `deploy/github/`     |
| Schema                  | `/packages/shared/src/db/`                                                                                                                                                                                                                                                                                   | `schema.ts`, `schema-columns.ts`, `index.ts`                                                                                                          |
| Migration runner        | `/packages/migrate/`                                                                                                                                                                                                                                                                                         | the runner, ledger, drift                                                                                                                             |
| Daemon tokens           | `/apps/www/src/lib/daemon-*.ts`                                                                                                                                                                                                                                                                              | `daemon-token.ts`, `daemon-token-context.ts`, `daemon-api-key.ts`, `daemon-thread-auth.ts`, `daemon-route.ts`, `daemon-auth-unavailable.ts` (+ tests) |
| Daemon-token mint route | `/apps/www/src/app/api/internal/daemon-token/`                                                                                                                                                                                                                                                               | `route.ts`                                                                                                                                            |
| Auth config             | `/apps/www/src/lib/auth.ts`, `/apps/www/src/lib/auth-server.ts`, `/apps/www/src/lib/auth-session-config.ts`                                                                                                                                                                                                  | Better Auth config, server session, session policy                                                                                                    |
| Auth routes             | `/apps/www/src/app/api/auth/`                                                                                                                                                                                                                                                                                | Better Auth handler, OAuth callbacks                                                                                                                  |
| Broadcast auth          | `/apps/broadcast/src/auth.ts`                                                                                                                                                                                                                                                                                | the realtime service's token check                                                                                                                    |
| Cell broker             | `/packages/cell-broker/`                                                                                                                                                                                                                                                                                     | ADR-014 broker                                                                                                                                        |
| Credential broker       | `/apps/www/src/server-lib/credential-broker/`, `/packages/sandbox/src/providers/docker-cred-broker.ts`, `/packages/sandbox/src/cred-broker-standalone.*`                                                                                                                                                     | broker selection, the Docker broker and its standalone bundle                                                                                         |
| Provider credentials    | `/packages/shared/src/model/agent-provider-credentials.ts`, `/apps/www/src/agent/credentials.ts`, `/apps/www/src/server-lib/credentials.ts`, `/apps/www/src/app/api/daemon/agent-credentials/`, `/apps/www/src/app/api/daemon/run-credential-source/`, `/packages/worker/src/agent-run/agent-credentials.ts` | the stored provider keys, their decryption, and their delivery to the sandbox                                                                         |
| CI                      | `/.github/workflows/`, `/.github/CODEOWNERS`                                                                                                                                                                                                                                                                 |                                                                                                                                                       |
| Workers config          | `/apps/*/wrangler.jsonc`                                                                                                                                                                                                                                                                                     | `apps/www/wrangler.jsonc`, `apps/broadcast/wrangler.jsonc`                                                                                            |

Left out on purpose, to keep the list tight: the credentials UI (`components/credentials/`), the
OAuth helper flows (`claude-oauth.ts`, `openai-oauth.ts`, `server-actions/*credentials*`), and
`packages/env`. They are a short addition if the TL wants them.

## Design

### 1. `.github/CODEOWNERS`

The patterns above, owner `@espinozasenior` each. Every pattern starts with `/` (anchored) and uses
only `*` within one path segment, so a test can check each one against `git ls-files` without a
full gitignore engine. On its own the file only requests reviews; merging it before the ruleset is
harmless.

### 2. The ruleset as code: `deploy/github/ruleset-main.json`

The body of `POST /repos/{owner}/{repo}/rulesets`:

- `target: branch`, `enforcement: active`, `conditions.ref_name.include: ["refs/heads/main"]`;
- `pull_request`: `required_approving_review_count: 0`, `require_code_owner_review: true`,
  `dismiss_stale_reviews_on_push: true`, `require_last_push_approval: false`,
  `required_review_thread_resolution: false`;
- `required_status_checks`: one context, `ci-gate`, pinned to `integration_id: 15368` (GitHub
  Actions), `strict_required_status_checks_policy: false` (no "branch must be up to date", which
  would make every agent PR rebase after each merge);
- `deletion` and `non_fast_forward`: `main` cannot be deleted or force-pushed;
- `bypass_actors`: one, `OrganizationAdmin` (`actor_id: 1`), `bypass_mode: pull_request`.

**Deviation from the brief: 0 approvals, not 1.** With `require_code_owner_review` GitHub requires a
code owner's approval whenever the PR changes a code-owned file, whatever the count. A count of 1
would also require an approval on every other PR. AC 2 says those keep merging on Automata's
approval and green CI "as today", and whether an approval from a GitHub App (`automata-ai-bot`)
counts toward the required count is not something this PR can verify without applying the
ruleset. At 0, AC 1 and AC 2 hold either way. If the UAT shows the TL wants every PR approved, it is
a one-field change.

**Break-glass.** The org admins (today `espinozasenior` and `mcones`) can merge a PR that does not
meet the rules (`bypass_mode: pull_request`: through a PR only, never a direct push). The merge
box shows the bypass checkbox; `gh pr merge --admin` does it from the CLI. Each bypass is recorded in
the repo's **Rules → Insights** (and the rule-suites API). Removing the ruleset is the rollback.

**One required check: `ci-gate`.** A new job in `ci.yml`, `ci-gate`, `needs:` the six jobs, runs
`if: always()` and fails unless every one of them succeeded. The ruleset requires only it, so a new
or renamed CI job never needs a ruleset change (the test checks `needs:` lists every other CI job),
and the name collision with `synthetic.yml`'s PR job `test` no longer matters: only the unique
`ci-gate` name has to stay unshadowed (also tested). This replaced a first draft that required the
six job names and renamed `synthetic.yml`'s job (the /simplify altitude review).

### 3. `deploy/github/apply-ruleset.sh`

`--dry-run` (reads only: lists the rulesets to choose POST or PUT, prints the plan and the payload),
default apply (`POST`, or `PUT` to the ruleset with the same name), `--delete` (rollback). It
validates the file with `jq`, passes the repo explicitly (AP-001) and prints the acting `gh` login
before a write. It is not run for real in this PR.

### 4. `deploy/github/agent-app-token.sh`

Mints a one-hour installation token for `automata-agent` and prints only the token.

- App id and installation id: `AUTOMATA_AGENT_APP_ID` / `AUTOMATA_AGENT_INSTALLATION_ID`, else
  `APP_ID=` / `INSTALLATION_ID=` lines in `~/.config/automata-agent/app.env` (read, never sourced).
  Neither id is a secret.
- Private key: `security find-generic-password -s automata-agent-app-key -a automata -w`. The key is
  stored base64-encoded (one line); a raw PEM and the hex form `security -w` prints for a multi-line
  value are also accepted. `AUTOMATA_AGENT_APP_KEY_FILE` replaces the keychain (tests, Linux).
- JWT: RS256, `iat = now - 60`, `exp = now + 540`, `iss = <app id>`, signed by `openssl dgst
-sha256 -sign` with the key fed through a file descriptor (never written to disk, never on argv).
- the request body scopes the token to one repository (`AUTOMATA_AGENT_REPO`, default `automata`)
  and to contents/pull_requests/issues write, checks/metadata read, the same fence as
  `packages/worker/dev/canary/github-token.ts`; a response wider than that is refused;
- `POST /app/installations/{id}/access_tokens` with `curl`, the `Authorization` header read from
  stdin (`-H @-`), so neither the JWT nor the token appears in the process list.
- stdout carries the token only; errors go to stderr with GitHub's `message`, never the token or JWT.
  `--jwt` prints the JWT instead (no network), for debugging and tests.

**Alternatives checked (adopt over build).**

- `actions/create-github-app-token`: the maintained reference implementation, but an Action only;
  it cannot run in a local agent session.
- `gh` has no App-token command. The `Link-/gh-token` extension does this, but it is a third-party
  binary handling the App's private key, its key input is a file path or a base64 argv value (the
  argv form is visible in `ps`), and it adds an install step on every machine.
- `@octokit/auth-app` is in the lockfile (via `octokit`), but only as a transitive dependency of
  workspace packages; `deploy/` has no package.json, so importing it from a deploy script means a new
  direct dependency and a `pnpm install` before minting.
- Build: about 60 lines of bash on `openssl`, `curl` and `jq`, which every target machine has. Chosen.

### 5. Runbook: `docs/runbooks/agent-github-app.md`

The TL's steps (create the App, store the key), the agent-session switch, the rollout order (App on a
throwaway PR → ruleset → UAT), break-glass and rollback, and the Automata review-trigger caveat:
an App-authored PR is opened by a Bot sender, so Automata may skip `opened`; the agent opens it as a
draft and marks it ready (`ready_for_review` is always reviewed), and keeps `git push` on the
person's git credential so `synchronize` events are not Bot-sent. The automation's author filter
must include `automata-agent[bot]` (or all authors); the throwaway PR proves it.

Where agent PRs are opened (no change here): the somnio plugin's `dev-execution` Step 5 (gstack
`/ship`), `scripts/pr-opened.sh`, `loop-mode` and `pr-sync`, and the `pr-manager` agent. They run
`gh` with whatever token the session has. The switch is one line in the repo's `AGENTS.md` (or the
TL's global `CLAUDE.md`) once the App works; the plugin itself is changed upstream, not in its cache.

### 6. Tests

- `deploy/github/agent-app-token.test.ts` (`node --test`): a throwaway RSA key generated in a temp
  dir, fake `curl` and `security` on `PATH`. It verifies the JWT's signature with the public key and
  its claims, the endpoint and headers sent, that stdout is exactly the token, that stderr never
  holds the token or the JWT, the three key encodings, the keychain lookup arguments, the config-file
  fallback, and the exit codes for missing config and an API error.
- `deploy/github/branch-protection.test.ts` (`node --test`): the ruleset's shape (rule types,
  code-owner review at count 0, the one bypass); it requires only `ci-gate` from integration 15368;
  `ci-gate` runs `if: always()`, checks every result is `success`, and its `needs:` lists every other
  `ci.yml` job; no other workflow defines a `ci-gate` job; every CODEOWNERS pattern is anchored,
  owned by `@espinozasenior` and matches a tracked file by git's own gitignore matcher; the #697
  paths are owned; `/apps/*/wrangler.jsonc` does not reach the `__fixtures__` wrangler files.
- CI: the `check` job runs `node --test 'deploy/*.test.ts' 'deploy/github/*.test.ts'` and
  `shellcheck deploy/github/*.sh`.
- After the push, `GET /repos/be-automata/automata/codeowners/errors?ref=feat/697-branch-protection`
  (read-only) must return no errors.

## Acceptance criteria (ticket) and how each is verified

| AC                                                                           | Verified by                                                                                           | When                                            |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1. A bot PR touching `deploy/migrations/` cannot merge until the TL approves | CODEOWNERS + ruleset tests now; the live throwaway PR after the App exists and the ruleset is applied | deferred: needs the App and the applied ruleset |
| 2. A non-sensitive PR merges on Automata's approval and green CI             | ruleset requires 0 approvals and only CI checks (test); live throwaway PR                             | deferred: same                                  |
| 3. The TL can approve agent PRs                                              | the mint script (tests) + runbook; live once the App exists                                           | deferred: needs the App                         |
| 4. Break-glass documented                                                    | runbook section, ruleset `bypass_actors` (test)                                                       | now                                             |

## Out of scope

Automata's review flow (stays as is; the harness watch still requires its approval). The delivery
loop's "any Bot author → needs_human" check is reported as a follow-up, not changed. No live repo
setting is touched.

## Risks

- A wrong CODEOWNERS path silently skips protection: the test fails on a pattern with no match.
- A misconfigured App breaks the agent ship path: the switch happens only after the throwaway PR works,
  and reverting is unsetting `GH_TOKEN`.
- The agents still run with the TL's own `gh` login, an org admin who can bypass. The runbook lists
  permission deny entries for `gh pr merge --admin` and ruleset writes, for the TL to add.

## Validation (fresh agent, 2026-11-18) and what changed

Confirmed: every ground-truth row above (live GETs and file:line), the six check names from app
15368 on PR #698, the `synthetic.yml` `test` collision (since resolved by `ci-gate`, not a rename), the rulesets API shape (`required_approving_review_count` 0-10, `OrganizationAdmin` bypass,
`pull_request` bypass mode), CODEOWNERS read from the base branch, `curl -H @-`.

| Finding                                                                                               | Severity | Disposition                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The agent session keeps the TL's `gh` login, so it could approve an App-authored PR as the code owner | blocker  | Runbook section 3: deny entries and a tokenising hook, added by the TL before the ruleset (agents cannot edit `.claude/settings.json`); a separate-`GH_CONFIG_DIR` agent session as the follow-up. Reported as a TL step.                                                                                                                                                                                   |
| Missing sensitive paths                                                                               | major    | Added `/.github/actions/`, `/.claude/settings.json`, `/.claude/hooks/`, `/packages/worker/deploy/`, `/packages/utils/src/encryption.ts`, `/packages/utils/src/payload-seal.ts`, `/packages/shared/src/github-app.ts`. Left as candidates: `cell-authority.ts`, the worker's `run-secrets`/`payload-seal-keys`/`revoke-installation-tokens`/`assert-auth`, the webhook signature checks, `cli-api-token.ts`. |
| The docs do not state count-0 + code-owner behaviour                                                  | major    | UAT step 1 runs first and checks the block before any approval; count 1 stays the documented fallback.                                                                                                                                                                                                                                                                                                      |
| `vercel` has `administration: write` on selected repos                                                | major    | Runbook TL check.                                                                                                                                                                                                                                                                                                                                                                                           |
| Org audit log claim unverified                                                                        | minor    | Dropped; Rule Insights and the rule-suites API only.                                                                                                                                                                                                                                                                                                                                                        |
| App approvals do not count per the docs                                                               | minor    | Supports 0.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `*` segment semantics                                                                                 | minor    | Test: `/apps/*/wrangler.jsonc` does not match the `__fixtures__` wrangler files; `codeowners/errors` checked after push.                                                                                                                                                                                                                                                                                    |
| Single code owner                                                                                     | minor    | Open question for the TL (`@mcones` as a second owner).                                                                                                                                                                                                                                                                                                                                                     |
