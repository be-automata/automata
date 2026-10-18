import { unlinkSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AmbiguousEvidenceError,
  applyDraft,
  checkPage,
  HumanEditedPageError,
  reconcile,
  retargetOp,
  stubUpdater,
  type ClaimStatus,
  type Draft,
  type Sidecar,
  type UpdateRequest,
} from "./claims.ts";
import { parseOpKey } from "./op-key.ts";
import {
  BILLING_LINES,
  countingUpdater,
  diffOf,
  duplicateTrial,
  edit,
  PAGE,
  pageOf,
  SOURCE_SHA,
  useCorpus,
  writeBilling,
} from "./test-fixtures.ts";

const statuses = (root: string, sc: Sidecar) =>
  Object.fromEntries(
    checkPage(root, pageOf(root), sc).claims.map((c) => [c.id, c.status]),
  );

const ALL_FRESH: Record<string, ClaimStatus> = {
  "trial-length": "fresh",
  "seat-price": "fresh",
  "sso-workaround": "fresh",
  "sso-fixed-in": "fresh",
};

interface Scenario {
  name: string;
  mutate: (root: string) => void;
  expect: Record<string, ClaimStatus>;
  llmCalls: number;
  mode?: Draft["mode"];
  statement?: Record<string, string>;
}

const SCENARIOS: Scenario[] = [
  { name: "noop", mutate: () => {}, expect: ALL_FRESH, llmCalls: 0 },
  {
    name: "whitespace-only code edit",
    mutate: (r) =>
      edit(r, "repo/billing.ts", (s) =>
        s.replace("TRIAL_DAYS = 14;", "TRIAL_DAYS   =   14;"),
      ),
    expect: ALL_FRESH,
    llmCalls: 0,
  },
  {
    name: "code moved (lines inserted above)",
    mutate: (r) =>
      edit(
        r,
        "repo/billing.ts",
        (s) => `// billing constants\nimport "./x";\n\n${s}`,
      ),
    expect: {
      ...ALL_FRESH,
      "trial-length": "relocated",
      "seat-price": "relocated",
    },
    llmCalls: 0,
  },
  {
    name: "trial changed in code only (marketing still says 14)",
    mutate: (r) =>
      edit(r, "repo/billing.ts", (s) =>
        s.replace("TRIAL_DAYS = 14", "TRIAL_DAYS = 30"),
      ),
    expect: { ...ALL_FRESH, "trial-length": "conflict" },
    llmCalls: 0,
  },
  {
    name: "trial changed in code AND marketing copy",
    mutate: (r) => {
      edit(r, "repo/billing.ts", (s) =>
        s.replace("TRIAL_DAYS = 14", "TRIAL_DAYS = 30"),
      );
      edit(r, "docs/pricing.md", (s) =>
        s.replace("14-day free trial", "30-day free trial"),
      );
    },
    expect: { ...ALL_FRESH, "trial-length": "stale" },
    llmCalls: 1,
    statement: { "trial-length": "Trials last 30 days and need no card." },
  },
  {
    name: "marketing edits an unrelated doc section",
    mutate: (r) =>
      edit(r, "docs/pricing.md", (s) =>
        s.replace("monthly or annual.", "monthly, annual, or via invoice."),
      ),
    expect: ALL_FRESH,
    llmCalls: 0,
  },
  {
    name: "marketing changes the trial copy",
    mutate: (r) =>
      edit(r, "docs/pricing.md", (s) =>
        s.replace("14-day free trial", "21-day free trial"),
      ),
    expect: { ...ALL_FRESH, "trial-length": "conflict" },
    llmCalls: 0,
  },
  {
    name: "support ticket: fix version corrected",
    mutate: (r) =>
      edit(r, "tickets/SUP-12.json", (s) => s.replace('"2.4.1"', '"2.4.2"')),
    expect: { ...ALL_FRESH, "sso-fixed-in": "stale" },
    llmCalls: 1,
  },
  {
    name: "support ticket deleted",
    mutate: (r) => unlinkSync(join(r, "tickets/SUP-12.json")),
    expect: {
      ...ALL_FRESH,
      "sso-workaround": "missing",
      "sso-fixed-in": "missing",
    },
    llmCalls: 0,
  },
  {
    name: "doc heading renamed (body unchanged)",
    mutate: (r) =>
      edit(r, "docs/pricing.md", (s) => s.replace("## Trial", "## Free trial")),
    expect: { ...ALL_FRESH, "trial-length": "relocated" },
    llmCalls: 0,
  },
  {
    name: "doc heading renamed AND body rewritten",
    mutate: (r) =>
      edit(r, "docs/pricing.md", (s) =>
        s.replace(
          "## Trial\nEvery workspace starts with a 14-day free trial.",
          "## Try it free\nTwo weeks free on every workspace.",
        ),
      ),
    expect: { ...ALL_FRESH, "trial-length": "degraded" },
    llmCalls: 0,
  },
  {
    // D-1: two identical spans must never be sent to the model as a consistent change.
    name: "duplicated span makes relocation ambiguous",
    mutate: (r) => edit(r, "repo/billing.ts", duplicateTrial),
    expect: {
      ...ALL_FRESH,
      "trial-length": "ambiguous",
      "seat-price": "relocated",
    },
    llmCalls: 0,
  },
  {
    name: "human rewrites a wiki sentence",
    mutate: (r) =>
      edit(r, `wiki/${PAGE}.md`, (s) =>
        s.replace(
          "Each seat costs $29 per month; workspaces get 3 free seats.",
          "Seats are $29/mo each. The first 3 seats are free (great for small teams!).",
        ),
      ),
    expect: { ...ALL_FRESH, "seat-price": "orphaned" },
    llmCalls: 0,
    mode: "propose",
  },
  {
    name: "human edit + code change at once",
    mutate: (r) => {
      edit(r, `wiki/${PAGE}.md`, (s) =>
        s.replace(
          "The SSO loop was fixed in version 2.4.1.",
          "Fixed in 2.4.1 — upgrade if you still see it.",
        ),
      );
      edit(r, "repo/billing.ts", (s) =>
        s.replace("TRIAL_DAYS = 14", "TRIAL_DAYS = 30"),
      );
    },
    expect: {
      ...ALL_FRESH,
      "sso-fixed-in": "orphaned",
      "trial-length": "conflict",
    },
    llmCalls: 0,
    mode: "propose",
  },
  {
    name: "human edit + code moved (repin allowed, no rewrite)",
    mutate: (r) => {
      edit(r, `wiki/${PAGE}.md`, (s) =>
        s.replace(
          "Trials last 14 days and need no card.",
          "Trials last 14 days and need no card. **No exceptions.**",
        ),
      );
      edit(r, "repo/billing.ts", (s) => `// header\n${s}`);
    },
    expect: {
      ...ALL_FRESH,
      "trial-length": "relocated",
      "seat-price": "relocated",
    },
    llmCalls: 0,
    mode: "propose",
  },
];

describe("regression scenarios", () => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))("%s", (_name, s) => {
    const { root, sc } = useCorpus();
    s.mutate(root);
    const md = pageOf(root);
    expect(statuses(root, sc)).toEqual(s.expect);
    const draft = reconcile(root, md, sc, stubUpdater(), {
      sourceRev: SOURCE_SHA,
    });
    expect(draft.llmCalls).toBe(s.llmCalls);
    if (s.mode) expect(draft.mode).toBe(s.mode);
    for (const [id, want] of Object.entries(s.statement ?? {})) {
      expect(
        draft.ops.find((o) => o.claimId === id && o.op === "update")?.after,
      ).toBe(want);
    }
    const approve = draft.ops
      .filter((o) => o.op === "update" || o.op === "retract")
      .map((o) => o.id);
    if (draft.mode === "apply") {
      // No approvals: only repins may change anything, and never the page text.
      expect(applyDraft(root, md, sc, draft).md).toBe(md);
      const out = applyDraft(root, md, sc, draft, approve);
      // Idempotence: after applying, a re-check needs no repins/updates and zero model calls.
      const again = reconcile(root, out.md, out.sc, stubUpdater(), {
        sourceRev: SOURCE_SHA,
      });
      expect(
        again.ops.filter((o) => o.op === "repin" || o.op === "update"),
      ).toEqual([]);
      expect(again.llmCalls).toBe(0);
    } else {
      // Human text must survive byte-for-byte: propose mode never rewrites the page.
      if (draft.ops.some((o) => !o.auto)) {
        expect(() =>
          applyDraft(
            root,
            md,
            sc,
            draft,
            draft.ops.filter((o) => !o.auto).map((o) => o.id),
          ),
        ).toThrow(HumanEditedPageError);
      }
      const repinOnly = applyDraft(root, md, sc, draft);
      expect(repinOnly.md).toBe(md);
      expect(repinOnly.sc.pageVersion).toBe(sc.pageVersion);
    }
  });
});

describe("D-1: ambiguous evidence", () => {
  it("emits exactly one review op listing every candidate span, and never calls the updater", () => {
    const { root, sc } = useCorpus();
    edit(root, "repo/billing.ts", duplicateTrial);
    const seen: UpdateRequest[][] = [];
    const llm = {
      ...stubUpdater(),
      rework: (items: UpdateRequest[]) => (seen.push(items), []),
    };
    const draft = reconcile(root, pageOf(root), sc, llm, {
      sourceRev: SOURCE_SHA,
    });
    const ops = draft.ops.filter((o) => o.claimId === "trial-length");
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: "review", auto: false });
    expect(ops[0]?.evidence.join(" ")).toMatch(
      /2 identical spans: repo:\/\/billing\.ts#L2-L2, repo:\/\/billing\.ts#L11-L11/,
    );
    expect(seen.flat().map((i) => i.claim.id)).not.toContain("trial-length");
  });

  it("leaves the claim byte-identical when every op is approved", () => {
    const { root, sc } = useCorpus();
    edit(root, "repo/billing.ts", duplicateTrial);
    const md = pageOf(root);
    const draft = reconcile(root, md, sc, stubUpdater(), {
      sourceRev: SOURCE_SHA,
    });
    const out = applyDraft(
      root,
      md,
      sc,
      draft,
      draft.ops.map((o) => o.id),
    );
    expect(out.md).toBe(md);
    expect(out.sc.claims.find((c) => c.id === "trial-length")).toEqual(
      sc.claims.find((c) => c.id === "trial-length"),
    );
  });

  it("refuses an approved text change even when the op was retargeted to update", () => {
    const { root, sc } = useCorpus();
    edit(root, "repo/billing.ts", duplicateTrial);
    const md = pageOf(root);
    const draft = reconcile(root, md, sc, stubUpdater(), {
      sourceRev: SOURCE_SHA,
    });
    const ops = draft.ops.map((o) =>
      o.claimId === "trial-length"
        ? {
            ...retargetOp(o, "update", "forced"),
            after: "Trials last 99 days.",
          }
        : o,
    );
    expect(() =>
      applyDraft(
        root,
        md,
        sc,
        { ...draft, ops },
        ops.map((o) => o.id),
      ),
    ).toThrow(AmbiguousEvidenceError);
  });

  it("keeps missing and degraded ahead of ambiguous", () => {
    const { root, sc } = useCorpus();
    edit(root, "repo/billing.ts", duplicateTrial);
    edit(root, "docs/pricing.md", (s) =>
      s.replace(
        "## Trial\nEvery workspace starts with a 14-day free trial.",
        "## Try it free\nTwo weeks free.",
      ),
    );
    expect(statuses(root, sc)["trial-length"]).toBe("degraded");
  });

  it("counts two doc sections with the same heading slug as ambiguous", () => {
    const { root, sc } = useCorpus();
    // The pinned "#trial" heading is renamed, and a second identical "Free trial" section is appended:
    // both sections hash like the pin and render as the same URI, but they are two places.
    const body =
      "Every workspace starts with a 14-day free trial. No card required.";
    edit(
      root,
      "docs/pricing.md",
      (s) =>
        `${s.replace("## Trial", "## Free trial")}\n## Free trial\n${body}\n`,
    );
    const claim = checkPage(root, pageOf(root), sc).claims.find(
      (c) => c.id === "trial-length",
    );
    expect(claim?.status).toBe("ambiguous");
    expect(claim?.evidence.find((e) => e.uri.startsWith("doc://"))).toEqual({
      kind: "ambiguous",
      uri: "doc://pricing#trial",
      candidates: ["doc://pricing#free-trial"],
    });
  });
});

describe("D-2: re-anchoring is enforced inside reconcile", () => {
  const TAIL = BILLING_LINES.slice(3);

  function withDiff(now: string[], header: string) {
    const { root, sc } = useCorpus();
    writeBilling(root, now);
    const { llm, seen } = countingUpdater();
    const draft = reconcile(root, pageOf(root), sc, llm, {
      sourceRev: SOURCE_SHA,
      diff: diffOf(now, header),
    });
    return { draft, seen };
  }

  it("re-anchors a fused insert+edit to the edited line and pins the new span on apply", () => {
    // One hunk inserts a new constant and edits the seat price: -2 +2,2.
    const now = [
      "export const TRIAL_DAYS = 14;",
      "export const ANNUAL_DISCOUNT = 20;",
      "export const SEAT_PRICE_USD = 35;",
      "export const MAX_SEATS_FREE = 3;",
      ...TAIL,
    ];
    const { draft, seen } = withDiff(now, "@@ -2 +2,2 @@");
    expect(seen).toContain("seat-price");
    // The updater reads the re-anchored span (35 / 3), not the old L2-L3 (20 / 35).
    expect(draft.ops.find((o) => o.claimId === "seat-price")).toMatchObject({
      op: "update",
      after: "Each seat costs $35 per month; workspaces get 3 free seats.",
      newEvidence: ["repo://billing.ts#L3-L4"],
    });
  });

  it("turns a below-floor match into a review without calling the model", () => {
    const now = [
      "export const TRIAL_DAYS = 14;",
      "// pricing moved to the billing service",
      "export const MAX_SEATS_FREE = 3;",
      ...TAIL,
    ];
    const { draft, seen } = withDiff(now, "@@ -2 +2 @@");
    expect(draft.ops.find((o) => o.claimId === "seat-price")).toMatchObject({
      op: "review",
    });
    expect(seen).not.toContain("seat-price");
  });

  it("turns a span the diff deleted into a retract", () => {
    const now = ["export const TRIAL_DAYS = 14;", ...TAIL];
    const { draft } = withDiff(now, "@@ -2,2 +1,0 @@");
    expect(draft.ops.find((o) => o.claimId === "seat-price")).toMatchObject({
      op: "retract",
      why: "the merge deleted every span this fact was grounded on",
    });
  });
});

describe("D-4: op ids", () => {
  it("binds every op id to page, claim and source revision", () => {
    const { root, sc } = useCorpus();
    edit(root, "repo/billing.ts", (s) =>
      s.replace("TRIAL_DAYS = 14", "TRIAL_DAYS = 30"),
    );
    const draft = reconcile(root, pageOf(root), sc, stubUpdater(), {
      sourceRev: SOURCE_SHA,
    });
    for (const o of draft.ops)
      expect(parseOpKey(o.id)).toEqual({
        op: o.op,
        page: PAGE,
        claimId: o.claimId,
        sourceRev: SOURCE_SHA.slice(0, 12),
      });
  });

  it("gives the same change different ids at different source revisions", () => {
    const { root, sc } = useCorpus();
    edit(root, "repo/billing.ts", (s) =>
      s.replace("TRIAL_DAYS = 14", "TRIAL_DAYS = 30"),
    );
    const a = reconcile(root, pageOf(root), sc, stubUpdater(), {
      sourceRev: SOURCE_SHA,
    });
    const b = reconcile(root, pageOf(root), sc, stubUpdater(), {
      sourceRev: "460cdd27e59f8d965d85996ea1c27e498e069e9a",
    });
    expect(a.ops.map((o) => o.id)).not.toEqual(b.ops.map((o) => o.id));
    expect(
      applyDraft(
        root,
        pageOf(root),
        sc,
        b,
        a.ops.map((o) => o.id),
      ).sc.claims,
    ).toEqual(applyDraft(root, pageOf(root), sc, b).sc.claims);
  });

  it("retargetOp keeps page, claim and revision and drops the proposed text for non-text ops", () => {
    const { root, sc } = useCorpus();
    edit(root, "repo/billing.ts", (s) =>
      s.replace("TRIAL_DAYS = 14", "TRIAL_DAYS = 30"),
    );
    edit(root, "docs/pricing.md", (s) =>
      s.replace("14-day free trial", "30-day free trial"),
    );
    const draft = reconcile(root, pageOf(root), sc, stubUpdater(), {
      sourceRev: SOURCE_SHA,
    });
    const update = draft.ops.find((o) => o.op === "update");
    expect(update).toBeDefined();
    if (!update) return;
    const review = retargetOp(update, "review", "low confidence");
    expect(parseOpKey(review.id)).toEqual({
      op: "review",
      page: PAGE,
      claimId: update.claimId,
      sourceRev: SOURCE_SHA.slice(0, 12),
    });
    expect(review).toMatchObject({
      op: "review",
      auto: false,
      after: undefined,
      why: "low confidence",
    });
  });
});
