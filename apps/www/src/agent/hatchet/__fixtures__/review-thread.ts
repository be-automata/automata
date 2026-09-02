import { vi } from "vitest";
import { db } from "@/lib/db";
import { createTestThread } from "@terragon/shared/model/test-helpers";
import { createAutomation } from "@terragon/shared/model/automations";
import { thread as threadTable } from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";

/**
 * Shared dispatch-test fixtures: a PR-review automation + a `booting` thread
 * under it, and a fetch mock that routes the Hatchet trigger vs cancel calls.
 */

export async function createReviewAutomation({
  userId,
  orgId,
  triggerType = "pull_request",
}: {
  userId: string;
  orgId: string;
  triggerType?: "pull_request" | "github_mention";
}): Promise<string> {
  const automation = await createAutomation({
    db,
    userId,
    accessTier: "pro",
    organizationId: orgId,
    automation: {
      name: `${triggerType} automation`,
      repoFullName: "be-automata/automata",
      branchName: "main",
      enabled: true,
      triggerType,
      triggerConfig: {},
      action: {
        type: "user_message",
        config: {
          message: {
            type: "user",
            model: null,
            parts: [],
            timestamp: new Date().toISOString(),
          },
        },
      },
    },
  });
  return automation.id;
}

/**
 * A PR thread already transitioned to `booting`: in production dispatch runs
 * only after startAgentMessage does that, so a prior review thread is ACTIVE
 * when the next dispatch arrives — the state the #165 "www never touches it"
 * assertions exercise. ThreadInsert omits `status`, so it is set directly.
 */
export async function createBootingPRThread({
  userId,
  orgId,
  automationId,
  prNumber,
}: {
  userId: string;
  orgId: string;
  automationId: string;
  prNumber: number;
}): Promise<{ threadId: string; threadChatId: string }> {
  const t = await createTestThread({
    db,
    userId,
    overrides: {
      organizationId: orgId,
      githubRepoFullName: "be-automata/automata",
      githubPRNumber: prNumber,
      automationId,
    },
  });
  await db
    .update(threadTable)
    .set({ status: "booting" })
    .where(eq(threadTable.id, t.threadId));
  return t;
}

/** A fetch mock that routes trigger vs cancel and records the cancel bodies. */
export function routedHatchetFetch(triggerRunId: string) {
  const cancelBodies: unknown[] = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/tasks/cancel")) {
      cancelBodies.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    }
    return new Response(
      JSON.stringify({ run: { metadata: { id: triggerRunId } } }),
      { status: 200 },
    );
  });
  return { mock, cancelBodies };
}

/** The parsed body of the trigger POST among a routed mock's calls. */
export function triggerBody(mock: ReturnType<typeof vi.fn>): {
  workflowName: string;
  input: Record<string, unknown>;
  additionalMetadata: Record<string, string>;
} {
  const call = (mock.mock.calls as unknown as [string, RequestInit][]).find(
    ([u]) => String(u).includes("/workflow-runs/trigger"),
  );
  if (!call) throw new Error("no trigger call recorded");
  return JSON.parse(call[1].body as string);
}
