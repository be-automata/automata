import { describe, expect, it } from "vitest";

import { renderFixPrBody } from "./open-fix-pr";

const INPUT = {
  attempt: { id: "att_1", attemptNo: 1, gatedHeadSha: "abc123" },
  finding: { ruleId: "dep.vulnerable", fingerprint: "0123456789abcdef" },
  issueNumber: 42,
  diffLines: 0,
};

describe("renderFixPrBody", () => {
  it("says so when a fix moved only the lockfile (#277)", () => {
    const body = renderFixPrBody({ ...INPUT, flags: ["lockfile_only"] });
    expect(body).toContain("Lockfile-only change");
    expect(body).toContain("`pnpm.overrides`");
  });

  it("adds no lockfile note for a manifest-pinned fix", () => {
    expect(renderFixPrBody({ ...INPUT, flags: [] })).not.toContain(
      "Lockfile-only change",
    );
    expect(renderFixPrBody(INPUT)).not.toContain("Lockfile-only change");
  });
});
