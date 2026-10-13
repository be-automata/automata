# www

## Getting Started

### 1. Environment Setup

1. Copy the `.env.example` file to create `.env.development.local`:

```bash
cp .env.example .env.development.local
```

2. Update the missing variables in `.env.development.local`:

### 2. Dev Environment & Database Setup

Make sure you have @terragon/dev-env and @terragon/shared setup.

### GitHub App Setup

1. Go to https://github.com/settings/apps and click **"New GitHub App"**.
2. Fill out the basic information:
   - **GitHub App name**: `Terragon Dev`
   - **Homepage URL**: `http://localhost:3000`
   - **Callback URL**: `http://localhost:3000/api/auth/callback/github`
   - **Webhook URL**: `https://your-domain.com/api/webhooks/github` (for production) or use ngrok for local development
   - **Webhook secret**: Generate a secure random string (e.g., using `openssl rand -hex 32`)
3. Under **Webhook events**:
   - In the "Subscribe to events" section, check: **Pull requests**
4. Under **Repository permissions** grant:
   - **Contents**: **Read and write**
   - **Pull requests**: **Read and write**
   - **Metadata**: **Read** (always required)
5. Under **Account permissions** grant:
   - **Email addresses**: **Read-only**
6. Click **"Create GitHub App"**.
7. On the next screen:
   - Generate a **Client ID** and **Client Secret** and add them to `.env.development.local` as `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.
   - Copy the **App slug** (kebab-case name) and add it to `.env.development.local` as `NEXT_PUBLIC_GITHUB_APP_NAME`.
   - Add your webhook secret to `.env.development.local` as `GITHUB_WEBHOOK_SECRET`.
8. You can manage or revoke the app at any time from https://github.com/settings/apps.

### Setting Up GitHub Webhooks

The application uses webhooks to receive real-time updates about pull request status changes.

The webhook handler is located at `/api/webhooks/github` and the events we listen to can be found in `src/app/api/webhooks/github/route.ts`.

1. Use ngrok to expose your local server: `ngrok http 3000`
2. Update your GitHub App's webhook URL to the ngrok URL: `https://your-ngrok-domain.ngrok.io/api/webhooks/github`
3. Make sure `GITHUB_WEBHOOK_SECRET` in your `.env.development.local` matches the webhook secret in your GitHub App settings

### E2B API Setup

1. Go to https://e2b.dev/
2. Sign up for an account
3. Navigate to your dashboard
4. Create a new API key
5. Copy the API key and add it to your `.env.development.local` file as `E2B_API_KEY`

E2B provides cloud-based sandboxed environments for code execution and is used for secure sandbox environments in the application.

### Cloudflare R2 Setup (Optional)

Cloudflare R2 is used for file storage. If you need file upload/storage functionality:

1. Go to https://dash.cloudflare.com/
2. Navigate to R2 Object Storage
3. Create a bucket
4. Generate API tokens with R2 permissions
5. Add the R2 configuration to your `.env.development.local` file

### Slack Integration Setup (Optional)

The Slack integration allows users to interact with Terragon through Slack. Users can create tasks directly from Slack messages.

#### 1. Create a Slack App

1. Go to https://api.slack.com/apps
2. Click **"Create New App"** → **"From scratch"**
3. Give your app a name (e.g., "Terragon-Dev-YourName")

#### 2. Configure OAuth & Permissions

1. In the app settings, go to **"OAuth & Permissions"**
2. Under **"Redirect URLs"**, add:
   - For local development: `<LOCALHOST_PUBLIC_DOMAIN>/api/auth/slack/callback`
   - For production: `https://www.terragonlabs.com/api/auth/slack/callback`
3. Under **"Bot Token Scopes"**, add all the scopes in `SLACK_BOT_SCOPES` in `src/server-actions/slack.ts`

#### 3. Event Subscriptions

1. Go to **"Event Subscriptions"**
2. Set the **"Request URL"** to:
   - For local development: `<LOCALHOST_PUBLIC_DOMAIN>/api/webhooks/slack`
   - For production: `https://www.terragonlabs.com/api/webhooks/slack`
3. Subscribe to bot events:
   - `app_mention` - For mentions in channels

### 4. Interactivity

1. Go to **"Interactivity & Shortcuts"**
2. Set the **"Request URL"** to:
   - For local development: `<LOCALHOST_PUBLIC_DOMAIN>/api/webhooks/slack`
   - For production: `https://www.terragonlabs.com/api/webhooks/slack`

#### 5. Get App Credentials

1. Go to **"Basic Information"**
2. Under **"App Credentials"**, copy:
   - **Client ID** → Add to `.env.development.local` as `SLACK_CLIENT_ID`
   - **Client Secret** → Add to `.env.development.local` as `SLACK_CLIENT_SECRET`
   - **Signing Secret** → Add to `.env.development.local` as `SLACK_SIGNING_SECRET`

These three values configure the **platform** Slack app. Without `SLACK_SIGNING_SECRET`, `/api/webhooks/slack` rejects every request.

#### Organization Slack apps

An organization can bring its own Slack app instead: an owner or admin sets `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `SLACK_SIGNING_SECRET` on **Environments → Organization**. Setting any of them switches the org to its own app (values are never mixed with the platform's). The app's Event Subscriptions and Interactivity Request URL is then `/api/webhooks/slack/<organizationId>`. **Settings → Integrations** shows which level supplies each key and the exact URLs to register. These keys are control-plane only and never reach an agent.

#### Development Tips

- Slack OAuth redirect URLs cannot be localhost, you need to use the ngrok URL if you're testing the slack auth flow.
- This might require you to add your ngrok URL to your GitHub app settings.
