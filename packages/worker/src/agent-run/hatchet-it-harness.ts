import { execFile } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

/**
 * Test-support harness for the ISOLATED hatchet-lite stack the integration
 * suites run against (HATCHET_IT=1). Not shipped. ONE home for the safety
 * invariants both suites depend on:
 *
 *  - its own compose project (`automata-hatchet-it`), never the live pilot
 *    project (`automata-hatchet`) — `down -v` here can never destroy pilot data;
 *  - its own ports (25433 / 28888 / 27077), far from the live 8888/7077 and
 *    the maintenance overlay's 55433;
 *  - the engine's broadcast address is overridden to the isolated gRPC port,
 *    so a token minted here can never point a worker at the live engine. The
 *    literal 127.0.0.1 (not `localhost`) keeps Node's IPv6-first resolution
 *    on CI runners from dialing ::1, which is not bound.
 */
export const IT = {
  project: "automata-hatchet-it",
  pgPort: 25433,
  restPort: 28888,
  grpcPort: 27077,
} as const;

const execFileAsync = promisify(execFile);

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const COMPOSE_FILE = path.join(packageRoot, "docker-compose.hatchet.yml");
// `docker compose up` has no --publish flag; the isolated ports come from a
// generated override scoped to the IT project only, so the repo's compose
// files stay untouched (the base publishes no postgres port by design).
const OVERRIDE_FILE = path.join(
  packageRoot,
  ".hatchet-it-override.generated.yml",
);
const OVERRIDE_YAML = `services:
  postgres:
    ports:
      - "127.0.0.1:${IT.pgPort}:5432"
  hatchet-lite:
    ports: !override
      - "127.0.0.1:${IT.restPort}:8888"
      - "127.0.0.1:${IT.grpcPort}:7077"
    environment:
      SERVER_GRPC_BROADCAST_ADDRESS: 127.0.0.1:${IT.grpcPort}
      SERVER_URL: http://127.0.0.1:${IT.restPort}
      SERVER_INTERNAL_CLIENT_INTERNAL_GRPC_BROADCAST_ADDRESS: localhost:7077
`;

export const REST = `http://127.0.0.1:${IT.restPort}`;

/** `docker compose` with the IT project's fixed argv. */
export async function compose(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", [
    "compose",
    "-f",
    COMPOSE_FILE,
    "-f",
    OVERRIDE_FILE,
    "-p",
    IT.project,
    "--project-directory",
    packageRoot,
    ...args,
  ]);
  return stdout;
}

export async function composeUp(): Promise<void> {
  await writeFile(OVERRIDE_FILE, OVERRIDE_YAML, "utf8");
  await compose(["up", "-d", "postgres", "hatchet-lite"]);
}

export async function composeDownV(): Promise<void> {
  await compose(["down", "-v"]).catch(() => {});
  await rm(OVERRIDE_FILE, { force: true }).catch(() => {});
}

/**
 * Poll `read` until `ok`, within `budgetMs`. The ONLY wait primitive in the
 * suites — no fixed sleeps. Default cadence suits a remote read; pass a
 * faster one for in-memory reads.
 */
export async function pollUntil<T>(
  what: string,
  read: () => Promise<T>,
  ok: (v: T) => boolean,
  budgetMs = 30_000,
  everyMs = 250,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${budgetMs}ms waiting for ${what}; last=${JSON.stringify(v)}`,
      );
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/**
 * The engine's own readiness signal. hatchet-lite serves /api/ready only after
 * its migrations have landed, so this is the ONE gate both suites share — see
 * the boot-race note in scheduling-health.integration.test.ts for why table
 * existence alone is not a substitute.
 */
export async function waitForEngineReady(
  budgetMs = 60_000,
  everyMs = 250,
): Promise<void> {
  await pollUntil(
    "hatchet-lite engine ready (/api/ready)",
    () =>
      // The per-request timeout is load-bearing, not decoration: bare `fetch`
      // has no default timeout, so ONE hung connection to a wedged engine
      // never settles and `pollUntil` can never reach its deadline — the
      // budget above would be silently unenforceable. Cap each attempt well
      // under the poll cadence's own patience.
      fetch(`${REST}/api/ready`, { signal: AbortSignal.timeout(5_000) })
        .then((r) => r.status)
        .catch(() => 0),
    (s) => s === 200,
    budgetMs,
    everyMs,
  );
}

/** Counts the schema-readiness probe reads, one field per guarded object. */
export interface SchemaReadyCounts {
  tables: number;
  evicted_at: number;
  delete_trigger_fn: number;
}

/**
 * EVERY schema object the scheduling-health suite's queries actually touch —
 * not just the one that caused the observed 42703. Gating on a subset and
 * relying on the rest happening to land in the same migration batch is how
 * this class of flake comes back through a different table.
 *
 * `SCHEMA_READY_TABLES` is the union of what the suite runs, read off
 * scheduling-health.ts: detectStepConcurrencyRot -> v1_step_concurrency;
 * detectWorkflowConcurrencyRot -> v1_workflow_concurrency; findReclaimableSlots
 * / reclaimEngineSlots -> v1_concurrency_slot, v1_task_runtime, "Worker",
 * v1_task_events_olap. `reclaimEngineSlots` in mode `on` also DELETEs, which
 * fires the engine's own release trigger, so that function is gated too.
 */
export const SCHEMA_READY_TABLES = [
  "v1_step_concurrency",
  "v1_workflow_concurrency",
  "v1_concurrency_slot",
  "v1_task_runtime",
  "Worker",
  "v1_task_events_olap",
] as const;

export const SCHEMA_READY_DELETE_TRIGGER_FN =
  "after_v1_concurrency_slot_delete_function";

export const SCHEMA_READY = {
  tables: SCHEMA_READY_TABLES.length,
  evictedAt: 1,
  deleteTriggerFn: 1,
} as const;

export function schemaIsReady(r: SchemaReadyCounts): boolean {
  return (
    r.tables >= SCHEMA_READY.tables &&
    r.evicted_at >= SCHEMA_READY.evictedAt &&
    r.delete_trigger_fn >= SCHEMA_READY.deleteTriggerFn
  );
}

/** A connected pg Client to the IT postgres, once it accepts queries. */
export async function connectPg(timeoutMs = 90_000): Promise<Client> {
  return pollUntil(
    "postgres ready",
    async () => {
      const c = new Client({
        host: "127.0.0.1",
        port: IT.pgPort,
        user: "hatchet",
        password: "hatchet",
        database: "hatchet",
      });
      try {
        await c.connect();
        await c.query("SELECT 1");
        return c;
      } catch {
        await c.end().catch(() => {});
        return null;
      }
    },
    (c): c is Client => c !== null,
    timeoutMs,
    1000,
  ).then((c) => c as Client);
}

/**
 * hatchet-lite owns the migrations AND bootstraps the default tenant; wait for
 * both, then mint a tenant API token with the image's own admin CLI. The
 * token embeds the (overridden) isolated broadcast address.
 */
export async function bootstrapTenant(
  pg: Client,
): Promise<{ tenantId: string; token: string }> {
  const tenantId = await pollUntil(
    "default tenant",
    async () => {
      const r = await pg
        .query(`SELECT id FROM "Tenant" WHERE slug = 'default' LIMIT 1`)
        .catch(() => ({ rows: [] as { id: string }[] }));
      return r.rows[0]?.id ?? "";
    },
    (id) => id.length > 0,
    120_000,
    500,
  );
  await waitForEngineReady();
  const minted = await compose([
    "exec",
    "-T",
    "hatchet-lite",
    "/hatchet-admin",
    "token",
    "create",
    "--config",
    "/config",
    "--tenant-id",
    tenantId,
    "--name",
    "it",
  ]);
  const token = minted.trim().split("\n").pop()!.trim();
  if (token.split(".").length !== 3) {
    throw new Error("hatchet-admin did not return a JWT");
  }
  return { tenantId, token };
}
