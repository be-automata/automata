# OpenAI Proxy Route

This directory hosts the catch-all Next.js route that forwards requests to the OpenAI API.

## Behavior

- `GET/POST/... /api/proxy/openai` → `https://api.openai.com/v1/chat/completions` (default)
- `GET/POST/... /api/proxy/openai/<path>` → `https://api.openai.com/<path>`
- The server injects `Authorization: Bearer <OPENAI_API_KEY>` from `@terragon/env/apps-www`.
- Clients must include `X-Daemon-Token: <Terragon API key>` in each request; the proxy verifies the key with `verifyDaemonApiKey` (`src/lib/daemon-api-key.ts`, same mechanism as the daemon routes): an unknown, disabled or expired key gets 401; an auth-store failure gets 503 + `Retry-After` so clients retry instead of treating the credential as revoked.
- Access additionally requires that the requesting user have a positive Terragon credit balance; requests from users without remaining credits receive a `402 Payment Required` response.
- Query strings and request bodies are forwarded unchanged; streaming responses are passed through.

## Supported Endpoints

The proxy supports the following OpenAI API endpoints with usage tracking and billing:

- **Chat Completions API** (`/v1/chat/completions`): Standard chat completions endpoint
  - Supports both streaming and non-streaming responses
  - Tracks usage for prompt tokens, completion tokens, and cached tokens
  - Logs usage when the final chunk with usage data is received in streams
- **Responses API** (`/v1/responses`): OpenAI's newer responses API
  - Supports both streaming and non-streaming responses
  - Tracks usage from `response.completed` events in streams
  - Logs usage from JSON response bodies

All other endpoints are proxied but not tracked for billing.

## CORS

The route mirrors the incoming `Origin` header when present (otherwise `*`) and handles `OPTIONS` preflight requests with the allowed methods and headers.

## Codex Testing

To get a daemon token for testing, visit http://localhost:3000/api/internal/daemon-token and copy the token.

Point Codex at the proxy by defining a Terragon model provider in your `config.toml` and setting the daemon token when invoking Codex:

```bash
[model_providers.terry]
name = "terry"
base_url = "http://localhost:3000/api/proxy/openai/v1"
env_http_headers = { "X-Daemon-Token" = "DAEMON_TOKEN" }

DAEMON_TOKEN=*** codex -m gpt-5 -c 'model_provider="terry"'
```

For production use:

```bash
[model_providers.terry]
name = "terry"
base_url = "http://terragonlabs.com/api/proxy/openai/v1"
env_http_headers = { "X-Daemon-Token" = "DAEMON_TOKEN" }

DAEMON_TOKEN=*** codex -m gpt-5 -c 'model_provider="terry"'
```
