# Agent GitHub App (`automata-agent`) and the `main` ruleset

Issue: #697. Decision: #674 (AC 3, TL, 2026-11-18). Spec: `docs/specs/697/spec.md`.

## Why

On 2026-11-17 several sensitive PRs merged into `main` without the human review their bodies
asked for. `main` had no branch protection, no ruleset and no CODEOWNERS. The fix is a ruleset that
requires a code owner's approval on sensitive paths (`.github/CODEOWNERS`).

GitHub never counts an approval from a PR's own author. Agent PRs are opened as the TL
(`espinozasenior`), so the TL could never approve them. Agent PRs therefore move to a GitHub App,
`automata-agent`, **before** the ruleset is applied.

## The order

1. The TL creates the App and installs it on `be-automata/automata` only (section 1).
2. The TL stores its private key in the keychain from their own terminal (section 2).
3. A throwaway PR opened through the App works end to end (section 4).
4. Agent sessions switch to the App for opening PRs (section 3).
5. The ruleset is applied (section 5).
6. The UAT from #697 runs (section 6).

Steps 1 and 2 are the TL's and never an agent's. Nothing here is applied by merging the PR that adds
it: CODEOWNERS on its own only requests reviews.

## 1. Create the App (TL, GitHub settings)

Open <https://github.com/organizations/be-automata/settings/apps/new>.

| Field                              | Value                                                                                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub App name                    | `automata-agent` (if the name is taken, pick another; the bot login is `<slug>[bot]`)                                                                       |
| Homepage URL                       | `https://github.com/be-automata/automata`                                                                                                                   |
| Webhook                            | **Active: off** (no webhook URL, no secret)                                                                                                                 |
| Repository permissions             | Contents: **Read and write** · Pull requests: **Read and write** · Issues: **Read and write** · Metadata: **Read-only** (mandatory) · Checks: **Read-only** |
| Workflows                          | **No access.** Only needed if agents push through the App; they do not (section 3).                                                                         |
| Organization / account permissions | none                                                                                                                                                        |
| Where can this App be installed    | **Only on this account**                                                                                                                                    |

Then:

1. **Create GitHub App.** Note the **App ID** on the App's General page.
2. **Generate a private key** (same page, bottom). A `.pem` file downloads.
3. **Install App** → `be-automata` → **Only select repositories** → `be-automata/automata`.
   The installation id is the number at the end of the URL you land on
   (`.../settings/installations/<installation id>`).

## 2. Store the key and the ids (TL, own terminal)

Run this in your own terminal, not in an agent session. The key is stored base64-encoded on one line,
because `security -w` prints a multi-line value as hex.

```bash
base64 -i ~/Downloads/automata-agent.*.private-key.pem | tr -d '\n' | pbcopy
security add-generic-password -U -s automata-agent-app-key -a automata -w
# paste at the prompt (it asks twice), then clear the clipboard and delete the file:
pbcopy </dev/null
rm -P ~/Downloads/automata-agent.*.private-key.pem
```

With `-w` last, `security` prompts for the value, so the key never appears in the process list or
the shell history. The ids are not secret:

```bash
mkdir -p ~/.config/automata-agent
printf 'APP_ID=%s\nINSTALLATION_ID=%s\n' '<app id>' '<installation id>' > ~/.config/automata-agent/app.env
```

Check (the first run may show a keychain prompt for `security`; allow it):

```bash
deploy/github/agent-app-token.sh >/dev/null && echo minted
GH_TOKEN=$(deploy/github/agent-app-token.sh) gh api /installation/repositories --jq '.repositories[].full_name'
# → be-automata/automata, and nothing else
```

`agent-app-token.sh` prints only a token, valid one hour. `--jwt` prints the App JWT instead (ten
minutes, no network call), for debugging. `AUTOMATA_AGENT_APP_ID`, `AUTOMATA_AGENT_INSTALLATION_ID`
and `AUTOMATA_AGENT_APP_KEY_FILE` override the config file and the keychain.

## 3. How agent sessions use it

Set the token **per command**, never `export` it:

```bash
GH_TOKEN=$(deploy/github/agent-app-token.sh) gh pr create --repo be-automata/automata --draft --title ... --body-file ...
GH_TOKEN=$(deploy/github/agent-app-token.sh) gh pr ready <n> --repo be-automata/automata
```

- **Open as a draft, then mark it ready.** Automata's review trigger skips `opened` and
  `synchronize` events sent by a Bot when its automation sets `excludeBotSenders`; `ready_for_review`
  is always reviewed (`apps/www/src/app/api/webhooks/github/handlers.ts:293-316`).
- **`git push` stays on the person's git credential.** Pushes then arrive as `synchronize` events
  from a user, which Automata reviews, and the App needs no Workflows permission. An exported
  `GH_TOKEN` would also reach `gh auth git-credential` and push as the App: keep it per command.
- **The author filter.** Unless the review automation for this repo matches all authors, it reviews
  only PRs whose author is its user or is listed in `otherAuthors` (`handlers.ts:355-380`). Add
  `automata-agent[bot]` there, or confirm all-authors. The throwaway PR (section 4) proves it.
- **Never merge.** The person merges. Agents never use `--admin`.

Where agent PRs are opened today, all with the session's `gh` token:
the somnio plugin's `dev-execution` Step 5 (gstack `/ship`), `scripts/pr-opened.sh`, `loop-mode` and
`pr-sync` in `somnio-engineering-ai`, and the `pr-manager` agent. Do not edit the plugin cache. Once
section 4 passes, add this to the hand-written part of `AGENTS.md` (or to your global `CLAUDE.md`):

```markdown
- **Agent PRs open as the `automata-agent` App** (#697): run `gh pr create`, `gh pr ready` and PR
  comments with `GH_TOKEN=$(deploy/github/agent-app-token.sh)` set on that command only, open as a
  draft, then mark it ready. `git push` stays on your normal credential. Never merge, never `--admin`.
```

and propose upstream that the plugin's PR-opening steps take a token command (for example an
`AGENT_GH_TOKEN_CMD` setting) instead of the ambient `gh` login.

**Keep the agent from being the human.** After the switch the agent session still holds the TL's own
`gh` login and git credential: an org admin who can bypass the ruleset, and the code owner whose
approval the ruleset asks for. An agent running `gh pr review --approve` (or an `APPROVE` review via
`gh api`) on an App-authored PR would supply the "human" approval itself. Before section 5, the TL
(a person's edit; the harness blocks agents from changing it) adds to `.claude/settings.json`:

- `permissions.deny`: `Bash(gh pr review*--approve*)`, `Bash(gh pr review*-a*)`,
  `Bash(gh pr merge*--admin*)`, `Bash(gh api*rulesets*)`, `Bash(gh api*/reviews*)`,
  `Bash(gh auth token*)`, `Bash(deploy/github/apply-ruleset.sh*)`;
- because deny entries match by prefix (see the `deny-destructive-cloud.py` note in `AGENTS.md`), a
  tokenising `PreToolUse(Bash)` hook in the same style that refuses an approving review, `--admin`
  merges and ruleset writes in any segment of a compound command.

The durable fix is an agent session whose `gh` holds only the App token (a separate `GH_CONFIG_DIR`,
pushes through the App with the Workflows permission, and the review automation's `excludeBotSenders`
turned off for `automata-agent[bot]`). That is a follow-up, not part of #697.

**Check the other installed Apps.** `vercel` holds `administration: write` (which can edit or delete
rulesets) and `workflows: write` on its selected repositories. In org settings → GitHub Apps → Vercel
→ Configure, confirm `be-automata/automata` is not selected, or remove it. Record the answer on #697.

## 4. Prove the App on a throwaway PR (before the ruleset)

```bash
git switch -c chore/697-app-smoke origin/main
echo "" >> docs/runbooks/agent-github-app.md
git commit -am "chore: automata-agent smoke (#697), do not merge"
git push -u origin chore/697-app-smoke          # your credential
GH_TOKEN=$(deploy/github/agent-app-token.sh) gh pr create --repo be-automata/automata --draft \
  --title "chore: automata-agent smoke (#697), do not merge" --body "Throwaway, #697 section 4."
GH_TOKEN=$(deploy/github/agent-app-token.sh) gh pr ready <n> --repo be-automata/automata
gh pr view <n> --repo be-automata/automata --json author --jq .author   # → login app/automata-agent, is_bot true
```

Pass when: the author is the App, Automata reviews it, and you can submit an **Approve** review
(AC 3). Then close it and delete the branch.

## 5. Apply the ruleset

The ruleset is `deploy/github/ruleset-main.json` (REST rulesets API body):

- `main` only; a PR is required; a **code owner's approval** is required when the PR changes a path
  in `.github/CODEOWNERS`; approvals are dismissed on a new push;
- `required_approving_review_count` is **0**, so a PR that touches no code-owned path needs no
  GitHub approval and merges on green CI (Automata's approval stays required by the harness watch,
  not by GitHub);
- CI must pass: the one required check is CI's `ci-gate` job, which succeeds only when `audit`,
  `check`, `test`, `schema-drift`, `worker-e2e` and `e2e` all succeeded (GitHub Actions only; the
  branch need not be up to date);
- `main` cannot be deleted or force-pushed;
- the only bypass is break-glass (below).

```bash
deploy/github/apply-ruleset.sh --dry-run    # read-only: prints POST or PUT and the payload
deploy/github/apply-ruleset.sh              # as an admin of the repo
gh api repos/be-automata/automata/rulesets --jq '.[] | [.id, .name, .enforcement] | @tsv'
```

The script updates the ruleset with the same name if it exists. A new CI job needs no ruleset
change: add it to `ci-gate`'s `needs:` (`deploy/github/branch-protection.test.ts` fails until it is).

## 6. UAT (#697)

1. **Sensitive path blocks (AC 1).** Run this first: GitHub's docs do not state the behaviour of a
   code-owner review at an approval count of 0, so this step is what proves it. Through the App
   (section 3), open a PR that reformats `deploy/migrations/drift-allowlist.json` (whitespace only).
   Before anyone approves it, expect
   `gh pr view <n> --repo be-automata/automata --json reviewDecision,mergeStateStatus` to show
   `REVIEW_REQUIRED` / `BLOCKED`, and the merge box to say a code owner's review is required, even
   with green CI and Automata's approval. Approve it as the TL: it becomes mergeable. Push one more
   commit: the approval is dismissed. **Close it without merging.**
2. **Non-sensitive path merges (AC 2).** Through the App, open a PR touching only `docs/`. Expect it
   to be mergeable on green CI with no human approval (`reviewDecision` empty). Merge it or close it.
3. **Break-glass logged (AC 4).** Read the bypass entry for any break-glass merge in
   Settings → Rules → Insights; nothing to provoke on purpose.

If step 1 does not block (a code owner review not enforced at a count of 0), set
`required_approving_review_count` to 1 in `ruleset-main.json`, re-run section 5, and repeat step 2:
Automata's approval must then count, or every PR will need a human approval.

## Break-glass

- **Who:** the org admins (`OrganizationAdmin`, today `espinozasenior` and `mcones`), through a PR
  only (`bypass_mode: pull_request`); a direct push to `main` stays blocked for everyone.
- **When:** a production fix that cannot wait for a code owner, or CI itself broken in a way only a
  merge can fix.
- **How:** tick "Merge without waiting for requirements to be met (bypass rules)" in the merge box, or
  `gh pr merge <n> --repo be-automata/automata --admin`. A person does this, never an agent.
- **Logged:** every bypass is recorded in the repo's Settings → Rules → Insights (also readable as
  `gh api repos/be-automata/automata/rulesets/rule-suites`). Afterwards, comment on the PR with the reason and open an issue for its post-merge review.

## Rollback

- **Ruleset:** `deploy/github/apply-ruleset.sh --delete` (or Settings → Rules → Rulesets → delete).
  `main` is back to today's state at once.
- **App:** stop setting `GH_TOKEN`; agent PRs fall back to your login. Then suspend or uninstall the
  App (org settings → GitHub Apps), revoke its key on the App page, and
  `security delete-generic-password -s automata-agent-app-key -a automata`.
- **CODEOWNERS:** harmless without the ruleset (it only requests reviews); keep it.

**Key rotation:** generate a new key on the App page, store it (section 2, `-U` replaces the item),
check the mint, then delete the old key on the App page.
