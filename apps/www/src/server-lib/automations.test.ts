import { describe, it, vi, beforeEach, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestAutomation,
} from "@terragon/shared/model/test-helpers";
import { createOrganization } from "@terragon/shared/model/organizations";
import { bindGithubInstallationToOrg } from "@terragon/shared/model/github-installation";
import { automations as automationsTable } from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { User } from "@terragon/shared";
import { createNewThread } from "./new-thread-shared";
import { runAutomation } from "./automations";

vi.mock("./new-thread-shared", () => ({
  createNewThread: vi
    .fn()
    .mockResolvedValue({ threadId: "t1", threadChatId: "tc1" }),
}));

describe("runAutomation — org inheritance (WI-5)", () => {
  let user: User;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(createNewThread).mockResolvedValue({
      threadId: "t1",
      threadChatId: "tc1",
    });
    user = (await createTestUser({ db })).user;
  });

  it("creates the thread with the automation's org", async () => {
    const org = await createOrganization({
      db,
      name: "Acme",
      slug: `acme-${nanoid(8).toLowerCase()}`,
    });
    const automation = await createTestAutomation({ db, userId: user.id });
    // An automation is org-owned; stamp its org.
    await db
      .update(automationsTable)
      .set({ organizationId: org.id })
      .where(eq(automationsTable.id, automation.id));

    await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "manual",
    });

    expect(createNewThread).toHaveBeenCalledTimes(1);
    expect(createNewThread).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: org.id }),
    );
  });

  it("passes a null org when the automation has none (nullable-safe)", async () => {
    const automation = await createTestAutomation({ db, userId: user.id });

    await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "manual",
    });

    const callArgs = vi.mocked(createNewThread).mock.calls[0]?.[0];
    expect(callArgs?.organizationId ?? null).toBeNull();
  });

  it("shadow: runs as a shadow thread when the org's installation is in shadow mode", async () => {
    const org = await createOrganization({
      db,
      name: "ShadowOrg",
      slug: `shadow-${nanoid(8).toLowerCase()}`,
    });
    await bindGithubInstallationToOrg({
      db,
      installationId: Math.floor(Math.random() * 1_000_000_000),
      organizationId: org.id,
      mode: "shadow",
    });
    const automation = await createTestAutomation({ db, userId: user.id });
    await db
      .update(automationsTable)
      .set({ organizationId: org.id })
      .where(eq(automationsTable.id, automation.id));

    await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "manual",
    });

    expect(createNewThread).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: org.id, shadow: true }),
    );
  });

  it("active/none: runs as a non-shadow thread when the org has no shadow installation", async () => {
    const org = await createOrganization({
      db,
      name: "ActiveOrg",
      slug: `active-${nanoid(8).toLowerCase()}`,
    });
    await bindGithubInstallationToOrg({
      db,
      installationId: Math.floor(Math.random() * 1_000_000_000),
      organizationId: org.id,
      mode: "active",
    });
    const automation = await createTestAutomation({ db, userId: user.id });
    await db
      .update(automationsTable)
      .set({ organizationId: org.id })
      .where(eq(automationsTable.id, automation.id));

    await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "manual",
    });

    expect(createNewThread).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: org.id, shadow: false }),
    );
  });
});
