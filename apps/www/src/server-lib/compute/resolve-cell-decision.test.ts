import { describe, expect, it, vi } from "vitest";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import {
  getCellDecisionsForThread,
  insertProfileEvidence,
  upsertExecutionProfile,
} from "@terragon/shared/model/execution-profiles";
import type { ThreadTrustContext } from "@terragon/shared/db/types";
import {
  boxConfigurationFor,
  cellFactsForRun,
  isTrustedPrContent,
  recordShadowCellDecision,
  resolveCellDecision,
  type CellRunFacts,
} from "./resolve-cell-decision";

const DAY_MS = 86_400_000;

const trustedPr: ThreadTrustContext = {
  source: "github-pr",
  isFork: false,
  isCrossRepo: false,
  authorAssociation: "MEMBER",
  capturedAt: "2026-11-10T00:00:00Z",
};

const runFacts = (over: Partial<CellRunFacts> = {}): CellRunFacts => ({
  lane: "task",
  isCompanionRun: false,
  repoVisibility: "private",
  trustContext: null,
  trustedAuthorThreshold: "MEMBER",
  sourceType: null,
  secretNames: ["installationToken", "daemonToken"],
  ...over,
});

describe("cellFactsForRun", () => {
  it("unknown visibility fails closed to private/internal", () => {
    const facts = cellFactsForRun(runFacts({ repoVisibility: null }));
    expect(facts.repo_visibility).toBe("private");
    expect(facts.data_class).toBe("internal");
  });

  it("a public repo is public data", () => {
    const facts = cellFactsForRun(runFacts({ repoVisibility: "public" }));
    expect(facts.data_class).toBe("public");
  });

  it("a member-written task is trusted; a mention or automation is not", () => {
    expect(cellFactsForRun(runFacts()).untrusted_content).toBe(false);
    expect(
      cellFactsForRun(runFacts({ sourceType: "www-fork" })).untrusted_content,
    ).toBe(false);
    expect(
      cellFactsForRun(runFacts({ sourceType: "github-mention" }))
        .untrusted_content,
    ).toBe(true);
    expect(
      cellFactsForRun(runFacts({ sourceType: "automation-skill" }))
        .untrusted_content,
    ).toBe(true);
  });

  it("PR lanes follow the trust snapshot; missing trust and companions are untrusted", () => {
    expect(
      cellFactsForRun(runFacts({ lane: "review", trustContext: trustedPr }))
        .untrusted_content,
    ).toBe(false);
    expect(
      cellFactsForRun(runFacts({ lane: "review", trustContext: null }))
        .untrusted_content,
    ).toBe(true);
    expect(
      cellFactsForRun(
        runFacts({ lane: "pr", isCompanionRun: true, trustContext: trustedPr }),
      ).untrusted_content,
    ).toBe(true);
  });

  it("secret names are deduplicated and sorted; egress needs are the system hosts", () => {
    const facts = cellFactsForRun(
      runFacts({ secretNames: ["repoEnv", "daemonToken", "repoEnv"] }),
    );
    expect(facts.secrets).toEqual(["daemonToken", "repoEnv"]);
    expect(facts.needs_egress).toContain("api.anthropic.com");
    expect(facts.irreversible).toBe(false);
  });
});

describe("isTrustedPrContent", () => {
  it.each([
    [{ ...trustedPr }, "MEMBER", true],
    [{ ...trustedPr, authorAssociation: "OWNER" }, "MEMBER", true],
    [{ ...trustedPr, authorAssociation: "CONTRIBUTOR" }, "MEMBER", false],
    [{ ...trustedPr, authorAssociation: "MEMBER" }, "OWNER", false],
    [{ ...trustedPr, isFork: true }, "MEMBER", false],
    [{ ...trustedPr, isCrossRepo: undefined }, "MEMBER", false],
    [{ ...trustedPr, authorAssociation: "BOGUS" }, "NONE", false],
  ] as const)("%o at %s -> %s", (trust, threshold, expected) => {
    expect(isTrustedPrContent(trust, threshold)).toBe(expected);
  });
});

describe("boxConfigurationFor", () => {
  it("a resolved shape means enforce, none means observe", () => {
    expect(boxConfigurationFor({ level: "domain", allowlist: [] })).toEqual({
      egress_mode: "enforce",
    });
    expect(boxConfigurationFor(null)).toEqual({ egress_mode: "observe" });
  });
});

describe("resolveCellDecision (DB + compiled WASM)", () => {
  const BOX_CAPS: Record<string, unknown> = {
    metadata_blocked: true,
    peer_isolated: true,
    teardown_verified: true,
    secret_brokering: true,
    provider_creds_in_guest: false,
  };

  async function seedBox(measuredAt: Date) {
    const box = { provider: `box-${nanoid(6)}`, tier: "customer_box" as const };
    for (const mode of ["observe", "enforce"] as const) {
      const profile = await upsertExecutionProfile({
        db,
        id: `${box.provider}/${mode}`,
        ...box,
        configuration: { egress_mode: mode },
      });
      const caps: Record<string, unknown> =
        mode === "enforce"
          ? { ...BOX_CAPS, egress: "allowlist", dns_closed: true }
          : BOX_CAPS;
      for (const [capability, value] of Object.entries(caps)) {
        await insertProfileEvidence({
          db,
          evidence: {
            profileId: profile.id,
            capability,
            measuredAt,
            source: "conformance",
            result: { value },
          },
        });
      }
    }
    return box;
  }

  const facts = cellFactsForRun(
    runFacts({ lane: "review", trustContext: null }),
  );
  const shape = {
    level: "domain" as const,
    allowlist: [...facts.needs_egress],
  };

  it("observe mode: denied as open egress (ADR-014: observe is not enforce)", async () => {
    const now = new Date("2026-11-10T12:00:00Z");
    const box = await seedBox(new Date(now.getTime() - DAY_MS));
    const d = await resolveCellDecision({
      db,
      facts,
      egressPolicy: null,
      now,
      box,
    });
    expect(d.allowed).toBe(false);
    expect(d.reasons).toContain("egress_open");
    // Everything else measured holds: only the open egress (and what it
    // implies for hosts and secrets) is named.
    expect(d.reasons).not.toContain("metadata_not_proven_blocked");
    expect(d.reasons).not.toContain("evidence_expired");
    expect(d.profileId).toBe(`${box.provider}/observe`);
    expect(d.evidenceIds).toHaveLength(Object.keys(BOX_CAPS).length);
  });

  it("enforce mode with current evidence: allowed, the allowlist is the run's shape", async () => {
    const now = new Date("2026-11-10T12:00:00Z");
    const box = await seedBox(new Date(now.getTime() - DAY_MS));
    const d = await resolveCellDecision({
      db,
      facts,
      egressPolicy: shape,
      now,
      box,
    });
    expect(d).toMatchObject({ allowed: true, reasons: [] });
    expect(
      (d.input.profile as { capabilities: Record<string, unknown> })
        .capabilities.egress_allowlist,
    ).toEqual(shape.allowlist);
  });

  it("enforce mode with the clock past expiry: evidence_expired", async () => {
    const measuredAt = new Date("2026-10-25T09:56:00Z");
    const box = await seedBox(measuredAt);
    const d = await resolveCellDecision({
      db,
      facts,
      egressPolicy: shape,
      now: new Date(measuredAt.getTime() + 30 * DAY_MS + 1000),
      box,
    });
    expect(d.allowed).toBe(false);
    expect(d.reasons).toEqual(["evidence_expired"]);
  });

  it("no catalog row: unknown_profile, deny by default", async () => {
    const d = await resolveCellDecision({
      db,
      facts,
      egressPolicy: null,
      now: new Date(),
      box: { provider: `absent-${nanoid(6)}`, tier: "customer_box" },
    });
    expect(d.allowed).toBe(false);
    expect(d.profileId).toBeNull();
    expect(d.reasons).toEqual(
      expect.arrayContaining(["unknown_profile", "evidence_missing"]),
    );
  });
});

describe("recordShadowCellDecision", () => {
  const base = async () => {
    const { user } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
    });
    return {
      db,
      threadId,
      threadChatId,
      organizationId: null,
      repoFullName: "be-automata/automata",
      lane: "task" as const,
      isCompanionRun: false,
      trustContext: null,
      sourceType: null,
      secretNames: ["installationToken", "daemonToken"],
      egressPolicy: null,
      repoRow: undefined,
    };
  };

  it("records the decision and its exact input (secret names only)", async () => {
    const args = await base();
    await recordShadowCellDecision({
      ...args,
      deps: { readRepoVisibility: async () => "public" },
    });
    const rows = await getCellDecisionsForThread({
      db,
      threadId: args.threadId,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      threadChatId: args.threadChatId,
      seam: "dispatch",
      mode: "shadow",
    });
    const input = rows[0]!.input as { cell: { secrets: string[] } };
    expect(input.cell.secrets).toEqual(["daemonToken", "installationToken"]);
  });

  it("a resolver error is recorded as resolver_error and never thrown", async () => {
    const args = await base();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      recordShadowCellDecision({
        ...args,
        deps: {
          readRepoVisibility: async () => "public",
          resolve: async () => {
            throw new Error("wasm exploded");
          },
        },
      }),
    ).resolves.toBeUndefined();
    const rows = await getCellDecisionsForThread({
      db,
      threadId: args.threadId,
    });
    expect(rows[0]).toMatchObject({
      allowed: false,
      reasons: ["resolver_error"],
      profileId: null,
    });
    expect(warn).toHaveBeenCalledWith(
      "[cell] resolver error (shadow: dispatch proceeds)",
      expect.objectContaining({ error: "wasm exploded" }),
    );
    warn.mockRestore();
  });

  it("a failed insert is logged and never thrown", async () => {
    const args = await base();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      recordShadowCellDecision({
        ...args,
        threadId: `missing-${nanoid()}`, // FK violation
        deps: { readRepoVisibility: async () => null },
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "[cell] cell_decision insert failed (shadow: dispatch proceeds)",
      expect.anything(),
    );
    warn.mockRestore();
  });
});
