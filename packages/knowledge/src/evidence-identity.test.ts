import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  checkEvidence,
  checkPage,
  reconcile,
  stubUpdater,
  type ClaimStatus,
  type Sidecar,
} from "./claims";
import {
  classifyEvidence,
  PROSE_EXTENSIONS,
  type EvidenceClass,
  type EvidenceScheme,
} from "./evidence-class";
import {
  edit,
  limitsPageOf,
  pageOf,
  SOURCE_SHA,
  useCorpus,
  useLimitsCorpus,
  withClaim,
} from "./test-fixtures";

const EXACT = /^x:[0-9a-f]{16}$/;
const PROSE = /^[0-9a-f]{16}$/;

const limitStatuses = (root: string, sc: Sidecar) =>
  Object.fromEntries(
    checkPage(root, limitsPageOf(root), sc).claims.map((c) => [c.id, c.status]),
  );
const billingStatuses = (root: string, sc: Sidecar) =>
  Object.fromEntries(
    checkPage(root, pageOf(root), sc).claims.map((c) => [c.id, c.status]),
  );

const LIMITS_FRESH: Record<string, ClaimStatus> = {
  "api-rate": "fresh",
  burst: "fresh",
  "readme-rate": "fresh",
};
const BILLING_FRESH: Record<string, ClaimStatus> = {
  "trial-length": "fresh",
  "seat-price": "fresh",
  "sso-workaround": "fresh",
  "sso-fixed-in": "fresh",
};

/** The pre-ENG-03 pin hash: whitespace collapsed, first 16 hex of sha256. */
const legacyHash = (text: string) =>
  createHash("sha256")
    .update(text.replace(/\s+/g, " ").trim())
    .digest("hex")
    .slice(0, 16);

describe("classifyEvidence", () => {
  it.each<[EvidenceScheme, string, EvidenceClass]>([
    ["doc", "pricing", "prose"],
    ["ticket", "SUP-12", "prose"],
    ["repo", "README.md", "prose"],
    ["repo", "docs/guide.MDX", "prose"],
    ["repo", "notes.txt", "prose"],
    ["repo", "a.rst", "prose"],
    ["repo", "b.adoc", "prose"],
    ["repo", "c.asciidoc", "prose"],
    ["repo", "d.markdown", "prose"],
    ["repo", "ratelimit.py", "exact"],
    ["repo", "config.yaml", "exact"],
    ["repo", "x.yml", "exact"],
    ["repo", "a.json", "exact"],
    ["repo", "a.toml", "exact"],
    ["repo", "billing.ts", "exact"],
    ["repo", "run.sh", "exact"],
    ["repo", "Makefile", "exact"],
    ["repo", "dir.md/file", "exact"],
    ["repo", ".env", "exact"],
    ["repo", "weird.unknownext", "exact"],
  ])("%s://%s is %s", (scheme, target, want) => {
    expect(classifyEvidence(scheme, target)).toBe(want);
  });

  it("lists exactly the prose extensions", () => {
    expect([...PROSE_EXTENSIONS]).toEqual([
      "md",
      "mdx",
      "markdown",
      "txt",
      "rst",
      "adoc",
      "asciidoc",
    ]);
  });
});

describe("limits corpus", () => {
  it("starts with every claim fresh", () => {
    const { root, sc } = useLimitsCorpus();
    const report = checkPage(root, limitsPageOf(root), sc);
    expect(
      Object.fromEntries(report.claims.map((c) => [c.id, c.status])),
    ).toEqual({ "api-rate": "fresh", burst: "fresh", "readme-rate": "fresh" });
  });
});

describe("evidence identity (ENG-03 / O7)", () => {
  it("python: a whitespace-only edit inside a pinned span makes the pin stale", async () => {
    const { root, sc } = useLimitsCorpus();
    edit(root, "repo/ratelimit.py", (s) =>
      s.replace("BURST_ALLOWANCE = 20", "BURST_ALLOWANCE  = 20"),
    );
    expect(limitStatuses(root, sc)).toEqual({
      ...LIMITS_FRESH,
      burst: "stale",
    });
    const draft = await reconcile(root, limitsPageOf(root), sc, stubUpdater(), {
      sourceRev: SOURCE_SHA,
    });
    expect(draft.llmCalls).toBe(1);
    const ops = draft.ops.filter((o) => o.claimId === "burst");
    expect(ops.map((o) => o.op)).toEqual(["update"]);
  });

  it("yaml: re-indenting a pinned line conflicts with the python pin that still holds", async () => {
    const { root, sc } = useLimitsCorpus();
    edit(root, "repo/config.yaml", (s) =>
      s.replace("    requests_per_minute: 120", "  requests_per_minute: 120"),
    );
    expect(limitStatuses(root, sc)).toEqual({
      ...LIMITS_FRESH,
      "api-rate": "conflict",
    });
    const draft = await reconcile(root, limitsPageOf(root), sc, stubUpdater(), {
      sourceRev: SOURCE_SHA,
    });
    expect(draft.llmCalls).toBe(0);
    expect(
      draft.ops.filter((o) => o.claimId === "api-rate").map((o) => o.op),
    ).toEqual(["conflict"]);
  });

  it("ts: a whitespace-only edit of a pinned constant conflicts with the doc pin", async () => {
    const { root, sc } = useCorpus();
    edit(root, "repo/billing.ts", (s) =>
      s.replace("TRIAL_DAYS = 14;", "TRIAL_DAYS   =   14;"),
    );
    expect(billingStatuses(root, sc)).toEqual({
      ...BILLING_FRESH,
      "trial-length": "conflict",
    });
    const draft = await reconcile(root, pageOf(root), sc, stubUpdater(), {
      sourceRev: SOURCE_SHA,
    });
    expect(draft.llmCalls).toBe(0);
  });

  it("prose repo file (.md): a doubled space stays fresh", () => {
    const { root, sc } = useLimitsCorpus();
    edit(root, "repo/README.md", (s) =>
      s.replace("allows 120 requests", "allows  120 requests"),
    );
    expect(limitStatuses(root, sc)).toEqual(LIMITS_FRESH);
  });

  it("prose doc://: re-wrapping a section across lines stays fresh", () => {
    const { root, sc } = useCorpus();
    edit(root, "docs/pricing.md", (s) =>
      s.replace(
        "14-day free trial. No card required.",
        "14-day free trial.\nNo card   required.",
      ),
    );
    expect(billingStatuses(root, sc)).toEqual(BILLING_FRESH);
  });

  it("prose ticket://: a doubled space in a ticket field stays fresh", () => {
    const { root, sc } = useCorpus();
    edit(root, "tickets/SUP-12.json", (s) =>
      s.replace("Clear the ag_session cookie", "Clear the  ag_session cookie"),
    );
    expect(billingStatuses(root, sc)).toEqual(BILLING_FRESH);
  });

  it("pins are self-describing: exact hashes carry x:, prose hashes stay bare", () => {
    const limits = useLimitsCorpus().sc;
    const billing = useCorpus().sc;
    const hashes = new Map(
      [...limits.claims, ...billing.claims].flatMap((c) =>
        c.evidence.map((e) => [e.uri, e.hash] as const),
      ),
    );
    for (const uri of [
      "repo://ratelimit.py#L1-L1",
      "repo://ratelimit.py#L2-L2",
      "repo://config.yaml#L3-L3",
      "repo://billing.ts#L1-L1",
      "repo://billing.ts#L2-L3",
    ])
      expect(hashes.get(uri)).toMatch(EXACT);
    for (const uri of [
      "repo://README.md#L3-L3",
      "doc://pricing#trial",
      "ticket://SUP-12#/resolution/workaround",
      "ticket://SUP-12#/resolution/fixedIn",
    ])
      expect(hashes.get(uri)).toMatch(PROSE);
  });

  it("legacy: a bare hash on a code pin still verifies whitespace-tolerantly", () => {
    const { root, sc } = useCorpus();
    const uri = "repo://billing.ts#L1-L1";
    const pin = { uri, hash: legacyHash("export const TRIAL_DAYS = 14;") };
    const legacy: Sidecar = {
      ...withClaim(sc, "trial-length", (c) => ({
        ...c,
        evidence: c.evidence.map((e) => (e.uri === uri ? pin : e)),
      })),
    };
    expect(checkEvidence(root, pin)).toEqual({ kind: "fresh", uri });
    expect(billingStatuses(root, legacy)).toEqual(BILLING_FRESH);
    edit(root, "repo/billing.ts", (s) =>
      s.replace("TRIAL_DAYS = 14;", "TRIAL_DAYS   =   14;"),
    );
    expect(checkEvidence(root, pin)).toEqual({ kind: "fresh", uri });
    expect(billingStatuses(root, legacy)).toEqual(BILLING_FRESH);
  });

  it("relocation: a block moved unchanged relocates, the same block re-indented does not", () => {
    const moved = useLimitsCorpus();
    edit(moved.root, "repo/ratelimit.py", (s) => `# limits\nimport os\n${s}`);
    expect(limitStatuses(moved.root, moved.sc)).toEqual({
      ...LIMITS_FRESH,
      "api-rate": "relocated",
      burst: "relocated",
    });

    const reindented = useLimitsCorpus();
    edit(
      reindented.root,
      "repo/ratelimit.py",
      (s) =>
        `# limits\nimport os\n${s.replace("BURST_ALLOWANCE = 20", "    BURST_ALLOWANCE = 20")}`,
    );
    expect(limitStatuses(reindented.root, reindented.sc).burst).toBe("stale");
  });

  it("CRLF: converting line endings makes an exact pin stale (no CRLF normalization)", () => {
    const { root, sc } = useLimitsCorpus();
    edit(root, "repo/ratelimit.py", (s) => s.replace(/\n/g, "\r\n"));
    expect(limitStatuses(root, sc).burst).toBe("stale");
  });
});
