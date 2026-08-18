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

| | shadow | active |
|---|---|---|
| Webhook ingested | yes | yes |
| Thread/task row created (org-stamped, dashboard-visible) | yes | yes |
| `thread.shadow` flag (UI can badge) | `true` | `false` |
| Sandbox boot / agent run | **no** | yes |
| GitHub side effects (comments, checks, reviews, eyes reaction) | **none** | yes |
| Billing-link comment for no-access users | suppressed | posted |

Implementation seams:

- **Resolution** — `getInstallationOrgAndMode({ db, installationId })`
  (`packages/shared/src/model/github-installation.ts`) returns `{ organizationId,
  mode }` in one read. **No row → `active`** (migration-safe: an installation
  that predates the binding table keeps working). A *new binding* defaults to
  `shadow` (safe onboarding); shadow is therefore always opt-in per binding,
  never a side effect of an installation being unknown.
- **Ingest gate** — `handleAppMention` derives the mode once, suppresses the
  eyes reaction + billing comment when shadow, and passes `shadow` down to
  `newThreadInternal` → `createNewThread`.
- **Boot suppression** — `createNewThread` stamps `thread.shadow` and, when
  shadow, returns without scheduling `startAgentMessage` (no boot). As a
  belt-and-suspenders systemic guarantee, `queueFollowUpInternal` also refuses
  to drain the follow-up queue for a shadow thread, so a *second* mention on an
  already-shadow thread still never boots the agent.

### The deployment-level kill-switch (defense in depth)

Per-installation shadow mode has one gap: between wiring the pilot webhook and
running the bind step, an event from a *resolvable* sender resolves to `active`
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

| # | Event class | Prod skill (intent) | Chassis today | Gap → plan |
|---|---|---|---|---|
| 1 | `pull_request.opened` | github-ops (PR review) | `handlePullRequestUpdated` runs a PR **automation** only if a user created one (`on.open`); else PR-status DB update — **no task** | **Seeded automation** (`on.open`, `includeAllAuthors`, shadow-aware) → "Review PR" for every PR |
| 2 | `pull_request.synchronize` | github-ops | PR automation only, `on.update` | Same seeded automation (`on.update`) |
| 3 | `pull_request.review_requested` | github-ops | **Not handled** (action absent from route) | **Mirror-intake** → "Review PR #N (review requested)" |
| 4 | `pull_request.closed` (merged=true) | github-pr-merged-jira | `handlePullRequestStatusChange` → status DB update only, **no task** | Mirror-intake, `merged===true` only → "Post-merge follow-up for PR #N" |
| 5 | `pull_request_review.changes_requested` | github-ops (re-review) | `handlePullRequestReviewEvent` fires only on `submitted` **and** is mention-gated; state not inspected → **no task** | Mirror-intake, `review.state==="changes_requested"` → "Address changes requested on PR #N" |
| 6 | `workflow_run` failure | gh-fix-ci | **Not handled** (event absent from route) | Mirror-intake, new `workflow_run.completed` sub, `conclusion==="failure"` → "Fix CI: run '<name>' failed" |
| 7 | `issues.opened` | github-deep-research | `handleIssueEvent` runs an issue **automation** only if a user created one (`on.open`); else **no task** | **Seeded automation** (`on.open`, `includeAllAuthors`, shadow-aware) → "Research issue" |
| 8 | `issues.labeled` [`bug`\|`enhancement`] | github-ops | **Not handled** (only `issues.opened` subscribed) | Mirror-intake, new `issues.labeled` sub + label allowlist → "Handle issue #N (labeled <label>)" |
| 9 | `issue_comment.created` + bot mention | github-mention-respond (chassis-native) | `handleIssueCommentEvent` → `handleAppMention` | **COVERED** (native; shadow-aware) |
| 10 | `pull_request_review_comment.created` + bot mention | github-review-comment-respond (chassis-native) | `handlePullRequestReviewCommentEvent` → `handleAppMention` | **COVERED** (native; shadow-aware) |

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

**Tracker note (out of pilot scope):** prod's per-repo config names a Linear team
as the tracker. The pilot proves GitHub intake only; no Linear/Jira wiring is in
scope here.

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
let the bot comment on our own PRs. Still flip in this order so an *unintended*
installation can't act during the transition:

**5a. Flip the global kill-switch ON.** Set `GITHUB_SIDE_EFFECTS_ENABLED=true`
(or remove it) on the pilot Worker and redeploy. Per-installation mode now
governs — and BeAutomata is still **shadow**-bound, so it *still* produces no
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

1. **Prod orch-agents** — the existing bot, driven by the GitHub App's *own*
   webhook (the App-level webhook URL, which points at prod).
2. **The new Automata platform** — driven by a **separate, repo-level webhook**
   we add to the customer repo, pointing at the Workers URL.

> **CRITICAL SAFETY — the GitHub App's own webhook URL is NEVER touched.** It
> keeps pointing at prod for the entire pilot. The pilot uses a *separate
> repo-level webhook* (Settings → Webhooks on the customer repo). Never repoint,
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
> now both *acting*). Coordinate the prod cutover (remove the repo from prod's
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

A worker box authenticates agent runs to Anthropic one of two ways, and the box
says which by setting `WORKER_BOX_TRUST`:

| value | how runs authenticate | use when |
|---|---|---|
| `shared` (default) | control-plane proxy (`useCredits`) — the run bills platform credits and no provider credential ever touches this disk | the box executes runs for tenants who do not own it |
| `owner` | the worker pulls the run's own credential from `/api/daemon/agent-credentials` and writes it to a per-run `HOME` (0600, wiped at teardown) — the run spends the USER's subscription or API key | the box belongs to the tenant whose runs it executes (the pilot: the operator's own Mac) |

```bash
# pilot box (single-tenant): let runs spend the user's Claude subscription
export WORKER_BOX_TRUST=owner
```

**Every run gets a fresh `HOME`, in both modes.** This is not hygiene. On macOS the
agent CLI keeps its OAuth in the login **Keychain**, not in `~/.claude/.credentials.json`
— so a run that inherits the operator's `HOME` authenticates AS the operator and
spends *their* subscription, with no credential file and no env var anywhere to show
for it. Verified on Claude Code 2.1.234: with a fresh `HOME` the CLI reports "Not
logged in"; with a delivered credential file it reads that file. The operator's own
`claude` login on the box is untouched and unreachable from a run.

**The box's own `ANTHROPIC_API_KEY` is no longer a run credential.** It used to be
the silent fallback: `buildRemoteDaemonMessage` skips `useCredits` when the user
*has* a credential, but nothing delivered that credential to the box, so the daemon
fell through to whatever key the box carried. A user with a Max subscription ran on
the operator's API key, and a box with no key failed runs that should never have
touched it. A run now either has its own credential in its own `HOME`, or it goes
through the proxy — never the box key.

Leaving `WORKER_BOX_TRUST` unset is safe but **changes who pays**: runs that used
to quietly draw on the box's `ANTHROPIC_API_KEY` now bill platform credits. Set
`owner` on a single-tenant box to get the subscription behaviour.
