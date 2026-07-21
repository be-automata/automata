# UAT — per-repo review tolerance + draft-PR policy

Durable, re-runnable acceptance cases for the two per-repo review settings shipped on
`feat/p05-chassis-triage` (commits `30e2c90` tolerance, `1e09405` UI, `312bcf4` draft policy):

- **REQUESTED_CHANGES tolerance** — an operator sets, per repo, the severity floor that forces
  `request_changes`: `error` (only error/critical block), `warning` (default), `info` (everything blocks).
- **Review draft PRs** — per repo, whether Automata engages DRAFT PRs. Default **true** (works on drafts).

Read [`README.md`](./README.md) first (parameters + preflight). These cases reuse the same plane; the
mechanism is proven at the unit/integration layer (see the note at the bottom) — this suite proves the
**live** end-to-end path on real GitHub PRs.

## Preconditions (in addition to README preflight)

1. **Deployed www carries the feature.** `feat/p05-chassis-triage` (≥ `312bcf4`) is deployed to `$WORKER_URL`.
2. **Prod Neon is migrated.** The new `repo_review_settings` table exists:
   ```bash
   # from a box with the prod DATABASE_URL (packages/shared/.env.production.local):
   cd packages/shared && pnpm run drizzle-kit-push-prod   # additive: creates repo_review_settings only
   psql "$DATABASE_URL" -tAc "select to_regclass('public.repo_review_settings')"   # expect: repo_review_settings
   ```
   Additive migration — one new table + defaulted columns; no existing table is touched.
3. **A `pull_request` automation is configured on `$REPO`** (dispatch is automation-gated — see README §2).
4. **Auth for the settings API.** The endpoints are session + active-org fenced. Drive them from the
   dashboard (`$WORKER_URL/settings/review`) while signed in to the org that owns `$REPO`, OR with the
   session cookie. Set once:
   ```bash
   export ORG_REPO="$REPO"            # owner/name as stored (lowercased server-side)
   export OWNER="${ORG_REPO%%/*}" ; export NAME="${ORG_REPO##*/}"
   # $COOKIE = a valid better-auth session cookie for a member of the org owning $REPO
   ```

Helper — set/clear/read a repo's settings (org resolved from the session):
```bash
set_tolerance(){ curl -s -X PUT "$WORKER_URL/api/review-settings/$OWNER/$NAME" -H "cookie: $COOKIE" -H 'content-type: application/json' -d "{\"blockTolerance\":\"$1\"}"; echo; }
set_drafts(){    curl -s -X PUT "$WORKER_URL/api/review-settings/$OWNER/$NAME" -H "cookie: $COOKIE" -H 'content-type: application/json' -d "{\"reviewDraftPrs\":$1}"; echo; }
clear_repo(){    curl -s -X DELETE "$WORKER_URL/api/review-settings/$OWNER/$NAME" -H "cookie: $COOKIE"; echo; }
show_repo(){     curl -s "$WORKER_URL/api/review-settings" -H "cookie: $COOKIE" | jq --arg r "$OWNER/$NAME" '.settings[]|select(.repoFullName==($r|ascii_downcase))'; }
```

---

## Cases

Each case: create/advance a real PR on `$REPO`, wait for the bot review, assert the **posted verdict**
via `gh api repos/$REPO/pulls/<n>/reviews`. The reviewed-commit + verdict is the evidence.

### TOL-1 — default floor blocks a warning (baseline)
1. `clear_repo` (repo on the `warning` default).
2. Open a PR whose diff has exactly one **warning**-level issue (a real-but-non-critical concern the
   agent will tag `warning`) and no error/critical.
3. **Expect:** bot posts **CHANGES_REQUESTED**. `show_repo` returns nothing (no override row).

### TOL-2 — loosen to `error`: same class of finding no longer blocks (live, no restart)
1. `set_tolerance error` → response `{"setting":{...,"blockTolerance":"error",...}}`; `show_repo` shows `error`.
2. Advance the **same** PR (push a trivial commit to re-trigger `synchronize`) — do NOT redeploy/restart.
3. **Expect:** bot now posts **COMMENTED** (the warning surfaces in the body but does not block). Proves
   the dashboard change took effect on the very next review with no restart.

### TOL-3 — tighten to `info`: an info-only nit blocks
1. `set_tolerance info`.
2. Open a PR whose only finding is an `info` nit (nothing warning+).
3. **Expect:** **CHANGES_REQUESTED** (every finding blocks under `info`).
4. Cleanup: `clear_repo`.

### TOL-4 — org isolation (multi-tenant)
If a second org also has `$REPO` onboarded: set `info` under org A and `error` under org B for the same
slug; confirm each org's reviews use its own floor. (Skip if only one org onboards the repo.)

### DRAFT-1 — works on drafts by default
1. `clear_repo` (draft policy defaults to true).
2. Open a **draft** PR with a reviewable diff.
3. **Expect:** bot engages — a review/comment is posted (draft verdicts cap at COMMENT by design). A run
   dispatches (visible in `/api/runs` / worker log).

### DRAFT-2 — opt a repo out of drafts, then back in
1. `set_drafts false`.
2. Open a **draft** PR (or convert an open one to draft) and push a commit.
3. **Expect:** **no run dispatches** — the webhook logs `Skipping automation … for draft PR #<n> … (repo draft policy = ignore)`. No review is posted.
4. Mark the PR **ready for review**.
5. **Expect:** the bot now engages and posts a verdict.
6. `set_drafts true` (or `clear_repo`) and confirm a fresh draft PR is engaged again.

---

## Pass bar

All cases post the asserted verdict against the reviewed commit, TOL-2 flips **without a restart**, and
DRAFT-2 shows the intake skip in the log then engages on ready. Record the PR numbers + reviewed SHAs +
verdicts as evidence (mirror the matrix convention in `docs/triage/`).

## Mechanism already proven below the live layer (context for the validator)

The verdict math and gates are locked by unit/integration tests (real Postgres containers), so a live
failure implies an env/deploy/migration gap, not logic:
- `apps/www/src/server-lib/review/execute-review-from-intent.floor.test.ts` — same emitted intent →
  approve/comment/request_changes purely by resolved policy; draft cap; never-upgrade.
- `apps/www/src/server-lib/review/resolve-approve-floor.test.ts` / `resolve-review-draft-policy.test.ts` —
  live-read precedence (row > env/automation > default), org-fenced.
- `packages/shared/src/model/repo-review-settings.test.ts` — org isolation, partial-upsert preserves the
  other field, column defaults.
- `apps/www/src/app/api/review-settings/**/route.test.ts` — authz (401/400), validation, org fence, audit.
- `apps/www/src/components/settings/review-tolerance/constants.test.ts` — the UI matrix is locked
  cell-for-cell against the server kernel (no frontend/backend drift).
