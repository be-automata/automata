# Canary harness: real container runs on a throwaway box (ADR-013)

**Dev only.** Nothing in `packages/worker/src` imports this directory and no
production path changes. It lets the ADR-013 throwaway box run REAL agent runs
end to end with **no production service involved**:

```
dispatch.mts ──seal+trigger──▶ local hatchet-lite (127.0.0.1:7077/8888)
                                   │
                    real worker (systemd, container path)
                                   │  worker ⇄ daemonCallbackUrl (direct)
                                   │  container daemon ⇄ egress proxy ⇄ daemonCallbackUrl
                                   ▼
             public tunnel URL ──▶ stub-www.mts (127.0.0.1:8787) ──▶ requests.jsonl
```

| File              | What it is                                                                                                                 |
| :---------------- | :------------------------------------------------------------------------------------------------------------------------- |
| `stub-www.mts`    | node:http server on loopback that implements exactly the www endpoints the worker and daemon call, and logs every request. |
| `dispatch.mts`    | Builds a run as `apps/www/src/agent/hatchet/dispatch.ts` does, seals it (#380) and triggers it on the local engine.        |
| `stub-core.ts`    | The stub's pure request handler (auth, F2 binding, state machine, revoke-on-terminal-read).                                |
| `run-input.ts`    | Lane → workflow, input, metadata and next-message, mirroring www.                                                          |
| `github-token.ts` | Repo allowlist + single-repo, least-permission App installation token.                                                     |
| `engine-guard.ts` | Refuses any Hatchet engine that is not loopback.                                                                           |
| `thread-spec.ts`  | The per-thread file dispatch writes and the stub reads (`<state>/threads/<id>.json`, 0600 in a 0700 dir).                  |

## Safety rails (all enforced in code, all unit-tested)

- **Repo allowlist first.** `--repo` must be an exact slug in `CANARY_REPOS`
  (default `be-automata/automata-container-canary`). Anything else exits 3
  **before** the App key is read. The App key can mint for every org repo.
- **Restricted token.** The mint asks for `repositories: [<name>]` and the
  lane's minimum permissions. Review: `contents/metadata/pull_requests: read`.
  Task and mention: `contents: write, pull_requests: write, issues: write,
metadata: read`. The response is checked as well: a token GitHub returns
  with `repository_selection != selected`, a second repo, or any permission
  that was not requested is refused, revoked and never used.
- **Local engine only.** The engine addresses come from
  `HATCHET_CLIENT_HOST_PORT`/`_API_URL`, or else from the token's claims. Both
  must be loopback, and they are passed to `Hatchet.init` as overrides.
- **Callback must be the stub.** Dispatch fetches
  `<callback>/__canary/health` and refuses unless the stub's marker answers, so
  a run's daemon token and callbacks never go to the real www.
- **No secrets in the evidence log.** Daemon tokens and the API key are scrubbed
  by value, and `redactSecrets` runs over every line. The credential response
  body is never logged.

## Reachability: why the stub needs a public tunnel URL

The worker calls `daemonCallbackUrl` from the host, so loopback would work for
the worker alone. The container daemon cannot use loopback:

- The container is `--network none`. Its only exits are the forwarded proxy
  and broker sockets (C3, #430). `container-policy.ts` sets
  `AUTOMATA_DAEMON_CALLBACK_VIA_PROXY=1`, so the daemon's `/api/daemon-event`
  POST goes through the run's **egress proxy** (`packages/daemon/src/proxy-fetch.ts`).
- `NO_PROXY` holds `127.0.0.1,localhost`. A loopback callback therefore goes
  _direct_, to the container's own loopback, where nothing listens.
- The egress proxy refuses **every host-local target** in every mode (#367
  `isHostLocalAddress`): loopback, RFC 1918, Docker bridges, the box's own
  public IPs, and names that resolve to any of these. A private or box IP is
  refused too.

So the stub has to be reachable at a **public hostname that does not resolve to
the box**, the same way prod www is. Without changing production code, the way
to do that is a Cloudflare tunnel on the box that points at the loopback stub:

```bash
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8787   # prints https://<random>.trycloudflare.com
```

(A named tunnel with a fixed hostname works the same.) The daemon token and the
API-key credential response then travel over that HTTPS URL. This matches prod:
www serves the same credential over its public URL behind the same token check.
The stub refuses every request without the run's token.

**Egress allowlist entry.** With no `--egress-allow`, the input carries no
`egressPolicy`. The worker then runs the proxy in **observe** mode: every
non-host-local destination is allowed and audited, so the tunnel host and
`api.anthropic.com` both pass with no entry. With `--egress-allow <host>…`,
dispatch builds the worker-plane shape that www builds: level `domain`,
allowlist = your hosts + **the callback host (e.g. `<random>.trycloudflare.com`)**

- `api.anthropic.com`. That callback-host entry is the one the stub needs.
  GitHub goes through the loopback brokers and needs no entry.

**Model traffic.** The stub serves an owner credential (`json-file`
`{"anthropicApiKey": …}`, www's shape for an Anthropic API-key credential).
A key file holding a `claude setup-token` token (`sk-ant-oat…`) is served in
www's setup-token shape instead (`{"claudeAiOauth": {accessToken, refreshToken:
"", far-future expiresAt}}`), so a subscription works too. Never copy a live
interactive login: its access token dies when the source refreshes.
With `WORKER_BOX_TRUST=owner`, the worker delivers it into the run HOME, forces
`useCredits=false`, and the daemon sets `ANTHROPIC_API_KEY` from the file. No
`ANTHROPIC_BASE_URL` is set, so the agent calls `api.anthropic.com` directly
through the egress proxy and the stub needs **no** `/api/proxy/anthropic`
forwarder. In any other trust mode the worker forces credits, and the daemon
would call `<callback>/api/proxy/anthropic`. The stub answers that path with
**501 + a log line**, so the misconfiguration is loud.

## Box recipe (run as root on the throwaway box)

```bash
# 0. Worker env (in its systemd env file): WORKER_BOX_TRUST=owner; it already holds HATCHET_CLIENT_TOKEN for the
#    local engine and the seal ring at /etc/automata/payload-seal.key.
install -d -m 0700 /var/lib/automata-canary /etc/automata-canary
install -m 0600 /dev/null /etc/automata-canary/anthropic.key   # then write the API key or setup-token into it
install -m 0600 /dev/null /etc/automata-canary/gh-app.pem      # then write the App private key into it

# 1. Stub (loopback) + tunnel
cd /path/to/automata/packages/worker
CANARY_STATE_DIR=/var/lib/automata-canary \
CANARY_ANTHROPIC_KEY_FILE=/etc/automata-canary/anthropic.key \
CANARY_STUB_PORT=8787 \
  npx tsx dev/canary/stub-www.mts &
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8787 &   # note the https URL

# 2. Dispatch
set -a; . /etc/automata/worker.env; set +a     # only HATCHET_CLIENT_* are used
export CANARY_CALLBACK_URL=https://<random>.trycloudflare.com
export CANARY_STATE_DIR=/var/lib/automata-canary
export CANARY_GH_APP_ID=<id> CANARY_GH_INSTALLATION_ID=<id>
export CANARY_GH_APP_KEY_FILE=/etc/automata-canary/gh-app.pem
# optional: CANARY_REPOS, CANARY_SEAL_KID (default: newest in the ring),
#           CANARY_SEAL_KEY_FILE, CANARY_ORG_ID (default canary-org)
npx tsx dev/canary/dispatch.mts --lane task \
  --repo be-automata/automata-container-canary --prompt "Add a line to README.md, commit, push"
npx tsx dev/canary/dispatch.mts --lane review --pr 1 \
  --repo be-automata/automata-container-canary --prompt "<review prompt with the json intent block instructions>"
npx tsx dev/canary/dispatch.mts --lane mention --pr 1 \
  --repo be-automata/automata-container-canary --prompt "Reply on the PR with a summary"
```

Dispatch prints one JSON line: `threadId`, `workflowRunId`, workflow, branch,
and so on. The evidence is in `/var/lib/automata-canary/requests.jsonl` (one
line per request; the agent's final `result` gets its own
`"kind":"agent-result"` line, so a review's verdict / intent block shows up
there). It is also in `journalctl -u <worker unit>` for the worker's side.

Flags: `--branch`/`--base` override the PR's head/base, which are read from
GitHub with the minted token. `--policy` (review) picks the variant
(`newest-wins` → `agent-run-newest`, the default). `--model` defaults to
`sonnet`. `--permission-mode` defaults to `review` for reviews and `allowAll`
otherwise. `--egress-allow` switches to enforce (see above).

## Endpoints the stub implements

| Route                                    | Auth                    | Behaviour (mirrors apps/www)                                                                                                                                         |
| :--------------------------------------- | :---------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/daemon/next-message`          | X-Daemon-Token + F2     | The dispatched `claude` message; 204 once terminal                                                                                                                   |
| `POST /api/daemon/agent-credentials`     | X-Daemon-Token + F2     | `{agent:"claudeCode", credentials:{type:"json-file", contents:"{\"anthropicApiKey\":…}"}}`                                                                           |
| `POST /api/daemon-event`                 | X-Daemon-Token + F2     | queued → working on the first event; `result` → complete (`is_error` → error); `custom-error` → error; `custom-stop` → stopped; 409 on a foreign `x-run-external-id` |
| `POST /api/daemon/thread-status`         | X-Daemon-Token + F2     | `{status, terminal}`; the token is revoked right after `terminal:true` is served (ADR-003 F3)                                                                        |
| `POST /api/daemon/run-terminal`          | X-Daemon-Token + F2     | `complete` + typed cause, `{applied}` idempotent; 409 on a generation mismatch; 400 on an unknown cause                                                              |
| `POST /api/daemon/run-staleness`         | X-Daemon-Token + F2     | `{stale}`: true only when a newer canary dispatch shares the PR key                                                                                                  |
| `POST /api/daemon/egress-event`          | X-Daemon-Token          | `{inserted:n}` (1..100 events); events logged                                                                                                                        |
| `POST /api/daemon/run-credential-source` | X-Daemon-Token + F2     | `{recorded:true}`                                                                                                                                                    |
| `POST /api/self-heal/audit-checks`       | x-self-heal-check-token | first write `{recorded:true}`, then `false`; the canary mints no self-heal runs, so in practice always 401                                                           |
| `POST /api/self-heal/fix-check`          | x-self-heal-gate-token  | same                                                                                                                                                                 |
| `/api/proxy/*`                           | –                       | 501 (credits path is not supported; use `WORKER_BOX_TRUST=owner`)                                                                                                    |
| `GET /__canary/health`                   | –                       | the stub marker dispatch checks                                                                                                                                      |

Not modelled: the stub keeps runtime state in memory (restarting it resets
statuses to `queued` but keeps the token files). It also does not model www's
org/owner checks, checkpointing, PR creation or the GitHub review post.
