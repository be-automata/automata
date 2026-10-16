import { beforeEach, describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";

import { createDb } from "../db";
import { getOrgUsageStats } from "./org-usage-stats";
import {
  createTestGitHubPR,
  createTestOrg,
  createTestThread,
  createTestUser,
} from "./test-helpers";

const db = createDb(env.DATABASE_URL!);
const range = () => ({
  startDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
  endDate: new Date(Date.now() + 60 * 1000),
});

describe("getOrgUsageStats", () => {
  let orgId: string;
  let otherOrgId: string;
  let aliceId: string;
  let bobId: string;

  beforeEach(async () => {
    orgId = await createTestOrg({ db, name: "Usage" });
    otherOrgId = await createTestOrg({ db, name: "Other" });
    aliceId = (await createTestUser({ db })).user.id;
    bobId = (await createTestUser({ db })).user.id;
  });

  it("counts only the organization's threads, by repo, member, source and outcome", async () => {
    const pr = await createTestGitHubPR({
      db,
      overrides: { repoFullName: "acme/api", status: "merged" },
    });
    await createTestThread({
      db,
      userId: aliceId,
      overrides: {
        organizationId: orgId,
        githubRepoFullName: "acme/api",
        githubPRNumber: pr.number,
      },
      chatOverrides: { status: "complete" },
    });
    await createTestThread({
      db,
      userId: bobId,
      overrides: {
        organizationId: orgId,
        githubRepoFullName: "acme/api",
        sourceType: "slack-mention",
      },
      chatOverrides: {
        status: "working-error",
        errorMessage: "agent-generic-error",
      },
    });
    await createTestThread({
      db,
      userId: aliceId,
      overrides: {
        organizationId: orgId,
        githubRepoFullName: "acme/web",
        terminalCause: "superseded",
      },
      chatOverrides: { status: "complete" },
    });
    await createTestThread({
      db,
      userId: aliceId,
      overrides: { organizationId: otherOrgId, githubRepoFullName: "acme/api" },
    });

    const stats = await getOrgUsageStats({
      db,
      organizationId: orgId,
      ...range(),
    });
    expect(stats.funnel).toEqual({
      started: 3,
      completed: 1,
      openedPR: 1,
      merged: 1,
    });
    expect(stats.errored).toBe(1);
    expect(
      stats.byRepo.map((r) => [r.repoFullName, r.tasks, r.merged]),
    ).toEqual([
      ["acme/api", 2, 1],
      ["acme/web", 1, 0],
    ]);
    expect(stats.bySource.slack).toBe(1);
    expect(stats.bySource.web).toBe(2);
    expect(stats.byMember.find((m) => m.userId === aliceId)?.tasks).toBe(2);
    expect(stats.notFinished).toEqual(
      expect.arrayContaining([
        { label: "Superseded", count: 1 },
        { label: "Agent error", count: 1 },
      ]),
    );
  });

  it("narrows to one member for the Mine view", async () => {
    await createTestThread({
      db,
      userId: aliceId,
      overrides: { organizationId: orgId },
    });
    await createTestThread({
      db,
      userId: bobId,
      overrides: { organizationId: orgId },
    });
    const stats = await getOrgUsageStats({
      db,
      organizationId: orgId,
      userId: bobId,
      ...range(),
    });
    expect(stats.funnel.started).toBe(1);
    expect(stats.byMember.map((m) => m.userId)).toEqual([bobId]);
  });
});
