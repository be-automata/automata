import { describe, expect, it, vi } from "vitest";

import { memoizeMint } from "./fix-attempt-session";

describe("memoizeMint", () => {
  it("mints once per repo, case-insensitively", async () => {
    const mint = vi.fn(
      async ({ owner, repo }: { owner: string; repo: string }) => ({
        key: `${owner}/${repo}`,
      }),
    );
    const memo = memoizeMint(mint);
    const a = await memo({ owner: "Acme", repo: "Widgets" });
    const b = await memo({ owner: "acme", repo: "widgets" });
    await memo({ owner: "acme", repo: "gadgets" });
    expect(a).toBe(b);
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed mint failed for its lifetime; a new memo mints again", async () => {
    const mint = vi
      .fn<(args: { owner: string; repo: string }) => Promise<string>>()
      .mockRejectedValueOnce(new Error("mint down"))
      .mockResolvedValue("token");
    const memo = memoizeMint(mint);
    await expect(memo({ owner: "a", repo: "b" })).rejects.toThrow("mint down");
    await expect(memo({ owner: "a", repo: "b" })).rejects.toThrow("mint down");
    expect(mint).toHaveBeenCalledTimes(1);
    await expect(memoizeMint(mint)({ owner: "a", repo: "b" })).resolves.toBe(
      "token",
    );
  });
});
