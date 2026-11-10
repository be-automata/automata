import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";
import { readCellPolicyWasm } from "@terragon/shared/cell-policy/cell-policy-file";
import {
  CELL_FIELDS,
  type CellPolicyInput,
} from "@terragon/shared/cell-policy/cell-policy";

/**
 * ADR-014 step 5: the allow_cell WASM runs under workerd, loaded the way
 * apps/www/worker-entry.ts loads it (a static `.wasm` import precompiled by
 * wrangler, registered on a global), including the host-provided
 * time.parse_rfc3339_ns builtin.
 *
 * Card: protects=the policy loads and decides under workerd;
 * fails_when=wrangler stops bundling .wasm as a Module, opa-wasm needs an API
 * workerd lacks, or the custom time builtin breaks there;
 * no_claim=nothing about the deployed OpenNext bundle (the fixture is a plain
 * module worker on www's compatibility date + nodejs_compat, as for
 * payload-seal.workerd.test.ts).
 */

const FIXTURES = join(__dirname, "__fixtures__");

type Reply =
  | {
      ok: true;
      decision: { allowed: boolean; reasons: string[] };
      runtime: string;
    }
  | { ok: true; compiled: true }
  | { ok: false; message: string };

const server = Object.fromEntries(CELL_FIELDS.map((f) => [f, "server"]));

const enforceBox: CellPolicyInput = {
  now: "2026-11-10T12:00:00Z",
  cell: {
    data_class: "internal",
    repo_visibility: "private",
    untrusted_content: true,
    irreversible: false,
    lane: "review",
    secrets: ["daemonToken", "installationToken"],
    needs_egress: ["www.example.com", "api.anthropic.com"],
  },
  provenance: server,
  profile: {
    id: "automata-box/enforce",
    provider: "automata-box",
    tier: "customer_box",
    configuration: { egress_mode: "enforce" },
    capabilities: {
      egress: "allowlist",
      egress_allowlist: ["www.example.com", "api.anthropic.com"],
      dns_closed: true,
      metadata_blocked: true,
      peer_isolated: true,
      teardown_verified: true,
      secret_brokering: true,
      provider_creds_in_guest: false,
    },
    evidence: {
      source: "conformance",
      measured_at: "2026-11-01T00:00:00Z",
      expires_at: "2026-12-01T00:00:00Z",
    },
  },
};

describe("allow_cell WASM under workerd (ADR-014 step 5)", () => {
  let worker: Unstable_DevWorker;

  const call = async (body: unknown): Promise<Reply> => {
    const res = await worker.fetch("http://cell-policy.test/", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return (await res.json()) as Reply;
  };

  beforeAll(async () => {
    worker = await unstable_dev(
      join(FIXTURES, "cell-policy-workerd.worker.ts"),
      {
        config: join(FIXTURES, "cell-policy-workerd.wrangler.jsonc"),
        experimental: { disableExperimentalWarning: true },
        local: true,
        logLevel: "error",
      },
    );
  }, 90_000);

  afterAll(async () => {
    await worker?.stop();
  });

  it("allows the box in enforce mode with current evidence", async () => {
    const reply = await call({ op: "evaluate", input: enforceBox });
    expect(reply).toMatchObject({
      ok: true,
      decision: { allowed: true, reasons: [] },
      runtime: "Cloudflare-Workers",
    });
  });

  it("denies with evidence_expired once the clock passes expiry", async () => {
    const reply = await call({
      op: "evaluate",
      input: { ...enforceBox, now: "2026-12-02T00:00:00Z" },
    });
    expect(reply).toMatchObject({
      ok: true,
      decision: { allowed: false, reasons: ["evidence_expired"] },
    });
  });

  it("denies the box in observe mode as open egress", async () => {
    const reply = await call({
      op: "evaluate",
      input: {
        ...enforceBox,
        profile: {
          ...enforceBox.profile,
          configuration: { egress_mode: "observe" },
        },
      },
    });
    expect(reply).toMatchObject({
      ok: true,
      decision: { allowed: false, reasons: ["egress_open"] },
    });
  });

  it("workerd refuses to compile WASM bytes at runtime (why the import is static)", async () => {
    const bytes = await readCellPolicyWasm();
    const reply = await call({
      op: "compileBytes",
      base64: Buffer.from(bytes).toString("base64"),
    });
    expect(reply.ok).toBe(false);
  });
});
