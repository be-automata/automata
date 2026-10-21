import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { nanoid } from "nanoid";

import { getInstallationToken } from "@terragon/shared/github-app";

// The REAL updateGitHubPR (bypassing the test-setup @/lib/github mock), so
// the order of its DB check and its token mint is what runs.
const { updateGitHubPR } = (await vi.importActual(
  "@/lib/github",
)) as typeof import("@/lib/github");

describe("updateGitHubPR on a PR the platform does not track", () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    vi.clearAllMocks();
    // A 404 (never retried by Octokit) stands in for GitHub: no request leaves
    // the test, and the control case below fails fast.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // protects=#447: a webhook ack for an untracked PR (check_run, check_suite,
  //   pull_request.* on repos with no platform thread) pays no installation
  //   token mint (2 GitHub round trips) and no PR read;
  // fails_when=the token is minted, or any HTTP request is made, before the
  //   DB lookup says the PR is untracked;
  // no_claim=the tracked-PR path's GitHub calls, which are unchanged.
  it("returns after the DB lookup with zero GitHub calls", async () => {
    await expect(
      updateGitHubPR({
        repoFullName: `owner-${nanoid(6)}/repo`,
        prNumber: 1,
        createIfNotFound: false,
      }),
    ).resolves.toBeUndefined();

    expect(getInstallationToken).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Control for the case above: with createIfNotFound the same untracked PR
  // does reach the mint, so the spies above can see one.
  it("control: createIfNotFound still mints a token for an untracked PR", async () => {
    await expect(
      updateGitHubPR({
        repoFullName: `owner-${nanoid(6)}/repo`,
        prNumber: 1,
        createIfNotFound: true,
      }),
    ).rejects.toThrow();

    expect(getInstallationToken).toHaveBeenCalledTimes(1);
  });
});
