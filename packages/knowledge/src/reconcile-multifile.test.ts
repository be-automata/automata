// ENG-01 (O4): one reconcile over a diff that spans many files re-anchors a stale pin in ANY changed
// file through that file's hunks, instead of sending every pin outside a single supplied file to review.
import { describe, expect, it } from "vitest";

import {
  ConflictingDiffOptionsError,
  DuplicateDiffPathError,
  reconcile,
  stubUpdater,
  type ReconcileDiff,
} from "./claims";
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
 * `RATE_LIMIT_PER_MINUTE = 120` -> `= 150` keeps one of three tokens: a value edit on a two-token line
 * scores 0.33, below the default re-anchor floor (0.5). The caller-supplied floor admits it; the default
 * floor sends it to review (pinned by its own test below).
 */
const SHORT_LINE_FLOOR = 0.3;

/**
 * The SC1 merge: a py constant changes in place, a yaml value changes below an inserted comment line, and
 * a README heading changes (nothing is pinned on it). Returns one diff per changed file, with the hunk
 * headers `git diff -U0` emits for exactly these edits.
 */
function mutateLimits(root: string, floor?: number): ReconcileDiff[] {
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
  const at = (d: ReconcileDiff) => (floor === undefined ? d : { ...d, floor });
  return [
    at(diffOfFile("ratelimit.py", fixture("ratelimit.py"), py, "@@ -1 +1 @@")),
    at(
      diffOfFile(
        "config.yaml",
        fixture("config.yaml"),
        yaml,
        "@@ -0,0 +1 @@\n@@ -3 +4 @@",
      ),
    ),
    at(diffOfFile("README.md", fixture("README.md"), readme, "@@ -1 +1 @@")),
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
    const diffs = mutateLimits(root, SHORT_LINE_FLOOR);
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

  it("at the default floor a two-token value edit is located through its file's diff, then reviewed below the floor", async () => {
    const { root, sc } = useLimitsCorpus();
    const diffs = mutateLimits(root);
    const { llm, seen } = countingUpdater();
    const draft = await reconcile(root, limitsPageOf(root), sc, llm, {
      sourceRev: SOURCE_SHA,
      diffs,
    });
    const op = draft.ops.find((o) => o.claimId === "api-rate");
    expect(op?.op).toBe("review");
    expect(op?.why).toMatch(/^re-anchor below-floor/);
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
    const [, yaml, readme] = mutateLimits(root, SHORT_LINE_FLOOR);
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

  it("passing both diff and diffs is refused", async () => {
    const { root, sc } = useCorpus();
    const billing = extendTrial(root);
    await expect(
      reconcile(root, pageOf(root), sc, stubUpdater(), {
        diff: billing,
        diffs: [billing],
      }),
    ).rejects.toBeInstanceOf(ConflictingDiffOptionsError);
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
  ])("%s is refused with the path", async (_, diffs) => {
    const { root, sc } = useCorpus();
    const err = await reconcile(root, pageOf(root), sc, stubUpdater(), {
      diffs,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DuplicateDiffPathError);
    expect((err as DuplicateDiffPathError).path).toBe("billing.ts");
  });

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
