# #697 gate log

Branch `feat/697-branch-protection` off `origin/main` @ `96c28905`, run on 2026-11-18 on macOS (Node
22.23, shellcheck from Homebrew, OpenSSL/LibreSSL as shipped). Nothing was applied to the live repo:
every GitHub call below is a GET. Each line is the command and its real exit code.

## Gates

| Gate                         | Command                                                                                | Exit                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| new tests                    | `node --test 'deploy/github/*.test.ts'`                                                | 0 (21 tests: mint 10, ruleset/CI/CODEOWNERS 11)                       |
| existing deploy tests        | `node --test 'deploy/*.test.ts'`                                                       | 0 (105 tests, 104 pass, 1 skipped; run outside the Claude sandbox, which blocks smoke.test.ts's local server)|
| shellcheck                   | `shellcheck deploy/github/*.sh`                                                        | 0                                                                     |
| ruleset JSON sanity          | `jq -e '.rules \| length == 4' deploy/github/ruleset-main.json`                        | 0 (`true`); the shape is asserted by the test above                   |
| format                       | `prettier --config .prettierrc --no-editorconfig --check` on every changed file        | 0                                                                     |
| ruleset dry run (read-only)  | `deploy/github/apply-ruleset.sh --dry-run`                                             | 0: `would POST repos/be-automata/automata/rulesets`                   |
| rollback dry run (read-only) | `deploy/github/apply-ruleset.sh --dry-run --delete`                                    | 0: `no ruleset named ... nothing to delete`                           |
| CODEOWNERS syntax (GitHub)   | `gh api 'repos/be-automata/automata/codeowners/errors?ref=feat/697-branch-protection'` | 0: `{"errors":[]}`                                                    |
| live repo untouched          | `gh api repos/be-automata/automata/rulesets`                                           | 0: `[]` (before and after)                                            |
| roborev                      | `roborev-guard review --branch --wait`                                                 | jobs 1271-1273 `F` (one finding each, all fixed); 1274 `P`, no issues |

`/verify` (`gstack-checks run`) selected unrelated `apps/www` vitest files and stopped on `vitest not
found`: this worktree has no `node_modules`, and no package code changed. The `ci.yml` lanes run the
full suites on the PR.

## Acceptance criteria

| AC                                                                           | Status                       | Evidence / reason                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. A bot PR touching `deploy/migrations/` cannot merge until the TL approves | deferred: blocked by the App | `branch-protection.test.ts` proves `deploy/migrations/` is code-owned and the ruleset requires a code-owner review. The block itself needs the App (TL, runbook sections 1-2) and the applied ruleset (section 5); verified by UAT step 1 (section 6). |
| 2. A non-sensitive PR merges on Automata's approval and green CI             | deferred: blocked by the App | The ruleset requires 0 approvals and only `ci-gate` (test). Verified by UAT step 2 after section 5.                                                                                                                                                    |
| 3. The TL can approve agent PRs                                              | deferred: blocked by the App | `agent-app-token.test.ts` proves the mint (JWT signature and claims, scoped request, stdout only the token, no secret on stderr or argv). The PR author changing needs the App: runbook section 4.                                                     |
| 4. Break-glass documented                                                    | met                          | `docs/runbooks/agent-github-app.md` "Break-glass" (who: org admins; how: PR-only bypass; logged: Rule Insights), `ruleset-main.json` `bypass_actors`, asserted by `branch-protection.test.ts`.                                                         |
