// ENG-01 (O4): one reconcile over a diff that spans many files re-anchors a stale pin in ANY changed
// file through that file's hunks, instead of sending every pin outside a single supplied file to review.
import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyDraft,
  InvalidEvidenceUriError,
  reconcile,
  stubUpdater,
  UnappliableOpError,
  type Draft,
  type ReconcileDiff,
} from "./claims";
import { parseUnifiedDiff } from "./diff";
import { parseHunks } from "./reanchor";
import {
  countingUpdater,
  diffOfFile,
  edit,
  FIXTURES,
  limitsPageOf,
  pageOf,
  SOURCE_SHA,
  useCorpus,
  useLimitsCorpus,
  writeRepo,
} from "./test-fixtures";

const fixture = (rel: string) => FIXTURES[`repo/${rel}`] ?? "";

/**
 * The SC1 merge: a py constant changes in place, a yaml value changes below an inserted comment line, and
 * a README heading changes (nothing is pinned on it). Returns one diff per changed file, with the hunk
 * headers `git diff -U0` emits for exactly these edits.
 */
function mutateLimits(root: string): ReconcileDiff[] {
  const py = fixture("ratelimit.py").replace(
    "RATE_LIMIT_PER_MINUTE = 120",
    "RATE_LIMIT_PER_MINUTE = 150",
  );
  const yaml = `# tuned for the new plan\n${fixture("config.yaml").replace(
    "requests_per_minute: 120",
    "requests_per_minute: 150",
  )}`;
  const readme = fixture("README.md").replace("# Limits", "# API limits");
  writeRepo(root, "ratelimit.py", py);
  writeRepo(root, "config.yaml", yaml);
  writeRepo(root, "README.md", readme);
  return [
    diffOfFile("ratelimit.py", fixture("ratelimit.py"), py, "@@ -1 +1 @@"),
    diffOfFile(
      "config.yaml",
      fixture("config.yaml"),
      yaml,
      "@@ -0,0 +1 @@\n@@ -3 +4 @@",
    ),
    diffOfFile("README.md", fixture("README.md"), readme, "@@ -1 +1 @@"),
  ];
}

/** The trial moves from 14 to 30 days in code (billing.ts L1) and in the marketing doc. */
function extendTrial(root: string): ReconcileDiff {
  const billing = fixture("billing.ts").replace(
    "TRIAL_DAYS = 14",
    "TRIAL_DAYS = 30",
  );
  writeRepo(root, "billing.ts", billing);
  edit(root, "docs/pricing.md", (s) =>
    s.replace("14-day free trial", "30-day free trial"),
  );
  return diffOfFile(
    "billing.ts",
    fixture("billing.ts"),
    billing,
    "@@ -1 +1 @@",
  );
}

describe("reconcile over a multi-file diff (SC1)", () => {
  it("re-anchors stale pins in every changed file with one batched model call", async () => {
    const { root, sc } = useLimitsCorpus();
    const diffs = mutateLimits(root);
    const { llm, seen } = countingUpdater();
    const draft = await reconcile(root, limitsPageOf(root), sc, llm, {
      sourceRev: SOURCE_SHA,
      diffs,
    });
    expect(draft.ops.find((o) => o.claimId === "api-rate")).toMatchObject({
      op: "update",
      after: "The API allows 150 requests per minute.",
      newEvidence: ["repo://ratelimit.py#L1-L1", "repo://config.yaml#L4-L4"],
    });
    expect(draft.ops.find((o) => o.claimId === "burst")).toBeUndefined();
    expect(draft.ops.find((o) => o.claimId === "readme-rate")).toBeUndefined();
    expect(draft.ops.some((o) => o.op === "review")).toBe(false);
    expect(draft.llmCalls).toBe(1);
    expect(seen).toEqual(["api-rate"]);
  });

  it("at the default floor a two-token value edit (similarity 0.33) re-anchors by position, not to review", async () => {
    // `RATE_LIMIT_PER_MINUTE = 120` -> `= 150` keeps one of three tokens, below the 0.5 floor. Each file's
    // hunk replaces exactly the pinned line with one line, so the positional rule locates it.
    const { root, sc } = useLimitsCorpus();
    const diffs = mutateLimits(root);
    expect(diffs.every((d) => d.floor === undefined)).toBe(true);
    const { llm, seen } = countingUpdater();
    const draft = await reconcile(root, limitsPageOf(root), sc, llm, {
      sourceRev: SOURCE_SHA,
      diffs,
    });
    expect(draft.ops.find((o) => o.claimId === "api-rate")).toMatchObject({
      op: "update",
      newEvidence: ["repo://ratelimit.py#L1-L1", "repo://config.yaml#L4-L4"],
    });
    expect(draft.ops.some((o) => o.op === "review")).toBe(false);
    expect(draft.llmCalls).toBe(1);
    expect(seen).toEqual(["api-rate"]);
  });

  it("the default floor still applies when the hunk is not a one-for-one replacement of the pin", async () => {
    // The py constant is a one-for-one edit (positional). In config.yaml, lines 2-4 are rewritten as three
    // new lines: the 1-line pin on L3 sits inside a wider hunk, so it is scored. The best window
    // (`burst: 120`, 0.33) is below the floor: review, no model call.
    const { root, sc } = useLimitsCorpus();
    const [py] = mutateLimits(root);
    const before = fixture("config.yaml");
    const yaml = before.replace(
      "  api:\n    requests_per_minute: 120\n  seats:",
      "  rate:\n    burst: 120\n  seat_caps:",
    );
    expect(yaml).not.toBe(before);
    writeRepo(root, "config.yaml", yaml);
    const { llm, seen } = countingUpdater();
    const draft = await reconcile(root, limitsPageOf(root), sc, llm, {
      sourceRev: SOURCE_SHA,
      diffs: [
        py as ReconcileDiff,
        diffOfFile("config.yaml", before, yaml, "@@ -2,3 +2,3 @@"),
      ],
    });
    const op = draft.ops.find((o) => o.claimId === "api-rate");
    expect(op?.op).toBe("review");
    expect(op?.why).toMatch(/^re-anchor below-floor \(similarity 0\.33\)/);
    expect(draft.llmCalls).toBe(0);
    expect(seen).toEqual([]);
  });

  it("a billing line pin re-anchors through its own file's diff while another file also changed", async () => {
    const { root, sc } = useCorpus();
    const billing = extendTrial(root);
    const [py] = mutateLimits(root);
    const { llm, seen } = countingUpdater();
    const draft = await reconcile(root, pageOf(root), sc, llm, {
      sourceRev: SOURCE_SHA,
      diffs: [billing, py as ReconcileDiff],
    });
    expect(draft.ops.find((o) => o.claimId === "trial-length")).toMatchObject({
      op: "update",
      after: "Trials last 30 days and need no card.",
      newEvidence: ["repo://billing.ts#L1-L1", "doc://pricing#trial"],
    });
    expect(draft.ops.some((o) => o.op === "review")).toBe(false);
    expect(seen).toEqual(["trial-length"]);
  });

  it("a stale line pin on a file absent from the diffs becomes a review and never reaches the model", async () => {
    const { root, sc } = useLimitsCorpus();
    const [, yaml, readme] = mutateLimits(root);
    const { llm, seen } = countingUpdater();
    const draft = await reconcile(root, limitsPageOf(root), sc, llm, {
      sourceRev: SOURCE_SHA,
      diffs: [yaml as ReconcileDiff, readme as ReconcileDiff],
    });
    const op = draft.ops.find((o) => o.claimId === "api-rate");
    expect(op?.op).toBe("review");
    expect(op?.why).toMatch(/^no diff for ratelimit\.py/);
    expect(seen).not.toContain("api-rate");
    expect(draft.llmCalls).toBe(0);
  });

  it("a pin pushed past end-of-file in a file present in the diffs is a re-anchor candidate, not a retraction", async () => {
    const { root, sc } = useCorpus();
    // Lines 1-7 collapse into one edited seat-price line: the old L2-L3 pin is now past EOF.
    const now = "export const SEAT_PRICE_USD = 35;";
    writeRepo(root, "billing.ts", now);
    const { llm } = countingUpdater();
    const draft = await reconcile(root, pageOf(root), sc, llm, {
      sourceRev: SOURCE_SHA,
      diffs: [
        diffOfFile("billing.ts", fixture("billing.ts"), now, "@@ -1,7 +1 @@"),
      ],
    });
    const op = draft.ops.find((o) => o.claimId === "seat-price");
    expect(op?.op).toBe("review");
    expect(op?.why).toMatch(/^re-anchor /);
  });

  it.each([
    [
      "two entries with the same path",
      [
        { path: "billing.ts", hunks: [], oldText: "", newText: "" },
        { path: "billing.ts", hunks: [], oldText: "", newText: "" },
      ],
    ],
    [
      "a path equal to another entry's rename source",
      [
        {
          path: "src/billing.ts",
          oldPath: "billing.ts",
          hunks: [],
          oldText: "",
          newText: "",
        },
        { path: "billing.ts", hunks: [], oldText: "", newText: "" },
      ],
    ],
  ])(
    "%s makes only that path ambiguous: its pins become reviews, reconcile does not throw",
    async (_, diffs) => {
      const { root, sc } = useCorpus();
      extendTrial(root);
      const draft = await reconcile(root, pageOf(root), sc, stubUpdater(), {
        sourceRev: SOURCE_SHA,
        diffs,
      });
      const op = draft.ops.find((o) => o.claimId === "trial-length");
      expect(op?.op).toBe("review");
      expect(op?.why).toMatch(/^two diff entries name billing\.ts/);
      expect(draft.llmCalls).toBe(0);
    },
  );

  it("an empty diffs list behaves like no diff at all (positional re-pin)", async () => {
    const { root, sc } = useCorpus();
    extendTrial(root);
    const none = await reconcile(root, pageOf(root), sc, stubUpdater(), {
      sourceRev: SOURCE_SHA,
    });
    const empty = await reconcile(root, pageOf(root), sc, stubUpdater(), {
      sourceRev: SOURCE_SHA,
      diffs: [],
    });
    expect(empty).toEqual(none);
    expect(empty.ops.find((o) => o.claimId === "trial-length")).toMatchObject({
      op: "update",
    });
  });
});

const PY = fixture("ratelimit.py");
const MOVED = "limits/ratelimit.py";

/** ratelimit.py moves to limits/ratelimit.py (optionally edited on the way); the old file is gone. */
function moveRatelimit(
  root: string,
  header = "",
  change: (s: string) => string = (s) => s,
): ReconcileDiff {
  mkdirSync(join(root, "repo/limits"), { recursive: true });
  renameSync(join(root, "repo/ratelimit.py"), join(root, "repo", MOVED));
  const now = change(PY);
  writeRepo(root, MOVED, now);
  return diffOfFile(MOVED, PY, now, header, "ratelimit.py");
}

const opFor = (draft: Draft, claimId: string) =>
  draft.ops.find((o) => o.claimId === claimId);

describe("renames and deletions", () => {
  it("a pure rename re-pins mechanically onto the new path, applies, and is idempotent", async () => {
    const { root, sc } = useLimitsCorpus();
    const diffs = [moveRatelimit(root)];
    const { llm, seen } = countingUpdater();
    const md = limitsPageOf(root);
    const draft = await reconcile(root, md, sc, llm, {
      sourceRev: SOURCE_SHA,
      diffs,
    });
    const burstPin = sc.claims.find((c) => c.id === "burst")?.evidence[0];
    expect(opFor(draft, "burst")).toMatchObject({
      op: "repin",
      auto: true,
      newEvidence: [`repo://${MOVED}#L2-L2`],
      newEvidenceHash: [burstPin?.hash],
    });
    expect(opFor(draft, "api-rate")).toMatchObject({
      op: "repin",
      auto: true,
      newEvidence: [`repo://${MOVED}#L1-L1`, "repo://config.yaml#L3-L3"],
    });
    expect(opFor(draft, "readme-rate")).toBeUndefined();
    expect(draft.llmCalls).toBe(0);
    expect(seen).toEqual([]);

    const out = applyDraft(root, md, sc, draft);
    expect(out.md).toBe(md);
    expect(
      out.sc.claims.map((c) => [c.id, c.evidence.map((e) => e.uri)]),
    ).toEqual([
      ["api-rate", [`repo://${MOVED}#L1-L1`, "repo://config.yaml#L3-L3"]],
      ["burst", [`repo://${MOVED}#L2-L2`]],
      ["readme-rate", ["repo://README.md#L3-L3"]],
    ]);
    const again = await reconcile(root, out.md, out.sc, llm, {
      sourceRev: SOURCE_SHA,
      diffs,
    });
    expect(again.ops).toEqual([]);
    expect(again.llmCalls).toBe(0);
  });

  it("a renamed and edited file goes through the normal update path at the new path", async () => {
    const { root, sc } = useLimitsCorpus();
    const diffs = [
      moveRatelimit(root, "@@ -2 +2 @@", (s) =>
        s.replace("BURST_ALLOWANCE = 20", "BURST_ALLOWANCE = 25"),
      ),
    ];
    const { llm, seen } = countingUpdater();
    const draft = await reconcile(root, limitsPageOf(root), sc, llm, {
      sourceRev: SOURCE_SHA,
      diffs,
    });
    expect(opFor(draft, "burst")).toMatchObject({
      op: "update",
      after: "Bursts may exceed the limit by 25 requests.",
      newEvidence: [`repo://${MOVED}#L2-L2`],
    });
    expect(opFor(draft, "api-rate")).toMatchObject({
      op: "repin",
      newEvidence: [`repo://${MOVED}#L1-L1`, "repo://config.yaml#L3-L3"],
    });
    expect(draft.llmCalls).toBe(1);
    expect(seen).toEqual(["burst"]);
  });

  it("a rename repin whose new span no longer holds the pinned content is refused", async () => {
    const { root, sc } = useLimitsCorpus();
    const md = limitsPageOf(root);
    const draft = await reconcile(root, md, sc, stubUpdater(), {
      sourceRev: SOURCE_SHA,
      diffs: [moveRatelimit(root)],
    });
    writeRepo(
      root,
      MOVED,
      PY.replace("BURST_ALLOWANCE = 20", "BURST_ALLOWANCE = 99"),
    );
    expect(() => applyDraft(root, md, sc, draft)).toThrow(UnappliableOpError);
    expect(() => applyDraft(root, md, sc, draft)).toThrow(
      /a rename repin must land on content identical/,
    );
  });

  it("a rename repin naming an unsafe target is refused, never read", async () => {
    const { root, sc } = useLimitsCorpus();
    const md = limitsPageOf(root);
    const draft = await reconcile(root, md, sc, stubUpdater(), {
      sourceRev: SOURCE_SHA,
      diffs: [moveRatelimit(root)],
    });
    const forged: Draft = {
      ...draft,
      ops: draft.ops.map((o) =>
        o.claimId === "burst"
          ? { ...o, newEvidence: ["repo://../x#L1-L1"] }
          : o,
      ),
    };
    const err = (() => {
      try {
        applyDraft(root, md, sc, forged);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(
      err instanceof InvalidEvidenceUriError ||
        err instanceof UnappliableOpError,
    ).toBe(true);
  });

  it("a rename target outside the repository becomes a review", async () => {
    const { root, sc } = useLimitsCorpus();
    rmSync(join(root, "repo/ratelimit.py"));
    const draft = await reconcile(root, limitsPageOf(root), sc, stubUpdater(), {
      sourceRev: SOURCE_SHA,
      diffs: [diffOfFile("../ratelimit.py", PY, PY, "", "ratelimit.py")],
    });
    expect(opFor(draft, "burst")).toMatchObject({ op: "review" });
    expect(opFor(draft, "burst")?.why).toMatch(/outside the repository/);
  });

  it("a same-file relocation repin carries no proposal, exactly as before", async () => {
    const { root, sc } = useCorpus();
    const now = `// header\n${fixture("billing.ts")}`;
    writeRepo(root, "billing.ts", now);
    const draft = await reconcile(root, pageOf(root), sc, stubUpdater(), {
      sourceRev: SOURCE_SHA,
      diffs: [
        diffOfFile("billing.ts", fixture("billing.ts"), now, "@@ -0,0 +1 @@"),
      ],
    });
    const op = opFor(draft, "seat-price");
    expect(op).toMatchObject({ op: "repin", auto: true });
    expect(Object.keys(op ?? {}).sort()).toEqual([
      "auto",
      "before",
      "claimId",
      "evidence",
      "id",
      "op",
      "why",
    ]);
  });

  it("a deleted file retracts its sole-source claims and reviews claims that still hold elsewhere", async () => {
    const { root, sc } = useCorpus();
    rmSync(join(root, "repo/billing.ts"));
    const draft = await reconcile(root, pageOf(root), sc, stubUpdater(), {
      sourceRev: SOURCE_SHA,
      diffs: [
        {
          path: "billing.ts",
          hunks: parseHunks("@@ -1,7 +0,0 @@"),
          oldText: fixture("billing.ts"),
          newText: "",
        },
      ],
    });
    expect(opFor(draft, "seat-price")).toMatchObject({ op: "retract" });
    expect(opFor(draft, "trial-length")).toMatchObject({ op: "review" });
  });
});

/** `git diff --no-color -U0 -M` for the SC1 merge (mutateLimits). */
const SC1_GIT_DIFF = [
  "diff --git a/README.md b/README.md",
  "index 1111111..2222222 100644",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1 @@",
  "-# Limits",
  "+# API limits",
  "diff --git a/config.yaml b/config.yaml",
  "index 3333333..4444444 100644",
  "--- a/config.yaml",
  "+++ b/config.yaml",
  "@@ -0,0 +1 @@",
  "+# tuned for the new plan",
  "@@ -3 +4 @@ limits:",
  "-    requests_per_minute: 120",
  "+    requests_per_minute: 150",
  "diff --git a/ratelimit.py b/ratelimit.py",
  "index 5555555..6666666 100644",
  "--- a/ratelimit.py",
  "+++ b/ratelimit.py",
  "@@ -1 +1 @@",
  "-RATE_LIMIT_PER_MINUTE = 120",
  "+RATE_LIMIT_PER_MINUTE = 150",
  "",
].join("\n");

describe("parser integration", () => {
  it("parseUnifiedDiff output plus file texts gives the same draft as the hand-built SC1 diffs", async () => {
    const { root, sc } = useLimitsCorpus();
    const hand = mutateLimits(root);
    const parsed: ReconcileDiff[] = parseUnifiedDiff(SC1_GIT_DIFF).map((f) => ({
      path: f.path,
      ...(f.oldPath ? { oldPath: f.oldPath } : {}),
      hunks: f.hunks,
      oldText: fixture(f.oldPath ?? f.path),
      newText: readFileSync(join(root, "repo", f.path), "utf8"),
    }));
    const hunksByPath = (ds: ReconcileDiff[]) =>
      Object.fromEntries(ds.map((d) => [d.path, d.hunks]));
    expect(hunksByPath(parsed)).toEqual(hunksByPath(hand));
    const md = limitsPageOf(root);
    const fromHand = await reconcile(root, md, sc, stubUpdater(), {
      sourceRev: SOURCE_SHA,
      diffs: hand,
    });
    const fromParser = await reconcile(root, md, sc, stubUpdater(), {
      sourceRev: SOURCE_SHA,
      diffs: parsed,
    });
    expect(fromParser).toEqual(fromHand);
    expect(fromParser.ops.some((o) => o.op === "review")).toBe(false);
    expect(opFor(fromParser, "api-rate")).toMatchObject({ op: "update" });
  });

  it("a parsed pure rename feeds the rename repin", async () => {
    const { root, sc } = useLimitsCorpus();
    moveRatelimit(root);
    const parsed: ReconcileDiff[] = parseUnifiedDiff(
      [
        `diff --git a/ratelimit.py b/${MOVED}`,
        "similarity index 100%",
        "rename from ratelimit.py",
        `rename to ${MOVED}`,
        "",
      ].join("\n"),
    ).map((f) => ({
      path: f.path,
      ...(f.oldPath ? { oldPath: f.oldPath } : {}),
      hunks: f.hunks,
      oldText: PY,
      newText: readFileSync(join(root, "repo", f.path), "utf8"),
    }));
    const draft = await reconcile(root, limitsPageOf(root), sc, stubUpdater(), {
      sourceRev: SOURCE_SHA,
      diffs: parsed,
    });
    expect(opFor(draft, "burst")).toMatchObject({
      op: "repin",
      newEvidence: [`repo://${MOVED}#L2-L2`],
    });
  });
});
