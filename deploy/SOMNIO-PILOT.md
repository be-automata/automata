# Somnio pilot — intake readiness & operator runbook

How to onboard the Somnio Software org onto the Automata platform **without any
risk of two bots acting on the same PR**. The pilot installation is brought up
in **shadow mode** first (ingest-only, zero GitHub side effects), verified from
the dashboard, then flipped to **active** once we trust it.

---

## The safety model (read this first)

Two independent things must never fight over one PR:

1. **Prod orch-agents** — the existing bot, driven by the GitHub App's *own*
   webhook (the App-level webhook URL, which points at prod).
2. **The new Automata platform** — driven by a **separate, repo-level webhook**
   we add to the pilot repo, pointing at the Workers URL.

> **CRITICAL SAFETY — the GitHub App's own webhook URL is NEVER touched.** It
> keeps pointing at prod for the entire pilot. The pilot uses a *separate
> repo-level webhook* (Settings → Webhooks on the pilot repo). Never repoint,
> disable, or edit the App-level webhook to run this pilot. If the only way you
> can think of to route events to the platform is to change the App's webhook
> URL, stop — that would hijack every repo the App is installed on.

Shadow mode is the second guardrail. Even with the repo-level webhook wired and
delivering, a **shadow** installation produces **zero GitHub side effects**: no
comments, no checks, no reviews, no reactions, and the agent never runs. So even
if both webhooks fire for the same PR during the pilot, only prod acts; the
platform merely records a shadow thread you can inspect.

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
(the migration-safe no-row default) and would act on a live customer PR — the
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

Prod orch-agents routes these marketplace-monorepo event classes (from its
`WORKFLOW.md`) to skills. The pilot needs **intake parity**: every routed event
class must produce a correctly-attributed shadow task/thread in the bound org.
Execution (running the named skill) comes later; the pilot proves intake.

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
> class, both would fire — the pilot org has none.

**Attribution.** A mirror task isn't triggered by a specific user action (a PR
opening has no "commenter"), so it's attributed to the **bound org's owner**
(`role: "owner"` member) + the org id. Mention tasks keep their existing
commenter attribution.

**Tracker note (out of pilot scope):** prod's marketplace-monorepo config names
Linear team **AUT** as the tracker. The pilot proves GitHub intake only; no
Linear/Jira wiring is in scope here.

## Capturing the installation id (first delivery)

The installation id is **not** obtainable via the user-token GitHub API, so the
bind step (below) needs it from a real delivery. Every webhook delivery is
logged by the intake route with the id and account, e.g.:

```
[github webhook] event received pull_request action: opened repository: somnio-projects/marketplace-monorepo installation.id: 12345678 account: somnio-projects
```

Additionally, the first delivery for an **unbound** installation is fast-acked
(WI-8 2xx) with an explicit skip log naming the id + account, so the operator
can read it and bind:

```
[github webhook] skipped { category: 'unmapped_installation', installationId: 12345678, accountLogin: 'somnio-projects', ... }
```

Flow: wire the repo-level webhook (step 3) **first**, trigger any event (open a
throwaway PR or re-deliver from the repo's webhook "Recent Deliveries"), read the
`installation.id` from the log, run the bind (step 2), then **re-deliver** the
same payload from GitHub's webhook UI so it now lands against the bound org.

## Operator steps

Prerequisites: `DATABASE_URL` points at the platform Postgres; the Somnio org
exists (create it in the dashboard, or via `deploy/seed-selfhost.ts` for a dev
box). You need the pilot repo's admin settings and the GitHub App's webhook
secret.

### 0. Set the kill-switch OFF (before anything reaches the Worker)

On the pilot Worker set `GITHUB_SIDE_EFFECTS_ENABLED=false` (see
`deploy/WORKERS-ENV-MAP.md`). This makes the platform globally inert on GitHub —
no boot, no comments/checks/reviews/reactions — for **every** installation
regardless of binding, closing the window before the binding exists. Do this
first; it stays off through shadow-verify.

### 1. Create / confirm the org

Create **"Somnio Software"** in the dashboard and note its **slug** (e.g.
`somnio-software`). The bind step resolves the org by slug.

### 2. Bind the installation in shadow mode

Get the installation id (GitHub → org settings → Installed GitHub Apps → the
Automata app → the URL ends in `/installations/<id>`; or read it from a webhook
delivery payload's `installation.id`).

```bash
DATABASE_URL=postgres://... pnpm exec tsx deploy/bind-github-installation.ts \
  <installationId> somnio-software        # mode defaults to shadow
```

The script prints the bound row and confirms `mode: shadow`. It **only** writes
the `github_installation → org` mapping — it never touches any webhook config.

### 3. Add the repo-level webhook (NOT the App webhook)

On the **pilot repo** → Settings → Webhooks → Add webhook:

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
pass its id.

```bash
DATABASE_URL=postgres://... pnpm exec tsx deploy/seed-somnio-mirror.ts \
  somnio-software somnio-projects/marketplace-monorepo <installationId>
```

The remaining classes (review_requested, merged, changes_requested,
workflow_run, labeled) need no seeding — the webhook mirror-intake layer handles
them for any bound installation.

### 4. Shadow-verify

Exercise both intake paths: comment `@<bot>` on a PR (mention path) and trigger a
mirror class — open a PR or push to one (→ "Review PR" task), or label an issue
`bug` (→ "Handle issue" task). Then confirm from the dashboard:

- A thread appears under the **Somnio Software** org, badged **shadow**.
- **On GitHub, nothing happened** — no eyes reaction, no comment, no check, no
  review. This is the whole point of shadow mode.
- If webhook deliveries show non-2xx, that's a bug, not a rejection — the intake
  endpoint fast-acks business rejections with a 2xx skip (WI-8) so GitHub never
  disables the webhook. A genuine 5xx needs investigating.

### 5. Go live — two ordered flips (only when verified)

Two switches gate side effects; flip them in this order so there is never a
moment where an *unintended* installation could act:

**5a. Flip the global kill-switch ON.** Set `GITHUB_SIDE_EFFECTS_ENABLED=true`
(or remove it) on the pilot Worker and redeploy. Per-installation mode now
governs — and Somnio is still **shadow**-bound, so it *still* produces no side
effects. Re-verify shadow behavior once more here: this proves the switch flip
alone didn't wake anything up.

**5b. Flip the Somnio binding to active** (the final step):

```bash
DATABASE_URL=postgres://... pnpm exec tsx deploy/bind-github-installation.ts \
  <installationId> somnio-software active
```

Now — and only now — the platform boots the agent and acts on PRs for this
installation.

> Before 5b, decide how prod orch-agents stops acting on the pilot repo
> (otherwise you re-introduce the two-bots problem — now both *acting*).
> Coordinate the prod cutover (remove the repo from prod's scope, or stop the
> App-level delivery for it) as a separate, deliberate step.

### Rollback

Fastest, global (all installations at once): set
`GITHUB_SIDE_EFFECTS_ENABLED=false` on the Worker and redeploy — the platform
goes inert on GitHub immediately, no DB change needed.

Per-installation: flip the Somnio binding back to shadow at any time:

```bash
DATABASE_URL=postgres://... pnpm exec tsx deploy/bind-github-installation.ts \
  <installationId> somnio-software shadow
```

Either way the platform immediately stops producing GitHub side effects;
existing shadow threads remain visible for inspection.
