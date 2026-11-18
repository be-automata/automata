import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  CELL_DAEMON_TOKEN_HEADER,
  CELL_DAEMON_TOKEN_PLACEHOLDER,
  type CellVaultEntry,
  type OpenSandboxCellCreatePlan,
  type OpenSandboxNetworkPolicy,
  type OpenSandboxNetworkRule,
} from "@terragon/types/cell";

import { reconcileExpiredCells } from "../cell/reconcile";
import { createOpenSandboxCellProvider } from "./opensandbox-cell";
import {
  buildConformanceEvidence,
  RUNC_REQUIRED_CHECKS,
  type ConformanceChecks,
  type RuncCheckName,
} from "../cell/conformance-evidence";
import {
  API_BASE_URL,
  dind,
  GUEST_ENTRYPOINT,
  GUEST_IMAGE,
  newStepKey,
  parseProbeOutput,
  probeArgv,
  type ProbeResult,
  type ProbeSpec,
  lines,
  rawApi,
  readApiKey,
  sleep,
  type DindSnapshot,
  scanHostSide,
  SELF_CHECK_ARGV,
  settledSnapshot,
  SILENT_LOGGER,
  snapshot,
  stateDir,
  encodeSecret,
} from "./opensandbox-it/harness";

/**
 * #634 S3: the OpenSandbox adapter against a real OpenSandbox 1.2.1 server in
 * a throwaway dind (`opensandbox-it/up.sh`). Opt-in, outside the Claude
 * sandbox (it needs the Docker socket):
 *   OPENSANDBOX_IT=1 pnpm --filter @terragon/sandbox exec vitest run \
 *     --no-file-parallelism src/providers/opensandbox-cell.integration.test.ts
 * OPENSANDBOX_IT_REUSE=1 skips up.sh; OPENSANDBOX_IT_KEEP=1 skips down.sh.
 * Evidence for the runc profile is written only when every scenario passed.
 */

const IT = process.env.OPENSANDBOX_IT === "1";

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
const TIMEOUT_MS = 10 * 60 * 1000;
const EXEC_TIMEOUT_MS = 120_000;
const IT_DIR = join(__dirname, "..", "..", "opensandbox-it");

/** The deployment tag every IT cell carries; the reconciler lists with it. */
const IT_DEPLOYMENT = "osbit.test";

const ALLOWED = "httpbin.org";
const MODEL_HOST = "api.anthropic.com";
/**
 * Runs a harness script without blocking the event loop: a synchronous spawn
 * of up.sh (minutes of image pulls) starves vitest's worker RPC.
 */
function runScript(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [join(IT_DIR, name)], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`)),
    );
  });
}

const DENY_80: OpenSandboxNetworkRule = { action: "deny", ports: [80] };

function policy(...targets: string[]): OpenSandboxNetworkPolicy {
  return {
    defaultAction: "deny",
    egress: [
      ...targets.map(
        (target): OpenSandboxNetworkRule => ({ action: "allow", target }),
      ),
      DENY_80,
    ],
  };
}

const P_ONE = policy(ALLOWED);
const P_CRED = policy(ALLOWED, MODEL_HOST);
const P_WILD = policy("*.github.com", "github.com");
const P_101 = policy(
  ...Array.from(
    { length: 99 },
    (_, i) => `h${String(i).padStart(3, "0")}.${ALLOWED}`,
  ),
  ALLOWED,
);

/** Stand-ins: A for the broker bearer, B for the model token. */
const CANARY_A = `osbit-canary-${randomBytes(8).toString("hex")}`;
const CANARY_B = `osbit-canary-${randomBytes(8).toString("hex")}`;
const CANARY_C = `osbit-canary-${randomBytes(8).toString("hex")}`;
const DAEMON_HEADER = CELL_DAEMON_TOKEN_HEADER;
/**
 * The production daemon binding (`buildDaemonVaultEntry` in
 * `packages/shared/src/model/cell-create-plan.ts`), with this test's host and
 * path. The header and placeholder are the production constants from
 * @terragon/types; the entry's other fields are pinned by the plan builder's
 * exact-shape test (sandbox cannot import shared, which dev-depends on it).
 */
const DAEMON_PLACEHOLDER = CELL_DAEMON_TOKEN_PLACEHOLDER;
const DAEMON_PATH = "/anything/daemon-event";
const DAEMON_ENTRY: CellVaultEntry = {
  name: "daemon",
  hosts: [ALLOWED],
  paths: [DAEMON_PATH],
  auth: "apiKey",
  header: DAEMON_HEADER,
  credential: CANARY_C,
  placeholder: DAEMON_PLACEHOLDER,
};
const VAULT: CellVaultEntry[] = [
  {
    name: "probe",
    hosts: [ALLOWED],
    paths: ["/bearer"],
    auth: "bearer",
    credential: CANARY_A,
  },
  { name: "model", hosts: [MODEL_HOST], auth: "bearer", credential: CANARY_B },
];

function plan(
  scenario: string,
  networkPolicy: OpenSandboxNetworkPolicy,
  vault: CellVaultEntry[] = [],
  expiresAt?: number,
): OpenSandboxCellCreatePlan {
  const ttlMs = 15 * 60 * 1000;
  return {
    provider: "opensandbox",
    runtime: "runc",
    tags: {
      automata: "cell",
      worker: "osbit",
      epoch: "1",
      deployment: IT_DEPLOYMENT,
      stepKey: newStepKey(scenario),
      attempt: "1",
      expiresAt: String(expiresAt ?? Date.now() + ttlMs),
    },
    networkPolicy,
    vault,
    resources: { cpu: 1, memoryMiB: 512 },
    ttlMs,
    egressDigest: `osbit-${scenario}`,
    profileId: "opensandbox/runc",
  };
}

const CHECKS: ConformanceChecks = {
  egress_enforced: [],
  metadata_blocked: [],
  peer_isolated: [],
  teardown_verified: [],
  secret_brokering: [],
  provider_creds_in_guest: [],
  provider_endpoints_reachable: [],
};
const RESULTS: Record<string, unknown> = {};
const NOTES: Record<string, unknown> = {};

/** Records a check for the evidence, then asserts it (a failure stops the `it`). */
function check<G extends keyof ConformanceChecks>(
  group: G,
  name: RuncCheckName<G>,
  ok: boolean,
  detail?: unknown,
): void {
  CHECKS[group].push({ name, ok });
  RESULTS[name] = { ok, detail };
  expect(ok, `${group}.${name} ${JSON.stringify(detail ?? null)}`).toBe(true);
}

/**
 * Network error kinds the probe reports. Anything else (a probe bug such as
 * `probe:KeyError`, `unknown_kind`, or no error at all) is never "blocked".
 */
const NETWORK_ERROR =
  /^(TimeoutError|timeout|URLError|gaierror|OSError|ConnectionRefusedError|ConnectionResetError|ConnectionAbortedError|BrokenPipeError|SSLError|SSLCertVerificationError|SSLEOFError|SSLZeroReturnError|RemoteDisconnected|IncompleteRead)\b/;

/**
 * Blocked: the probe failed with a network error (refused, reset, timeout,
 * TLS). Any HTTP status counts as reached, even a 5xx: an upstream such as
 * httpbin.org answers 502/503 itself, so a status cannot tell the proxy's
 * refusal from a real reach. The credential proxy answers TCP handshakes on
 * :80 and :443, so those ports are probed with real HTTP/TLS requests.
 */
function blocked(r: ProbeResult | undefined): boolean {
  return r !== undefined && r.ok === false && NETWORK_ERROR.test(r.err ?? "");
}

/** Names the guest legitimately carries (the sandbox id, a proxy mode flag). */
const KNOWN_GUEST_PROVIDER_ENV = new Set([
  "OPENSANDBOX_ID",
  "OPENSANDBOX_EGRESS_MITMPROXY_TRANSPARENT",
]);

function brief(r: ProbeResult | undefined): Record<string, unknown> {
  return r ? { ok: r.ok, err: r.err, status: r.status, ms: r.ms } : {};
}

describe(
  "OpenSandbox cell adapter against a real server (OPENSANDBOX_IT)",
  { skip: !IT, timeout: TIMEOUT_MS },
  () => {
    vi.setConfig({ testTimeout: TIMEOUT_MS, hookTimeout: TIMEOUT_MS });

    let provider: ReturnType<typeof createOpenSandboxCellProvider>;
    let exampleIp = "";
    let baseline: DindSnapshot | undefined;
    let anyFailed = false;
    const live = new Set<string>();
    const evidenceFile = (): string =>
      join(stateDir(), "opensandbox-runc-conformance.json");

    afterEach((ctx) => {
      if (ctx.task.result?.state !== "pass") anyFailed = true;
    });

    async function create(p: OpenSandboxCellCreatePlan): Promise<string> {
      const { cellId } = await provider.create(p);
      live.add(cellId);
      return cellId;
    }

    async function destroy(cellId: string): Promise<void> {
      await provider.teardown(cellId);
      live.delete(cellId);
    }

    async function probe(
      cellId: string,
      probes: ProbeSpec[],
    ): Promise<ProbeResult[]> {
      const r = await provider.exec(cellId, probeArgv(probes), {
        timeoutMs: EXEC_TIMEOUT_MS,
      });
      expect(r.exitCode, "probe exit").toBe(0);
      return parseProbeOutput(r.stdout);
    }

    async function containersOf(cellId: string): Promise<string[]> {
      const names = await lines([
        "docker",
        "ps",
        "-a",
        "--format",
        "{{.Names}}",
      ]);
      return names.filter((n) => n.includes(cellId));
    }

    async function sidecarIp(cellId: string): Promise<string> {
      const names = await containersOf(cellId);
      const sidecar = names.find((n) => n.includes("egress"));
      if (!sidecar) throw new Error("no sidecar container for the cell");
      const r = await dind([
        "docker",
        "inspect",
        sidecar,
        "--format",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}",
      ]);
      const ip = r.stdout.trim().split(/\s+/)[0];
      if (!ip) throw new Error("sidecar has no IP");
      return ip;
    }

    beforeAll(async () => {
      // First, before anything that can fail: a stale file from an earlier
      // passing run must not outlive this one.
      rmSync(evidenceFile(), { force: true });
      if (process.env.OPENSANDBOX_IT_REUSE !== "1") {
        await runScript("up.sh");
      }
      provider = createOpenSandboxCellProvider(
        {
          baseUrl: API_BASE_URL,
          apiKey: readApiKey(),
          image: GUEST_IMAGE,
          entrypoint: GUEST_ENTRYPOINT,
          selfCheck: { argv: SELF_CHECK_ARGV },
          readyTimeoutMs: 180_000,
        },
        {
          fetch,
          sleep,
          now: () => Date.now(),
          logger: SILENT_LOGGER,
        },
      );
      exampleIp = (await lookup("example.org", { family: 4 })).address;
      baseline = await snapshot();
      expect(baseline.networks.length, "baseline networks").toBeGreaterThan(0);
      expect(baseline.netfilter.length, "baseline netfilter").toBeGreaterThan(
        0,
      );
    });

    afterAll(async () => {
      await Promise.allSettled([...live].map((id) => provider.teardown(id)));
      if (process.env.OPENSANDBOX_IT_KEEP !== "1") {
        await runScript("down.sh");
      }
    });

    it("AC-3: only the allowed host is reachable, on :443 only", async () => {
      const id = await create(plan("enforce", P_ONE));
      try {
        const [gw, ...r] = await probe(id, [
          { kind: "gateway" },
          { kind: "https", url: `https://${ALLOWED}/get` },
          { kind: "http", url: `http://${ALLOWED}/get` },
          { kind: "dns", host: "example.org" },
          { kind: "tls_ip", ip: exampleIp, sni: "example.org" },
          { kind: "http", url: `http://${exampleIp}/` },
          { kind: "tcp", host: "1.1.1.1", port: 853 },
          { kind: "https", url: "https://1.1.1.1/dns-query?name=example.org" },
          {
            kind: "http",
            url: "http://169.254.169.254/latest/meta-data/",
          },
          { kind: "http", url: "http://@gateway:8090/health" },
          { kind: "http", url: "http://127.0.0.1:18080/policy" },
          {
            kind: "http",
            url: "http://127.0.0.1:18080/credential-vault",
          },
          { kind: "http", url: "http://127.0.0.1:18080/healthz" },
        ]);
        check(
          "provider_endpoints_reachable",
          "guest_gateway_found",
          gw?.ok === true && typeof gw.gateway === "string",
          { gateway: gw?.gateway },
        );
        check(
          "egress_enforced",
          "allowed_https_200",
          r[0]?.status === 200,
          brief(r[0]),
        );
        check(
          "egress_enforced",
          "allowed_80_blocked",
          blocked(r[1]),
          brief(r[1]),
        );
        check(
          "egress_enforced",
          "denied_dns_nxdomain",
          // gaierror = the resolver answered "no such name"; a timeout is not.
          blocked(r[2]) && (r[2]?.err ?? "").startsWith("gaierror"),
          brief(r[2]),
        );
        check(
          "egress_enforced",
          "denied_ip_tls_blocked",
          blocked(r[3]),
          brief(r[3]),
        );
        check(
          "egress_enforced",
          "denied_ip_80_blocked",
          blocked(r[4]),
          brief(r[4]),
        );
        check("egress_enforced", "dot_blocked", blocked(r[5]), brief(r[5]));
        check(
          "egress_enforced",
          "doh_by_ip_blocked",
          blocked(r[6]),
          brief(r[6]),
        );
        check(
          "metadata_blocked",
          "metadata_169_254_blocked",
          blocked(r[7]),
          brief(r[7]),
        );
        check(
          "provider_endpoints_reachable",
          "server_api_at_gateway_blocked",
          blocked(r[8]),
          brief(r[8]),
        );
        const refused = (x: ProbeResult | undefined): boolean =>
          blocked(x) || x?.status === 401 || x?.status === 403;
        check(
          "provider_endpoints_reachable",
          "sidecar_policy_api_refuses_guest",
          refused(r[9]),
          brief(r[9]),
        );
        check(
          "provider_endpoints_reachable",
          "sidecar_vault_api_refuses_guest",
          refused(r[10]),
          brief(r[10]),
        );
        NOTES.sidecar_healthz_from_guest = brief(r[11]);
      } finally {
        await destroy(id);
      }
    });

    it("live API: exec exit codes, argv, cwd, copyOut, listByTags", async () => {
      const p = plan("api", P_ONE);
      const id = await create(p);
      try {
        const exit7 = await provider.exec(id, ["sh", "-c", "exit 7"]);
        expect(exit7.exitCode).toBe(7);
        const argv = await provider.exec(id, ["printf", "%s|", "a b", "c'd"]);
        expect(argv.stdout).toBe("a b|c'd|");
        const cwd = await provider.exec(id, ["pwd"], { cwd: "/tmp" });
        expect(cwd.stdout.trim()).toBe("/tmp");
        const made = await provider.exec(id, [
          "sh",
          "-c",
          "head -c 1048576 /dev/urandom > /tmp/f && sha256sum /tmp/f",
        ]);
        expect(made.exitCode).toBe(0);
        const bytes = await provider.copyOut(id, "/tmp/f");
        expect(bytes.byteLength).toBe(1048576);
        const digest = sha256Hex(bytes);
        expect(made.stdout.split(/\s+/)[0]).toBe(digest);
        const found = await provider.listByTags({ stepKey: p.tags.stepKey });
        expect(found.map((f) => f.cellId)).toEqual([id]);
      } finally {
        await destroy(id);
      }
    });

    it("peer isolation: one cell cannot reach another", async () => {
      const [a, b] = await Promise.all([
        create(plan("peer-a", P_ONE)),
        create(plan("peer-b", P_ONE)),
      ]);
      try {
        const ipB = await sidecarIp(b);
        const r = await probe(a, [
          { kind: "tcp", host: ipB, port: 44772 },
          { kind: "http", url: `http://${ipB}/` },
        ]);
        check(
          "peer_isolated",
          "peer_execd_blocked",
          blocked(r[0]),
          brief(r[0]),
        );
        check("peer_isolated", "peer_80_blocked", blocked(r[1]), brief(r[1]));
      } finally {
        await Promise.allSettled([destroy(a), destroy(b)]);
      }
    });

    it("wildcard and a 101-rule policy are accepted and enforced", async () => {
      expect(P_101.egress).toHaveLength(101);
      const [wild, big] = await Promise.all([
        create(plan("wild", P_WILD)),
        create(plan("p101", P_101)),
      ]);
      try {
        const r = await probe(wild, [
          { kind: "https", url: "https://github.com/" },
          { kind: "https", url: "https://api.github.com/" },
          { kind: "https", url: "https://gitlab.com/" },
        ]);
        const answered = (x: ProbeResult | undefined): boolean =>
          x?.status !== undefined && x.status < 500;
        check(
          "egress_enforced",
          "wildcard_apex_allowed",
          answered(r[0]),
          brief(r[0]),
        );
        check(
          "egress_enforced",
          "wildcard_sub_allowed",
          answered(r[1]),
          brief(r[1]),
        );
        check(
          "egress_enforced",
          "wildcard_sibling_blocked",
          blocked(r[2]),
          brief(r[2]),
        );
        const r101 = await probe(big, [
          { kind: "https", url: `https://${ALLOWED}/get` },
        ]);
        check(
          "egress_enforced",
          "policy_101_rules_enforced",
          r101[0]?.status === 200,
          brief(r101[0]),
        );
      } finally {
        await Promise.allSettled([destroy(wild), destroy(big)]);
      }
    });

    it("AC-6: no secret reaches the guest, the container config or the logs", async () => {
      const id = await create(plan("canary", P_CRED, VAULT));
      try {
        const r = await probe(id, [
          {
            kind: "canary_scan",
            canaries: [CANARY_A, CANARY_B],
            namePattern: "OPEN.?SANDBOX|EGRESS|VAULT",
          },
        ]);
        const scan = r[0];
        expect(scan?.ok, "canary scan ran").toBe(true);
        // A scan that could read no other process proves nothing.
        expect(scan?.pid1, "scan read pid 1").toBe(true);
        expect(scan?.scanned ?? 0, "processes scanned").toBeGreaterThan(1);
        check(
          "secret_brokering",
          "guest_proc_has_no_secret",
          (scan?.found ?? [true]).every((f) => f === false),
          { found: scan?.found },
        );
        check(
          "provider_creds_in_guest",
          "guest_env_has_no_provider_names",
          scan?.envNames !== undefined &&
            scan.envNames.every((n) => KNOWN_GUEST_PROVIDER_ENV.has(n)),
          { envNames: scan?.envNames },
        );
        const names = await containersOf(id);
        expect(
          names.length,
          "workload and sidecar found",
        ).toBeGreaterThanOrEqual(2);
        expect(
          names.some((n) => n.includes("egress")),
          "sidecar found",
        ).toBe(true);
        const host = await scanHostSide(names, [
          encodeSecret(CANARY_A),
          encodeSecret(CANARY_B),
        ]);
        expect(host.containers, "containers scanned").toBe(names.length);
        expect(host.inspectBytes, "inspect output scanned").toBeGreaterThan(0);
        expect(host.logBytes, "log output scanned").toBeGreaterThan(0);
        check(
          "secret_brokering",
          "inspect_has_no_secret",
          host.inspect.every((f) => !f),
          host,
        );
        check(
          "secret_brokering",
          "logs_have_no_secret",
          host.logs.every((f) => !f),
          host,
        );
      } finally {
        await destroy(id);
      }
    });

    it("AC-5: revoke, quarantine and delete each take effect; nothing survives", async () => {
      const before = await snapshot();
      // The teardown()-only cell is made alongside, so both are measured
      // against the snapshot taken before either existed.
      const [id, other] = await Promise.all([
        create(plan("revoke", P_CRED, VAULT)),
        create(plan("teardown", P_CRED, VAULT)),
      ]);
      let deleted = false;
      try {
        const pre = await probe(id, [
          { kind: "https", url: `https://${ALLOWED}/bearer`, marker: CANARY_A },
          { kind: "dns", host: ALLOWED },
        ]);
        check(
          "secret_brokering",
          "vault_injects_bearer",
          pre[0]?.status === 200,
          brief(pre[0]),
        );
        NOTES.upstream_echoes_secret = pre[0]?.bodyHasMarker;
        const learnedIp = pre[1]?.ips?.[0];
        expect(learnedIp, "learned IP").toBeDefined();

        await provider.revoke(id);
        const revoked = await probe(id, [
          { kind: "https", url: `https://${ALLOWED}/bearer` },
          { kind: "https", url: `https://${MODEL_HOST}/v1/models` },
        ]);
        check(
          "teardown_verified",
          "after_revoke_bearer_401",
          revoked[0]?.status === 401,
          brief(revoked[0]),
        );
        // Recorded only: a fake model token is 401 before revoke as well.
        NOTES.after_revoke_model_status = brief(revoked[1]);

        await provider.quarantine(id);
        const quarantined = await probe(id, [
          { kind: "https", url: `https://${ALLOWED}/get` },
          { kind: "tls_ip", ip: learnedIp ?? "0.0.0.0", sni: ALLOWED },
        ]);
        check(
          "teardown_verified",
          "after_quarantine_host_blocked",
          blocked(quarantined[0]),
          brief(quarantined[0]),
        );
        check(
          "teardown_verified",
          "after_quarantine_learned_ip_blocked",
          blocked(quarantined[1]),
          brief(quarantined[1]),
        );

        check(
          "teardown_verified",
          "delete_deleted",
          (await provider.delete(id)) === "deleted",
        );
        deleted = true;
        live.delete(id);
        check(
          "teardown_verified",
          "second_delete_gone",
          (await provider.delete(id)) === "gone",
        );
      } finally {
        if (!deleted) await destroy(id);
      }

      await destroy(other);
      const after = await settledSnapshot(before, 30_000);
      check("teardown_verified", "no_survivors", after.settled, {
        before,
        after: after.snapshot,
      });
      // Nothing from any earlier scenario survives either (AC-8 runs after:
      // its no-policy sandbox leaks a netns upstream).
      const run = await settledSnapshot(baseline ?? (await snapshot()), 30_000);
      check("teardown_verified", "run_baseline_restored", run.settled, {
        baseline,
        now: run.snapshot,
      });
    });

    it("AC-7: the reconciler reaps an expired cell after a server restart, with no worker", async () => {
      // Clear leftovers of earlier scenarios first (a no-op revoke: they have
      // no control-plane step), so the real pass below sees only X and Y.
      const clearing = await reconcileExpiredCells({
        provider,
        revoke: async () => undefined,
        now: () => Date.now(),
        logger: SILENT_LOGGER,
        limit: 1000,
        deployment: IT_DEPLOYMENT,
      });
      NOTES.reconcile_leftovers_before_ac7 = clearing;

      const expiredPlan = plan("reap-x", P_CRED, [], Date.now() - 1000);
      const livePlan = plan("reap-y", P_CRED, [], Date.now() + 10 * 60 * 1000);
      const x = await create(expiredPlan);
      const y = await create(livePlan);
      try {
        const restart = await dind(["docker", "restart", "osb-server"], {
          timeoutMs: 120_000,
        });
        expect(restart.exitCode, "server restart").toBe(0);
        const deadline = Date.now() + 120_000;
        let healthy = false;
        while (!healthy && Date.now() < deadline) {
          try {
            const res = await fetch(`${API_BASE_URL}/health`, {
              signal: AbortSignal.timeout(5_000),
            });
            healthy = res.ok;
          } catch {
            healthy = false;
          }
          if (!healthy) await sleep(1_000);
        }
        expect(healthy, "server healthy after restart").toBe(true);

        // One ordered log of what the reconciler did, in call order.
        const events: string[] = [];
        const recording = {
          listByTags: provider.listByTags.bind(provider),
          teardown: async (cellId: string) => {
            events.push(`teardown:${cellId}`);
            await provider.teardown(cellId);
          },
        };
        const result = await reconcileExpiredCells({
          provider: recording,
          revoke: async (stepKey, attempt) => {
            events.push(`revoke:${stepKey}:${attempt}`);
          },
          now: () => Date.now(),
          logger: SILENT_LOGGER,
          deployment: IT_DEPLOYMENT,
        });
        live.delete(x);
        NOTES.reconcile_result_ac7 = result;

        // Only X's and Y's own calls are asserted; other cells are not ours.
        const xKey = expiredPlan.tags.stepKey;
        const yKey = livePlan.tags.stepKey;
        const xEvents = events.filter(
          (e) => e === `revoke:${xKey}:1` || e === `teardown:${x}`,
        );
        const revokedBeforeTeardown =
          xEvents.length === 2 &&
          xEvents[0] === `revoke:${xKey}:1` &&
          xEvents[1] === `teardown:${x}`;
        const yUntouched = !events.some(
          (e) => e.includes(yKey) || e === `teardown:${y}`,
        );
        const gone = (await provider.delete(x)) === "gone";
        const xListed = await provider.listByTags({ stepKey: xKey });
        const yListed = (await provider.listByTags({})).some(
          (c) => c.cellId === y,
        );
        check(
          "teardown_verified",
          "reconciler_reaped_expired_after_restart",
          revokedBeforeTeardown &&
            yUntouched &&
            gone &&
            xListed.length === 0 &&
            yListed &&
            result.failed === 0,
          {
            revokedBeforeTeardown,
            yUntouched,
            gone,
            xListed: xListed.length,
            yListed,
            failed: result.failed,
          },
        );
      } finally {
        await destroy(y);
      }
    });

    it("daemon apiKey: the proxy replaces the placeholder, only on the exact path", async () => {
      const id = await create(plan("daemon-apikey", P_CRED, [DAEMON_ENTRY]));
      try {
        const markers = [CANARY_C, DAEMON_PLACEHOLDER];
        const post = (path: string, withHeader: boolean): ProbeSpec => ({
          kind: "https_headers",
          url: `https://${ALLOWED}${path}`,
          headers: withHeader ? { [DAEMON_HEADER]: DAEMON_PLACEHOLDER } : {},
          markers,
        });
        const r = await probe(id, [
          post(DAEMON_PATH, true),
          post(DAEMON_PATH, false),
          post("/anything/daemon/cell-plan", true),
          post(`${DAEMON_PATH}/x`, true),
          post(`${DAEMON_PATH}x`, true),
        ]);
        // Both markers are tested: httpbin joins a repeated header, so an
        // append (`P,CANARY_C`) would still contain CANARY_C.
        const [canary, placeholder] = r[0]?.markersFound ?? [];
        NOTES.daemon_apikey_replaced = { ...brief(r[0]), canary, placeholder };
        NOTES.daemon_apikey_header_absent = {
          ...brief(r[1]),
          markersFound: r[1]?.markersFound,
        };
        const nearMiss = r.slice(2).map((x) => ({
          ...brief(x),
          markersFound: x.markersFound,
        }));
        NOTES.daemon_apikey_near_miss = nearMiss;
        expect(
          r[0]?.status === 200 && canary === true && placeholder === false,
          `replaced, not appended ${JSON.stringify(NOTES.daemon_apikey_replaced)}`,
        ).toBe(true);
        expect(
          r.slice(2).every((x) => {
            const [c, p] = x.markersFound ?? [];
            return x.ok && x.status === 200 && c === false && p === true;
          }),
          `exact path ${JSON.stringify(nearMiss)}`,
        ).toBe(true);

        const scan = (
          await probe(id, [
            { kind: "canary_scan", canaries: [CANARY_C], namePattern: "X" },
          ])
        )[0];
        expect(scan?.pid1, "scan read pid 1").toBe(true);
        expect(scan?.found, "guest procfs").toEqual([false]);
        const names = await containersOf(id);
        const host = await scanHostSide(names, [encodeSecret(CANARY_C)]);
        NOTES.daemon_apikey_canary_scan = { found: scan?.found, host };
        expect(
          host.inspect.every((f) => !f),
          "docker inspect",
        ).toBe(true);
        expect(
          host.logs.every((f) => !f),
          "logs",
        ).toBe(true);
      } finally {
        await destroy(id);
      }
    });

    it("AC-8 negative control: a cell with no policy reaches the internet", async () => {
      const created = await rawApi("POST", "/sandboxes", {
        image: { uri: GUEST_IMAGE },
        entrypoint: [...GUEST_ENTRYPOINT],
        timeout: 600,
        resourceLimits: { cpu: "1000m", memory: "512Mi" },
        metadata: {
          automata: "cell",
          worker: "osbit",
          stepKey: newStepKey("neg"),
        },
      });
      expect([200, 201, 202]).toContain(created.status);
      const body = created.body as { id?: unknown } | undefined;
      const id = typeof body?.id === "string" ? body.id : "";
      expect(id, "negative-control sandbox id").not.toBe("");
      try {
        let ready = false;
        for (let i = 0; i < 360 && !ready; i++) {
          // The adapter's own readiness test: execd answers its ping.
          const got = await rawApi("GET", `/sandboxes/${id}/proxy/44772/ping`);
          ready = got.status === 200;
          if (!ready) await sleep(500);
        }
        expect(ready, "negative-control sandbox running").toBe(true);
        const r = await probe(id, [
          { kind: "dns", host: "example.org" },
          { kind: "https", url: "https://example.org/" },
          { kind: "tcp", host: exampleIp, port: 80, unproxied: true },
          { kind: "tls_ip", ip: exampleIp, sni: "example.org" },
        ]);
        const reached = r.filter((x) => x.ok).length;
        check(
          "egress_enforced",
          "negative_control_reaches_4_of_4",
          reached === 4,
          r.map(brief),
        );
        const selfCheck = await provider.exec(id, [...SELF_CHECK_ARGV], {
          timeoutMs: EXEC_TIMEOUT_MS,
        });
        expect(selfCheck.exitCode, "self-check reports reachable").toBe(0);
        // #656 PR-C: a cell with no policy has no sidecar, so revoke and
        // quarantine answer 502 (retried for the whole budget); teardown still
        // resolves once GET /sandboxes/{id} says SANDBOX_NOT_FOUND. A second
        // teardown of the deleted cell resolves on the three 404s.
        const started = Date.now();
        await expect(provider.teardown(id)).resolves.toBeUndefined();
        NOTES.no_policy_teardown_ms = Date.now() - started;
        const again = Date.now();
        await expect(provider.teardown(id)).resolves.toBeUndefined();
        NOTES.no_policy_second_teardown_ms = Date.now() - again;
      } finally {
        await rawApi("DELETE", `/sandboxes/${id}`);
        NOTES.no_policy_netns_after_delete = (await snapshot()).netns.length;
      }
    });

    it("writes the runc profile's conformance evidence", () => {
      // vitest keeps going after a failed `it`: no evidence from such a run.
      expect(anyFailed, "every scenario passed").toBe(false);
      const results = JSON.stringify({ results: RESULTS, notes: NOTES });
      const head = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const dirty =
        execFileSync("git", ["status", "--porcelain"], {
          encoding: "utf8",
        }).trim() !== "";
      const measuredAt = new Date();
      const platformSha = dirty ? `${head}-dirty` : head;
      const artifactDigest = `sha256:${sha256Hex(results)}`;
      const rows = buildConformanceEvidence({
        profileId: "opensandbox/runc",
        allowlist: (
          process.env.OPENSANDBOX_IT_PROFILE_ALLOWLIST ??
          `${ALLOWED},${MODEL_HOST}`
        )
          .split(",")
          .map((h) => h.trim())
          .filter((h) => h !== ""),
        checks: CHECKS,
        required: RUNC_REQUIRED_CHECKS,
        measuredAt,
        // A dirty tree is not the commit it names; S4 can refuse the suffix.
        platformSha,
        artifactDigest,
      });
      const file = evidenceFile();
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify(
          {
            // The four fields push-evidence.sh sends to the ingest route.
            measuredAt: measuredAt.toISOString(),
            platformSha,
            artifactDigest,
            checks: CHECKS,
            rows,
            ...JSON.parse(results),
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      renameSync(tmp, file);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.source === "conformance")).toBe(true);
    });
  },
);
