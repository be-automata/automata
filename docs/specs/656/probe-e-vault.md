# #656 PR-E pre-flight: Claude Code authenticates through the vault (2026-11-17)

**Question.** Can real Claude Code inside a cell authenticate to Anthropic through the egress vault,
with only a placeholder in the guest? Spike 058 proved the rewrite: the binding changed Anthropic's
answer, and revoking reverted it. It never got a successful reply with a real token. PR-E's design
depends on that success.

**Setup**

- Box: the throwaway UAT box, running OpenSandbox 1.2.1 on the dedicated rootless daemon (PR-G).
- Image: the published cell image
  `ghcr.io/be-automata/automata-cell@sha256:eb8d0082303b7eff9fe8d27d67f75fa180d2f197cfeccdc03af3e51d85d48dce`,
  built from `main` at `fc3498b8` and pulled anonymously.
- Egress policy: deny by default, allow `api.anthropic.com` only.
- Vault: production's model binding (`cell-create-plan.ts`): bearer, host `api.anthropic.com`,
  paths `/v1/*` and `/api/*`.
- Guest: `CLAUDE_CODE_OAUTH_TOKEN` carried only a placeholder, on the command line.

**Credential handling.** The owner's Claude OAuth token was piped from the macOS keychain over SSH
stdin into the probe process. It was never in argv, env or a file. The probe redacted it, and the
OpenSandbox key, from all output.

There is deliberately no guest-side scan for the token: a scan would have to put part of it in
exec argv, and execd logs argv.

**Results**

| step                                                           | result                                                                  |
| :------------------------------------------------------------- | :---------------------------------------------------------------------- |
| identity                                                       | uid 10001 (`agent`), `HOME=/home/agent`, Claude Code 2.1.284            |
| no vault                                                       | `401 Invalid bearer token`                                              |
| vault with the real token (201; the response does not echo it) | **`"result": "ok"`**, `claude-haiku-4-5`, `terminal_reason: completed`  |
| after `DELETE /credential-vault` (204)                         | `401 Invalid bearer token`                                              |
| `DELETE /sandboxes/{id}`                                       | 204; no probe container left; the probe script was removed from the box |

**What this proves**

- The vault's bearer binding authenticates Claude Code's own OAuth requests end to end, while the
  guest holds only a placeholder.
- Revoking the vault stops it at once.
- TLS as uid 10001, with no root, works through the sidecar's MITM CA (`NODE_EXTRA_CA_CERTS`). PR-F
  had left this to PR-E's canary gate.

**Not covered.** Claude Code started through `cell-entry.sh` and the daemon, with the placeholder in
the daemon message rather than on the command line. That is PR-E's IT and UAT.
