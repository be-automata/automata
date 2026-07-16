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

---

## Operator steps

Prerequisites: `DATABASE_URL` points at the platform Postgres; the Somnio org
exists (create it in the dashboard, or via `deploy/seed-selfhost.ts` for a dev
box). You need the pilot repo's admin settings and the GitHub App's webhook
secret.

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
- **Secret**: the **GitHub App's webhook secret** (`GITHUB_WEBHOOK_SECRET` — the
  same secret the platform verifies HMAC-SHA256 against). Do not invent a new one.
- **Events**: issue comments, pull request review comments (whatever the mention
  intake consumes).

Leave the **App-level** webhook exactly as it is (pointing at prod).

### 4. Shadow-verify

Comment `@<bot>` on a PR in the pilot repo, then confirm from the dashboard:

- A thread appears under the **Somnio Software** org, badged **shadow**.
- **On GitHub, nothing happened** — no eyes reaction, no comment, no check, no
  review. This is the whole point of shadow mode.
- If webhook deliveries show non-2xx, that's a bug, not a rejection — the intake
  endpoint fast-acks business rejections with a 2xx skip (WI-8) so GitHub never
  disables the webhook. A genuine 5xx needs investigating.

### 5. Flip to active (only when verified)

```bash
DATABASE_URL=postgres://... pnpm exec tsx deploy/bind-github-installation.ts \
  <installationId> somnio-software active
```

Now the platform boots the agent and acts on PRs for this installation.

> Before flipping to active, decide how prod orch-agents stops acting on the
> pilot repo (otherwise you re-introduce the two-bots problem — now both
> *acting*). Coordinate the prod cutover (remove the repo from prod's scope, or
> stop the App-level delivery for it) as a separate, deliberate step.

### Rollback

Flip straight back to shadow at any time:

```bash
DATABASE_URL=postgres://... pnpm exec tsx deploy/bind-github-installation.ts \
  <installationId> somnio-software shadow
```

The platform immediately stops producing GitHub side effects for the
installation; existing shadow threads remain visible for inspection.
