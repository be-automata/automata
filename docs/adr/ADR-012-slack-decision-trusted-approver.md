# ADR-012: Which source is trusted to say who approved a knowledge decision made in Slack

- **Status:** Proposed
- **Date:** 2026-10-19
- **Context source:** `apps/www/src/app/api/webhooks/slack/route-fence.ts:13-18` (a signature proves
  the app, not the payload claims), `route-fence.ts:33-59` (`getSlackInstallationForRoute`: a
  workspace is served by exactly one app), `route-fence.ts:84-140` (`confirmMentionForRoute`, the
  mention re-read from Slack), `apps/www/src/app/api/webhooks/slack/handle-request.ts:37-51`
  (signature checked with the route's secret), `handle-request.ts:76-86` (`block_actions` entry and
  the attribution log), `handle-request.ts:87-110` (`retry_task_creation`),
  `apps/www/src/app/api/webhooks/slack/[organizationId]/route.ts:17-24` (the org route verifies
  with the org's own signing secret), `apps/www/src/server-lib/slack-config.ts:56-84` (an org owns
  its app as soon as it sets any `SLACK_*` key), `apps/www/src/app/api/auth/slack/callback/route.ts:81-89`
  (binding a workspace to an org needs an org admin role) and `callback/route.ts:167-196` (a Slack
  account is linked only after `jwtVerify` of the OpenID `id_token`),
  `apps/www/src/app/api/webhooks/slack/block-action-attribution.ts` (the per-click attribution
  log, fail closed on the org route).
- **Deciders:** platform owner
- **Relates to:** ADR-001 (tenant scoping), ADR-005 (monotone floors), ADR-010 (single writer).
- **Supersedes / superseded by:** —

## Context

The knowledge system will let a Slack button approve or reject a change to a recorded claim. Only
the claim owner, or a delegate the org names, may decide. The question this ADR answers: **on an
org's own Slack app, what is trusted to say who clicked?**

### What a signature proves, per route

- **Platform route** (`/api/webhooks/slack`). The platform alone holds the platform app's signing
  secret. A valid signature means Slack built the payload, so `payload.user.id` is the Slack user
  who clicked. The platform maps that id to a platform account through the OpenID link
  (`callback/route.ts:167-196`), which is itself verified.
- **Org route** (`/api/webhooks/slack/<orgId>`). The signature is checked with the org's own
  `SLACK_SIGNING_SECRET` (`[organizationId]/route.ts:17-24`). A valid signature proves only that
  the org's app sent the request. As `route-fence.ts:13-18` says, on this route "every claim in the
  payload (team, user, text) is the admin's to forge".

### Why the mention fix cannot cover clicks

`confirmMentionForRoute` (`route-fence.ts:84-140`) defends the org route by re-reading the mention
from Slack with the bot token and requiring it to match the payload user. That works because Slack
**stores the message**, so a record exists that the platform can query independently of the
payload. A `block_actions` click has no stored, queryable record of who clicked. There is nothing
to re-read, so the same pattern has no equivalent for buttons.

### Who can forge on the org route

Whoever holds the org app's signing secret: any org admin who set `SLACK_*` on the org
environment, anyone the secret leaked to, and anyone with Slack admin rights over that app. On a
forged payload they can name any Slack user id, which defeats an owner/delegate check made against
the payload user.

### How much of that is new exposure

An org admin can already name delegates, so the ability of an admin to decide is not new. The
exposure that remains is mainly **repudiation** (a decision falsely attributed to a claim owner)
and **escalation by a secret-holder who is not an org admin**. Privilege escalation by an admin is
the smaller part.

### Interactive modals do not help

`views.open` followed by a `view_submission` looks like a second step, but both arrive at the same
interactivity URL signed with the same org secret. The submission payload carries the same
forgeable `user` object. A forger can sign the `block_actions` and the `view_submission`
equally well, so a modal adds friction for honest users and nothing against a secret-holder.

## Options considered

### Option A: platform-app route only

- **Trusted source:** `payload.user.id` under the platform signature, mapped to an OpenID-linked
  platform account.
- **Routes accepted:** `/api/webhooks/slack` only. On an org route, knowledge decision actions are
  refused and logged. Any UI explaining this (for example on the integrations page) is **deferred**
  until after the proof of concept; this ADR commits no phase to a UI change.
- **Setup facts that favour it:** the org's workspace has the platform app installed, or may
  install it; the org does not own a Slack app (no `SLACK_*` key on its environment); the people
  who decide have linked Slack through OpenID.
- **Phase 15 code implied:** a route-kind check at the start of the decision handler, a refusal
  reply, and a log line. No new trust root and no new endpoint. Decision rows record
  `identity_source = platform_linked`.
- **Residual risk:** an org that owns its app cannot decide in Slack. This is a capability gap,
  not a security gap.

### Option A′: platform-app route, owners keyed by Slack identity

- **Trusted source:** `payload.user.id` and `payload.team.id` under the platform signature, used
  as-is. The same trust as A: the platform alone holds the signing secret, so Slack built the
  payload. What changes is the owner map, not the trust root: an owner or delegate may be named by
  `(slack_team_id, slack_user_id)` instead of by platform user, so a workspace member decides
  without a platform account or an OpenID link.
- **Routes accepted:** `/api/webhooks/slack` only, exactly as A. The existing fence
  (`route-fence.ts:33-59`) only matches the route kind to the installation: on the platform route
  it returns an unbound installation, or one whose org has no app of its own, without comparing it
  to any claim. A′ therefore needs a **new check in the decision handler**: the installation for
  the payload's team must have an `organizationId` equal to the claim's org. An unbound
  installation, or one bound to another org, is refused. This matters more under A′ than A,
  because a Slack-keyed owner entry would otherwise match a click from any workspace.
- **Setup facts that favour it:** the org's workspace runs the platform app, and the people who
  should decide are workspace members (for example everyone in the org's alerts channel) who will
  not sign in to the platform.
- **Phase 15 code implied:** owner-map entries that hold either a platform user id or a Slack
  identity; an org-admin flow to name Slack users as owners or delegates; the same route-kind
  check, refusal reply and log line as A. A decision matched through a Slack-keyed owner-map
  entry records `identity_source = platform_slack`, with the linked platform user id null when the
  decider has no linked platform account. A decision matched through a platform-user entry, under
  A or A′, records `identity_source = platform_linked` with the linked id set.
- **Residual risk:** offboarding follows Slack, not the platform: a person removed from the
  workspace stops being able to click, but their owner-map entry stays until an admin removes it,
  and a reused or reassigned Slack account inherits it. Decisions are attributed to a Slack
  identity, not a platform user, so telemetry that counts "owner decisions" must treat both kinds.
  Non-repudiation is as strong as A, because the identity still comes from a payload the org
  cannot forge.

### Option B: org route with a platform-held second factor

- **Trusted source:** the click only opens a confirmation, which the platform verifies with
  something the org app's secret cannot forge: a short-lived signed link to www that the decider
  completes under their platform session.
- **Routes accepted:** both. On the org route the click never applies a decision by itself.
- **Setup facts that favour it:** the org owns its Slack app and cannot move to the platform app;
  deciders are platform users who can sign in to www from Slack.
- **Phase 15 code implied:** a link-minting step bound to the click's operation id, a www
  confirmation page, a single-use, short-TTL token, and the same decision write as Option C.
- **Residual risk:** a forged click can still spam links at a named user (annoyance, not a
  decision); the link must be bound to the session user, not to the payload user.

### Option C: decide in www, Slack as notifier

- **Trusted source:** the platform session on www. Slack only notifies.
- **Routes accepted:** every route, but none of them applies a decision. Buttons are links.
- **Setup facts that favour it:** a mixed estate of org-owned and platform apps; a workspace
  where interactivity is restricted (for example guests); a wish for one uniform path.
- **Phase 15 code implied:** a www decision page and its server action, and notifier messages
  with link buttons. The strongest identity, from the platform's own authentication.
- **Residual risk:** the most friction, and the slowest path from notification to decision.

### Option D: accept org-route payload identity, labelled

- **Trusted source:** `payload.user.id` under the org's signature, with the owner/delegate check
  against it.
- **Routes accepted:** both. The decision row records `identity_source = org_app_asserted` on the
  org route.
- **Setup facts that favour it:** the org's admins and the org's Slack admins are the same small
  trusted set, and the org accepts that trust in writing.
- **Phase 15 code implied:** the `identity_source` column on decision rows, an admin-panel marker,
  and a filter that excludes `org_app_asserted` rows from exit-test telemetry.
- **Residual risk:** this **downgrades non-repudiation**. A secret-holder can attribute a decision
  to any owner. It is acceptable only as an explicit, recorded choice and never as a default.

### Comparison

| Option | Org-route payload identity trusted | Decides in Slack on org app | New trust root | UX friction |
| ------ | ---------------------------------- | --------------------------- | -------------- | ----------- |
| A      | No (refused)                       | No                          | None           | Low         |
| A′     | No (refused)                       | No                          | None           | Lowest      |
| B      | No (second factor)                 | Opens only                  | www session    | Medium      |
| C      | No (not used)                      | No (link)                   | www session    | High        |
| D      | Yes (labelled)                     | Yes                         | Org secret     | Lowest      |

## Recommendation (pending the partner-setup check)

**A as the default, with C as the fallback** for orgs that cannot install the platform app. A reuses
the fence that already exists (`route-fence.ts:33-59` serves a workspace through exactly one app)
and adds no new trust root. **A′ is the same route with a wider owner map**: choose it, alone or
alongside A, if the org runs the platform app, owns no app of its own, and its deciders are
workspace members without linked platform accounts. This is a recommendation only: the final
choice depends on the Slack setup facts of the first external org, recorded in a local
investigation note, and is made when this ADR moves to Accepted. The ADR names no organisation.

## Decision

Not yet taken. Status stays Proposed until the setup facts are in; the accepting change records
the chosen option and the facts behind it.

## Phase 15 contract (holds under every option)

1. Verify the signature before parsing (unchanged, `handle-request.ts:37-51`).
2. Resolve the decider identity only from the chosen option's trusted source.
3. Refuse and log any decider who is not the claim owner or a named delegate (DEC-03). Only the
   mapped owner or a named delegate can decide; the org admin or the owner names delegates.
4. Every decision row stores `slack_team_id`, `slack_user_id`, the linked platform user id (null
   under A′ when the decider has no linked platform account), the route kind and an `identity_source`
   value, so the decision is signed with the approver's verified Slack identity by the control
   plane.
5. A refusal reply never reveals org membership to an unverified payload (the rule at
   `route-fence.ts:132`).

## Consequences

**Positive**

- The trusted source is chosen on evidence before any decision code exists.
- Every option keeps the existing mention confirmation untouched.
- Under A, A′, B and C a leaked org-app secret cannot forge an approval.

**Negative / watch**

- Under A, A′ and C an org that owns its Slack app loses one-click approval in Slack.
- Under D, repudiation is possible by design; telemetry must be able to exclude those rows.
- Known pre-existing items handed to Phase 15 (EW5), not decided here: `retry_task_creation`
  re-runs a mention as the original poster taken from `action.value`, not the clicker
  (`handle-request.ts:87-110`), and `handle-request.ts:90-93` logs the retry data including
  message text.

## Testing

Phase 15 must ship tests for:

- the owner/delegate matrix on each route kind (owner, delegate, non-owner, unlinked Slack user).
  An unlinked Slack user is refused under A, B and C; under A′ that user decides only when the
  owner map names their `(slack_team_id, slack_user_id)`, and is refused otherwise;
- under A′, a Slack-keyed owner deciding without a platform account, and the same Slack user id
  refused when it arrives from a different team, an unbound installation, or an installation bound
  to another org;
- a forged org-route payload naming an owner, refused (A, A′, B, C) or recorded with
  `identity_source = org_app_asserted` (D);
- a refusal reply that does not leak org membership;
- a `view_submission` carrying a forged user, treated the same as a forged click;
- attribution logs that carry ids only.

## Anti-deviation invariants

- No knowledge decision is applied from a payload identity on a route whose signing secret the
  platform does not exclusively hold, unless the chosen option explicitly allows it with a
  recorded `identity_source`.
- The existing mention confirmation (`confirmMentionForRoute`) is not weakened.
- Attribution logs carry ids only, never message text.
- Decision rows always record the verified identity source and the route kind.
