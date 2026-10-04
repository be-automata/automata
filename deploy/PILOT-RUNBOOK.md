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
