# ADR-011: Nango is the OAuth credential vault behind the credential broker — agents and planes never learn it exists

- **Status:** Proposed (2026-10-18). Not implemented. Open decisions resolved 2026-10-18 by the
  operator (deployment mode: Nango Cloud; see "Deployment mode"). Stays Proposed until the Phase 1
  spike report proves the checks listed there; acceptance follows that report.
- **Date:** 2026-10-18
- **Context source:** anchors are against `main` @ `a50935e`.
  `packages/worker/src/agent-run/gh-broker.ts:128-157` (`startGhBroker` takes `installationToken`
  once and injects it per request), `packages/worker/src/agent-run/git-broker.ts:88-118` (same
  shape for git), `packages/worker/src/agent-run/broker-common.ts` (`REQUEST_OWNED`, `HOP_BY_HOP`,
  `timingSafeEqualStr`), `packages/sandbox/src/cred-broker-standalone.cjs:35-41` (Docker sidecar
  reads its token once from a `:ro` secrets file), `packages/sandbox/src/types.ts:25-35,210-231`
  (`CredentialBrokerShape` HONESTY NOTE; `BrokerRefresh.mintToken`, invoked only on resume and
  `extendLife`), `apps/www/src/server-lib/credential-broker/resolve-credential-broker.ts` (per-plane
  shape resolution), `apps/www/src/server-lib/egress/resolve-egress-policy.ts:40-63` (system-host
  merge; the worker plane already drops the GitHub hosts because they are brokered),
  `apps/www/src/app/api/auth/slack/callback/route.ts:90-136,219` (hand-rolled `oauth.v2.access` /
  `openid.connect.token` exchange, token encrypted into the row), `packages/shared/src/db/schema.ts:885-934`
  (`slack_installation.bot_access_token_encrypted`, `slack_account.access_token_encrypted` — no
  refresh token, no expiry), `apps/www/src/server-lib/slack-config.ts:56-108` (an org may bring its
  own Slack app), `apps/www/src/server-lib/env-audience.ts:44-58` (`CONTROL_PLANE_ONLY_ENV_KEYS`,
  `ORGANIZATION_CONTROL_PLANE_ONLY_ENV_KEYS`), `apps/www/src/server-lib/tracker/tracker-client.ts:9-25`
  (the `kind` switch), `packages/sandbox/src/mcp-config.ts:11-23` (MCP `headers` are plain strings
  written into the guest), `apps/www/wrangler.jsonc` (control plane is a Cloudflare Worker),
  `deploy/SELFHOST.md`, `deploy/egress-pf.conf:45,53` (loopback passes; only 80/443 blocked for
  the agent uid), `docs/credential-brokering-decision.md` ("Trust note").
  Vendor facts, checked against primary sources on 2026-10-18: Nango API keys
  (https://nango.dev/docs/reference/api-keys), security
  (https://nango.dev/docs/guides/platform/security), pricing (https://nango.dev/pricing),
  `GET /connection` (https://nango.dev/docs/reference/api/connection/get), import
  (https://nango.dev/docs/reference/backend/http-api/connections/post), free self-host scope
  (https://nango.dev/docs/guides/platform/self-hosting/self-hosting.md), licence (repository
  `LICENSE`, Elastic License 2.0); Composio token custody
  (https://docs.composio.dev/docs/security/token-custody), proxy execute
  (https://docs.composio.dev/api-reference/api-reference/v3/tools/post-tools-execute-proxy), data
  retention (https://docs.composio.dev/docs/security/data-retention), pricing
  (https://composio.dev/pricing), May 2026 incident
  (https://composio.dev/blog/composio-may-2026-security-incident). **Still secondary:** the two
  Nango CVEs (CVE-2026-9317, CVE-2026-92804) — pending NVD / GitHub advisory confirmation.
- **Deciders:** operator (open decisions resolved 2026-10-18; acceptance after the Phase 1 spike)
- **Relates to:** ADR-002 (only the control plane holds cross-tenant secrets; short-lived per-task
  tokens; R3.4 "customization adds capability, never identity"; customer secrets by explicit
  declaration), ADR-004 (review runs carry no GitHub credential; write lanes use the broker, never
  a resident token), ADR-005 (controls only tighten), ADR-006 (planes receive resolved shapes),
  ADR-008 (tracker effects are emit-only; the tracker token stays on the control plane), ADR-010
  (the control plane is the only writer).
- **Supersedes / superseded by:** —

## Context

Every third-party OAuth integration is hand-rolled today. Slack is the only one live: the callback
exchanges the code itself, encrypts the access token into `slack_installation` /
`slack_account`, and stores no refresh token and no expiry, so nothing rotates. On `main` an org
may bring its own Slack app (`slack-config.ts`), which multiplies the client-id/secret pairs the
control plane must hold. The first tracker (YouTrack) uses a static `YOUTRACK_TOKEN`, not OAuth;
a second tracker (Linear, Jira) would be the first OAuth tracker, and the `createTrackerClient`
`kind` switch is the seam it lands in. Each new provider repeats the exchange, storage, refresh and
revocation logic.

The execution-plane half is already solved for one credential: GitHub. The gh/git brokers hold the
real token in the worker heap (or a sidecar) and the agent holds only a per-run bearer. Three
limits matter for extending that pattern:

1. **The brokers are GitHub-specific.** The host fence is a literal (`api.github.com`) and the
   policy is hard-coded per broker.
2. **The brokers cannot refresh mid-run.** `startGhBroker` / `startGitBroker` receive the token at
   construction; the Docker sidecar reads it once. On the managed planes E2B and Daytona refresh
   only through `BrokerRefresh.mintToken` on resume and `extendLife` — inject-at-boot. A provider
   whose access token lives minutes to an hour breaks a long run.
3. **MCP has no broker at all.** An MCP server's `headers` are written into the guest's agent
   config, so any token there is resident in the guest.

Nango is an open-source OAuth broker: it runs the consent flow, stores tokens encrypted, refreshes
them, and exposes them by connection id (`GET /connection/{id}`, which refreshes an expired token,
accepts `force_refresh`, and returns 424 when refresh is exhausted) or proxies a request with the
token injected. It cannot run on the control plane itself: the control plane is a Cloudflare Worker
(`wrangler.jsonc`), and Nango is a Node service with Postgres and Redis.

## Decision

1. **Adopt Nango for auth and proxy only** — the store and refresher of third-party OAuth tokens.
   Its functions, syncs and MCP server are not used (see Options).
2. **Only the control plane talks to Nango.** It fetches fresh tokens with `GET /connection/{id}`
   and/or calls the Nango proxy for control-plane, emit-only effects (Slack posts; tracker writes
   per ADR-008). The control plane's Nango key is a Worker secret and its name is added to
   `CONTROL_PLANE_ONLY_ENV_KEYS` (`env-audience.ts`), so a stored copy can never reach an
   execution-plane getter. **Treat that key as an environment-wide god key**: Nango scopes keys by
   permission (e.g. `environment:connections:read_credentials`, `environment:proxy`), never by
   integration or connection (Nango "API keys" docs), so any key that can read credentials reads
   every connection in its environment.

   **There is one control-plane key, and every scope it holds reads credentials.**

   - `read_credentials` returns the token directly. That is its documented purpose (`GET /connection`).
   - `proxy` can send any token to any host through `Base-Url-Override`. Proven in the spike, on self-hosted and Cloud.
   - `connections:create` gets the token back in the import response. Proven in the spike, on Cloud.

   Both proven rows were run with a full-access environment key. Whether a key holding only the
   four scopes below is refused everything else is spike check 3, which is still open.

   Scoping therefore limits which operations the key can perform, never what it can read, so the
   key is treated as an environment-wide god key whatever its scopes. It holds exactly
   `connections:read_credentials`, `proxy`, `connections:create` (connect and import) and
   `connections:delete` (revoke). It never holds `connections:list` or
   `connections:list_credentials`, so a leaked key cannot enumerate connection ids, and connection
   ids stay unguessable (Decision §10). A second key for the connect path is not adopted: it would
   read credentials too, so it adds a secret without narrowing exposure. Calling Nango over HTTPS
   from a Worker is fine; only hosting Nango there is ruled out.

3. **Agents reach third-party APIs only through a generalized broker.** The gh-broker pattern
   becomes data-driven: `host + method/path allowlist + header injection`, the agent holding only
   the per-run bearer. The plane receives the resolved shape — host, allowlist, an opaque grant
   handle and the bearer — never a Nango identifier, connection id, provider config key or key
   (ADR-006). The allowlist starts read-only, as the gh-broker did; write methods are an
   allowlist change behind ADR-005's tighten-only rule.
   - **No confused deputy.** Which connection a request uses is bound server-side from the run
     context the control plane issued (org, run, lane), never from anything in the agent's
     request — the same rule as ADR-008 I2 for write targets. A header, path or query parameter
     naming a connection, provider or account is ignored.
   - **The broker never mints or returns credentials.** The path allowlist denies every
     credential-minting, -exchanging or -returning endpoint of the provider (OAuth token exchange
     and refresh, e.g. Slack `oauth.v2.access` / `oauth.v2.exchange`, token introspection,
     `auth.test`-style endpoints that echo a token). The injected token never appears in a
     response body or header the agent sees.
   - **Rate limit and audit per bearer.** Each brokered request is counted against the run's
     bearer and logged as method + path + status (never the query, body or token), like the
     gh-broker's deny record.
   - **Plane fit.** E2B and Daytona inject at boot and refresh only on resume (`BrokerRefresh`), so
     a short-lived Nango token (e.g. 1 h) does not fit their native injection. Nango-brokered lanes
     are therefore limited to the worker and Docker planes; a managed-plane run with a
     Nango-brokered grant is refused at dispatch with a named reason (decided 2026-10-18: the
     managed planes are unset by design, `deploy/WORKERS-ENV-MAP.md:100`; a control-plane-hosted
     broker is deferred until they return). The shape stays vendor-blind (ADR-006): the plane
     decision is made on the control plane.
   - **On the worker plane the sandbox is the agent uid.** The broker runs in the worker process;
     its heap, environment, socket and any cache file must be unreadable by the agent uid
     (`WORKER_AGENT_USER`). The per-run bearer stays the fence on the socket, as in `gh-broker.ts`.
4. **Mid-run refresh is a new, named seam: the broker token endpoint.** For the broker to fetch a
   fresh token per request while invariant I2 holds, the broker asks the **control plane**, never
   Nango. A new control-plane endpoint takes a **broker credential** plus the opaque grant handle
   and returns `{token, expiresAt}`. The broker credential is issued to the broker process alone
   (held in the worker heap, or in the Docker sidecar's `:ro` secrets file) and is never present in
   the agent's or the daemon's environment. **Delivery (decided 2026-10-18), per plane:**
   - **Docker plane.** No engine payload is involved. The control plane mints the per-run
     credential when the Docker provider creates the sandbox. The provider writes it into the same
     host secrets file the sidecar already reads (`installationToken` + `runBearer` today), at mode
     `0o400`, bind-mounted `:ro` into the **sidecar container only**
     (`packages/sandbox/src/providers/docker-cred-broker.ts:13-23,223-224`). The guest container
     never mounts that file, and the credential is never on argv, in `-e`, in `docker inspect` or in
     control-plane logs. The agent runs inside the guest container, so container isolation is the
     boundary here, in place of the uid split. A brokered Docker sandbox stays non-resumable, as
     today, so the credential is never re-delivered into a live guest.
   - **Worker plane.** One credential per
     run, minted at dispatch and carried in the task payload **sealed to the receiving worker's
     per-box key**, so the engine's payload store never holds a usable value — the engine keeps task
     payloads in plaintext (`v1_payload`, 21 daily partitions on the live box; 1,500 of 3,697 inline
     payloads carried an installation token on 2026-10-18). The worker unseals it into heap only;
     it never appears in argv (the agent uid can read the worker's `/proc/<pid>/cmdline`, though not
     its `environ` or `mem` — probed 2026-10-18). The endpoint refuses it once the run is terminal or
     superseded. The endpoint rejects the daemon token and the per-run
     agent bearer: on the sandbox planes the daemon runs inside the guest, so an endpoint that
     accepted the daemon token would hand the raw third-party token to any agent that read it. The endpoint checks that the grant belongs to that run,
     that the run is live (not superseded, ADR-007), and that the org owns the connection
     (ADR-001), then calls Nango. The broker caches the token until `expiresAt` minus a skew.
     This is what inject-at-boot cannot do. The endpoint is the only path from a plane to a
     third-party token, and it fails closed.
5. **Fail closed.** If Nango returns 424 (refresh exhausted), times out, or errors, or the token
   endpoint refuses, the brokered request fails with a status to the agent (502/503) and the
   control-plane effect is reported as not applied. There is no fallback to a cached-but-expired
   token, a resident token, or a direct call.
6. **Egress: only the broker is reachable.** Neither the Nango host nor any brokered provider host
   (`slack.com`, `api.linear.app`, …) may be on an agent allowlist. An allowlisted multi-tenant API
   host is an exfiltration channel even with no leaked key — the agent can bring an attacker's own
   Nango key or a token it found — and a direct provider host bypasses the broker's fences. On the
   worker plane the broker is loopback/unix-socket and its upstream call is made by the worker
   process, outside the agent's proxy, so the agent allowlist gains **nothing** (mirroring how
   `systemEgressHosts("worker")` already drops the GitHub hosts). On the Docker plane it gains only
   the broker sidecar's address.
7. **Migration order.** (a) Slack (confirmed first, 2026-10-18): replace the hand-rolled exchange
   and token columns with a Nango connection per installation. Refresh only becomes live if Slack
   token rotation is turned on; the immediate win is removing the exchange/storage code. Existing
   rows migrate **hybrid**: import the bot token (`POST /connections` with `connection_config`
   `team.id` and a per-org `config_override` client), and re-consent any workspace whose user
   token or event routing fails the spike's dry-run import — Nango's import body has no `raw`
   field, while its Slack code reads the user token from `raw.authed_user`. Moot if production
   has no installations. (b) OAuth for a second tracker
   (Linear or Jira) as a new `kind` in `createTrackerClient`. **Out of scope:** the GitHub App
   (installation tokens stay minted from the App private key on the control plane, ADR-002 §3),
   and agent-provider credentials (Claude/Codex OAuth, `agentProviderCredentials`).
8. **Never in a guest.** The Nango secret key, its MCP server and its connect-session tokens never
   reach a sandbox, worker, setup script or MCP config. One Nango environment key authorizes every
   connection in that environment — a resident cross-tenant bearer, which is what ADR-002 §3 and
   ADR-004 forbid.
9. **A self-hosted Nango is not network-reachable from any execution plane.** It never runs on an
   execution box. Domain allowlists do not cover loopback or the LAN: the macOS PF template
   (`deploy/egress-pf.conf:45,53`) has `pass out quick on lo0 all` and blocks only ports 80/443
   for the agent uid, so a co-located Nango's API and runner ports would be open to the agent. The
   Linux equivalent (`packages/worker/deploy/linux/egress-nft.conf`, loaded by
   `automata-egress.service`) has the same shape — `oif "lo" accept`, then `meta skuid <agent>`
   rejected on tcp/udp 80/443 only — and on the live execution box (probed 2026-10-18 as the
   agent uid) loopback services (engine gRPC/API, Postgres) and every non-web port to the internet
   were reachable, while direct 443 was reset. So the host fence stops a direct HTTPS call to a
   hosted Nango, but not a Nango on the same box, nor a self-hosted Nango elsewhere listening on a
   non-web port. A self-hosted Nango therefore runs off the execution plane AND accepts inbound only
   from the control plane (e.g. behind a tunnel with service-token auth), never on an open port.
   Per secondary sources (pending NVD / GitHub advisory), CVE-2026-9317 is an unauthenticated RCE on the runner port: reachability
   alone is the threat, no key needed.
10. **Tenancy: Nango is one shared store; Automata is the tenant boundary.** Nango organises
    tenants but does not isolate them:

    - A connection carries an id we choose and `tags`, `end_user` and `metadata` fields; the spike's responses carried `"end_user":null,"tags":{}`.
    - Each org-owned OAuth app can be its own integration or a per-connection `config_override`.
    - Environments separate dev from prod, not one customer from another.

    No Nango key can be limited to one tenant. Keys are scoped by permission, never by connection
    or integration, and the spike's environment key listed every connection on both self-hosted and
    Cloud. Nango returns whatever connection it is asked for, and the proxy's `Base-Url-Override`
    can send any tenant's token anywhere (spike tables below). So one wrong `connection_id` in the
    control plane is a cross-tenant leak.

    Isolation therefore stays where it is today:

    - The org → connection mapping lives in our database, behind the ADR-001 org-scoped accessor.
    - The connection id the control plane sends to Nango always comes from that accessor, for the org the run or request belongs to.
    - It never comes from request input, a webhook payload, a Nango response or an agent (I6, I6a, I6g).
    - Connection ids are org-prefixed and carry the org in `tags`. That is for audit and forensics only; it is never the authority.

    Hard isolation inside Nango (one environment or account per customer, each with its own key)
    is not adopted. Whether Cloud supports it, and at what cost, is unverified; revisit it only if a
    customer contract requires vault-level separation.

## Deployment mode — decided: Nango Cloud (2026-10-18), exit proven by the Phase 1 spike

Nango Cloud with the least-privilege key in Decision §2. Cloud custody is a recorded deviation,
like the managed-plane "Trust note" in `credential-brokering-decision.md`. The free self-host was
not chosen: Nango scopes it to hobby projects, and it lacks audit trail, MFA, RBAC and webhooks,
and its encryption key cannot be rotated. Before this ADR is Accepted, the spike must prove:

1. **Exit:** credentials read with `read_credentials` import into a test self-hosted instance
   via `POST /connections` and work there (export out of Cloud is not documented).
2. **Slack import dry-run:** one workspace's bot token imports and posts; whether the user token
   and event routing survive decides import vs re-consent per workspace (Decision §7).
3. **Key scope:** the exact key Decision §2 adopts (`connections:read_credentials`, `proxy`,
   `connections:create`, `connections:delete`) is refused (403) on `GET /connections` (list) and
   on every `list_credentials` route, and still succeeds on the four operations it holds.
4. Latency of `GET /connection/{id}` from a Worker, and 424/timeout behaviour under a revoked
   grant (I4).
5. The number of production Slack installations (operator query).

### Phase 1 spike — local half (2026-10-18)

Ran against a throwaway self-hosted `nangohq/nango-server:hosted-0.71.13` (server, Postgres and Redis only, bound to 127.0.0.1, torn down afterwards), using fake Slack credentials. The Cloud half is in the next table.

| Check                                                              | Result                                                                                                                                                                                                                     |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Import a Slack bot token with no refresh token or expiry (check 2) | `POST /connections` → 201, with `connection_config` `team.id` and metadata stored.                                                                                                                                         |
| Import for an org-owned Slack app (check 2)                        | `config_override` `{client_id, client_secret}` accepted per connection → 201.                                                                                                                                              |
| Import the user token where Nango's Slack code reads it (check 2)  | `raw.authed_user` → **400 `unrecognized_keys: "raw"`**. The user token cannot be imported to that location, so user tokens need re-consent or a separate connection (Decision §7, hybrid).                                 |
| Export side of the exit (check 1)                                  | `GET /connection` returns the imported `access_token`. The self-hosted target can both receive and hand back tokens.                                                                                                       |
| Refresh failure (check 4, I4)                                      | Expired token plus a bogus refresh token → **424 `invalid_credentials`**. Later reads return immediately with "A recent refresh attempt failed. Backing off", so it fails closed and fast.                                 |
| Key scope (check 3)                                                | The self-hosted 0.71.13 build has **no scoped keys**: `nango.api_secrets` has no scopes column, and the environment key lists every connection. Scoped keys are Cloud-only, which supports the Cloud decision.             |
| At-rest encryption                                                 | No plaintext token found in `_nango_connections` with `NANGO_ENCRYPTION_KEY` set.                                                                                                                                          |
| `GET /connection` latency                                          | p50 10.6 ms, p95 12.9 ms locally (Docker on the same host, not from a Worker).                                                                                                                                             |
| **Proxy `Base-Url-Override` header**                               | **Sends the injected token to any host.** A `Base-Url-Override: https://httpbin.org` request was answered by httpbin with `Authorization: Bearer <the connection's token>`. An absolute URL in the path was refused (404). |

### Phase 1 spike — Cloud half (2026-10-18)

Ran against Nango Cloud (`api.nango.dev`) with a dev-environment key and a throwaway `slack` integration using fake credentials. Every object the spike created was deleted afterwards, and the environment returned to its starting state (1 integration, 1 connection, neither touched).

| Check                                       | Result                                                                                                                                                                                                                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Import a bot token with `team.id` (check 2) | 201. The import response **echoes the token**, so `environment:connections:create` also reads credentials back.                                                                                                                                                        |
| `raw.authed_user` import (check 2)          | 400 `unrecognized_keys: "raw"`, same as self-hosted.                                                                                                                                                                                                                   |
| Exit, Cloud to self-hosted (check 1)        | **Proven.** `GET /connection` on Cloud, reshaped into the `POST /connections` body and imported into a self-hosted 0.71.13 instance, gave a byte-identical token (sha256 match) with `connection_config` intact.                                                       |
| Refresh failure (check 4, I4)               | Same as self-hosted: `invalid_credentials` on refresh failure, then an immediate "Backing off" answer.                                                                                                                                                                 |
| **Proxy `Base-Url-Override`**               | **Also leaks on Cloud.** httpbin received `Authorization: Bearer <the connection's token>`.                                                                                                                                                                            |
| `GET /connection` latency (check 4)         | From the operator's laptop: p50 525 ms, p95 740 ms, max 7.8 s. Not yet measured from a Worker. The broker caches tokens until `expiresAt`, so this is paid once per token lifetime, not per request.                                                                   |
| Rate limit                                  | `x-ratelimit-limit: 200` per window on this plan. Caching keeps the broker far below that.                                                                                                                                                                             |
| Key scope (check 3)                         | **Still open.** It needs a custom key with exactly the four Decision §2 scopes, created in the dashboard or with an account key; the spike had only a full-access environment key. Pass: list and `list_credentials` return 403, and the four held operations succeed. |
| Real Slack workspace (check 2)              | **Still open.** Needs a test workspace.                                                                                                                                                                                                                                |

**Consequence of the proxy rows (binding on Decision §2):** a key with the `proxy` scope can send any connection's token to any host, so in practice `proxy` is as strong as `read_credentials`. When the control plane uses Nango's proxy, it builds every Nango header itself. It never forwards a header, path or base URL that came from an agent, a webhook or user input, and it never sends `Base-Url-Override`. _Guard:_ a unit test that the control-plane Nango client drops any `Base-Url-Override` it is handed, and that its proxy path is a constant per call site.

The comparison that produced the decision is kept below.

| Criterion                   | Nango Cloud                                                                                                 | Self-hosted (docker-compose, auth + proxy)                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Custody                     | Nango holds the tokens (a plaintext custodian, like the "Trust note" in `credential-brokering-decision.md`) | We hold them; same trust boundary as the control plane                                                             |
| Cost (primary, see header)  | Pay-as-you-go, $50/mo credits, $0.29 per connection per month                                               | Free for auth + proxy; we pay for a box, Postgres and Redis                                                        |
| Assurance (primary, header) | SOC 2 Type II; AES-256-GCM with envelope encryption under AWS KMS                                           | Ours to provide; patch discipline is ours (see Risks)                                                              |
| Hosting                     | None                                                                                                        | Needs its own box: not the Worker, and **never the execution box** (Decision §9); Neon for Postgres is a candidate |
| Residency                   | Vendor region                                                                                               | Our choice                                                                                                         |
| Self-host bundles           | N/A                                                                                                         | Licence review needed before shipping it inside an Automata self-host bundle                                       |

One integration per org-owned Slack app applies in either mode (see Consequences).

## Anti-deviation invariants (what must always hold)

- **I1 — No Nango secret in any guest.** No Nango key, connect-session token or Nango-hosted URL
  appears in an agent env, argv, setup script, MCP config or guest file. _Guard:_ an
  `env-audience.test.ts`-style structural test — the Nango client is imported by exactly one
  control-plane module — plus an `env-audience.test.ts` assertion that the key name is in
  `CONTROL_PLANE_ONLY_ENV_KEYS` and is stripped by every execution-plane getter, plus a
  `validateMcpConfig` rejection of a Nango host or key-shaped header.
- **I2 — Only the control plane calls Nango.** No code under `packages/worker`, `packages/sandbox`,
  `packages/daemon` or `packages/bundled` references the Nango host or SDK. _Guard:_ a grep test
  over those package roots (same shape as the ADR-006 composability grep-gate).
- **I3 — The brokered shape carries no vault identity.** The shape a plane receives has a host,
  an allowlist, an opaque grant handle and a bearer — no connection id, provider config key,
  provider name or Nango URL. _Guard:_ a compile-level test on the shape type (as in ADR-006 #75)
  plus a snapshot of the resolved shape in the resolver test.
- **I4 — Fail closed on refresh failure.** A 424, a timeout or an error from Nango, or a refusal
  from the token endpoint, yields a non-2xx to the agent and a "not applied" control-plane effect;
  the broker never serves a token past `expiresAt`. _Guard:_ broker and token-endpoint unit tests
  with a stub Nango returning 424, hanging, and 500.
- **I5 — Only the broker is reachable.** No agent allowlist on any plane contains the Nango host
  or the host of any brokered provider. _Guard:_ `resolve-egress-policy.test.ts` asserts the merged
  set for every plane excludes both, and the per-repo allowlist write path rejects the Nango host
  and every host registered as brokered (the brokered-host list is the single source both read).
- **I5a — Self-hosted Nango is unreachable from execution planes.** _Verification:_ a deploy-time
  probe run as the agent uid on each execution box (connect to the Nango API and runner ports by
  loopback, LAN and public address — all must fail), recorded in the deploy runbook next to
  `pf-verify`; plus a static check that no execution-box deploy file references Nango.
- **I6 — The token endpoint is run-scoped.** A grant handle resolves only for the run it was issued
  to, only while that run is live, only for a connection the run's org owns, and only to the
  broker credential. _Guard:_ endpoint tests for a foreign run, a superseded run, another org's
  handle, and a request carrying the daemon token or the agent bearer (all 401/403); plus a test
  that neither the broker credential nor the grant handle is written to any env, file or socket
  the agent uid can read.
- **I6a — The connection is never chosen by the agent.** The broker resolves the connection from
  the grant bound to the run; request headers, path and query cannot change it. _Guard:_ broker
  test sending a foreign connection id / provider config key in a header and query — the upstream
  sees the run's connection.
- **I6b — The broker never mints or returns credentials.** _Guard:_ allowlist test that every
  provider's token-exchange, refresh, introspection and token-echo endpoints are 403, and a test
  that no response forwarded to the agent contains the injected token.
- **I6c — Per-bearer rate limit and audit.** _Guard:_ broker test that requests past the limit are
  429 and that every request (allowed and denied) emits one audit record with method, path and
  status only.
- **I6d — Nango-brokered grants only on fitting planes.** A run on E2B or Daytona with a
  Nango-brokered grant is refused at dispatch with a named reason (a control-plane-hosted broker
  is deferred, Decision §3). _Guard:_ resolver test per provider.
- **I6e — The agent uid cannot read the broker.** _Guard:_ the worker's existing agent-uid drills
  (`HOST_UID_IT`) extended to assert the agent uid cannot read the broker's process environment or
  memory (`/proc` on Linux) or any cache file, and cannot connect to the socket without the bearer.
- **I6f — The broker credential is sealed in transit and never in argv.**
  - **Worker plane:** the task payload carries it only sealed to the receiving worker's key. It is never passed on a command line or written to the engine in plaintext. _Guard:_ a payload test asserting the field is ciphertext and that unsealing with another box's key fails, plus a spawn test that no child argv contains it.
  - **Docker plane:** it is delivered only in the sidecar's `0o400` `:ro` secrets file. _Guard:_ extend the `docker-cred-broker.ts` builder tests to assert that the secrets JSON carries the broker credential, that the guest container's `docker run` args mount no secrets path, and that no argv or `-e` value of either container contains it.
- **I6g — The connection id always comes from the org-scoped accessor.** Every control-plane
  call to Nango (`GET /connection`, proxy, import, delete) takes its `connection_id` and provider
  config key from the ADR-001 org-scoped accessor, for the org of the run or request. Nothing
  else may supply it. _Guard:_ the Nango client's call signature accepts only the accessor's
  branded connection type, not a string (a compile-level test, as in ADR-006 #75). A
  structural test asserts no call site builds a connection id from request, webhook or response
  data. An endpoint test asserts that org A's run or request asking for org B's connection gets
  403 and never reaches Nango.
- **I7 — The GitHub App stays out of Nango.** Installation tokens are minted from the App key on
  the control plane. _Guard:_ review rule; I2's grep covers the planes.

## Options considered

- **Nango, auth + proxy only (chosen).** Exposes the token by API, so it can feed our broker and
  our fences stay ours; open source and self-hostable.
- **Composio.** Rejected. Per its own token-custody doc: tokens stay in Composio's custody with no
  supported export, so it cannot feed our broker and every call transits Composio; its quickstart
  puts `COMPOSIO_API_KEY` and a session MCP URL in the agent — a resident bearer over all connected
  accounts; self-host/VPC is enterprise-only with a closed-source backend. Composio has publicly
  disclosed a May 2026 platform incident (figures from Composio's own disclosure, linked in the header): over about 8 hours an attacker pivoted through an internal agentic monitoring
  tool and the tool-execution sandbox; about 0.3% of connections — including 5,001 GitHub
  connections — and 5,241 API keys were treated as exposed. It
  has since announced remediations (no token return, hashed keys, envelope encryption, IP
  allowlists, customer-managed keys). Compared as hosted vaults on 2026-10-18 (custody is vendor
  custody either way): Nango sits on the credential path only (the broker calls providers
  directly), while Composio sits on the data path of every call (`POST /tools/execute/proxy`,
  payloads logged unless "Don't store data" or paid ZDR is on) and has no exit without
  re-consent. Composio is cheaper at this scale. **Future lane (recorded, not built):** its 1,000+
  pre-built actions and triggers may be added as an opt-in, brokered lane with a
  **customer-owned** Composio key for long-tail prompt-defined automations — behind the broker,
  never in the credential path of this ADR.
- **Nango full platform (functions, syncs, MCP server).** Rejected for now. The MCP server takes the
  secret key and connection id as headers — a resident secret in the guest; functions run our code
  on Nango's runner, a second trust surface; on self-host these are paid/enterprise.
- **Status quo — hand-roll each provider.** Rejected. Cost grows linearly per integration, and
  exchange, refresh and revocation logic is duplicated per provider with no mid-run refresh.
- **Provider-native injection on the managed planes (E2B/Daytona secrets).** Not an alternative to
  the vault: it injects, it does not obtain tokens, and it refreshes only on resume and
  `extendLife`, so it does not fit short-lived Nango tokens (Decision §3, I6d).

## Consequences

**Positive**

- A new OAuth integration is a Nango integration plus a broker allowlist entry, not new exchange
  and refresh code.
- MCP servers and agent-side API access get a never-resident path, closing the gap in
  `mcp-config.ts`.
- Mid-run refresh works on the worker and Docker planes, which inject-at-boot cannot do.

**Negative / watch**

- **A new dependency in the credential path.** A Nango outage fails brokered third-party access and
  control-plane effects closed (I4). That is required behaviour, not a degradation to engineer
  around.
- **Self-host patch discipline.** Per secondary sources (pending NVD / GitHub advisory): CVE-2026-9317 (critical unauthenticated RCE
  in the Nango runner, fixed in v0.71.6, published 2026-09-04) and CVE-2026-92804 (SSRF through
  connection config, ≤ v0.70.4); latest release v0.71.13 (2026-10-14). Pin an exact version and
  track advisories. Auth + proxy only keeps the runner out of the deployment, but do not count on
  that alone.
- **Licence.** Nango is Elastic License 2.0 (repository `LICENSE`): internal use is fine; offering
  Nango itself as a hosted or managed service is prohibited. Legal review before any Automata
  self-host bundle ships Nango.
- **Custody and residency under Nango Cloud.** Nango holds every customer's third-party tokens —
  record it as a custody deviation like the managed-plane "Trust note".
- **Per-org Slack apps.** An org-owned Slack app is its own OAuth client, so it maps to its own
  Nango integration (provider config key). Creating that integration when an org sets its
  `SLACK_*` keys is new control-plane work, and those keys stay control-plane-only.
- **Slack migration.** Existing `bot_access_token_encrypted` / `access_token_encrypted` rows must be
  imported into Nango or re-consented; the columns stay until every installation is migrated, then
  drop with a manual production schema push (AGENTS.md).
- **A per-box worker key pair** for sealing the broker credential (Decision §4): provisioned with
  the box, its public half registered with the control plane, rotated like other box secrets.
  Worker registration has no per-box identity today, so this is new work.
- **Broker generalisation touches three mirrored broker sources** (`gh-broker.ts`, `git-broker.ts`,
  `cred-broker-standalone.cjs`); the mirror convention applies.

## Testing

- The I1–I7 guards above. The model is `env-audience.test.ts` "env-audience is the only decrypt
  site (ADR-008 I1)": structural, source-scanning, no mocks of the property under test.
- Generalized broker: per-request fences (bearer, host, method/path) and refresh-through-cache with
  a stub token endpoint, including expiry mid-stream.
- Phase 1 spike report (the five checks under "Deployment mode") before acceptance and before any
  production change.
