import { beforeEach, describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";

import { createDb } from "../db";
import * as schema from "../db/schema";
import { getOrgAgentActivity } from "./agent-activity";
import {
  createTestAutomation,
  createTestOrg,
  createTestThread,
  createTestUser,
} from "./test-helpers";

const db = createDb(env.DATABASE_URL!);
const noRepoAccess = async () => false;

describe("getOrgAgentActivity", () => {
  let orgId: string;
  let otherOrgId: string;
  let viewerId: string;
  let teammateId: string;

  beforeEach(async () => {
    orgId = await createTestOrg({ db, name: "Activity" });
    otherOrgId = await createTestOrg({ db, name: "Elsewhere" });
    viewerId = (await createTestUser({ db })).user.id;
    teammateId = (await createTestUser({ db })).user.id;
  });

  it("only returns threads of the requested organization", async () => {
    const { threadId } = await createTestThread({
      db,
      userId: viewerId,
      overrides: { organizationId: orgId },
      chatOverrides: { status: "working" },
    });
    await createTestThread({
      db,
      userId: viewerId,
      overrides: { organizationId: otherOrgId },
      chatOverrides: { status: "working" },
    });
    const activity = await getOrgAgentActivity({
      db,
      organizationId: orgId,
      viewerUserId: viewerId,
      hasRepoAccess: noRepoAccess,
    });
    expect(activity.active.map((row) => row.threadId)).toEqual([threadId]);
    expect(activity.counts.running).toBe(1);
  });

  it("reads the effective status from the thread chat", async () => {
    const { threadId } = await createTestThread({
      db,
      userId: viewerId,
      enableThreadChatCreation: true,
      overrides: { organizationId: orgId },
      chatOverrides: { status: "queued-tasks-concurrency" },
    });
    const activity = await getOrgAgentActivity({
      db,
      organizationId: orgId,
      viewerUserId: viewerId,
      hasRepoAccess: noRepoAccess,
    });
    const row = activity.active.find((r) => r.threadId === threadId);
    expect(row?.state).toEqual({
      kind: "waiting",
      word: "queued",
      reason: "waiting for a free slot",
    });
    expect(activity.counts.waiting).toBe(1);
  });

  it("masks a teammate's private task and opens a repo-visible one with access", async () => {
    const { threadId: privateId } = await createTestThread({
      db,
      userId: teammateId,
      overrides: {
        organizationId: orgId,
        name: "Secret refactor",
        githubRepoFullName: "acme/private",
      },
      chatOverrides: { status: "working" },
    });
    const { threadId: repoId } = await createTestThread({
      db,
      userId: teammateId,
      overrides: {
        organizationId: orgId,
        name: "# Shared fix",
        githubRepoFullName: "acme/shared",
      },
      chatOverrides: { status: "working" },
    });
    await db.insert(schema.threadVisibility).values([
      { threadId: privateId, visibility: "private", organizationId: orgId },
      { threadId: repoId, visibility: "repo", organizationId: orgId },
    ]);
    const checked: string[] = [];
    const activity = await getOrgAgentActivity({
      db,
      organizationId: orgId,
      viewerUserId: viewerId,
      hasRepoAccess: async (repo) => {
        checked.push(repo);
        return repo === "acme/shared";
      },
    });
    const privateRow = activity.active.find((r) => r.threadId === privateId)!;
    const repoRow = activity.active.find((r) => r.threadId === repoId)!;
    expect(privateRow.canOpen).toBe(false);
    expect(privateRow.title).toBeNull();
    expect(privateRow.repoFullName).toBe("acme/private");
    expect(privateRow.starter.kind).toBe("member");
    expect(repoRow.canOpen).toBe(true);
    expect(repoRow.title).toBe("Shared fix");
    expect(checked).toEqual(["acme/shared"]);
  });

  it("lists a recent failure under needs-you until the owner reads it", async () => {
    const { threadId } = await createTestThread({
      db,
      userId: viewerId,
      overrides: {
        organizationId: orgId,
      },
      chatOverrides: {
        status: "working-error",
        errorMessage: "invalid-claude-credentials",
      },
    });
    const first = await getOrgAgentActivity({
      db,
      organizationId: orgId,
      viewerUserId: viewerId,
      hasRepoAccess: noRepoAccess,
    });
    expect(first.needsYou.map((r) => r.threadId)).toEqual([threadId]);
    expect(first.needsYou[0]!.needsYou?.action).toBe("reconnect-credential");

    await db.insert(schema.threadReadStatus).values({
      threadId,
      userId: viewerId,
      isRead: true,
      lastReadAt: new Date(Date.now() + 1000),
    });
    const second = await getOrgAgentActivity({
      db,
      organizationId: orgId,
      viewerUserId: viewerId,
      hasRepoAccess: noRepoAccess,
    });
    expect(second.needsYou).toEqual([]);
  });

  it("filters to my runs and to people-started runs", async () => {
    const automation = await createTestAutomation({ db, userId: teammateId });
    await createTestThread({
      db,
      userId: teammateId,
      overrides: {
        organizationId: orgId,
        automationId: automation.id,
      },
      chatOverrides: { status: "working" },
    });
    const { threadId: mine } = await createTestThread({
      db,
      userId: viewerId,
      overrides: { organizationId: orgId },
      chatOverrides: { status: "working" },
    });
    const mineOnly = await getOrgAgentActivity({
      db,
      organizationId: orgId,
      viewerUserId: viewerId,
      mineOnly: true,
      hasRepoAccess: noRepoAccess,
    });
    expect(mineOnly.active.map((r) => r.threadId)).toEqual([mine]);
    const people = await getOrgAgentActivity({
      db,
      organizationId: orgId,
      viewerUserId: viewerId,
      peopleOnly: true,
      hasRepoAccess: noRepoAccess,
    });
    expect(people.active.map((r) => r.threadId)).toEqual([mine]);
    const all = await getOrgAgentActivity({
      db,
      organizationId: orgId,
      viewerUserId: viewerId,
      hasRepoAccess: noRepoAccess,
    });
    const automationRow = all.active.find((r) => r.automationId !== null)!;
    expect(automationRow.trigger).toBe("automation");
    expect(automationRow.starter.kind).toBe("automation");
    expect(automationRow.automationName).toBe("Test Automation");
  });

  it("keeps finished runs from the last day under recent", async () => {
    const { threadId } = await createTestThread({
      db,
      userId: viewerId,
      overrides: { organizationId: orgId },
      chatOverrides: { status: "complete" },
    });
    const activity = await getOrgAgentActivity({
      db,
      organizationId: orgId,
      viewerUserId: viewerId,
      hasRepoAccess: noRepoAccess,
    });
    expect(activity.recent.map((r) => r.threadId)).toEqual([threadId]);
    expect(activity.recent[0]!.state.kind).toBe("done");
  });
});
