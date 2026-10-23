# OpenRouter Proxy Route

This directory hosts the catch-all Next.js route that forwards requests to OpenRouter, an OpenAI-compatible API provider.

## Supported Provider

### OpenRouter

- Base URL: `https://openrouter.ai/api/`
- Models:
  - **Grok Code Fast 1** https://openrouter.ai/x-ai/grok-code-fast-1
  - **Qwen3 Coder 480B** https://openrouter.ai/qwen/qwen3-coder:exacto
  - **Kimi K2** https://openrouter.ai/moonshotai/kimi-k2-0905:exacto
  - **GLM 4.6** https://openrouter.ai/z-ai/glm-4.6:exacto

## Behavior

- `GET/POST/... /api/proxy/openrouter` → `https://openrouter.ai/api/v1/chat/completions`
- `GET/POST/... /api/proxy/openrouter/<path>` → `https://openrouter.ai/api/<path>`
- The server injects `Authorization: Bearer <OPENROUTER_API_KEY>` for all requests
- Clients must include `X-Daemon-Token: <Terragon API key>` in each request; the proxy verifies the key with `verifyDaemonApiKey` (`src/lib/daemon-api-key.ts`, same mechanism as the daemon routes): an unknown, disabled or expired key gets 401; an auth-store failure gets 503 + `Retry-After` so clients retry instead of treating the credential as revoked.
- Access additionally requires that the requesting user have a positive Terragon credit balance; requests from users without remaining credits receive a `402 Payment Required` response
- Query strings and request bodies are forwarded unchanged; streaming responses are passed through

## Usage Logging

The proxy automatically logs usage for:

- `/v1/chat/completions` endpoints
- `/v1/completions` endpoints

Both streaming and non-streaming responses are supported and logged appropriately. Usage is billed according to the provider's pricing model.

## CORS

The route mirrors the incoming `Origin` header when present (otherwise `*`) and handles `OPTIONS` preflight requests with the allowed methods and headers.

## Testing

To get a daemon token for testing, visit http://localhost:3000/api/internal/daemon-token and copy the token.

Put this in your `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "terry": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Terragon",
      "options": {
        "baseURL": "http://localhost:3000/api/proxy/openrouter/v1",
        "headers": {
          "X-Daemon-Token": "{env:TERRAGON_TOKEN}"
        }
      },
      "models": {
        "grok-code": {
          "id": "x-ai/grok-code-fast-1",
          "name": "Grok Code Fast 1"
        },
        "qwen3-coder": {
          "id": "qwen/qwen3-coder:exacto",
          "name": "Qwen3 Coder 480B"
        },
        "kimi-k2": {
          "id": "moonshotai/kimi-k2-0905:exacto",
          "name": "Kimi K2"
        },
        "glm-4.6": {
          "id": "z-ai/glm-4.6:exacto",
          "name": "GLM 4.6"
        }
      }
    }
  }
}
```

Then run:

```sh
TERRAGON_TOKEN=<token> opencode run --model terry/grok-code --format json "Hi, how are you?"
```
