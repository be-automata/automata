# #579 — Mention threads get no org on repo webhooks

Source: https://github.com/be-automata/automata/issues/579 (verbatim copy in the run state).
Base: `origin/main` @ `4085a7be`.

## Decision (taken with the requester, 2026-11-10)

Fix **B, scoped to the mention lane**: when the payload carries no `installation`,
`handleAppMention` resolves it with `getRepoInstallationId(owner, repo)` — the same
fallback `org-mention-lane.ts` (L291-L299) and `mirror-intake.ts` (L270-L290) already use —
before calling `getRepoOrgAndMode`. Plus a **fail-closed** guard. Option A (automation org)
was rejected: it only works when an automation matched and can disagree with the repo binding.

## Ground truth (verified in the worktree at write time)

- `apps/www/src/app/api/webhooks/github/handle-app-mention.ts` L75-L79: tenant resolved with
  `getRepoOrgAndMode({ db, installationId, repoFullName })`; `installationId` is passed
  through from `handlers.ts` (`installationIdOf(event)`), undefined on repo-level webhooks.
- `packages/shared/src/model/github-installation.ts`: `getInstallationOrgAndMode` returns
  `{ organizationId: null, mode: "active" }` for a null/undefined id; `getRepoOrgAndMode`
  applies a `github_repo_org_binding` row only when the installation org is non-null.
- `packages/shared/src/github-app.ts` L183: `getRepoInstallationId(owner, repo)` →
  installation id, `null` on 404, rethrows anything else.
- Shadow already means "no run": `newThreadInternal({ shadow: true })` creates the thread
  without booting (covered by the existing test "shadow-mode installation: creates the
  thread as shadow (no boot)…"). So once the mode is resolved correctly, AC 2 holds.
- `repo_review_settings` (`packages/shared/src/db/schema.ts` ~L1530): rows keyed by
  `(organization_id, repo_full_name)`, `repo_full_name` stored lower-cased (`normalizeRepo`
  in `packages/shared/src/model/repo-review-settings.ts`). The org-default sentinel row
  (`ORG_DEFAULT_REPO_SENTINEL`) is never equal to a real repo name.
  **No cross-org "does this repo have any settings row" helper exists today.**
- `WebhookSkip` (`apps/www/src/app/api/webhooks/github/webhook-skip.ts`) category
  `unmapped_installation` exists; the route turns a thrown `WebhookSkip` into a 2xx +
  structured skip log. `findWebhookSkip(e)` is the test helper.
- `@terragon/shared/github-app` is mocked globally in `apps/www/src/test-helpers/test-setup.ts`
  (L127, L180) **without** `getRepoInstallationId`. Many existing cases call
  `handleAppMention` with no `installationId`, so `handle-app-mention.test.ts` needs a local
  mock with the same shape as `org-mention-lane.test.ts` L57-L61 (all three exports), with
  `getRepoInstallationId` defaulting to `null` ("not installed"), which keeps their
  current expectations. (Since then the global mock itself carries `getRepoInstallationId`,
  defaulting to `null`, and the local mock was dropped; see Tests.)
- No index starts with `repo_full_name` (the unique index is `(organization_id, repo_full_name)`),
  so the cross-org existence check scans the table. That is acceptable at today's size; the
  helper's doc says so.

## Contract

1. `handleAppMention`: `const resolvedInstallationId = installationId ?? (await getRepoInstallationId(owner, repo));`
   (parse owner/repo first — already done at L71), then pass `resolvedInstallationId` to
   `getRepoOrgAndMode`. The lookup runs inside `requireAppAccess` (roborev round 2): a
   failure other than 404 becomes a `WebhookSkip("app_access_unavailable")` (2xx), which
   is how this handler already treated the same GitHub call via `getOctokitForApp` (WI-8).
   This deliberately differs from org-mention-lane/mirror-intake, which propagate a 500.
   Update the inline comment.
2. Fail closed: if `organizationId === null` **and** some org has claimed the repo — at
   least one `repo_review_settings` row (any org) **or** a `github_repo_org_binding` row
   (added in refinement: a bound repo whose installation has no org is the same bypass) —
   throw
   `new WebhookSkip("unmapped_installation", …, { installationId: resolvedInstallationId ?? null, repoFullName })`
   before any side effect (before the octokit/branch lookup, reaction, billing comment,
   thread creation or a follow-up into an existing thread: mention threads created before
   #579 carry a null org). This also covers a payload installation with no org mapping. A repo no org has claimed keeps today's behavior (null-org thread),
   so un-onboarded repos are not broken.
3. New shared helper in `packages/shared/src/model/repo-review-settings.ts`:
   `repoHasReviewSettings({ db, repoFullName }): Promise<boolean>` — existence check across
   orgs on `normalizeRepo(repoFullName)`, excluding `ORG_DEFAULT_REPO_SENTINEL`, `limit(1)`. Documented as deliberately cross-org
   (it returns a boolean only, never another org's row).
4. Two additive seams (pre-landing review): `getRepoOrgAndMode` also returns
   `boundOrganizationId` (the repo's `github_repo_org_binding` org, applied or not), which the
   guard reads instead of querying the binding again; `getOctokitForApp`
   (`apps/www/src/lib/github.ts`) takes an optional `installationId`, so the mention's App
   client reuses the resolved id instead of a second `GET /repos/{owner}/{repo}/installation`.
5. Nothing else changes: `handlers.ts`, `org-mention-lane.ts`, `dispatch.ts`,
   `getRepoOrgAndMode`'s org/mode semantics, other lanes.

## Acceptance criteria

1. A mention thread on a repo with an egress policy is created with the repo's org, and the
   worker logs `egress proxy up (enforce)`.
2. A mention on a shadow installation creates no run.
3. A test covers a repo-webhook payload (no `installation`) for both points.
4. Backfill: none needed (mention threads are short-lived), but say so in the PR.

## Tests

`apps/www/src/app/api/webhooks/github/handle-app-mention.test.ts` (the global
`vi.mock("@terragon/shared/github-app")` in `test-helpers/test-setup.ts` carries
`getRepoInstallationId`, implementation inside `vi.fn`, default `null`; the test re-sets
`null` in `beforeEach`; the shared default repo's claim rows are cleared in `beforeEach`):

- T1 (AC1/AC3): no `installationId`, lookup returns an id bound to org X (active) →
  `getRepoInstallationId` called with `(owner, repo)`, `newThreadInternal` called with
  `{ organizationId: X, shadow: false }`.
- T2 (AC2/AC3): no `installationId`, lookup returns an id bound to org X in `shadow` →
  `newThreadInternal` with `{ organizationId: X, shadow: true }`; no eyes reaction.
- T3 (fail closed): no `installationId`, lookup returns `null`, repo has a
  `repo_review_settings` row → rejects with a `WebhookSkip` of category
  `unmapped_installation`; `newThreadInternal` and `getOctokitForApp` not called.
- T4: payload `installationId` present → `getRepoInstallationId` not called.
- T5: lookup throws a non-404 error → rejects with a `WebhookSkip` of category
  `app_access_unavailable`; nothing created.
- T7 (fail closed): no `installationId`, lookup returns `null`, repo bound to an org via
  `github_repo_org_binding` → same `WebhookSkip`; nothing created.
- T8 (fail closed): payload `installationId` with no org mapping on a claimed repo →
  `WebhookSkip`; `getRepoInstallationId` not called.
- T6: no `installationId`, lookup returns `null`, repo has **no** settings row →
  thread created with `organizationId: null`, `shadow: false` (un-onboarded repos keep working).
- T9 (fail closed): a follow-up to an existing null-org thread on a claimed repo →
  `WebhookSkip`; `queueFollowUpInternal` not called (unclaimed control: it is called).
- T10: a claimed repo (binding and settings row) whose installation resolves to the claiming
  org → thread created with that org, `shadow: false` (no skip).

`packages/shared/src/model/repo-review-settings.test.ts`: `repoHasReviewSettings` true for a
repo row (case-insensitive name), false for an unknown repo, false when only the org-default
sentinel exists.

`packages/shared/src/model/github-installation.test.ts`: `getRepoOrgAndMode` reports
`boundOrganizationId`, including a binding it did not apply.

`apps/www/src/lib/github-background-token.test.ts`: `getOctokitForApp` passes a known
`installationId` through to `getInstallationToken`, and calls it with `(owner, repo)` only
without one.

## UAT

Deferred to after deploy (needs a real repo-webhook mention): on
`be-automata/egress-probe-2026-11` mention the bot on a PR; the new thread has
`organization_id` = beautomata and the worker logs `egress proxy up (enforce)`.

## Out of scope

Resolving the installation centrally in `handlers.ts` for every lane; changing
`getInstallationOrgAndMode`'s no-row default; backfilling existing null-org mention threads.
An installation that resolves to org Y on a repo whose policy row belongs to org X is a
separate route (routing is `github_repo_org_binding`'s job); named in the PR as a follow-up.
The handlers' catch blocks log `console.error` before rethrowing a `WebhookSkip` — same as
the existing `requireAppAccess` skips; accepted.
