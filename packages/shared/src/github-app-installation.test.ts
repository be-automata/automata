import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.fn();
vi.mock("@octokit/app", () => ({
  App: vi.fn().mockImplementation(() => ({ octokit: { request } })),
}));

import { getRepoInstallationId, resetAppInstance } from "./github-app.js";

describe("getRepoInstallationId", () => {
  beforeEach(() => {
    request.mockReset();
    resetAppInstance();
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_PRIVATE_KEY = "fake-private-key";
  });

  it("returns the id of the installation that covers the repo", async () => {
    request.mockResolvedValueOnce({ data: { id: 42 } });
    await expect(getRepoInstallationId("acme-inc", "core")).resolves.toBe(42);
    expect(request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/installation",
      { owner: "acme-inc", repo: "core" },
    );
  });

  it("returns null when the App is not installed on the repo", async () => {
    request.mockRejectedValueOnce(
      Object.assign(new Error("nf"), { status: 404 }),
    );
    await expect(getRepoInstallationId("acme-inc", "core")).resolves.toBeNull();
  });

  it("rethrows any other failure: an outage is not 'not installed'", async () => {
    request.mockRejectedValueOnce(
      Object.assign(new Error("down"), { status: 503 }),
    );
    await expect(getRepoInstallationId("acme-inc", "core")).rejects.toThrow(
      "down",
    );
  });
});
