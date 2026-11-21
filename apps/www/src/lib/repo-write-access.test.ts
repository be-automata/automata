import { describe, it, vi, beforeEach, expect } from "vitest";

import { checkRepoWriteAccess } from "./repo-write-access";
import { isOrgAdmin } from "@/lib/org-role";
import { checkRepoAdmin } from "@/lib/repo-admin";

vi.mock("@/lib/org-role", () => ({ isOrgAdmin: vi.fn() }));
vi.mock("@/lib/repo-admin", () => ({ checkRepoAdmin: vi.fn() }));

const args = {
  db: {} as never,
  userId: "user_1",
  organizationId: "org_1",
  repoFullName: "acme/widgets",
};

describe("checkRepoWriteAccess (#125 C6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("an org admin is allowed without a GitHub lookup", async () => {
    vi.mocked(isOrgAdmin).mockResolvedValue(true);
    expect(await checkRepoWriteAccess(args)).toBe("allowed");
    expect(isOrgAdmin).toHaveBeenCalledWith({
      db: args.db,
      organizationId: "org_1",
      userId: "user_1",
    });
    expect(checkRepoAdmin).not.toHaveBeenCalled();
  });

  it("a GitHub admin of the repo who is not an org admin is allowed", async () => {
    vi.mocked(isOrgAdmin).mockResolvedValue(false);
    vi.mocked(checkRepoAdmin).mockResolvedValue("admin");
    expect(await checkRepoWriteAccess(args)).toBe("allowed");
    expect(checkRepoAdmin).toHaveBeenCalledWith({
      userId: "user_1",
      repoFullName: "acme/widgets",
    });
  });

  it("neither an org admin nor a repo admin is not_repo_admin", async () => {
    vi.mocked(isOrgAdmin).mockResolvedValue(false);
    vi.mocked(checkRepoAdmin).mockResolvedValue("not-admin");
    expect(await checkRepoWriteAccess(args)).toBe("not_repo_admin");
  });

  it("a GitHub lookup that cannot answer is lookup_failed (fail-closed)", async () => {
    vi.mocked(isOrgAdmin).mockResolvedValue(false);
    vi.mocked(checkRepoAdmin).mockResolvedValue("lookup-failed");
    expect(await checkRepoWriteAccess(args)).toBe("lookup_failed");
  });
});
