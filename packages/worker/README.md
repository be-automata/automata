# @terragon/worker — execution-plane substrate (Hatchet)

The execution plane from ADR-002: agent runs happen on a **customer-supplied box**,
not the control plane. This package owns the worker **runtime/bootstrap** (Hatchet
client, worker process, the local hatchet-lite substrate). The real agent-run
**workflow steps** are owned separately (tenancy-coder / ADR-003 dispatch seam) — the
`hello` workflow here is only a throwaway round-trip proof.

## Layout

```
docker-compose.hatchet.yml   hatchet-lite engine + REST + dashboard + its own Postgres
src/hatchet-client.ts        Hatchet.init() — reads the org worker token from env
src/hello/workflow.ts        trivial proof task (scheduleTimeout 30m, per ADR-002)
src/hello/worker.ts          registers hello + long-polls the engine (outbound gRPC)
src/hello/trigger.ts         triggers one run and reads the result
src/index.ts                 package entry (re-exports client + hello)
```

## Pilot substrate (this box = BeAutomata's customer box)

```sh
pnpm --filter @terragon/worker hatchet:up          # bring up hatchet-lite (:8888 REST, :7077 gRPC)
# mint an org token (default tenant 707d0855-…):
docker compose -f docker-compose.hatchet.yml exec hatchet-lite \
  /hatchet-admin token create --config /config --tenant-id <tenant> --name automata-pilot
# put HATCHET_CLIENT_TOKEN + HATCHET_CLIENT_TLS_STRATEGY=none in an env file, then:
pnpm --filter @terragon/worker exec dotenv -e <env> -- tsx src/hello/worker.ts    # worker
pnpm --filter @terragon/worker exec dotenv -e <env> -- tsx src/hello/trigger.ts   # trigger
```

## Hard rules (ADR-002)

- **Never a `-dev` image / `--disable-auth`.** The `-dev` images embed a publicly-known
  JWT signing key (authdisabled build tag) — tenant isolation becomes void, not weaker.
  The image tag is pinned to a non-dev release (`hatchet-lite:v0.94.10`).
- **Deploy guard** (assert before trusting an engine): `GET /api/v1/meta` must report
  `authDisabled: false`, and an unauthenticated `GET /api/v1/tenants/<uuid>/workers`
  must return 401/403. Both verified on this substrate.
- **`SERVER_GRPC_INSECURE=t` is pilot-only** (worker + engine share localhost here). A
  real customer box MUST use TLS — the worker token crosses the public internet.
- **`scheduleTimeout` is set to 30m, not the 5m default.** On a customer box that
  window is the grace period for THEIR infra being down; at 5m a brief outage silently
  deletes queued work.

## Reachability: www-on-Workers → engine (the finding that shapes the dispatch seam)

The engine exposes two ports: **REST/dashboard :8888** and **engine gRPC :7077**.

- The **worker** connects **outbound gRPC** to :7077. In the pilot that is localhost;
  on a customer box it is the engine's public gRPC endpoint (TLS).
- **www-on-Cloudflare-Workers cannot speak gRPC** (no HTTP/2-trailer client). So the
  control plane must **trigger runs over the REST API (:8888)**, not the SDK's default
  gRPC admin trigger (`hatchet.run` / `runNoWait` use gRPC and will not work from a
  Worker). The dispatch seam should POST to the Hatchet REST trigger endpoint.
- Cloudflare-edge reachability to :8888 is proven via a **cloudflared quick tunnel**
  (`cloudflared tunnel --url http://localhost:8888` → `edge → /api/v1/meta` = 200).
  A quick tunnel is fine for the pilot; a named tunnel under the account needs operator
  approval.

## Known local quirk

The SDK's blocking `hello.run()` (result-events stream) can stall under
`TLS_STRATEGY=none` locally — the task still runs to COMPLETED and its output is
readable via the REST API / OLAP store / `runNoWait` + poll. Not present with TLS on.
