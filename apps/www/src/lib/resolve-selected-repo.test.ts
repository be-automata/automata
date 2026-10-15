import { describe, expect, it } from "vitest";

import { resolveSelectedRepo } from "./resolve-selected-repo";

const repos = [
  { full_name: "acme/api", default_branch: "main" },
  { full_name: "acme/web", default_branch: "trunk" },
];

describe("resolveSelectedRepo", () => {
  it("keeps a selection the active org's list holds", () => {
    expect(
      resolveSelectedRepo({
        selectedRepoFullName: "acme/web",
        selectedBranch: "feature",
        repos,
      }),
    ).toEqual({ repoFullName: "acme/web", branchName: "feature" });
  });

  it("ignores a selection from another org and falls back to the first repo", () => {
    expect(
      resolveSelectedRepo({
        selectedRepoFullName: "customer-org/app",
        selectedBranch: "feature",
        repos,
      }),
    ).toEqual({ repoFullName: "acme/api", branchName: "main" });
  });

  it("falls back to none when the org lists no repos", () => {
    expect(
      resolveSelectedRepo({
        selectedRepoFullName: "customer-org/app",
        selectedBranch: "main",
        repos: [],
      }),
    ).toEqual({ repoFullName: null, branchName: null });
  });

  it("keeps the stored selection while the list is unknown", () => {
    expect(
      resolveSelectedRepo({
        selectedRepoFullName: "acme/web",
        selectedBranch: "main",
        repos: undefined,
      }),
    ).toEqual({ repoFullName: "acme/web", branchName: "main" });
  });

  it("uses main when the fallback repo has no default branch", () => {
    expect(
      resolveSelectedRepo({
        selectedRepoFullName: null,
        selectedBranch: null,
        repos: [{ full_name: "acme/api" }],
      }),
    ).toEqual({ repoFullName: "acme/api", branchName: "main" });
  });
});
