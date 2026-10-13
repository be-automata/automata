# The platform Slack app

One Slack app serves every organization: an org admin clicks **Add to Slack**
in Settings → Integrations, and members link their Slack account. The app is
created once, by the operator, from `deploy/slack-app-manifest.json`.

An organization that must run its own Slack app instead sets `SLACK_*` on its
organization environment (`apps/www/src/server-lib/slack-config.ts`); that path
is the exception, not the setup below.

## Create the app (once)

1. Sign in to <https://api.slack.com/apps> as an admin of the workspace that
   will own the app (the vendor's own workspace, never a customer's).
2. **Create New App → From a manifest**, pick that workspace, paste
   `deploy/slack-app-manifest.json`, create.
   Slack immediately tries to verify the Event Subscriptions request URL. It
   fails until the secrets below are deployed — that is expected; finish the
   steps and retry it in step 6.
3. **Basic Information → App Credentials**: note the Client ID, Client Secret
   and Signing Secret. Never paste them into chat, tickets or the repo.
4. **Manage Distribution**: complete the checklist and **Activate Public
   Distribution**. Without it, only the owning workspace can install the app
   (`invalid_team_for_non_distributed_app`).
5. Set the worker secrets and deploy www (from `apps/www`):

   ```bash
   npx wrangler secret put SLACK_CLIENT_ID
   npx wrangler secret put SLACK_CLIENT_SECRET
   npx wrangler secret put SLACK_SIGNING_SECRET
   ```

6. **Event Subscriptions**: click **Retry** next to the request URL; it must
   show **Verified**. Do the same under **Interactivity & Shortcuts**.

## Smoke test

1. Settings → Integrations → **Connect Slack Workspace**, then **Install Slack
   App** (an org owner/admin).
2. In a channel, `/invite @Automata`, then `@Automata <a small task>`.
3. The bot replies in the thread with the task link.
4. Install it into a second workspace you administer: proves public
   distribution.

## Changing the app

The manifest is generated from `apps/www/src/lib/slack-app-manifest.ts`, and a
test fails if the two drift. Every added scope makes each installed workspace
(and an Enterprise Grid org) re-approve the app — add one only with the code
that calls it, then update the app at api.slack.com from the new manifest.
