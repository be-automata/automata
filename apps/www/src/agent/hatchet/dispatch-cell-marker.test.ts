import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import type { User } from "@terragon/shared";
import {
  RUNC_REQUIRED_CHECKS,
  buildConformanceEvidence,
  passingRuncChecks,
} from "@terragon/sandbox/conformance-evidence";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import {
  insertProfileEvidenceRows,
  upsertExecutionProfile,
} from "@terragon/shared/model/execution-profiles";
import {
  getOrganizationCellsEnabled,
  setOrganizationCellsEnabled,
} from "@terragon/shared/model/organizations";
import type { EgressPolicyShape } from "@terragon/shared/model/egress-policy";
import { upsertRepoReviewSetting } from "@terragon/shared/model/repo-review-settings";
import {
  createTestOrg,
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import { getClaudeOauthAccessToken } from "@/agent/msg/claudeCredentials";
import { readCellEvidenceStatus } from "@/server-lib/compute/cell-evidence-status";

import { installTestPlaneKey } from "./__fixtures__/plane-key";
import {
  createBootingPRThread,
  createReviewAutomation,
  routedHatchetFetch,
  triggerBody,
} from "./__fixtures__/review-thread";
import { dispatchAgentRun } from "./dispatch";

vi.mock("@/agent/msg/claudeCredentials", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/agent/msg/claudeCredentials")>()),
  getClaudeOauthAccessToken: vi.fn(),
}));
vi.mock("@/server-lib/compute/cell-evidence-status", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/server-lib/compute/cell-evidence-status")
    >();
  return {
    ...actual,
    readCellEvidenceStatus: vi.fn(actual.readCellEvidenceStatus),
  };
});

// Evidence rows cannot be deleted and sibling test files share the database,
// so what dispatch reads is steered here: the real rows, none, or the real
// rows with their expiry moved to `shiftDays` from now.
type EvidenceMode = "real" | "none" | { shiftDays: number };
const evidence = vi.hoisted(() => ({ mode: "real" as EvidenceMode }));
vi.mock("@terragon/shared/model/execution-profiles", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@terragon/shared/model/execution-profiles")
    >();
  return {
    ...actual,
    getCurrentProfileEvidence: async (
      args: Parameters<typeof actual.getCurrentProfileEvidence>[0],
    ) => {
      const mode = evidence.mode;
      if (mode === "none") return [];
      const rows = await actual.getCurrentProfileEvidence(args);
      if (mode === "real") return rows;
      const expiresAt = new Date(Date.now() + mode.shiftDays * 86_400_000);
      return rows.map((r) => ({ ...r, expiresAt }));
    },
  };
});

const OAUTH_SENTINEL = "oauth-token-sentinel-4d2c81";
const PROFILE_ID = "opensandbox/runc";

// Pass-through spy: the real read runs, and a test can assert it was skipped.
vi.mock("@terragon/shared/model/organizations", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@terragon/shared/model/organizations")
    >();
  return {
    ...actual,
    getOrganizationCellsEnabled: vi.fn(actual.getOrganizationCellsEnabled),
  };
});

vi.mock("@terragon/shared/model/feature-flags", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@terragon/shared/model/feature-flags")
  >()),
  getFeatureFlagForUser: vi.fn(),
}));

/**
 * #634 S4: dispatch marks a plain org task run with `cell: "opensandbox"` when
 * OpenSandbox is configured and the flag is on for the user. The marker is a
 * reference: the sealed secrets are the same shape with it on or off.
 */

const plane = installTestPlaneKey("plane-cell-marker");

function setCellsEnv(on: boolean): void {
  const e = env as { OPENSANDBOX_URL: string; OPENSANDBOX_API_KEY: string };
  e.OPENSANDBOX_URL = on ? "http://127.0.0.1:18090" : "";
  e.OPENSANDBOX_API_KEY = on ? "test-key" : "";
}

describe("dispatchAgentRun: cell marker", () => {
  let user: User;
  let orgId: string;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = appUrl;
  });

  // Once: evidence rows cannot be deleted, and every test reads the same ones.
  beforeAll(async () => {
    await upsertExecutionProfile({
      db,
      id: PROFILE_ID,
      provider: "opensandbox",
      tier: "customer_box",
      configuration: { egress_mode: "enforce" },
    });
    await insertProfileEvidenceRows({
      db,
      rows: buildConformanceEvidence({
        profileId: PROFILE_ID,
        allowlist: ["api.anthropic.com", "app.example.test"],
        checks: passingRuncChecks(),
        measuredAt: new Date(Date.now() - 2 * 3600_000),
        platformSha: "a".repeat(40),
        artifactDigest: `sha256:${"d".repeat(64)}`,
        required: RUNC_REQUIRED_CHECKS,
      }),
    });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    evidence.mode = "real";
    vi.mocked(getClaudeOauthAccessToken).mockResolvedValue(OAUTH_SENTINEL);
    // The cell broker host is a public hostname (cell-gate.ts); a cell
    // egress set never compiles for a localhost one.
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";
    setCellsEnv(true);
    vi.mocked(getFeatureFlagForUser).mockResolvedValue(true);
    user = (await createTestUser({ db })).user;
    orgId = await createTestOrg({ db });
    await setOrganizationCellsEnabled({
      db,
      organizationId: orgId,
      enabled: true,
    });
  });

  /** `chat` defaults to a claudeCode chat. */
  async function dispatchPlain(
    overrides: { organizationId?: string } = {},
    chat: { agent: string | null | undefined } = { agent: "claudeCode" },
  ) {
    const t = await createTestThread({
      db,
      userId: user.id,
      overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
    });
    const { mock } = routedHatchetFetch("cell-marker-run");
    vi.stubGlobal("fetch", mock);
    try {
      await dispatchAgentRun({
        userId: user.id,
        threadId: t.threadId,
        threadChatId: t.threadChatId,
        repoFullName: "be-automata/automata",
        branch: "main",
        agent: chat.agent,
      });
      return triggerBody(mock).input;
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("flag off: no cell field", async () => {
    vi.mocked(getFeatureFlagForUser).mockResolvedValue(false);
    const input = await dispatchPlain({ organizationId: orgId });
    expect(input).not.toHaveProperty("cell");
  });

  it("env unset: no cell field and the flag is not even read", async () => {
    setCellsEnv(false);
    const input = await dispatchPlain({ organizationId: orgId });
    expect(input).not.toHaveProperty("cell");
    expect(getFeatureFlagForUser).not.toHaveBeenCalled();
  });

  it("flag on and env set: cell is opensandbox, secrets keep the same shape", async () => {
    const on = await dispatchPlain({ organizationId: orgId });
    expect(on.cell).toBe("opensandbox");
    const secretsOn = await plane.unseal(on);

    vi.mocked(getFeatureFlagForUser).mockResolvedValue(false);
    const off = await dispatchPlain({ organizationId: orgId });
    const secretsOff = await plane.unseal(off);

    // Same plaintext, value for value, except the per-dispatch daemon token.
    expect({ ...secretsOn, daemonToken: "" }).toEqual({
      ...secretsOff,
      daemonToken: "",
    });
    expect(secretsOn.daemonToken).not.toBe("");
    // Reference only: the marker carries nothing secret.
    expect(JSON.stringify(on)).not.toContain(secretsOn.daemonToken);
  });

  it("a flag lookup failure is logged and the run is dispatched without the marker", async () => {
    vi.mocked(getFeatureFlagForUser).mockRejectedValue(new Error("db down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const input = await dispatchPlain({ organizationId: orgId });
    expect(input).not.toHaveProperty("cell");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("db down");
    warn.mockRestore();
  });

  it("#708: org A enabled gets the marker, org B of the same user does not", async () => {
    const orgB = await createTestOrg({ db, name: "Org B" });
    const inA = await dispatchPlain({ organizationId: orgId });
    const inB = await dispatchPlain({ organizationId: orgB });
    expect(inA.cell).toBe("opensandbox");
    expect(inB).not.toHaveProperty("cell");
  });

  it("#708: switching the org off removes the marker on the next dispatch", async () => {
    expect((await dispatchPlain({ organizationId: orgId })).cell).toBe(
      "opensandbox",
    );
    await setOrganizationCellsEnabled({
      db,
      organizationId: orgId,
      enabled: false,
    });
    expect(await dispatchPlain({ organizationId: orgId })).not.toHaveProperty(
      "cell",
    );
    await setOrganizationCellsEnabled({
      db,
      organizationId: orgId,
      enabled: true,
    });
    expect((await dispatchPlain({ organizationId: orgId })).cell).toBe(
      "opensandbox",
    );
  });

  describe("#705: the repo's egress must compile for a cell", () => {
    const policyOf = (input: Record<string, unknown>) =>
      input.egressPolicy as EgressPolicyShape | undefined;
    const setRepo = (patch: {
      egressPolicy: string;
      egressAllowlist: string[];
    }) =>
      upsertRepoReviewSetting({
        db,
        organizationId: orgId,
        repoFullName: "be-automata/automata",
        patch,
      });

    it("OD-1: an ip_port repo is not marked and keeps its box egress", async () => {
      await setRepo({ egressPolicy: "ip_port", egressAllowlist: ["10.0.0.5"] });
      const input = await dispatchPlain({ organizationId: orgId });
      expect(input).not.toHaveProperty("cell");
      expect(policyOf(input)?.level).toBe("ip_port");
      expect(policyOf(input)?.allowlist).toContain("10.0.0.5");
    });

    it.each([["*.example.com"], ["example.com:8443"]])(
      "a domain entry the cell cannot express (%s) is not marked; the box keeps it",
      async (entry) => {
        await setRepo({ egressPolicy: "domain", egressAllowlist: [entry] });
        const input = await dispatchPlain({ organizationId: orgId });
        expect(input).not.toHaveProperty("cell");
        expect(policyOf(input)?.allowlist).toContain(entry);
      },
    );

    it("a domain repo the cell can express is marked", async () => {
      await setRepo({
        egressPolicy: "domain",
        egressAllowlist: ["example.com"],
      });
      const input = await dispatchPlain({ organizationId: orgId });
      expect(input.cell).toBe("opensandbox");
      expect(policyOf(input)?.level).toBe("domain");
    });
  });

  describe("#718: the same eligibility cell-plan applies", () => {
    let log: ReturnType<typeof vi.spyOn>;
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });
    afterEach(() => {
      log.mockRestore();
      warn.mockRestore();
    });
    const logged = () =>
      JSON.stringify([...log.mock.calls, ...warn.mock.calls]);

    it.each([["codex"], ["gemini"], [null], [undefined]])(
      "agent %s is not marked, and the everyday refusal logs nothing",
      async (agent) => {
        const input = await dispatchPlain({ organizationId: orgId }, { agent });
        expect(input).not.toHaveProperty("cell");
        expect(logged()).not.toContain("cell check refused");
      },
    );

    it("an org without cells is not marked, and logs nothing", async () => {
      await setOrganizationCellsEnabled({
        db,
        organizationId: orgId,
        enabled: false,
      });
      try {
        const input = await dispatchPlain({ organizationId: orgId });
        expect(input).not.toHaveProperty("cell");
        expect(logged()).not.toContain("cell check refused");
      } finally {
        await setOrganizationCellsEnabled({
          db,
          organizationId: orgId,
          enabled: true,
        });
      }
    });

    it("an unknown profile is not marked", async () => {
      vi.mocked(readCellEvidenceStatus).mockResolvedValueOnce({
        status: "refused",
        reason: "unknown_profile",
        expiresAt: null,
      });
      const input = await dispatchPlain({ organizationId: orgId });
      expect(input).not.toHaveProperty("cell");
      expect(logged()).toContain("unknown_profile");
    });

    it.each<[string, EvidenceMode, string]>([
      ["no", "none", "evidence_missing"],
      ["expired", { shiftDays: -1 }, "evidence_expired"],
    ])(
      "%s evidence is not marked (reason %s, no secrets)",
      async (_label, mode, reason) => {
        evidence.mode = mode;
        const input = await dispatchPlain({ organizationId: orgId });
        expect(input).not.toHaveProperty("cell");
        expect(logged()).toContain("egress_not_enforced");
        expect(logged()).toContain(reason);
        expect(getClaudeOauthAccessToken).not.toHaveBeenCalled();
      },
    );

    it("a failed evidence read is not marked and logs the error name only", async () => {
      vi.mocked(readCellEvidenceStatus).mockRejectedValueOnce(
        new Error("db down: secret-detail-xyz"),
      );
      const input = await dispatchPlain({ organizationId: orgId });
      expect(input).not.toHaveProperty("cell");
      expect(logged()).toContain("evidence_check_failed");
      expect(logged()).not.toContain("secret-detail-xyz");
      expect(getClaudeOauthAccessToken).not.toHaveBeenCalled();
    });

    it("expiring evidence is still marked", async () => {
      evidence.mode = { shiftDays: 2 };
      const input = await dispatchPlain({ organizationId: orgId });
      expect(input.cell).toBe("opensandbox");
    });

    it("no Claude OAuth credential is not marked", async () => {
      vi.mocked(getClaudeOauthAccessToken).mockResolvedValue(null);
      const input = await dispatchPlain({ organizationId: orgId });
      expect(input).not.toHaveProperty("cell");
      expect(logged()).toContain("no_model_credential");
    });

    it("a failed credential lookup is not marked and logs the error name only", async () => {
      vi.mocked(getClaudeOauthAccessToken).mockRejectedValue(
        new Error("refresh failed: secret-detail-xyz"),
      );
      const input = await dispatchPlain({ organizationId: orgId });
      expect(input).not.toHaveProperty("cell");
      expect(logged()).toContain("credential_lookup_failed");
      expect(logged()).not.toContain("secret-detail-xyz");
    });

    it("all checks pass: marked, and the OAuth value appears nowhere", async () => {
      const input = await dispatchPlain({ organizationId: orgId });
      expect(input.cell).toBe("opensandbox");
      expect(getClaudeOauthAccessToken).toHaveBeenCalledTimes(1);
      expect(logged()).not.toContain(OAUTH_SENTINEL);
      expect(JSON.stringify(input)).not.toContain(OAUTH_SENTINEL);
      expect(JSON.stringify(await plane.unseal(input))).not.toContain(
        OAUTH_SENTINEL,
      );
    });

    it.each<[string, () => Promise<void>, string, number]>([
      [
        "flag off",
        async () => {
          vi.mocked(getFeatureFlagForUser).mockResolvedValue(false);
        },
        "claudeCode",
        0,
      ],
      [
        "refused egress",
        async () => {
          await upsertRepoReviewSetting({
            db,
            organizationId: orgId,
            repoFullName: "be-automata/automata",
            patch: { egressPolicy: "ip_port", egressAllowlist: ["10.0.0.5"] },
          });
        },
        "claudeCode",
        0,
      ],
      ["a wrong agent", async () => undefined, "codex", 0],
      [
        "refused evidence",
        async () => {
          evidence.mode = { shiftDays: -1 };
        },
        "claudeCode",
        1,
      ],
    ])(
      "the checks short-circuit: %s never reaches the credential lookup",
      async (_label, arrange, agent, evidenceReads) => {
        await arrange();
        await dispatchPlain({ organizationId: orgId }, { agent });
        expect(readCellEvidenceStatus).toHaveBeenCalledTimes(evidenceReads);
        expect(getClaudeOauthAccessToken).not.toHaveBeenCalled();
      },
    );

    it("the agent check refuses before any DB read", async () => {
      await dispatchPlain({ organizationId: orgId }, { agent: "codex" });
      expect(getOrganizationCellsEnabled).not.toHaveBeenCalled();
      expect(getFeatureFlagForUser).not.toHaveBeenCalled();
      expect(readCellEvidenceStatus).not.toHaveBeenCalled();
      expect(getClaudeOauthAccessToken).not.toHaveBeenCalled();
    });
  });

  it("a thread without an organization never gets the marker", async () => {
    const input = await dispatchPlain();
    expect(input).not.toHaveProperty("cell");
  });

  it("a review run never gets the marker", async () => {
    const t = await createBootingPRThread({
      userId: user.id,
      orgId,
      automationId: await createReviewAutomation({ userId: user.id, orgId }),
      prNumber: 4343,
    });
    const { mock } = routedHatchetFetch("cell-marker-review");
    vi.stubGlobal("fetch", mock);
    try {
      await dispatchAgentRun({
        userId: user.id,
        threadId: t.threadId,
        threadChatId: t.threadChatId,
        repoFullName: "be-automata/automata",
        branch: "feature-marker",
        agent: "claudeCode",
      });
      expect(triggerBody(mock).input).not.toHaveProperty("cell");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
