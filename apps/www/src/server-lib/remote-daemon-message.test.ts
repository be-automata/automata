import { describe, it, beforeEach, vi, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestThread,
  createTestAutomation,
} from "@terragon/shared/model/test-helpers";
import { createOrganization } from "@terragon/shared/model/organizations";
import { User } from "@terragon/shared";
import type { ThreadTrustContext } from "@terragon/shared/db/types";
import { nanoid } from "nanoid";
import { buildRemoteDaemonMessage } from "./remote-daemon-message";

function trust(fields: {
  isFork: boolean;
  authorAssociation: string;
}): ThreadTrustContext {
  return {
    source: "github-pr",
    capturedAt: new Date().toISOString(),
    ...fields,
  };
}

describe("buildRemoteDaemonMessage", () => {
  let user: User;

  beforeEach(async () => {
    vi.clearAllMocks();
    user = (await createTestUser({ db })).user;
  });

  it("returns null when the threadChat has no pending user message", async () => {
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
    });
    const message = await buildRemoteDaemonMessage({
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(message).toBeNull();
  });

  it("returns null for an unknown thread", async () => {
    const message = await buildRemoteDaemonMessage({
      userId: user.id,
      threadId: "does-not-exist",
      threadChatId: "nope",
    });
    expect(message).toBeNull();
  });
});

/**
 * The permission-mode floor at Seam A (ADR-005 §2/§3/§3b, #82) — pins the
 * SAME clamped mode `resolve-permission-mode.test.ts` asserts against the
 * pure resolver, now through the actual dispatch build path.
 */
describe("buildRemoteDaemonMessage — permission-mode floor (#82)", () => {
  let user: User;
  let orgId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    user = (await createTestUser({ db })).user;
    const org = await createOrganization({
      db,
      name: "acme",
      slug: `acme-${nanoid(8).toLowerCase()}`,
    });
    orgId = org.id;
  });

  async function makeThread({
    triggerType,
    triggerConfig,
    trustContext,
  }: {
    triggerType: "pull_request" | "schedule";
    triggerConfig: Record<string, unknown>;
    trustContext?: ThreadTrustContext | null;
  }): Promise<{ threadId: string; threadChatId: string }> {
    const automation = await createTestAutomation({
      db,
      userId: user.id,
      values: {
        organizationId: orgId,
        repoFullName: "acme/widgets",
        triggerType,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        triggerConfig: triggerConfig as any,
      },
    });
    return createTestThread({
      db,
      userId: user.id,
      overrides: {
        organizationId: orgId,
        automationId: automation.id,
        githubRepoFullName: "acme/widgets",
        githubPRNumber: triggerType === "pull_request" ? 1 : undefined,
        trustContext: trustContext ?? null,
      },
      chatOverrides: {
        appendMessages: [
          {
            type: "user",
            model: "sonnet",
            parts: [{ type: "text", text: "hello" }],
          },
        ],
      },
    });
  }

  it("fork PR configured allowAll -> review", async () => {
    const { threadId, threadChatId } = await makeThread({
      triggerType: "pull_request",
      triggerConfig: {
        on: { open: true },
        filter: { includeAllAuthors: true },
        permissionMode: "allowAll",
      },
      trustContext: trust({ isFork: true, authorAssociation: "OWNER" }),
    });
    const message = await buildRemoteDaemonMessage({
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(message?.permissionMode).toBe("review");
  });

  it("trusted-internal PR configured plan -> plan", async () => {
    const { threadId, threadChatId } = await makeThread({
      triggerType: "pull_request",
      triggerConfig: {
        on: { open: true },
        filter: { includeAllAuthors: true },
        permissionMode: "plan",
      },
      trustContext: trust({ isFork: false, authorAssociation: "MEMBER" }),
    });
    const message = await buildRemoteDaemonMessage({
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(message?.permissionMode).toBe("plan");
  });

  it("trustContext NULL -> review (fail-closed)", async () => {
    const { threadId, threadChatId } = await makeThread({
      triggerType: "pull_request",
      triggerConfig: {
        on: { open: true },
        filter: { includeAllAuthors: true },
        permissionMode: "allowAll",
      },
      trustContext: null,
    });
    const message = await buildRemoteDaemonMessage({
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(message?.permissionMode).toBe("review");
  });

  it("non-PR (schedule) automation configured plan -> plan", async () => {
    const { threadId, threadChatId } = await makeThread({
      triggerType: "schedule",
      triggerConfig: {
        cron: "0 9 * * *",
        timezone: "UTC",
        permissionMode: "plan",
      },
    });
    const message = await buildRemoteDaemonMessage({
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(message?.permissionMode).toBe("plan");
  });

  it("non-PR (schedule) automation configured review -> review", async () => {
    const { threadId, threadChatId } = await makeThread({
      triggerType: "schedule",
      triggerConfig: {
        cron: "0 9 * * *",
        timezone: "UTC",
        permissionMode: "review",
      },
    });
    const message = await buildRemoteDaemonMessage({
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(message?.permissionMode).toBe("review");
  });

  it("unconfigured non-PR automation -> allowAll (AC4 regression)", async () => {
    const { threadId, threadChatId } = await makeThread({
      triggerType: "schedule",
      triggerConfig: { cron: "0 9 * * *", timezone: "UTC" },
    });
    const message = await buildRemoteDaemonMessage({
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(message?.permissionMode).toBe("allowAll");
  });
});
