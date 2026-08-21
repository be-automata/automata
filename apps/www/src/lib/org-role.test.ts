import { describe, it, vi, beforeEach, expect } from "vitest";
import { isOrgAdmin, ORG_ADMIN_ROLES } from "./org-role";
import { getMembership } from "@terragon/shared/model/organizations";

vi.mock("@terragon/shared/model/organizations", () => ({
  getMembership: vi.fn(),
}));

const ORG = "org_1";
const USER = "user_1";
const db = {} as never;

describe("isOrgAdmin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows an owner", async () => {
    vi.mocked(getMembership).mockResolvedValue({
      id: "m1",
      organizationId: ORG,
      userId: USER,
      role: "owner",
      createdAt: new Date(),
    } as never);
    await expect(
      isOrgAdmin({ db, organizationId: ORG, userId: USER }),
    ).resolves.toBe(true);
  });

  it("allows an admin", async () => {
    vi.mocked(getMembership).mockResolvedValue({
      id: "m1",
      organizationId: ORG,
      userId: USER,
      role: "admin",
      createdAt: new Date(),
    } as never);
    await expect(
      isOrgAdmin({ db, organizationId: ORG, userId: USER }),
    ).resolves.toBe(true);
  });

  it("denies a plain member", async () => {
    vi.mocked(getMembership).mockResolvedValue({
      id: "m1",
      organizationId: ORG,
      userId: USER,
      role: "member",
      createdAt: new Date(),
    } as never);
    await expect(
      isOrgAdmin({ db, organizationId: ORG, userId: USER }),
    ).resolves.toBe(false);
  });

  it("denies when there is no membership row", async () => {
    vi.mocked(getMembership).mockResolvedValue(undefined);
    await expect(
      isOrgAdmin({ db, organizationId: ORG, userId: USER }),
    ).resolves.toBe(false);
  });

  it("ORG_ADMIN_ROLES contains exactly owner and admin", () => {
    expect(ORG_ADMIN_ROLES.has("owner")).toBe(true);
    expect(ORG_ADMIN_ROLES.has("admin")).toBe(true);
    expect(ORG_ADMIN_ROLES.has("member")).toBe(false);
    expect(ORG_ADMIN_ROLES.size).toBe(2);
  });
});
