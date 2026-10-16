import { describe, expect, it } from "vitest";

import {
  HIDDEN_REPOS_LABEL,
  maskReposWithoutAccess,
} from "./usage-repo-masking";

const at = (iso: string) => new Date(iso);

describe("maskReposWithoutAccess", () => {
  it("keeps visible repos and folds the rest into one unnamed row", async () => {
    const rows = [
      {
        repoFullName: "acme/api",
        tasks: 4,
        merged: 2,
        errored: 1,
        lastActivityAt: at("2026-10-15T00:00:00Z"),
        daily: [1, 3],
      },
      {
        repoFullName: "acme/secret",
        tasks: 2,
        merged: 1,
        errored: 0,
        lastActivityAt: at("2026-10-16T00:00:00Z"),
        daily: [2, 0],
      },
      {
        repoFullName: "acme/other",
        tasks: 1,
        merged: 0,
        errored: 1,
        lastActivityAt: at("2026-10-14T00:00:00Z"),
        daily: [0, 1],
      },
    ];
    const result = await maskReposWithoutAccess(
      rows,
      async (repo) => repo === "acme/api",
    );
    expect(result.map((r) => r.repoFullName)).toEqual([
      "acme/api",
      HIDDEN_REPOS_LABEL,
    ]);
    expect(result[1]).toMatchObject({
      hidden: true,
      tasks: 3,
      merged: 1,
      errored: 1,
      daily: [2, 1],
      lastActivityAt: at("2026-10-16T00:00:00Z"),
    });
    expect(JSON.stringify(result)).not.toContain("acme/secret");
  });

  it("treats a failed access check as hidden and leaves all-visible input alone", async () => {
    const row = {
      repoFullName: "acme/api",
      tasks: 1,
      merged: 0,
      errored: 0,
      lastActivityAt: at("2026-10-15T00:00:00Z"),
      daily: [1],
    };
    expect(await maskReposWithoutAccess([row], async () => true)).toEqual([
      row,
    ]);
    const failed = await maskReposWithoutAccess([row], async () => {
      throw new Error("rate limited");
    });
    expect(failed[0]!.repoFullName).toBe(HIDDEN_REPOS_LABEL);
  });
});
