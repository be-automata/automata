# Pilot runbook — intake readiness & operator steps

How to onboard a repo onto the Automata platform. The **first pilot is
dogfooding**: org **BeAutomata** (slug `beautomata`), repo
**`be-automata/automata`** — our own platform repo.

**No double-bot risk here.** Prod orch-agents does **not** serve
`be-automata/automata` (its `WORKFLOW.md` routes only the two live customer orgs),
so even though the shared GitHub App delivers this repo's events to prod, prod
takes no action on them. That means the staged rollout below can proceed to
**FULL ACTIVE quickly** — including real bot comments/checks/reviews on our own
PRs — after a short shadow-verify sanity pass. Shadow mode + the kill-switch are
still used during bring-up as guardrails, not because a second bot is competing.

> The customer-repo case is different: onboarding a repo that prod DOES act on
> (e.g. Somnio's `marketplace-monorepo`) reintroduces the two-bots-on-one-PR
> hazard. Those steps and cautions live in **[Second onboarding: a customer
> repo](#second-onboarding-a-customer-repo)** at the bottom — read that section
> in full before onboarding any non-dogfooding repo.

---

## Prerequisite — install the GitHub App on the `be-automata` org

The pilot re-uses the **current prod GitHub App** (slug likely `automata`, bot
`automata-ai-bot`). For the platform's repo-access gate and API calls to work,
that App must be **installed on the `be-automata` org**. This is an operator
browser step, not a script:

1. Go to `https://github.com/apps/<app-slug>/installations/new`.
2. Select the **be-automata** org and grant it the repo(s) (at least
   `be-automata/automata`).

Installing the App is what mints the **installation id** that the id-capture flow
(below) binds to the BeAutomata org.

> **SAFETY (every pilot, universal): never touch the App's OWN webhook URL.** It
> points at prod, which serves two live customer orgs; repointing/disabling it
> would cut them off. Pilot intake is always a **separate repo-level webhook** on
> the pilot repo. If the only way you can see to route events to the platform is
> editing the App-level webhook, stop.

---

## Shadow mode — what it does (design note)

`githubInstallation.mode` is `'shadow' | 'active'` per installation→org binding.

|                                                                | shadow     | active  |
| -------------------------------------------------------------- | ---------- | ------- |
| Webhook ingested                                               | yes        | yes     |
| Thread/task row created (org-stamped, dashboard-visible)       | yes        | yes     |
| `thread.shadow` flag (UI can badge)                            | `true`     | `false` |
| Sandbox boot / agent run                                       | **no**     | yes     |
| GitHub side effects (comments, checks, reviews, eyes reaction) | **none**   | yes     |
| Billing-link comment for no-access users                       | suppressed | posted  |

Implementation seams:

- **Resolution** — `getInstallationOrgAndMode({ db, installationId })`
  (`packages/shared/src/model/github-installation.ts`) returns `{ organizationId,
mode }` in one read. **No row → `active`** (migration-safe: an installation
  that predates the binding table keeps working). A _new binding_ defaults to
  `shadow` (safe onboarding); shadow is therefore always opt-in per binding,
  never a side effect of an installation being unknown.
- **Ingest gate** — `handleAppMention` derives the mode once, suppresses the
  eyes reaction + billing comment when shadow, and passes `shadow` down to
  `newThreadInternal` → `createNewThread`.
- **Boot suppression** — `createNewThread` stamps `thread.shadow` and, when
  shadow, returns without scheduling `startAgentMessage` (no boot). As a
  belt-and-suspenders systemic guarantee, `queueFollowUpInternal` also refuses
  to drain the follow-up queue for a shadow thread, so a _second_ mention on an
  already-shadow thread still never boots the agent.

### The deployment-level kill-switch (defense in depth)

Per-installation shadow mode has one gap: between wiring the pilot webhook and
running the bind step, an event from a _resolvable_ sender resolves to `active`
(the migration-safe no-row default) and would act before the binding exists — the
id-capture chicken/egg. The env var **`GITHUB_SIDE_EFFECTS_ENABLED`** closes it.
It defaults `true` (back-compat), but the pilot Worker sets it **`false`**, which
forces shadow behavior for **every** GitHub-processing path — mention intake,
mirror-intake, and seeded automations — regardless of any installation's mode.
It's folded in at each path's single `shadow`-derivation point via
`effectiveShadow(mode)` (`apps/www/src/lib/github-side-effects.ts`): switch off →
always shadow; switch on → per-installation mode governs. So during bring-up the
platform is globally inert on GitHub no matter what state the binding is in.

---

## Intake parity — event coverage matrix

Prod orch-agents routes these repo event classes (from its `WORKFLOW.md`) to
skills. The pilot needs **intake parity**: every routed event class must produce
a correctly-attributed task/thread in the bound org.

| #   | Event class                                         | Prod skill (intent)                                             | Chassis today                                                                                                                      | Gap → plan                                                                                                |
| --- | --------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | `pull_request.opened`                               | github-ops (PR review)                                          | `handlePullRequestUpdated` runs a PR **automation** only if a user created one (`on.open`); else PR-status DB update — **no task** | **Seeded automation** (`on.open`, `includeAllAuthors`, shadow-aware) → "Review PR" for every PR           |
| 2   | `pull_request.synchronize`                          | github-ops                                                      | PR automation only, `on.update`                                                                                                    | Same seeded automation (`on.update`)                                                                      |
| 3   | `pull_request.review_requested`                     | github-ops                                                      | **Not handled** (action absent from route)                                                                                         | **Mirror-intake** → "Review PR #N (review requested)"                                                     |
| 4   | `pull_request.closed` (merged=true)                 | github-pr-merged-jira · `github-pr-merged` live skill (ADR-008) | `handlePullRequestStatusChange` → status DB update only, **no task**                                                               | Mirror-intake, `merged===true` only → "Post-merge follow-up for PR #N"                                    |
| 5   | `pull_request_review.changes_requested`             | github-ops (re-review)                                          | `handlePullRequestReviewEvent` fires only on `submitted` **and** is mention-gated; state not inspected → **no task**               | Mirror-intake, `review.state==="changes_requested"` → "Address changes requested on PR #N"                |
| 6   | `workflow_run` failure                              | gh-fix-ci                                                       | **Not handled** (event absent from route)                                                                                          | Mirror-intake, new `workflow_run.completed` sub, `conclusion==="failure"` → "Fix CI: run '<name>' failed" |
| 7   | `issues.opened`                                     | github-deep-research                                            | `handleIssueEvent` runs an issue **automation** only if a user created one (`on.open`); else **no task**                           | **Seeded automation** (`on.open`, `includeAllAuthors`, shadow-aware) → "Research issue"                   |
| 8   | `issues.labeled` [`bug`\|`enhancement`]             | github-ops                                                      | **Not handled** (only `issues.opened` subscribed)                                                                                  | Mirror-intake, new `issues.labeled` sub + label allowlist → "Handle issue #N (labeled <label>)"           |
| 9   | `issue_comment.created` + bot mention               | github-mention-respond (chassis-native)                         | `handleIssueCommentEvent` → `handleAppMention`                                                                                     | **COVERED** (native; shadow-aware)                                                                        |
| 10  | `pull_request_review_comment.created` + bot mention | github-review-comment-respond (chassis-native)                  | `handlePullRequestReviewCommentEvent` → `handleAppMention`                                                                         | **COVERED** (native; shadow-aware)                                                                        |

**Two implementation mechanisms.** The automation trigger schema
(`packages/shared/src/automations/index.ts`) expresses only `pull_request`
(`on.open` = opened/ready_for_review, `on.update` = synchronize) and `issue`
(`on.open`). For those three classes (rows 1–2, 7) mirror parity is achieved by
**seeding automations** with a new `includeAllAuthors` filter (prod routes
unconditionally per repo; the stock automation author-filter only matched the
owner/an allowlist, so `includeAllAuthors` was added to route every author).
`runAutomation` is shadow-aware, so a seeded automation in a shadow org creates a
dashboard-visible task without booting. The remaining five classes (rows 3–6, 8)
have **no** automation trigger, so they are handled by the webhook
**mirror-intake** layer (`mirror-intake.ts`). Both paths attribute to the org
owner and honor shadow mode.

> Interaction note: seeded automations (rows 1–2, 7) fire via the existing
> `handlePullRequestUpdated`/`handleIssueEvent` automation routing; mirror-intake
> (rows 3–6, 8) covers disjoint event classes, so the two never double-fire on
> the same delivery. If an org later hand-creates its own automation for the same
> class, both would fire — a fresh pilot org has none.

**Attribution.** A mirror task isn't triggered by a specific user action (a PR
opening has no "commenter"), so it's attributed to the **bound org's owner**
(`role: "owner"` member) + the org id. Mention tasks keep their existing
commenter attribution.

**Tracker note:** prod's per-repo config names a Linear team as the tracker; no Linear/Jira wiring
is in scope here. The one tracker integration the chassis has is the **post-merge audit**
(ADR-008), described next.

## Post-merge ticket audit (YouTrack)

A repo that has a live `github-pr-merged` skill gets its merged PRs audited against the ticket they
reference. Mirror-intake (row 4) resolves the skill, fetches the tickets the PR names, and hands
both to a read-only agent. The agent emits a verdict per acceptance criterion. The control plane
then posts one comment on the PR and, when writes are enabled, comments on the ticket and moves it
to `PR Merged`. The agent never holds the tracker token. A repo without the skill keeps the fixed
prompt in row 4.

**Onboard a repo** (repeat per repo; start with one):

1. Bind the GitHub App installation to the org in shadow mode
   (`deploy/bind-github-installation.ts`).
2. Push the skill under the lane name:

   ```bash
   DATABASE_URL=... pnpm exec tsx deploy/skill-push.ts <orgSlug> <owner/repo> \
     github-pr-merged deploy/skills/github-pr-merged-youtrack/SKILL.md
   ```

3. As the org owner, open the repository environment in the dashboard and set:

   | Variable                  | Value                                                        |
   | ------------------------- | ------------------------------------------------------------ |
   | `YOUTRACK_URL`            | `https://<instance>.youtrack.cloud` (https, public hostname) |
   | `YOUTRACK_TOKEN`          | a permanent token, ideally of a dedicated bot account        |
   | `YOUTRACK_PROJECTS`       | project short names, comma-separated (e.g. `ACME`)           |
   | `AUTOMATA_TRACKER_WRITES` | leave unset for now                                          |

   `YOUTRACK_TOKEN` is control-plane only: it is stripped before environment variables are handed
   to any sandbox, worker or terminal.

4. Flip the installation to active. With `AUTOMATA_TRACKER_WRITES` unset the audit runs in shadow:
   it reads the tickets and posts the PR comment, worded as "would move", and writes nothing to the
   tracker. Calibrate on a handful of real merges.
5. Set `AUTOMATA_TRACKER_WRITES=live` to enable ticket comments and stage moves.

**What it will and will not do.** Stage moves are limited to `PR Merged` for the ticket the PR
closes, `In Progress` for a `Backlog`/`To Do` ticket whose work is split across PRs, and `To Do` for
a `Backlog` ticket whose last blocker just merged. It never moves a ticket to `Done`,
`Staging (TF)` or `Won't do`, never moves one already at or past `PR Merged`, and never edits a
ticket's summary or description. A PR with no ticket reference gets a single comment saying so.

**Which ticket a PR is audited against.** The ticket it delivers: the key in the PR title, else in
the head branch name, else one named by a closing keyword (`Closes ACME-123`). Tickets the PR merely
mentions ("depends on", "related", "deferred to") are listed on the comment as "also referenced"
and are never audited, commented on or moved.

**Editing the skill** is live on the next merge: re-run `skill-push`, edit it in the Skills panel
on `/settings/review`, or commit `.automata/skills/github-pr-merged.md` to the repo's default
branch (the file refines a pushed skill; it cannot enable the lane by itself).

## Capturing the installation id (first delivery)

The installation id is **not** obtainable via the user-token GitHub API, so the
bind step (below) needs it from a real delivery. Every webhook delivery is
logged by the intake route with the id and account, e.g.:

```
[github webhook] event received pull_request action: opened repository: be-automata/automata installation.id: 12345678 account: be-automata
```

Additionally, the first delivery for an **unbound** installation is fast-acked
(WI-8 2xx) with an explicit skip log naming the id + account, so the operator
can read it and bind:

```
[github webhook] skipped { category: 'unmapped_installation', installationId: 12345678, accountLogin: 'be-automata', ... }
```

Flow: wire the repo-level webhook (step 3) **first**, trigger any event (open a
throwaway PR or re-deliver from the repo's webhook "Recent Deliveries"), read the
`installation.id` from the log, run the bind (step 2), then **re-deliver** the
same payload from GitHub's webhook UI so it now lands against the bound org.

## Operator steps (dogfooding: `be-automata/automata`)

Prerequisites: the App is installed on the `be-automata` org (see above);
`DATABASE_URL` points at the platform Postgres; the BeAutomata org exists (create
it in the dashboard, or via `deploy/seed-selfhost.ts` for a dev box). You need the
repo's admin settings.

### 0. Set the kill-switch OFF (before anything reaches the Worker)

On the pilot Worker set `GITHUB_SIDE_EFFECTS_ENABLED=false` (see
`deploy/WORKERS-ENV-MAP.md`). This makes the platform globally inert on GitHub —
no boot, no comments/checks/reviews/reactions — for **every** installation
regardless of binding, closing the window before the binding exists. Do this
first; it stays off through shadow-verify.

### 1. Create / confirm the org

Create **"BeAutomata"** in the dashboard and note its **slug** (`beautomata`).
The bind + seed steps resolve the org by slug.

### 2. Bind the installation in shadow mode

Get the installation id from the delivery log (see "Capturing the installation
id" above), or from GitHub → org settings → Installed GitHub Apps → the Automata
app → the URL ends in `/installations/<id>`.

```bash
DATABASE_URL=postgres://... pnpm exec tsx deploy/bind-github-installation.ts \
  <installationId> beautomata        # mode defaults to shadow
```

The script prints the bound row and confirms `mode: shadow`. It **only** writes
the `github_installation → org` mapping — it never touches any webhook config.

### 3. Add the repo-level webhook (NOT the App webhook)

On **`be-automata/automata`** → Settings → Webhooks → Add webhook:

- **Payload URL**: the platform's Workers endpoint, `https://<workers-host>/api/webhooks/github`
- **Content type**: `application/json`
- **Secret**: a **fresh pilot secret** — the value set as `GITHUB_WEBHOOK_SECRET`
  on the pilot Worker (a NEW value per `deploy/WORKERS-ENV-MAP.md`, **not** the
  prod App's webhook secret). The same fresh value goes on both sides (the Worker
  secret and this "Secret" field); the platform verifies HMAC-SHA256 against it.
- **Events** (to cover the full parity matrix): Pull requests, Pull request
  reviews, Pull request review comments, Issues, Issue comments, Workflow runs.

Leave the **App-level** webhook exactly as it is (pointing at prod).

### 3b. Seed the mirror automations

Provision the automation-expressible rows (PR open/update review, issue-open
research) for the bound org. Idempotent; binds the installation in shadow if you
pass its id. Args default to the pilot org, so for BeAutomata you can omit them:

```bash
DATABASE_URL=postgres://... pnpm exec tsx deploy/seed-pilot-mirror.ts \
  beautomata be-automata/automata <installationId>
# or simply (defaults): pnpm exec tsx deploy/seed-pilot-mirror.ts
```

The remaining classes (review_requested, merged, changes_requested,
workflow_run, labeled) need no seeding — the webhook mirror-intake layer handles
them for any bound installation.

### 4. Shadow-verify

Exercise both intake paths: comment `@<bot>` on a PR (mention path) and trigger a
mirror class — open a PR or push to one (→ "Review PR" task), or label an issue
`bug` (→ "Handle issue" task). Then confirm from the dashboard:

- A thread appears under the **BeAutomata** org, badged **shadow**.
- **On GitHub, nothing happened** — no eyes reaction, no comment, no check, no
  review. This is the whole point of shadow mode.
- If webhook deliveries show non-2xx, that's a bug, not a rejection — the intake
  endpoint fast-acks business rejections with a 2xx skip (WI-8) so GitHub never
  disables the webhook. A genuine 5xx needs investigating.

### 5. Go live (dogfooding — move fast)

Because prod does not act on `be-automata/automata`, there is no two-bots
contention, so once shadow-verify passes you can go straight to full active and
let the bot comment on our own PRs. Still flip in this order so an _unintended_
installation can't act during the transition:

**5a. Flip the global kill-switch ON.** Set `GITHUB_SIDE_EFFECTS_ENABLED=true`
(or remove it) on the pilot Worker and redeploy. Per-installation mode now
governs — and BeAutomata is still **shadow**-bound, so it _still_ produces no
side effects. A quick re-verify here proves the switch flip alone didn't wake
anything up.

**5b. Flip the BeAutomata binding to active** (the final step):

```bash
DATABASE_URL=postgres://... pnpm exec tsx deploy/bind-github-installation.ts \
  <installationId> beautomata active
```

Now the platform boots the agent and acts on `be-automata/automata` PRs — real
bot comments/checks/reviews on our own repo. That is the dogfooding goal.

### Rollback

Fastest, global (all installations at once): set
`GITHUB_SIDE_EFFECTS_ENABLED=false` on the Worker and redeploy — the platform
goes inert on GitHub immediately, no DB change needed.

Per-installation: flip the binding back to shadow at any time:

```bash
DATABASE_URL=postgres://... pnpm exec tsx deploy/bind-github-installation.ts \
  <installationId> beautomata shadow
```

Either way the platform immediately stops producing GitHub side effects;
existing shadow threads remain visible for inspection.

---

## Second onboarding: a customer repo

**This section applies when onboarding a repo that prod orch-agents DOES act on**
— e.g. Somnio's `somnio-projects/marketplace-monorepo`. Unlike the dogfooding
pilot, here two bots can fight over one PR, so the double-bot cautions below are
mandatory and the rollout must NOT rush to active.

### The safety model (read this first)

Two independent things must never fight over one PR:

1. **Prod orch-agents** — the existing bot, driven by the GitHub App's _own_
   webhook (the App-level webhook URL, which points at prod).
2. **The new Automata platform** — driven by a **separate, repo-level webhook**
   we add to the customer repo, pointing at the Workers URL.

> **CRITICAL SAFETY — the GitHub App's own webhook URL is NEVER touched.** It
> keeps pointing at prod for the entire pilot. The pilot uses a _separate
> repo-level webhook_ (Settings → Webhooks on the customer repo). Never repoint,
> disable, or edit the App-level webhook to run this pilot. If the only way you
> can think of to route events to the platform is to change the App's webhook
> URL, stop — that would hijack every repo the App is installed on (including the
> two live customer orgs it serves).

Shadow mode is the second guardrail. Even with the repo-level webhook wired and
delivering, a **shadow** installation produces **zero GitHub side effects**: no
comments, no checks, no reviews, no reactions, and the agent never runs. So even
if both webhooks fire for the same PR during the pilot, only prod acts; the
platform merely records a shadow thread you can inspect.

### Steps (customer repo)

Follow the same operator steps 0–4 above, but with the customer's org slug and
repo, e.g.:

```bash
DATABASE_URL=postgres://... pnpm exec tsx deploy/bind-github-installation.ts \
  <installationId> somnio-software        # shadow
DATABASE_URL=postgres://... pnpm exec tsx deploy/seed-pilot-mirror.ts \
  somnio-software somnio-projects/marketplace-monorepo <installationId>
```

Then **stay in shadow** and verify for as long as it takes to trust the platform
on live traffic — the whole point of shadow here is that only prod acts while you
watch.

### Going active (customer repo) — the extra gate

> **Before flipping the customer binding to active, decide how prod orch-agents
> stops acting on that repo** (otherwise you re-introduce the two-bots problem —
> now both _acting_). Coordinate the prod cutover (remove the repo from prod's
> scope, or stop the App-level delivery routing for it — but **never** by
> repointing the shared App webhook) as a separate, deliberate step. Only after
> prod is confirmed out of the loop do you run steps 5a → 5b for the customer
> binding.

## Execution-plane tunnel (Hatchet) — NAMED tunnel is current

The control plane reaches the Hatchet engine over a **named cloudflared tunnel**:
`hatchet.beautomata.com → localhost:8888` (tunnel `automata-hatchet`, id
`73d79054-70f6-40f8-901a-d445eff83577`; `HATCHET_API_URL` = `https://hatchet.beautomata.com`).
Run it with `cloudflared tunnel run --url http://localhost:8888 automata-hatchet` and
keep that process alive on the engine box. The hostname is **stable** — a process
restart needs no re-secret. Credentials live at `~/.cloudflared/73d79054-*.json`
(keep out of the repo; delete the tunnel to revoke). Full detail + the recovery drill
are in `deploy/PILOT-OPERATOR-STEPS.md` §5.

> The earlier **ephemeral quick-tunnel** recipe (`cloudflared tunnel --url …` →
> `*.trycloudflare.com` → re-`wrangler secret put HATCHET_API_URL` on every launch)
> is **SUPERSEDED** by the named tunnel above. It remains only as a break-glass
> fallback in PILOT-OPERATOR-STEPS §5.

## Execution-plane model credential — `WORKER_BOX_TRUST`

A worker box authenticates agent runs to Anthropic one of three ways, and the
box says which by setting `WORKER_BOX_TRUST`:

| value              | how runs authenticate                                                                                                                                                                          | use when                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `shared` (default) | control-plane proxy (`useCredits`) — the run bills platform credits and no provider credential ever touches this disk                                                                          | the box executes runs for tenants who do not own it                                      |
| `owner`            | the worker pulls the run's own credential from `/api/daemon/agent-credentials` and writes it to a per-run `HOME` (0600, wiped at teardown) — the run spends the USER's subscription or API key | the box belongs to the tenant whose runs it executes (the pilot: the operator's own Mac) |
| `box-key`          | the box's own `ANTHROPIC_API_KEY` is the declared credential for every run — no pull, no proxy                                                                                                 | self-host/pilot posture: the operator funded a key on this box on purpose                |

```bash
# pilot box (single-tenant): let runs spend the user's Claude subscription
export WORKER_BOX_TRUST=owner
```

**Every run gets a fresh `HOME`, in every mode, seeded as a trusted workspace.**
The seed (`projects[<realpath of workdir>].hasTrustDialogAccepted` in the run
HOME's `.claude.json`) is required: review runs use `--permission-mode default`,
and in an untrusted workspace the CLI ignores `.claude/settings.json` and the
agent exits with zero API calls. The path must be the REALPATH — macOS `tmpdir`
is a symlink and the CLI resolves it.

The fresh `HOME` is not hygiene. On macOS the
agent CLI keeps its OAuth in the login **Keychain**, not in `~/.claude/.credentials.json`
— so a run that inherits the operator's `HOME` authenticates AS the operator and
spends _their_ subscription, with no credential file and no env var anywhere to show
for it. Verified on Claude Code 2.1.234: with a fresh `HOME` the CLI reports "Not
logged in"; with a delivered credential file it reads that file. The operator's own
`claude` login on the box is untouched and unreachable from a run.

Do **not** set `CLAUDE_CODE_SIMPLE` on a worker box: simple mode cannot
authenticate from an OAuth credentials file (it reports "OAuth session expired
and could not be refreshed" without making an API call), which breaks every
`owner`-mode run.

**Outside `box-key` mode, the box's own `ANTHROPIC_API_KEY` is never a run
credential.** It used to be the silent fallback: `buildRemoteDaemonMessage` skips
`useCredits` when the user _has_ a credential, but nothing delivered that
credential to the box, so the daemon fell through to whatever key the box carried.
A user with a Max subscription ran on the operator's API key, and a box with no
key failed runs that should never have touched it. In `shared` and `owner` modes
a run now either has its own credential in its own `HOME`, or it goes through the
proxy — the box key is unreachable. Only `WORKER_BOX_TRUST=box-key` makes the box
key a run credential, and it does so explicitly, for every run, as a deliberate
operator opt-in — never as a silent fallback.

Leaving `WORKER_BOX_TRUST` unset is safe but **changes who pays**: runs that used
to quietly draw on the box's `ANTHROPIC_API_KEY` now bill platform credits. Set
`owner` on a single-tenant box to get the subscription behaviour.

## Connecting Claude — which credential kind to use

Three kinds, all reaching a run through the same `claudeAiOauth` credentials file
(the resolver decides the delivery shape; the execution planes only honour shapes):

| kind                             | how the user gets it                    | lifetime      | refresh                                 |
| -------------------------------- | --------------------------------------- | ------------- | --------------------------------------- |
| API key                          | console.anthropic.com                   | until revoked | n/a — metered API billing               |
| Subscription (interactive OAuth) | "Connect Claude subscription" popup     | **8 hours**   | control plane re-mints with a 1h buffer |
| Setup token                      | `claude setup-token` locally, pasted in | months        | none — re-mint and paste again          |

**Setup tokens are the right default for an unattended box.** They spend the user's
Claude subscription, survive far longer than the 8-hour interactive token, and need
no refresh machinery. The trade is that expiry is not detected in advance: a revoked
or expired token surfaces as a 401 inside the run. Re-mint with `claude setup-token`
and paste the new value.

The two `sk-ant-` secrets look alike and are NOT interchangeable — an API key
(`sk-ant-api…`) is sent as an `x-api-key` header, a setup token (`sk-ant-oat…`) as an
OAuth bearer. Pasting one into the other's field used to store fine and fail later as
an opaque 401; both fields now reject the other's prefix by name.

### Verifying a token by hand

Empty `HOME` isolates the check from any local login (on macOS the CLI reads its own
OAuth from the login Keychain, which a fresh `HOME` cannot reach):

```bash
H=$(mktemp -d); mkdir -p "$H/.claude"
cat > "$H/.claude/.credentials.json" <<JSON
{"claudeAiOauth":{"accessToken":"<token>","refreshToken":"","expiresAt":99999999999999,"scopes":["user:inference"],"subscriptionType":null}}
JSON
chmod 600 "$H/.claude/.credentials.json"
env -i PATH="$PATH" HOME="$H" claude -p "say OK" --output-format stream-json --verbose </dev/null
rm -rf "$H"
```

A working token reaches `"type":"result"` with `"is_error":false`. `401 OAuth access
token is invalid` means the token is dead — the channel itself is fine, since a 401
proves the file was read.

## Egress enforcement backstop (#66 slice 2 — worker plane)

When a repo has an egress policy set (`repoReviewSettings.egress_policy`), the
control plane resolves it into a shape (level + final allowlist) and the worker
starts a **per-run loopback filtering forward proxy**
(`packages/worker/src/agent-run/egress-proxy.ts`). The agent child gets
`HTTPS_PROXY`/`HTTP_PROXY` (both cases) pointed at it and
`NO_PROXY=127.0.0.1,localhost`. The proxy allows/denies each `CONNECT` and
absolute-form HTTP request against the allowlist (wildcard domains, port
pinning, exact IP:port — level-dependent), fails closed on unparseable targets,
and posts **every** decision (allow and deny) to
`POST /api/daemon/egress-event` for the `egress_events` audit trail. No policy
on the repo ⇒ no proxy, no env vars, no behavior change.

**The honest limitation: env-var proxying is cooperative.** A prompt-injected
agent that runs `unset HTTPS_PROXY` (or uses a client that ignores proxy vars)
bypasses the proxy entirely. The backstop is the PF anchor template at
`deploy/egress-pf.conf`: default-deny direct outbound 80/443 for the agent uid
— tcp AND udp, since udp/443 is QUIC / HTTP-3 and a tcp-only rule would leave
an https bypass — loopback excepted (so proxied traffic still flows). Load it
as root on the pilot box:

**The anchor fences a DEDICATED role account, never the worker's own uid** (#108).
Rendering `__AGENT_UID__` to uid 501 blocks the operator AND the worker — the
control-plane poll, the git broker's upstream fetch and the credential pull all
die at once. Provisioning, the preflight/verify scripts, the PF wrapper conf and
the boot LaunchDaemon are in
`packages/worker/deploy/AGENT-UID-PROVISIONING.md`; that document is the
procedure, and the summary below is not a substitute for it.

```bash
sudo cp deploy/egress-pf.conf /etc/pf.anchors/automata-egress
sudo sed -i '' "s/__AGENT_UID__/$(id -u _automata-agent)/" /etc/pf.anchors/automata-egress
sudo install -o root -g wheel -m 0644   packages/worker/deploy/automata-pf.conf /etc/automata-pf.conf
sudo packages/worker/deploy/pf-preflight.sh _automata-agent   # validates, parses, then loads with -E
sudo packages/worker/deploy/pf-verify.sh
```

Never edit `/etc/pf.conf` (Apple rewrites it on OS updates) and never enable PF
with `-e` (any system component calling `pfctl -X <token>` would silently disable
PF and this anchor).

Rollback, scoped: `sudo pfctl -a automata-egress -F rules`. Nuclear:
`sudo pfctl -d`. Neither can lock anyone out of the local console — PF filters
network paths only.

**Load order:** the daemon bundle carrying the proxy-aware control-plane callback
must be live on the box BEFORE the anchor is loaded, or the daemon's own
`POST /api/daemon-event` is dropped at the packet level and runs produce no
output at all.

**This is manual host configuration — NOT CI-verified and NOT applied by any
code in this repo.** macOS PF needs root and is host-global; the unprivileged
worker cannot load it per run. Until the anchor is loaded, the env-unset bypass
exists on the worker plane; with it loaded, direct web egress from the agent
uid is blocked at the packet level and only the audited loopback proxy path
remains.

**Provider planes (slice 3):** Docker (internal network + proxy sidecar), E2B
(native firewall, SDK v2) and Daytona (create-time allowlists) enforce the same
shape — ops gates (E2B template rebuild with envd ≥ 0.2.0 before deploy;
Daytona org-tier verification) and audit limitations are documented in
`docs/egress-enforcement.md`.

## Review batteries on the execution box (phase 3)

The review lane's "batteries" are pinned in `packages/worker/deploy/batteries.json`
and installed by `packages/worker/deploy/linux/install-batteries.sh` (root only).
Nothing reads them before Phase 5 seeds them into runs, so installing them needs
**no worker restart**.

**What lands where**

- Packs: `/usr/local/lib/automata-batteries/<packId>@<sha>/` (`skills/`,
  `agents/`, `LICENSE`, `.stamp`). These are root-owned, with dirs 0755 and
  files 0644.
- CLIs: `/usr/local/bin/{shellcheck,actionlint,gitleaks}` (0755). Their licenses
  are under `/usr/local/lib/automata-batteries/licenses/<name>-<version>/`.
- `/usr/local/lib/automata-batteries/manifest.sha256` is the sha256 of the
  manifest plus the overlay files that were installed. It is the contract that
  Phase 5 logs per run, and it is written only by a fully passing run.
  `manifest.sha256.invalid` means the last run did not fully pass.
- The script prints `SOURCE checkout <sha>`, one
  `INSTALLED`/`SKIPPED`/`FAIL`/`STALE`/`VERIFIED` line per item, and ends with
  exactly `RESULT: PASS` (exit 0) or `RESULT: FAIL (<n> failure(s))` (exit 1).

**Production step (after the PR merges; operator, as root on the box)**

1. Preflight: confirm no run is in flight. `ls -d /sys/fs/cgroup/system.slice/automata-worker.service/run-* 2>/dev/null | wc -l`
   must print 0; otherwise wait. Never disturb an in-flight review: on this box,
   replacing a same-sha dir takes two renames. Note
   `systemctl show -p NRestarts --value automata-worker.service` before and after.
2. Update the checkout as the automata user:
   `runuser -u automata -- git -C /opt/automata-platform -c safe.directory=/opt/automata-platform fetch origin`,
   then
   `runuser -u automata -- git -C /opt/automata-platform -c safe.directory=/opt/automata-platform merge --ff-only origin/main`.
   `--ff-only` fails loudly if the checkout has diverged. Investigate that; do
   not force.
3. Verify HEAD against the public origin and take a root-owned copy of the
   script from that commit:
   `H=$(git -C /opt/automata-platform -c safe.directory=/opt/automata-platform rev-parse HEAD)`.
   `git ls-remote https://github.com/be-automata/automata refs/heads/main` must
   print the same sha. Then run
   `git -C /opt/automata-platform -c safe.directory=/opt/automata-platform cat-file blob "$H:packages/worker/deploy/linux/install-batteries.sh" > /root/install-batteries.sh`.
4. Run it:
   `AUTOMATA_REPO=/opt/automata-platform bash /root/install-batteries.sh 2>&1 | tee /root/install-batteries.$(date -u +%Y%m%dT%H%M%SZ).log`.
   `${PIPESTATUS[0]}` must be 0, the `SOURCE checkout` line must equal `$H`, the
   last line must be `RESULT: PASS`, and every `VERIFIED agent …` line must be
   present. **Do not re-run `/usr/local/sbin/automata-provision.sh`**: it is a
   stale first-boot copy of cloud-init's `write_files`, it does not contain the
   battery call, and it would redo apt, npm and sysctl work.
5. Re-run it once. Every item must report `SKIPPED`. Record the output of
   `cat /usr/local/lib/automata-batteries/manifest.sha256`.
6. Attach the PASS summary and the manifest hash to the PR. No worker restart is
   needed, and NRestarts must be unchanged.
7. A `FAIL verify …` line from verify_as_agent is a script finding (drift in the
   spawn shape, permissions or PATH), not something to hand-fix on the box.
   Capture the log, leave `manifest.sha256.invalid` in place, and fix it in a
   follow-up PR. The same goes for a CLI smoke check that fails only on its
   version flag (actionlint `-version`, gitleaks `version`): fix `versionArgs` in
   `batteries.json` and re-run.

**Why a root-owned copy from the verified commit.** `/opt/automata-platform` is
writable by the worker uid, including `.git/config` and `.gitattributes`. The
installer therefore reads pack content, overlays and the manifest only as git
objects bound to commit ids (`rev-parse`, `ls-tree -r -z`, `cat-file blob`),
never the working tree. Every git call adds a scoped `-c safe.directory`. The
script file itself is the one input that is not object-bound, so you run a copy
taken from the HEAD you verified against the public origin.

**STALE dirs** are pack dirs for pins that are no longer in the manifest, plus
`.<id>@<sha>.replaced.<timestamp>` dirs moved aside when a same-sha pack was
re-installed (for example after an adapter edit). They are left in place on
purpose, because Phase 5 links runs into these paths. Remove them by hand only
when no run is in flight. Replacing a same-sha dir is atomic only with
`mv --exchange` (coreutils ≥ 9.5). Ubuntu 24.04 ships 9.4, so the script falls
back to two renames, which is another reason for the no-run-in-flight preflight.

**Rollback:** `rm -rf /usr/local/lib/automata-batteries` and
`rm -f /usr/local/bin/{shellcheck,actionlint,gitleaks}`. Nothing reads them
before Phase 5.

**Local dry run (developers, non-root):** commit first, because the manifest
and overlays are read from HEAD. Then run
`PREFIX="$TMPDIR/batt-dry" SKIP_SUDO_VERIFY=1 bash packages/worker/deploy/linux/install-batteries.sh`.
The prefix must be absolute. Add `BATTERIES_MANIFEST=<absolute path>` to try a
modified manifest. Both knobs are refused for root and for any prefix that
resolves to `/usr/local`. The dry run prints `VERIFY SKIPPED` instead of
checking through sudo.

**Bumping a pin:**

1. Set the new commit `sha` and recompute every `gitId` with
   `git rev-parse <sha>:<path>`.
2. For a CLI, take `sha256` from the publisher's checksum file and re-hash the
   tarball locally.
3. Re-check `allowedHelperRefs` on the gstack-review pack in `batteries.json`:
   each `ref` must still occur exactly `count` times in its `file`, and the
   adapter must still neutralise it.
4. Run the dry run and `pnpm --filter @terragon/worker exec vitest run src/agent-run/deploy-assets.test.ts src/agent-run/batteries-manifest.test.ts`.

**Recorded decisions and Phase 5 caveats**

- semgrep was dropped. A hash-pinned install needs a lockfile for a PyPI
  closure of about 60 packages. Its useful rules come from the semgrep.dev
  registry, which means network access plus metrics. The offline rule set is
  under the restrictive Semgrep Rules License v1.0.
- gstack `cso` was dropped. v3 routes every read through a 62 MB bun-compiled
  launcher that is gitignored upstream.
- `gsd-integration-checker` was dropped because it audits `.planning/`
  summaries, not a PR.
- Upstream gstack `review/SKILL.md` is never installed, because its preamble can
  execute a script from the PR checkout. The automata adapter
  (`packages/worker/deploy/batteries/gstack-review/SKILL.md`) replaces it. The
  adapter treats `gstack-shortcut(dec-*)` markers as UNVERIFIED and supersedes
  the specialists' JSON output format with plain-text bullets.
- `gsd-code-reviewer` and `gsd-security-auditor` declare Write/Edit, which the
  review lane denies (Phase 2 Q4).
  - `gsd-code-reviewer` fails closed without a files list or `diff_base`, and
    it wants to write `REVIEW.md`.
  - `gsd-security-auditor` targets a PLAN threat model. It also reads the
    project's `.claude/skills/`, which is PR-controlled, untrusted input.
- The somnio security-audit pipeline writes `reports/` through Bash redirects,
  which bypass the Write denial. Phase 5 should use its references as rules,
  not run the 11-step pipeline. Its `allowed-tools` line is stripped at install.
- Phase 5 adds an explicit
  `--disallowedTools Write Edit NotebookEdit WebFetch WebSearch` for the
  orchestrated lane, because a deny rule beats a skill's `allowed-tools`.

## Task-run batteries and the Somnio CLI (phase 7)

**What it is.** The `task_batteries` setting (Settings → Review → **Task agent
packs**; a repo override and the org default on the `'*'` row; null = inherit;
none = today) gives manual, scheduled and mention **task** runs the selected
battery packs in their per-run HOME. Review runs never take task packs.

- Task runs get the packs linked through the same verified-install fences as
  orchestrated reviews, but **no hooks-off `settings.json`**: a repo's own
  hooks keep today's semantics in the task lane.
- The worker logs exactly one batteries line per run. A task run that carried
  packs logs `batteries: lane=task packs=<ids|none> manifest=<12hex>` (or
  `batteries: unavailable lane=task reason=<r>`). A mention on a PR logs
  `lane=pr`. Every other run keeps today's `batteries: mode=…` line, and
  unconfigured repos are byte-identical in HOME and log.
- **Foreground-only guard (every non-review run, packs or not).** The per-run
  HOME gets a user-level `settings.json` whose PreToolUse hooks refuse
  background Bash (`run_in_background: true`) and Monitor: a headless
  `claude -p` session kills background work when it ends, so the run would
  report "complete" with the work abandoned. The worker logs
  `task agent: foreground-only hook installed` after the batteries line.
  Review runs never get it. Background sub-agents stay allowed.
- An invalid stored value never fails a dispatch: www logs
  `[hatchet] task agent: invalid stored taskBatteries — dispatching without packs`
  and the run goes without packs.

**Read-only GitHub token (DORA auth = Option 3; ADR-004 amendment 2026-10-04).**
A pack that declares `requires: ["github-read-token"]` in `batteries.json`
(today only `somnio-skills`) makes www mint a **read-only** (contents,
metadata, pull_requests, issues: read), **single-repo**, ≤1h GitHub App
installation token for that task run. Selecting the pack is the opt-in; there
is no other toggle.

- The agent gets it as `GITHUB_TOKEN`, while `GH_TOKEN` stays the per-run
  broker bearer. gh prefers `GH_TOKEN`, so gh and git stay brokered.
- It is never minted for review runs, and the worker refuses a forged one on
  the review lane.
- Why: the vendored `dora_metrics.py` hard-codes `https://api.github.com` and
  reads `GITHUB_TOKEN`, so the broker bearer gets a 401.
- **Prerequisite:** the GitHub App installation on the org must grant those
  four READ permissions. Otherwise the mint fails, the run proceeds without the
  token, www logs `[hatchet] task agent: read token mint failed — dispatching without it`,
  and DORA 401s.
- Every run whose task packs were seeded logs exactly one
  `task agent: read-token=<outcome>` line: `read-token=applied` when the agent
  got the token, otherwise `read-token=skip=<reason>` — `expired` (the worker
  refuses a token within a minute of expiry), `not-delivered` (a requiring
  pack was seeded but no token arrived), `no-requiring-pack` or `no-broker`.
  Runs without task packs (every review, every unconfigured repo) log no such
  line. The token value is never logged.
- A per-repo egress allowlist must include `api.github.com`, else DORA fails
  with a network error (not a 401).

**What is installed** (by `install-batteries.sh`, as root):

- The `somnio-skills` pack (`skills/dora-metrics`, `skills/react-health-audit`,
  `skills/security-audit` + LICENSE) at
  `/usr/local/lib/automata-batteries/somnio-skills@<sha>/`.
- A **build-only** Dart SDK at `/usr/local/lib/automata-batteries/dart-sdk@3.13.5/`
  (top dir 0700, sha256-checked before extraction, extracted with
  `python3 -m zipfile`). There is no `/usr/local/bin/dart`: agents never need
  Dart, and a writable or reachable SDK would be a second toolchain on PATH.
- The somnio CLI, compiled ahead of time from the pinned commit with OUR
  committed `pubspec.lock` (`pub get --enforce-lockfile`, then `dart compile exe`).
  It is installed root-owned under `somnio-cli@<sha>/`, behind a
  `/usr/local/bin/somnio` wrapper that exports `SOMNIO_ROOT` and a root-owned
  `PUB_CACHE`, so `somnio update` fails closed. We do not use
  `dart pub global activate`: its dependency closure floats and its tree would
  be writable by whoever activates it.
- The first install downloads about 240 MB (the SDK zip) and 62 pub archives
  as root, so it needs outbound github.com, storage.googleapis.com and pub.dev.

**Production rollout (operator; Phase 7 is not done until step 10 is recorded).**
Never run two worktrees' suites at once on the laptop, caffeinate the pilot
session, and restart the worker only when idle.

1. Prod schema push FIRST: `pnpm -C packages/shared drizzle-kit-push-prod` with
   the prod DATABASE_URL supplied out of band (write-only Worker secret).
   - Expect exactly one statement:
     `ALTER TABLE "repo_review_settings" ADD COLUMN "task_batteries" text[]`.
     Abort on any drop, rename or other change.
   - Then `DATABASE_URL=… pnpm exec tsx deploy/assert-schema-ready.ts` must
     print ok for task_batteries and exit 0.
2. Merge the single PR with CI green (check = tsc + lint + format-check, plus
   worker-e2e). The branch has no upstream: push with an explicit refspec, never
   a bare `git push` (push.default=upstream).
3. Box preflight, as root on the execution box:
   - No run in flight:
     `ls -d /sys/fs/cgroup/system.slice/automata-worker.service/run-* 2>/dev/null | wc -l` = 0.
   - Record `systemctl show -p NRestarts --value automata-worker.service`.
   - Confirm `sudo -u automata-agent python3 -c 'import requests'` (python3-requests
     is a box prerequisite of `dora_metrics.py`).
   - GitHub App prerequisite: the App's installation on the target org grants
     contents, metadata, pull_requests and issues READ (check the App settings /
     installation permissions page). Otherwise the read-token mint fails and DORA
     401s.
4. Checkout fast-forward as the service user:
   `runuser -u automata -- git -C /opt/automata-platform -c safe.directory=/opt/automata-platform fetch origin`,
   then `… merge --ff-only origin/main`. `H=$(git … rev-parse HEAD)` must equal
   `git ls-remote https://github.com/be-automata/automata refs/heads/main`.
   MANIFEST-DRIFT WINDOW OPENS HERE: the running worker (#240, 846c598)
   recomputes the manifest hash from this checkout, so from this ff until step 5
   writes the new manifest.sha256, orchestrated reviews log
   `batteries: unavailable … reason=manifest-drift` and run without packs (and
   from step 5 until step 6 the old worker's validator rejects the new `tools`
   key → `manifest-invalid`, same effect). Classic reviews and task runs without
   the setting are unaffected. Run step 5 immediately after step 4 and step 6
   right after step 5.
5. Installer as root from a root-owned copy of the verified commit:
   - `git … cat-file blob "$H:packages/worker/deploy/linux/install-batteries.sh" > /root/install-batteries.sh`
   - `AUTOMATA_REPO=/opt/automata-platform bash /root/install-batteries.sh 2>&1 | tee /root/install-batteries.$(date -u +%Y%m%dT%H%M%SZ).log`
   - Require: `${PIPESTATUS[0]}` = 0, `SOURCE checkout` = $H,
     `INSTALLED tool dart-sdk 3.13.5`, `INSTALLED tool somnio-cli 3.1.1`,
     `INSTALLED pack somnio-skills aa53f071…`,
     `VERIFIED agent tool somnio-cli (somnio v3.1.1; smoke ok)`,
     `VERIFIED agent tool dart-sdk (build-only, not traversable)`, every other
     VERIFIED line, and the last line `RESULT: PASS`.
   - Re-run once: every item SKIPPED. Record
     `cat /usr/local/lib/automata-batteries/manifest.sha256`.
   - A `FAIL verify …` is a script finding: keep the log, leave
     manifest.sha256.invalid, fix in a follow-up PR.
   - Adding `requires` to the somnio-skills entry changes its pack stamp, so a
     box that already had the pack re-stages it once. That is expected.
6. Worker restart (idle only):
   - Re-check step 3's idle test; then, unpiped,
     `cd /opt/automata-platform && CI=1 pnpm install --frozen-lockfile; echo "exit=$?"`.
     Require `exit=0`, and that `/opt/automata-platform/node_modules/.modules.yaml`
     exists and is newer than the ff (`stat`); else stop.
   - This runs the checkout's lifecycle scripts as root: the established worker
     deploy recipe (05-04), on the commit verified in step 4.
   - Then restart automata-worker.service. Confirm it booted (journal) and that
     NRestarts changed only by this restart.
7. www deploy (usual recipe; the build needs the NEXT_PUBLIC values +
   DATABASE_URL + placeholders). www needs step 1 first.
8. Set the setting for the target repo: Settings → Review → Task agent packs →
   Somnio skills, or `PUT /api/review-settings/<owner>/<repo>` with
   `{"taskBatteries":["somnio-skills"]}` as an org admin. Confirm the
   automation's thread has an organizationId; otherwise no taskAgent is shipped.
9. Re-run the target automation UNCHANGED (gstack browser with the operator's
   imported cookies). Do not edit the prompt first.
10. Evidence checklist (attach to the PR and 07-08-SUMMARY):
    - `bash packages/worker/deploy/linux/task-batteries-acceptance.sh box --since "<step 9 start>" --repo <owner/name>`
      → `ACCEPTANCE: PASS`, including `batteries: lane=task packs=somnio-skills manifest=<12hex>`
      with the prefix = manifest.sha256.
    - Transcript: `somnio --version` → `somnio v3.1.1`; Skill invocations of
      dora-metrics, react-health-audit and security-audit; thread status complete.
    - Egress: if the target repo has a per-repo egress allowlist, it must include
      api.github.com, otherwise DORA fails with a network error (not a 401).
      Re-check before the run.
    - DORA computes from GitHub in the UNCHANGED run: Deployment Frequency and
      Lead Time present in the transcript or final message, and NO
      "401 Unauthorized" from dora_metrics.py. The box journal shows
      `task agent: read-token=applied` for that thread, and www
      shows no `read token mint failed` line.
    - Reports produced = each report's CONTENT (DORA, react-health, security)
      quoted or summarised in the transcript or the final message. A branch is
      NOT a destination: reports/ is gitignored in the target repo, and the
      clone is deleted at run end.
    - somnio exit codes: record verbatim, NEVER as pass/fail evidence (v3.1.1
      `somnio run rh` returned 70 after "Audit completed successfully 13/13").
    - Review runs unaffected: the next PR review on any repo logs
      `run start: lane=review` + `batteries: mode=…`, posts exactly one review,
      and no `lane=task` line appears for it.
    - Record what failed or degraded, verbatim. Candidates: the read-only dora
      config, the report destination, model tier words. A DORA 401 now means the
      token was not delivered: check the two log lines above. Propose any prompt
      change to the operator with that evidence; never apply it silently.
      Rollback if needed: set Task agent packs back to Inherit/none.

**Acceptance script.** `task-batteries-acceptance.sh` is read-only on the box
and safe with runs in flight: no restart, no install, no repository write. Every
git call is hardened against the worker-writable checkout. Its last line is
`ACCEPTANCE: PASS` or `ACCEPTANCE: FAIL (<n>)`. On a developer checkout,
`bash packages/worker/deploy/linux/task-batteries-acceptance.sh local [--dry-run]`
runs the SC1-SC3 gates.

**Dry run for developers:**
`/bin/bash --noprofile --norc packages/worker/deploy/linux/batteries-dry-run.sh`
(network: github.com, storage.googleapis.com, pub.dev; never as root; commit
first, because it reads HEAD). The last line is `DRY-RUN-PROOF-OK`.

- On macOS arm64 the script pins the macos-arm64 3.13.5 SDK zip
  (sha256 cross-checked against the publisher's `.sha256sum`). The installer
  accepts that override only in a non-root dry run that names the host's own
  platform; as root it requires Linux x86_64 + linux-x64.
- The verified SDK zip is cached across dry runs (`BATTERIES_DOWNLOAD_CACHE`),
  and its sha256 is re-checked before every extraction.
- Linux x86_64 dev hosts use the exact production manifest.

**Bumping pins.**

- **Dart SDK:** the `url` comes from the dart-archive template for the new
  version/linux-x64, and the `sha256` from the publisher's `.sha256sum`
  (re-hash locally).
- **somnio commit:**
  1. Set the new `sha` and recompute every subpath `gitId` with
     `git rev-parse <sha>:<path>`.
  2. Regenerate and vet the lock as 07-01 Task 1 did: SDK-verified,
     hosted-only, every runtime row checked, no `hook/` dirs, compile proof.
  3. Update `lockSha256` and the deploy-assets lock table.
  4. Run the dry run, then the box steps above.
- **Output-shaping change:** bump `TOOLS_OUTPUT_VERSION` whenever
  `stage_dart_sdk`, `stage_dart_aot` or `write_wrapper` changes what lands on
  disk (RECORDED_TOOLS_OUTPUT pins it).
- **REMOVING a pack id** (from `batteries.json` and `BATTERY_PACK_IDS`): first
  clear every task_batteries / review_batteries value that references it, on
  every org and repo row (UI Restore default, or the routes). THEN ship the
  removal. Otherwise those task runs dispatch without packs (logged) until
  cleared.

**Rollback.**

- Set Task agent packs to Inherit/none: the worker seeds nothing, and no read
  token is minted.
- Code rollback: revert, then redeploy the worker and www.
- The installed tools may stay, because nothing reads them without the setting.
  Remove `/usr/local/lib/automata-batteries/{dart-sdk@*,somnio-cli@*,pub-cache,tools}`
  and `/usr/local/bin/somnio` by hand only with no run in flight.

**Known caveats.**

- dora's `config/projects.json` is read-only in the pack: copy it into the
  clone before editing.
- Report evidence is each report's CONTENT (DORA, react-health, security),
  quoted or summarised in the transcript or final message. A branch is NOT a
  destination: reports/ is gitignored in the target repo, and the clone is
  deleted at run end.
- somnio exit codes are recorded verbatim but are never pass/fail evidence
  (v3.1.1 `somnio run rh` returned 70 after "Audit completed successfully
  13/13").
- Agents should not run:
  - `somnio run`: it spawns nested claude processes, double-bills, and has
    30-minute steps;
  - `somnio skills install --project` in the clone: about 60 untracked files
    the agent may commit;
  - `somnio update`: it fails closed by design.
- Somnio skills and Somnio review both provide `security-audit`. If both are
  selected, the first in list order wins.
- Vendored agent files keep their `model: cheap|mid|frontier` tier words.
- python3-requests is a box prerequisite. The acceptance script checks it as
  the agent uid.

## Orchestrated review canary (phase 6)

**What it is.** In orchestrated mode the review agent works as a lead reviewer.
It fans out to sub-agents (security, correctness, tests, conventions) with the
seeded battery packs and the static CLIs, then consolidates their findings
itself. Exactly one review per push still comes from the platform (D2): the
lead emits one tagged `json review-intent` block and the control plane posts it.
Classic stays the default, and switching a repo is a per-repo Admin setting
(D1). The classic prompt bytes are pinned by sha in
`apps/www/src/server-lib/review/github-ops-review-mode.test.ts`, so a classic
repo receives exactly today's prompt.

**How the prompt is chosen.** The github-ops skill body carries review-mode
sections (`<!-- automata:if orchestrated -->` … `<!-- automata:endif -->`).
www renders them when it creates the thread, once per push, from the repo's
resolved review mode, and stamps orchestrated threads with
`sourceMetadata.reviewPromptMode = "orchestrated"`. Only stamped threads parse
the tagged block. Flipping a repo back to classic therefore restores today's
prompt on the next push.

**Deploy hazard.** A www older than this phase does not know the section markers
and serves a marker-bearing body verbatim, orchestrated text included, to every
repo that uses it. The order below exists because of that: the www deploy comes
before the skill push, the push goes to the canary repo only, and a rollback
must revert the skill version first, then roll back www.

**Preconditions.**

- Phase 5 is live on the box. The staged daemon has `--max-turns` and the
  background sub-agent result hold (`packages/daemon/src/adapters/result-hold.ts`):
  `grep -c -- '--max-turns' /usr/local/automata/daemon/index.js` ≥ 1 and
  `grep -c createResultHold /usr/local/automata/daemon/index.js` ≥ 1. (An
  earlier draft named `holdResultAfterBackgroundTask`, which never existed, so
  that grep always printed 0.) Box-mode acceptance (step 7) checks both as
  `CHECK box staged daemon`.
- Batteries are installed: `cat /usr/local/lib/automata-batteries/manifest.sha256`
  prints a 64-hex hash, and there is no `manifest.sha256.invalid`.
- This phase has no schema change, so there is no new `assert-schema-ready`
  entry. Still run `DATABASE_URL=... pnpm exec tsx deploy/assert-schema-ready.ts`
  before the www deploy, as AGENTS.md requires.

**Rollout (operator).** Each step is gated on the previous one. Nothing here is
run by an agent.

1. Merge the PR.
2. www deploy with the usual recipe. Confirm the new deployment is live:
   `wrangler deployments list` must show a deployment created after the merge
   time. The new renderer and parser MUST be live before step 3. No worker
   deploy is needed unless 06-04 Task 2 (copying agent files instead of
   symlinking) shipped in the same PR; in that case deploy the worker per the
   05-04 rollout notes before step 5.
3. Prepare the canary repo's skill:
   - In the dashboard skill panel, record the canary repo's CURRENT github-ops
     version id. It is the rollback target.
   - Confirm the repo has no `.automata/skills/github-ops.md` on its default
     branch. Tier 0 would shadow the pushed body.
   - Push the new body to the CANARY repo ONLY. If the current body is the seed
     composition (it starts with "A pull request was opened or updated in"), run
     `DATABASE_URL=... pnpm exec tsx deploy/seed-pilot-mirror.ts <orgSlug> <owner/repo> --dry-run`.
     The only expected diff is a new github-ops skill version. Then run the same
     command without `--dry-run`. If the current body is the raw SKILL.md body (it
     starts with "# GitHub PR Review (emit-only)"), run
     `DATABASE_URL=... pnpm exec tsx deploy/skill-push.ts <orgSlug> <owner/repo> github-ops deploy/skills/github-ops/SKILL.md`.
     Either way the body keeps its shape and its classic render is unchanged.
4. In Admin → Review, set the canary repo's review mode to Orchestrated with
   tests OFF and all three packs (gstack-review, gsd-reviewers, somnio-review).
   Leave the timeout and max turns inherited.
5. On the box, note `systemctl show -p NRestarts --value automata-worker.service`
   and `date -u` as T0.
6. Push one commit to an open SAME-repo PR on the canary. Include a shell script
   or workflow change so a CLI has something to say. Trigger with a PUSH,
   never a bot mention: mentions run the github_mention lane.
7. Wait for the review (at most 30 minutes). Then collect the evidence:
   - Take a root-owned copy of the acceptance script, the same way as the phase 3
     installer, because the checkout is worker-writable. As root, first confirm
     nothing is in flight:
     `ls -d /sys/fs/cgroup/system.slice/automata-worker.service/run-* 2>/dev/null | wc -l`
     must print 0. Never mid-review: wait otherwise. Then run
     `runuser -u automata -- git -C /opt/automata-platform -c safe.directory=/opt/automata-platform fetch origin`
     and
     `runuser -u automata -- git -C /opt/automata-platform -c safe.directory=/opt/automata-platform merge --ff-only origin/main`.
     Stop on divergence; never force.
     `H=$(git -C /opt/automata-platform -c safe.directory=/opt/automata-platform rev-parse HEAD)`
     must equal the sha printed by
     `git ls-remote https://github.com/be-automata/automata refs/heads/main`.
     Then run
     `git -C /opt/automata-platform -c safe.directory=/opt/automata-platform cat-file blob "$H:packages/worker/deploy/linux/orchestrated-review-acceptance.sh" > /root/orchestrated-review-acceptance.sh`.
     This needs no worker restart and no install, because the script only reads.
   - As root on the box:
     `bash /root/orchestrated-review-acceptance.sh box --since "<T0>" --repo <owner/repo> --pr <n> --expect orchestrated`
     must end with `ACCEPTANCE: PASS`.
   - From the laptop:
     `bash packages/worker/deploy/linux/orchestrated-review-acceptance.sh github --repo <owner/repo> --pr <n> --head-sha <pushed sha> --since <T0 as YYYY-MM-DDTHH:MM:SSZ> --bot <bot login>`
     must end with `ACCEPTANCE: PASS`.
   - Walk the printed `EVIDENCE manual` checklist in the thread view and the
     daemon log. Record the latency, the cost (thread usage) and the verdict.
8. If init `agents` lacks gsd-code-reviewer or gsd-security-auditor while
   `skills` has gstack-review, symlinked agent FILES do not load. Execute
   06-04 Task 2 (the copy fix), deploy the worker, then redo steps 6-7.
9. Flip back. Set the repo's review mode to inherit/Classic, note T1, and push
   again. Then run
   `bash /root/orchestrated-review-acceptance.sh box --since "<T1>" --repo <owner/repo> --pr <n> --expect classic`
   and the github mode again with the new head sha and T1. Confirm that the new
   thread's first message has no "## Orchestrated review — you are the lead
   reviewer" heading and that its sourceMetadata has no reviewPromptMode.
   NRestarts must be unchanged throughout.

**Rollback.**

- Mode: set the repo to Classic in the UI. This is instant and applies from the
  next push.
- Prompt: revert the canary's github-ops skill to the recorded version in the
  dashboard skill panel (revertSkillToVersion). Classic bytes are identical, so
  this is only needed if the new body itself misbehaves.
- Code: always revert the skill version first, then roll back www. An older www
  would serve the section markers and the orchestrated text verbatim.

**Widening (not part of this phase).** Compare verdicts, latency and cost on the
canary for a week before enabling tests or other repos (EPIC Rollout).

**Evidence for the PR / UAT.** Attach both `ACCEPTANCE: PASS` outputs, the
answers to the manual checklist, the GitHub review URL, the latency and the
cost.

**Developer gate.** On a checkout,
`bash packages/worker/deploy/linux/orchestrated-review-acceptance.sh local`
runs the www server-lib suite, the drift-test-unchanged check, www tsc and the
script's own tests.

## Audit self-healing loop — audit to issues (phase 8)

The audit lane turns a scheduled repository audit into GitHub issues. The agent emits one tagged
findings block and writes nothing; the control plane parses it, decides, persists and is the only
writer (ADR-010). Everything ships OFF and in dry-run first. Nothing here is run by an agent.

**Rollout (operator, in this order; each step is gated on the previous one).**

1. Production is never migrated by CI. BEFORE merging or deploying anything, push the schema to
   production by hand from the PR head: `DATABASE_URL=<prod> pnpm -C packages/shared exec drizzle-kit push --config drizzle.config.ts`.
   Read the statement list first: it must add tables and nullable columns and contain no DROP.
   This one push covers the phase 8 tables and settings columns AND the phase 9 columns. The prod
   URL is a write-only Worker secret; obtain it out of band.
2. Gate the deploy on it: `DATABASE_URL=<prod> pnpm exec tsx deploy/assert-schema-ready.ts` must
   exit 0 with no MISSING line. It fails closed on an unset URL or an unreachable database.
3. Merge the PR.
4. Deploy www with the usual recipe. Confirm the new deployment is live: the deployed `BUILD_ID`
   must match the merge commit's build, and `wrangler deployments list` must show a deployment
   created after the merge time. Probe the webhook: an unsigned
   `curl -s -o /dev/null -w '%{http_code}' -X POST <www>/api/webhooks/github` must print 401.
5. Deploy the worker ONLY on an idle box. As root, `ls -d /sys/fs/cgroup/system.slice/automata-worker.service/run-* 2>/dev/null | wc -l`
   must print 0; never restart mid-review (a wedged restart costs about 35 minutes), and note
   `systemctl show -p NRestarts --value automata-worker.service` before and after.
6. Turn the global flag on: set the `selfHealLoop` feature flag in Admin → Feature flags. With the
   repo mode still `off` nothing happens.
7. Push the audit skill per repo, canary repo only first. Record the repo's current audit-findings
   version id as the rollback target, then
   `DATABASE_URL=<...> pnpm exec tsx deploy/skill-push.ts <orgSlug> <owner/repo> audit-findings deploy/skills/audit-findings/SKILL.md`.
8. Create the scheduled automation for the canary repo that runs the audit-findings skill (the
   audit-findings skill name must be the automation's skill). Keep the run window
   (default 02:00-06:00) so audits stay off review hours.
9. In Admin → Review → Self-heal, set the canary repo's mode to `dry-run`. Leave every other field
   inherited. Do not set `on` in this phase.

**Pre-flight checklist (no fix loop yet).**

- The org kill switch is OFF but reachable: you know where the Drain button is (Admin → Review →
  Self-heal → Activity).
- GitHub App permissions on the canary: issues write, contents read, metadata read. A missing
  permission trips the permission latch and the run reports `missing-permission` instead of writing.
- Branch protection is optional (a free-plan private repo cannot have it) and never gates the lane: it never pushes in phase 8, and in phase 9 the git-broker ref fence plus the human merge keep main safe.
- No other automation or person depends on the labels below.

**Labels** (created on first use by the writer): `automata:finding`, `automata:auto-fix`,
`needs-human-approve`, `automata:wontfix`, `automata:paused`, and `audit:<name>`. The lane NEVER
applies `bug` or `enhancement`.

**SLOs.**

| SLO   | Objective                                                                                                                                          |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| SLO-1 | Review p95 queue+run during self-heal windows is at most baseline + 5 min; zero reviews killed by `executionTimeout` while waiting at the box lock |
| SLO-2 | The writer applies all decisions within 15 min of audit finish (finish hook plus the `*/10` drainer)                                               |
| SLO-3 | Zero duplicate issues per fingerprint                                                                                                              |
| SLO-4 | Zero agent-authored GitHub writes                                                                                                                  |

**Dry-run exit criteria** (all must hold on the canary before anything is switched on):

- at least 3 (≥ 3) COMPLETE dry-run audits;
- zero unparseable runs;
- fingerprint churn at most 10% between consecutive complete runs (the Activity view highlights
  chips over 10%);
- every `would_create` has been read by the operator and judged a real, correctly worded finding;
- zero `automata:finding` issues exist on GitHub (dry-run writes nothing).

Evidence: `bash packages/worker/deploy/linux/self-heal-acceptance.sh local` (developer gate),
`... box --since "<time>"` as root on the box (read-only; checks the platform checks ran and posted
before the daemon spawned and that no journal line carries the check token), and
`... github --repo <owner/repo> --since <YYYY-MM-DDTHH:MM:SSZ> --bot <login>` from the laptop (GETs
only; checks authorship, one issue per fingerprint, marker on line 1, no closing keyword or
mention, label hygiene, no duplicate comment marker). Each ends `ACCEPTANCE: PASS`.

**Retention** (the cron prunes; pending rows are never pruned):

| Rows                                       | Kept for |
| ------------------------------------------ | -------- |
| Applied or failed outbox effects           | 30 days  |
| Breaker events                             | 30 days  |
| Finished audit runs (with their decisions) | 90 days  |

**Reading the settings actor log.** Every accepted change to the self-heal fields writes one row
with the actor, the scope (`*` or the repo) and the FIELD NAMES changed, never the values of
secrets (there are none). Admin → Review → Self-heal → Activity shows the last 20 entries per
repo; `GET /api/self-heal/<owner>/<repo>?format=export` (org admin) returns the runs, ledger,
effects and attempts for offline review (capped at 500).

**Stop, Drain, bulk-clean, rollback, re-arm.**

- Stop (instant, writes nothing further): set the org kill switch on the org default row, or turn
  the `selfHealLoop` flag off. Both turn the next decision into outcome `killed`.
- Drain (Admin → Review → Self-heal → Activity, org scope): sets the kill switch FIRST, then
  cancels live self-heal runs. Use it when an audit is misbehaving right now. A breaker banner has
  its own Reset button; reset only after the cause is understood.
- Bulk-clean (only if issues were filed that should not exist): with the switch on, list with
  `gh issue list --repo <owner/repo> --label automata:finding --state open --json number`, review,
  then close them yourself with a comment. Do not delete ledger rows by hand.
- Rollback order, always in this order: flag off → disable the audit automations → revert the
  audit-findings skill version in the dashboard skill panel → revert www → roll back the worker
  (idle box only). An older www would not understand the stamped runs.
- Re-arm: clear the kill switch, turn the flag on, set the repo back to `dry-run` and repeat the
  exit criteria before `on`. A tripped breaker needs its Reset.

## Audit self-healing loop — fix loop (phase 9)

The fix loop lets the platform try to fix a filed finding. One agent run per attempt pushes one
`automata/fix-*` branch through the fenced git broker. The worker runs the finding's deterministic
check on the pushed sha. The platform opens a DRAFT PR, waits for the repo's CI gate, marks the PR
ready (which triggers exactly one review), and a person merges. Nothing in the lane merges
(ADR-010 part 2, ADR-004 phase 9 amendment). Everything ships OFF. Nothing here is run by an agent.

Phase 9 adds no column: the phase 8 push already created every table and column it uses. Its one
schema change is a single index, `audit_fix_attempts_pr_repo_lower_index` on
`(pr_number, lower(repo_full_name))`, which serves the platform-wide fix-PR lookup on
`pull_request.closed`. The schema gate fails only on columns; a missing or invalid index is a
performance gap, not a correctness failure, so the gate prints a WARN for it and still exits 0. It is
still created before the deploy (step 2). Still run the schema gate before each deploy.

**Rollout (operator, in this order; each step is gated on the previous one).**

1. Schema gate: `DATABASE_URL=<prod> pnpm exec tsx deploy/assert-schema-ready.ts` must exit 0 with
   no MISSING line. If it fails, stop: phase 8's push has not been applied.
2. Create the index on prod, non-blocking, BEFORE the worker-first deploy (idempotent):

   ```sql
   CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_fix_attempts_pr_repo_lower_index ON audit_fix_attempts (pr_number, lower(repo_full_name));
   ```

   Run it on its own (CONCURRENTLY cannot run inside a transaction), then verify it is valid:

   ```sql
   SELECT indexdef FROM pg_indexes WHERE indexname = 'audit_fix_attempts_pr_repo_lower_index';
   SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'audit_fix_attempts_pr_repo_lower_index';
   ```

   The definition must read `(pr_number, lower(repo_full_name))` and `indisvalid` must be `t`. An
   interrupted CONCURRENTLY build leaves an INVALID index that `IF NOT EXISTS` does not repair: run
   `DROP INDEX CONCURRENTLY audit_fix_attempts_pr_repo_lower_index;` and the CREATE again. Note:
   `drizzle-kit push` re-creates this expression index on every run (it cannot match the
   introspected expression) as a plain DROP + CREATE. That is harmless on dev and test databases; on
   prod use the statement above, never a push.

3. Merge the PR. The `selfHealLoop` flag stays OFF and every repo mode stays `off` or `dry-run`.
4. Deploy the worker first, then www. An older worker has no ref fence: a fix run on it would hand
   the agent an unfenced push path. Deploy the worker ONLY on an idle box (the phase 8 idle check:
   0 `run-*` cgroups, NRestarts noted before and after). Confirm `WORKER_CREDENTIAL_BROKER=on` on
   the box; a fix run refuses to start without the broker.
5. Deploy www with the usual recipe and confirm the new `BUILD_ID` and the 401 webhook probe, as in
   phase 8.
6. Only now may the flag or a repo mode be changed. Until BOTH halves run phase 9, keep the flag off
   and the mode off or `dry-run`.
7. Push the fix skill per repo, canary first. Record the current audit-fix version id as the
   rollback target, then
   `DATABASE_URL=<...> pnpm exec tsx deploy/skill-push.ts <orgSlug> <owner/repo> audit-fix deploy/skills/audit-fix/SKILL.md`.
8. Automations (Settings → Automations), per repo:
   - exactly ONE audit-fix automation: trigger "issue", labelled-only (`on.labeled` with
     `filter.labels: ["automata:auto-fix"]`, no `on.open`), action = the audit-fix skill. The
     validator rejects any other shape, so an older www can never fire it;
   - a PR review automation that matches bot-authored PRs: `on.open` with `includeAllAuthors`, or the
     bot login in `otherAuthors` (REV-01). Without it the dispatcher refuses with
     `no_review_automation` and a ready fix PR would get no review;
   - `reviewDraftPrs` stays false, so drafts are not reviewed. The ready transition is the review
     trigger;
   - the "Mirror: issue research" automation has `filter.excludeLabels: ["automata:finding"]`, so a
     filed finding starts no research run.
9. Turn `autoLabel` ON for the pilot repos (Admin → Review → Self-heal) (AUTO-01). The live cycle is
   proven with the platform's own `automata:auto-fix` label; a hand-added label is not the proof.
10. Turn the `selfHealLoop` flag on, keep the canary in `dry-run` until the pre-flight checklist
    holds, then set it to `on`.

**Pre-flight checklist for On.**

- GitHub App permissions on the repo: pull_requests write, contents write, issues write,
  checks read, actions read, metadata read. A missing permission latches and the lane refunds
  `missing-permission` instead of writing.
- Branch protection is OPTIONAL. Record its state and the resulting CI gate source, never require
  it: `protection` (required checks), `all-checks` (no protection, or unreadable on a free plan:
  every check run and commit status must be green, with a 2-minute settle window), or
  `finding-check-only` (no check appears within 10 minutes: the PR gets `needs-human-approve` and a
  no-repo-CI note). The activity card shows the gate source per attempt.
- The box is on the credential broker and was deployed before www (step 4).
- Linux box: the post-agent `git clean -ffdxq` runs as the agent uid and must be able to delete the
  run-owned `home/`, `gh-config/` and `tmp/` in the checkout. An ACL mask that blocks it fails every
  check closed with `self-heal fix-check: clean of the checkout failed`, which shows in the journal
  only. Verify it on the first live drill.
- No other automation or person pushes to `automata/fix-*` branches.
- You know where Drain is, and the org kill switch is OFF but reachable.

**SLOs.** The phase 8 SLOs apply unchanged (review p95 within baseline + 5 min during self-heal
windows, zero reviews killed at the box lock, writer within 15 min, zero duplicate issues, zero
agent-authored GitHub writes), plus: zero PRs merged by the bot, at most one open fix PR per
issue, and exactly one review per ready fix PR.

**Metrics.** The activity card and `?format=export` show the same numbers, computed by
`computeSelfHealMetrics`. Its definitions, verbatim from `packages/shared/src/self-heal/metrics.ts`:

```text
- prsOpened: attempts that opened a PR (pr_number is set).
- ready: attempts whose PR was marked ready for review (ready_at is set).
- merged: attempts whose PR was merged (pr_state merged or merged_at set).
- mergedByNonTrigger: merged PRs whose merged_by login is known and is not
  one of the trigger logins (the platform bot, and the GitHub login of the
  owner of the repo's audit-fix automation). Logins compare without case.
  A merge with an unknown merger is not counted.
- decided PRs: opened PRs whose pr_state is merged, closed or expired. A PR
  that is still a draft or ready has no outcome yet and is left out.
- mergeRate: mergedByNonTrigger / decided PRs.
- mergeRateBasis: "bot-and-owner" when the owner's login was known and
  excluded, "bot-only" when only the bot login was (the owner lookup failed
  or there is no audit-fix automation). Read a bot-only rate as an upper
  bound: the owner's own merges count as human merges there.
- humanEditRatio: among merged PRs whose human_commit_count is known, the
  share with at least one human commit after the gated head.
- reopenRate: among merged PRs whose 30-day regression window is complete
  (regression.windowComplete), the share whose finding was reopened.
- regressionRate30d: over the same set, the share that was reverted or got
  a non-bot follow-up commit touching the merged lines.
- meanAttemptsToClose: mean of the counted attempts (audit_findings.attempts,
  refunds excluded) over resolved findings with at least one attempt.
- expiredRate: decided PRs that expired unreviewed / decided PRs.
- refunded: attempts refunded for an infrastructure cause (infra_refunded).
- counted: finished attempts (phase closed) that were not refunded. Attempts
  still in flight are neither refunded nor counted.
- admissionDeferrals: self-heal runs for the repo that review-first
  admission deferred in the last 30 days (passed in by the caller).

Every rate is null when its denominator is zero.
```

A `bot-only` merge rate is an upper bound. `admissionDeferrals` counts only deferrals recorded after
this phase is deployed.

**Log lines.** www: the tick logs `[cron:self-heal] fix reconcile`, `fix draft opens`,
`fix draft CI`, `fix PR settle`, `breakers` and `fix dispatcher`; the hourly run logs
`[cron:self-heal] fix PR expiry …` and `[cron:self-heal] fix regressions …`. Decisions keep the
`[self-heal] v=1 …` layout; breakers log `[self-heal:breaker] transition` and
`[self-heal:breaker] LOOP_OPEN`. Box: fix runs start with `run start: lane=self-heal-fix`, the check
logs `self-heal fix-check: …`, and a refused push logs `git-broker: ref fence refused push (…)`.

**Cycle evidence (one full cycle on the canary).** Each command ends `ACCEPTANCE: PASS`.

- `bash packages/worker/deploy/linux/self-heal-acceptance.sh local` (developer gate).
- On the box, as root (read-only):
  `... box --since "<time>" --expect-fix`. Every `lane=self-heal-fix` run logs its
  `self-heal fix-check:` line after the terminal thread poll and before `box lock released`; no
  journal line carries the gate token header or field; ref-fence refusals are listed as EVIDENCE.
- From the laptop (GETs only):
  `... github --repo <owner/repo> --since <YYYY-MM-DDTHH:MM:SSZ> --bot <login> --expect-fix`. On top
  of the phase 8 checks: fix PRs are bot-authored, were drafts before ready, were readied only after
  the gate source's checks succeeded on the gated head, say `Fixes #<ledger issue>`, at most one is
  open per issue, none was merged by the bot, every ready PR has exactly one bot review at its gated
  head, and every default-branch commit since `--since` reached the branch through a PR merged by a
  non-bot. Branch protection is reported as `INFO` and never fails the run.

**Known gaps (by design or accepted).**

- PR expiry runs even while `loop_fix` is open: withdrawing a stale PR only narrows the loop.
- A failed GitHub close on expiry leaves the PR open while the attempt is recorded expired. Nothing
  retries the close. Close the PR by hand (the `fix PR expiry close failed` log line names it).
- A failed regression read still counts as that day's check (the 24 h recheck is stamped to bound
  API use); that day's signal is lost.
- Follow-up matching uses GitHub's diff hunks, which include 3 context lines on each side; a false
  positive only stops the loop.
- A `pull_request.reopened` on a counted fix PR is not handled; a later merge is still recorded.

**Stop, Drain, bulk-clean, rollback (ROLL-01), re-arm.**

- Stop: org kill switch or the `selfHealLoop` flag off, as in phase 8. In-flight drafts are refunded
  with no GitHub call and stay open for a person.
- Drain (Admin → Review → Self-heal → Activity, org scope) sets the kill switch first, then cancels
  live audit AND fix runs.
- Bulk-clean (only if the lane produced PRs that should not exist), with the switch on:
  list drafts and PRs with `gh pr list --repo <owner/repo> --state open --search "head:automata/fix-"`,
  review, then close them yourself with a comment; list leftover branches with
  `gh api "repos/<owner/repo>/git/matching-refs/heads/automata/fix-"` and delete only those whose
  PR is closed. Do not delete ledger rows by hand.
- Rollback order, always in this order: `selfHealLoop` flag off → disable the audit-fix and audit
  automations → Drain → revert www → revert worker (idle box only). Disabling the automations before
  the revert keeps an older www from firing anything; the labelled-only shape already prevents it.
- Re-arm: clear the kill switch, turn the flag on, set the repo to `dry-run`, and walk the
  pre-flight checklist again before `on`. A `paused_manual` breaker needs its attributed Reset.

**Pilot repo 2 exit criteria** (all must hold before the fix loop is armed on pilot repo 2):

- one full cycle closed on the canary pilot (finding → label → fix → draft → CI → ready → one
  review → human merge), with both acceptance runs at `ACCEPTANCE: PASS`;
- zero duplicate issues and zero duplicate PRs;
- review p95 within baseline + 5 min over the cycle;
- written sign-off on the notifications and the labels;
- at least 1 week (≥ 1 week) of dry-run on pilot repo 2.

### Benchmark and quarterly anchor (phase 9)

The benchmark measures the whole loop on a fixture with known answers: 48 seeded script-rule findings
(6 for each script rule), 4 rubric-only seeds and 8 negative-control decoys (SHA-pinned actions,
workflows with top-level permissions). Each seed has a hidden regression test kept outside the fixture
repo. The core lives in `packages/shared/src/self-heal/bench/`, the CLIs in `deploy/self-heal-bench/`
(each has a usage header). Run it LAST, after the canary cycle above.

**Safety.** The fixture declares deliberately vulnerable npm versions and fake secrets (every fake file
says `BENCHMARK FAKE — not a secret`). Push it ONLY to a PRIVATE fixture repo in the org; never run
the benchmark against the public pilot repo. Nothing is installed in this repo: the fixture's root
lockfile is generated once inside the fixture checkout. The fixture must be private for another
reason too: on a public repo the secret and sensitive-file rules are filtered and never filed.

**Shards (the per-run cap).** `MAX_FINDINGS_PER_RUN` is 25 and `maxOpenIssues` is at most 20. An
audit that reports all 52 planted findings drops the rest as `over_cap`, and an over-cap run is
incomplete, so it records no sightings at all. The benchmark therefore runs on the three shards of
`BENCH_SHARD_PLAN` (`packages/shared/src/self-heal/bench/seed-catalog.ts`), each with at most 20
non-decoy seeds (a test pins that). Every seeded seed and every decoy is in exactly one shard; the 4
rubric seeds are in all three, because every shard lacks that review automation. A shard renders only
what it seeds, so its audit has nothing unscored to report. Generate one directory per shard:

```bash
pnpm exec tsx deploy/self-heal-bench/generate-fixture.ts --seeds S01-S16,S49-S54 <dir>/shard-1
pnpm exec tsx deploy/self-heal-bench/generate-fixture.ts --seeds S17-S32,S49-S52,S55-S56 <dir>/shard-2
pnpm exec tsx deploy/self-heal-bench/generate-fixture.ts --seeds S33-S52,S57-S60 <dir>/shard-3
```

Run Setup, Phase A and Phase B below once per shard, each with that shard's own fixture repos and its
own `manifest.json` (`<dir>` below means the shard directory), and keep one report per shard. Raising
the per-run cap instead would be a separate reviewed change; record which way was used with the
results. `maxOpenIssues` 20 only limits throughput: issues are filed as earlier ones close.

**Setup (once per fixture repo).**

1. Generate the shard (commands above). The output is byte-identical on every run.
   `<dir>/hidden-tests/` and `<dir>/manifest.json` stay on the operator machine; only `<dir>/repo/`
   is pushed.
2. Create a PRIVATE repo, push `repo/` as the initial commit of `main`, then in that checkout run
   `npm install --package-lock-only --ignore-scripts` once (it resolves the pinned versions into
   `package-lock.json` without installing anything) and commit the lockfile.
3. Install the GitHub App on it and give it the same automations and settings as the pilot: the
   audit automation, exactly one labelled-only audit-fix automation, a PR review automation that
   matches bot-authored PRs, `reviewDraftPrs` false, and the research mirror excluding
   `automata:finding`. Push the audit and audit-fix skills as for the pilot.
4. Size the caps for the seeds: `maxOpenIssues` 20 (the maximum), `maxAttempts` 2, `minSeverity`
   `low` (so no seed is filtered by the agent's severity), `autoLabel` ON for the loop phase. Set
   `runWindow` to off-hours: the bench runs behind the same review-first admission gate, so it never
   competes with a pilot review.

A ledger is keyed by repo name and ledger rows are never deleted by hand, so "reset" means a fresh
private repo from the same generated output: one repo for the calibration and one per loop run.

**Phase A — consensus calibration (R3): 5 audit-only runs on a frozen commit.**

1. Set the calibration repo to `dry-run` and freeze it (no pushes until the phase ends).
2. Run 5 audits one after another. After each one, save the export:
   `BENCH_WWW_URL=<www> BENCH_SESSION_COOKIE='<admin cookie>' pnpm exec tsx deploy/self-heal-bench/collect.ts --repo <owner/fixture-cal> --out audit-<n>.json`.
   The cookie is the Cookie header of a signed-in org-admin session whose active organization owns
   the fixture repo. It is read from the environment only and never printed or written.
3. Section scores are not stored on `audit_runs`. Copy each run's `sections` array from its
   audit-findings block into `sections.json`, one entry per run, oldest first.
4. Score the calibration:
   `pnpm exec tsx deploy/self-heal-bench/score.ts --manifest <dir>/manifest.json --audit-only audit-1.json,...,audit-5.json --section-scores sections.json`.
   Read `calibration.perSeed`: `detectedIn` (out of 5) and `wouldFileAt2of3` per seed. Every decoy
   should have `wouldFileAt2of3: false`. `perSectionScoreSpread` gives the score spread per
   section.

**Phase B — 3 loop runs.**

1. For each run, use a fresh private fixture repo with the mode `on`. Let the loop run (audit → issue
   → fix → draft → CI → ready → review). A person merges only PRs whose review passed, without
   editing them, until no finding is ready and no fix PR is open (or after a fixed window you record).
2. Collect: `collect.ts --repo <owner/fixture-rN> --out loop-<n>.json`.
3. Verify:
   `pnpm exec tsx deploy/self-heal-bench/verify-fixes.ts --repo <owner/fixture-rN> --manifest <dir>/manifest.json --hidden <dir>/hidden-tests --export loop-<n>.json --out verify-<n>.json`.
   It is read-only on GitHub (`gh api` GETs and one clone into `$TMPDIR`, deleted on exit). Hidden
   tests import PR-head code written by the fix agent, so run it on a disposable machine if in
   doubt. The child processes get a scrubbed environment.
4. Score everything:
   `pnpm exec tsx deploy/self-heal-bench/score.ts --manifest <dir>/manifest.json --loop loop-1.json,loop-2.json,loop-3.json --audit-only audit-1.json,...,audit-5.json --verification verify-1.json,verify-2.json,verify-3.json [--costs c1,c2,c3] [--section-scores sections.json]`.
   Costs are optional: one total per loop run, reported only and never a threshold.
   Keep the reports in the private ops notes, not in this public repo.

**Metric definitions**, verbatim from `packages/shared/src/self-heal/bench/score.ts` (the
production metrics keep the definitions quoted above and pass through as `productionMetrics`):

```text

- issues: findings with an issue number (filed issues).
- precision: issues matching a seeded or rubric seed / issues. Issues
  matching a decoy, or no seed at all, are false positives. A duplicate
  issue of a true seed still counts as a true positive here.
- recall: seeded seeds with at least one issue / seeded seeds.
  rubricRecall: the same over rubric seeds.
- duplicateRate: issues whose seed already had an earlier issue in the same
  run / issues.
- attempts: fix attempts not refunded for an infrastructure cause
  (infra_refunded), attempts still in flight included. Refunded attempts
  are reported apart and excluded from every fix rate. The production
  metric `counted` is narrower (finished attempts only).
- fixPassRate: attempts that reached ready (ready_at set: the draft passed
  the amended gate and was marked ready) / attempts. reachedReady leaves
  refunded attempts out; the production metric `ready` counts them.
- hiddenRegressionRate: verified fix PRs whose seed's hidden test failed
  on the PR head / verified fix PRs (hidden test passed or failed).
- cheatRate: attempts whose guard reasons include one of
  CHEAT_GUARD_REASONS (suppression_comment, test_edit, ci_edit,
  audit_config_edit, denied_path), or whose PR diff verify-fixes found
  suppression markers in / attempts.
- falseClosureRate: resolved findings matching a seed whose final check on
  the default branch fails / resolved findings matching a seed with a
  final check outcome of pass or fail.
- meanAttemptsToClose: the export's meanAttemptsToClose definition (mean
  counted attempts over resolved findings with at least one attempt),
  pooled over the loop runs: summed attempts over summed findings, not the
  mean of each export's own value.
- costPerClosedFinding: total cost / resolved findings. Reported only,
  never a gate or a threshold; null without cost input.
- productionMetrics: each loop export's `metrics` object, unchanged.

Calibration (calibrateConsensus): the complete audit-only runs, deduped by
id and ordered oldest first. A seed is detected in a run when the run's
decisions record one of its fingerprints as seen (candidate, or sighting
with reason "seen"). wouldFileAt2of3 replays consensus over the first
CONSENSUS_WINDOW runs exactly as the audit lane does: a newest-first
window of CONSENSUS_WINDOW sightings with at least CONSENSUS_QUORUM seen.
perSectionScoreSpread gives n, min, max and the population standard
deviation of each section's score across the runs that reported one.
```

**Quarterly external anchor.** Once a quarter (first week of the quarter), the platform operator
runs about 50 fresh tasks from SWE-rebench and the TypeScript subset of SWE-PolyBench through the
task-run lane, one private scratch repo per task at the task's base commit, and records the
resolved rate (the task's own tests), mean attempts and cost next to the previous quarter. Use only
tasks published after the model's training cutoff. Do not use SWE-bench Verified: it is saturated
and its tasks are likely in training data, so it no longer separates real gains from memorisation.
Results stay in the private ops notes.
