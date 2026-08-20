import { describe, it, expect, vi } from "vitest";
import type { Octokit } from "octokit";
import { fetchRepoSkillOverride } from "./repo-skill-override";

function octokitWith(getContent: ReturnType<typeof vi.fn>): Octokit {
  return { rest: { repos: { getContent } } } as unknown as Octokit;
}

const fileResponse = (text: string) => ({
  data: {
    type: "file",
    content: Buffer.from(text, "utf8").toString("base64"),
  },
});

describe("fetchRepoSkillOverride (#54 C5)", () => {
  it("SECURITY INVARIANT: the content request names NO ref — default branch only", async () => {
    // A PR head is attacker-controlled; any `ref` in this call is a hole. The
    // pin is on the argument object itself, so a future 'pass the automation
    // branch' change fails here before it ships.
    const getContent = vi.fn().mockResolvedValue(fileResponse("override body"));
    await fetchRepoSkillOverride({
      octokit: octokitWith(getContent),
      repoFullName: "acme/widgets",
      skillName: "github-ops",
    });
    expect(getContent).toHaveBeenCalledTimes(1);
    const args = getContent.mock.calls[0]![0] as Record<string, unknown>;
    expect(args).toEqual({
      owner: "acme",
      repo: "widgets",
      path: ".automata/skills/github-ops.md",
    });
    expect("ref" in args).toBe(false);
  });

  it("returns the decoded file text", async () => {
    const getContent = vi.fn().mockResolvedValue(fileResponse("skill text"));
    await expect(
      fetchRepoSkillOverride({
        octokit: octokitWith(getContent),
        repoFullName: "acme/widgets",
        skillName: "github-mention",
      }),
    ).resolves.toBe("skill text");
  });

  it("absent file (404) → null, silently", async () => {
    const getContent = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("Not Found"), { status: 404 }),
      );
    await expect(
      fetchRepoSkillOverride({
        octokit: octokitWith(getContent),
        repoFullName: "acme/widgets",
        skillName: "github-ops",
      }),
    ).resolves.toBeNull();
  });

  it("non-404 failure or a directory at the path → null (degrade, never block)", async () => {
    const boom = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("rate limited"), { status: 403 }),
      );
    await expect(
      fetchRepoSkillOverride({
        octokit: octokitWith(boom),
        repoFullName: "acme/widgets",
        skillName: "github-ops",
      }),
    ).resolves.toBeNull();

    const dir = vi.fn().mockResolvedValue({ data: [{ type: "file" }] });
    await expect(
      fetchRepoSkillOverride({
        octokit: octokitWith(dir),
        repoFullName: "acme/widgets",
        skillName: "github-ops",
      }),
    ).resolves.toBeNull();
  });
});
