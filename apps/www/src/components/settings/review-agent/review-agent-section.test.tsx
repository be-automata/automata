import { describe, expect, it } from "vitest";

import {
  REVIEW_AGENT_CLEAR_PATCH,
  availableReviewAgentRepos,
  effectiveReviewMode,
  firstWriteFence,
  parseOptionalInt,
  reviewAgentOverrides,
} from "./review-agent-section";

const NO_AGENT = {
  reviewMode: null,
  reviewBatteries: null,
  reviewRunTests: null,
  reviewCommandTimeoutS: null,
  reviewMaxTurns: null,
};

function row(
  repoFullName: string,
  over: Partial<{
    reviewMode: "classic" | "orchestrated" | null;
    reviewBatteries:
      | ("gstack-review" | "somnio-review" | "gsd-reviewers")[]
      | null;
    reviewRunTests: boolean | null;
    reviewCommandTimeoutS: number | null;
    reviewMaxTurns: number | null;
    supersedePolicy: string | null;
  }> = {},
  updatedAt = "2026-10-03T00:00:00.000Z",
) {
  return {
    repoFullName,
    supersedePolicy: null,
    ...NO_AGENT,
    ...over,
    updatedAt,
  };
}

describe("effectiveReviewMode", () => {
  it("falls back to classic when nothing is set", () => {
    expect(effectiveReviewMode(null, null)).toBe("classic");
  });

  it("inherits the org value", () => {
    expect(effectiveReviewMode(null, "orchestrated")).toBe("orchestrated");
  });

  it("prefers the repo value", () => {
    expect(effectiveReviewMode("classic", "orchestrated")).toBe("classic");
  });
});

describe("reviewAgentOverrides", () => {
  it("keeps rows with any review-agent field set, including an empty pack list", () => {
    const rows = [
      row("acme/none", { supersedePolicy: "newest-wins" }),
      row("acme/mode", { reviewMode: "orchestrated" }),
      row("acme/packs", { reviewBatteries: [] }),
      row("acme/turns", { reviewMaxTurns: 10 }),
    ];
    expect(reviewAgentOverrides(rows).map((r) => r.repoFullName)).toEqual([
      "acme/mode",
      "acme/packs",
      "acme/turns",
    ]);
  });
});

describe("availableReviewAgentRepos", () => {
  it("offers repos without a review-agent override, case-insensitively, sorted", () => {
    const settings = [
      row("acme/api", { reviewMode: "classic" }),
      row("acme/web", { supersedePolicy: "newest-wins" }),
    ];
    expect(
      availableReviewAgentRepos(["Acme/Web", "zeta/x", "Acme/API"], settings),
    ).toEqual(["Acme/Web", "zeta/x"]);
  });
});

describe("firstWriteFence", () => {
  it("returns the existing row's version (case-insensitive)", () => {
    const settings = [
      row(
        "acme/web",
        { supersedePolicy: "newest-wins" },
        "2026-10-01T00:00:00.000Z",
      ),
    ];
    expect(firstWriteFence("Acme/Web", settings)).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });

  it("returns null when the repo has no row at all", () => {
    expect(firstWriteFence("acme/new", [])).toBeNull();
  });
});

describe("REVIEW_AGENT_CLEAR_PATCH", () => {
  it("clears all five fields", () => {
    expect(REVIEW_AGENT_CLEAR_PATCH).toEqual(NO_AGENT);
  });
});

describe("parseOptionalInt", () => {
  it("empty means inherit", () => {
    expect(parseOptionalInt("")).toBeNull();
    expect(parseOptionalInt("  ")).toBeNull();
  });

  it("parses a whole number", () => {
    expect(parseOptionalInt("120")).toBe(120);
  });

  it.each(["abc", "12.5", "-3", "1e2"])("rejects %j", (text) => {
    expect(parseOptionalInt(text)).toBeUndefined();
  });
});
