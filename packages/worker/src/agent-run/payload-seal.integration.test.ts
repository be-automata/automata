import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import {
  APIContracts,
  type Hatchet,
  type Worker,
} from "@hatchet-dev/typescript-sdk";

import {
  PayloadSealError,
  generatePlaneKeyPair,
  sealRunSecrets,
  type RunSecrets,
} from "@terragon/utils/payload-seal";
import { redactSecrets } from "@terragon/utils/redact";

import { AGENT_RUN_VARIANTS, buildAgentRunDefinition } from "./definition";
import {
  REST,
  bootstrapTenant,
  composeDownV,
  composeUp,
  connectPg,
  pollUntil,
} from "./hatchet-it-harness";
import { resolveRunSecrets, type AgentRunWireInput } from "./run-secrets";

/**
 * #380 (AC 2/3/7/8 at the engine level): a SEALED dispatch through a REAL,
 * isolated hatchet-lite engine. The shipped `agent-run` definition runs a
 * stub task fn that does exactly what the production run fn does first —
 * `resolveRunSecrets` with the plane ring — and records what it saw. Then
 * the engine's own Postgres is queried: no payload row may hold a `ghs_`
 * token, a plain-text secret field, or the daemon token's value, while at
 * least one row holds the envelope (so the query provably read the right
 * table). A second dispatch sealed to a key the ring does not hold FAILS at
 * the worker with a kid+reason error, and the engine's stored error text
 * carries no secret either.
 *
 * Gated on HATCHET_IT=1 like the sibling suites; skipped otherwise.
 *
 * Card: protects=the engine's persisted input + run API hold ciphertext
 * only, and an unopenable envelope fails the run without leaking;
 * fails_when=any engine payload/error row contains a secret value or a
 * plain-text secret field, the worker cannot open a www-sealed envelope, or
 * a foreign envelope "succeeds"; no_claim=the www dispatch code path (its
 * own suite seals with the same module), the sweep (www tests), token
 * revocation against GitHub (unit tests).
 */

const Status = APIContracts.V1TaskStatus;
type Status = APIContracts.V1TaskStatus;
const TERMINAL: Status[] = [Status.COMPLETED, Status.CANCELLED, Status.FAILED];

const itEnabled = process.env.HATCHET_IT === "1";
vi.setConfig({ testTimeout: 90_000 });

const SECRETS: RunSecrets = {
  installationToken: "ghs_itInstallationTokenValue0123456789abc",
  githubReadToken: "ghs_itReadTokenValue0123456789abcdefghij",
  daemonToken: "daemon_it_token_value_0123456789abcdefghijklmnopqrstuvwxyz",
};
const SECRET_NEEDLES = [
  "ghs_",
  "installationToken",
  "daemonToken",
  "githubReadToken",
  SECRETS.installationToken,
  SECRETS.githubReadToken,
  SECRETS.daemonToken,
];

describe.skipIf(!itEnabled)(
  "#380 sealed payload E2E (dockerized hatchet-lite, HATCHET_IT=1)",
  () => {
    let pg: Client;
    let tenantId: string;
    let token: string;
    let hatchet: Hatchet;
    let worker: Worker;
    let plane: Awaited<ReturnType<typeof generatePlaneKeyPair>>;
    /** What the stub fn observed, keyed by threadId. */
    const seen = new Map<
      string,
      { input: AgentRunWireInput; secrets?: RunSecrets; error?: string }
    >();
    const logLines: string[] = [];

    const uid = (p: string) =>
      `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    async function stubRun(
      wire: AgentRunWireInput,
      ctx: { log: (m: string) => void },
    ): Promise<{ threadId: string; outcome: string }> {
      const log = (m: string) => {
        logLines.push(m);
        ctx.log(m);
      };
      try {
        const { input, secrets, source } = await resolveRunSecrets({
          wire,
          keys: [plane.privateKey],
        });
        log(`[agent-run ${input.threadId}] run secrets: ${source}`);
        seen.set(wire.threadId, { input, secrets });
        return { threadId: input.threadId, outcome: "completed" };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log(`[agent-run ${wire.threadId}] ${message}`);
        seen.set(wire.threadId, { input: wire, error: message });
        if (e instanceof PayloadSealError) throw e;
        throw new Error(message);
      }
    }

    async function dispatch(input: AgentRunWireInput) {
      const res = await fetch(
        `${REST}/api/v1/stable/tenants/${tenantId}/workflow-runs/trigger`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            workflowName: "agent-run",
            input,
            additionalMetadata: {
              threadId: input.threadId,
              threadChatId: input.threadChatId,
            },
          }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        run?: { metadata?: { id?: string } };
      };
      return { id: body.run?.metadata?.id ?? "", status: res.status };
    }

    const statusOf = async (id: string): Promise<Status> => {
      try {
        return await hatchet.runs.get_status(id);
      } catch (e) {
        if ((e as { response?: { status?: number } }).response?.status === 404)
          return Status.QUEUED;
        throw e;
      }
    };
    const trajectory: string[] = [];
    const waitTerminal = (id: string) =>
      pollUntil(
        `${id} terminal`,
        async () => {
          const s = await statusOf(id);
          if (trajectory.at(-1) !== `${id}:${s}`) trajectory.push(`${id}:${s}`);
          return s;
        },
        (s) => TERMINAL.includes(s),
      );

    /**
     * Every engine (table, column) that persists a task input: hatchet-lite
     * v1 keeps it in `v1_task.input` (jsonb) AND in the day-partitioned
     * payload stores (`v1_payload*.inline_content`, `v1_payloads_olap*`).
     * Discovered from the catalog, not hard-coded, so an engine upgrade that
     * adds a store cannot silently drop out of the scan.
     */
    async function payloadColumns(): Promise<
      Array<{ table: string; column: string }>
    > {
      const r = await pg.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'public'
           AND column_name IN ('inline_content', 'input')
           AND data_type IN ('jsonb', 'json', 'text')
         ORDER BY table_name, column_name`,
      );
      return r.rows.map((x) => ({
        table: x.table_name,
        column: x.column_name,
      }));
    }

    beforeAll(async () => {
      plane = await generatePlaneKeyPair("plane-it");
      await composeUp();
      pg = await connectPg();
      ({ tenantId, token } = await bootstrapTenant(pg));
      process.env.HATCHET_CLIENT_TOKEN = token;
      process.env.HATCHET_CLIENT_TLS_STRATEGY = "none";
      const sdk = await import("@hatchet-dev/typescript-sdk");
      hatchet = sdk.Hatchet.init();
      const def = buildAgentRunDefinition(
        "agent-run",
        AGENT_RUN_VARIANTS["agent-run"],
      );
      const wf = hatchet.workflow<AgentRunWireInput>(def.workflow);
      wf.task({ ...def.task, fn: stubRun });
      worker = await hatchet.worker("it-seal-worker", {
        workflows: [wf],
        slots: 2,
      });
      void worker.start();
      await worker.waitUntilReady(60_000);
    }, 240_000);

    afterAll(async () => {
      await worker?.stop().catch(() => {});
      await pg?.end().catch(() => {});
      await composeDownV();
    }, 90_000);

    it("a sealed dispatch completes with the worker holding the unsealed secrets, and the engine's payload rows hold ciphertext only", async () => {
      const threadId = uid("thr-sealed");
      const threadChatId = "tc_it";
      const input: AgentRunWireInput = {
        threadId,
        threadChatId,
        repoFullName: "o/r",
        branch: "main",
        daemonCallbackUrl: "https://www.example.com",
        orgId: "org-it",
        sealedSecrets: await sealRunSecrets(
          plane.publicKey,
          SECRETS,
          threadChatId,
        ),
      };
      const run = await dispatch(input);
      expect(run.status).toBe(200);
      expect(run.id).not.toBe("");
      expect(await waitTerminal(run.id)).toBe(Status.COMPLETED);
      const observed = seen.get(threadId);
      expect(
        observed?.secrets,
        `stub observations: ${JSON.stringify([...seen.keys()])}; status trajectory: ${trajectory.join(" → ")}; journal: ${logLines.join(" | ")}`,
      ).toEqual(SECRETS);
      for (const field of [
        "installationToken",
        "githubReadToken",
        "daemonToken",
      ]) {
        expect(observed?.input).not.toHaveProperty(field);
      }

      // AC 2/3 at the engine: every payload table, zero rows with a secret;
      // at least one row with this run's envelope.
      const stores = await payloadColumns();
      expect(stores.map((s) => `${s.table}.${s.column}`)).toEqual(
        expect.arrayContaining(["v1_task.input", "v1_payload.inline_content"]),
      );
      let envelopeRows = 0;
      for (const { table, column } of stores) {
        const bad = await pg.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM "${table}"
           WHERE ${SECRET_NEEDLES.map((_, i) => `"${column}"::text LIKE $${i + 1}`).join(" OR ")}`,
          SECRET_NEEDLES.map((s) => `%${s}%`),
        );
        expect(Number(bad.rows[0]?.n), `${table}.${column}`).toBe(0);
        const good = await pg.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM "${table}"
           WHERE "${column}"::text LIKE $1 AND "${column}"::text LIKE $2`,
          [`%${threadId}%`, `%"sealedSecrets"%`],
        );
        envelopeRows += Number(good.rows[0]?.n);
      }
      expect(envelopeRows).toBeGreaterThan(0);

      // AC 8: the worker's own journal, scanned by the shared redactor — a
      // line that redacts to something else carried a token-shaped value.
      for (const line of logLines) {
        expect(redactSecrets(line)).toBe(line);
        for (const v of [
          SECRETS.installationToken,
          SECRETS.githubReadToken,
          SECRETS.daemonToken,
        ]) {
          expect(line).not.toContain(v);
        }
      }
    });

    it("an envelope sealed to a key the ring does not hold FAILS the run with kid + reason, and the engine's stored error holds no secret", async () => {
      const foreign = await generatePlaneKeyPair("plane-foreign");
      const threadId = uid("thr-foreign");
      const input: AgentRunWireInput = {
        threadId,
        threadChatId: "tc_it",
        repoFullName: "o/r",
        branch: "main",
        daemonCallbackUrl: "https://www.example.com",
        orgId: "org-it",
        sealedSecrets: await sealRunSecrets(
          foreign.publicKey,
          SECRETS,
          "tc_it",
        ),
      };
      const run = await dispatch(input);
      expect(run.status).toBe(200);
      expect(await waitTerminal(run.id)).toBe(Status.FAILED);
      expect(seen.get(threadId)?.error).toBe(
        "payload-seal: unseal failed (kid=plane-foreign, reason=unknown-kid)",
      );
      expect(seen.get(threadId)?.secrets).toBeUndefined();
      // The engine persisted the failure: its error text names kid + reason
      // only. (The OLAP event rows carry the task's error message.)
      const events = await pollUntil(
        "engine error rows for the failed run",
        async () => {
          const r = await pg.query<{ error_message: string | null }>(
            `SELECT error_message FROM v1_task_events_olap
             WHERE error_message IS NOT NULL AND error_message LIKE '%plane-foreign%'`,
          );
          return r.rows.map((x) => x.error_message ?? "");
        },
        (rows) => rows.length > 0,
        30_000,
        500,
      );
      for (const text of events) {
        expect(text).toContain("reason=unknown-kid");
        for (const v of [
          SECRETS.installationToken,
          SECRETS.githubReadToken,
          SECRETS.daemonToken,
        ]) {
          expect(text).not.toContain(v);
        }
        expect(text).not.toContain(plane.privateKey.privateKeyJwk.d);
      }
    });
  },
);
