import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import { createMockNextRequest } from "@/test-helpers/mock-next";
import { env } from "@terragon/env/apps-www";
import { getRepoInstallationId } from "@terragon/shared/github-app";
import { knowledgeCursor, knowledgeIntent } from "@terragon/shared/db/schema";
import { bindGithubInstallationToOrg } from "@terragon/shared/model/github-installation";
import { offboardKnowledge } from "@terragon/shared/model/knowledge-controls";
import { createOrganization } from "@terragon/shared/model/organizations";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import crypto from "crypto";

import { handleKnowledgePush } from "./knowledge-push";
import { POST } from "./route";

vi.mock("@terragon/shared/github-app", () => ({
  getRepoInstallationId: vi.fn(async () => null),
  getInstallationToken: vi.fn(async () => "mock-github-token"),
  getSandboxGithubToken: vi.fn(async () => "mock-github-token"),
  lookupInstallationId: vi.fn(async () => 424242),
}));

const AFTER = "a".repeat(39) + "1";
const ZERO = "0".repeat(40);

let orgId: string;
let userId: string;
let installationId: number;
let repoFullName: string;

function pushPayload(over: Record<string, unknown> = {}, repoOver = {}) {
  return {
    ref: "refs/heads/main",
    before: "b".repeat(40),
    after: AFTER,
    deleted: false,
    forced: false,
    installation: { id: installationId },
    repository: {
      full_name: repoFullName,
      name: repoFullName.split("/")[1],
      default_branch: "main",
      owner: { login: repoFullName.split("/")[0] },
      ...repoOver,
    },
    ...over,
  } as never;
}

async function intents() {
  return db
    .select()
    .from(knowledgeIntent)
    .where(eq(knowledgeIntent.organizationId, orgId));
}

beforeAll(async () => {
  const { user } = await createTestUser({ db });
  userId = user.id;
});

beforeEach(async () => {
  vi.clearAllMocks();
  const slug = `kp-${nanoid(8).toLowerCase()}`;
  const org = await createOrganization({ db, name: slug, slug });
  orgId = org.id;
  installationId = Math.floor(Math.random() * 1_000_000_000) + 1000;
  repoFullName = `Fixture-Owner/repo-${nanoid(6).toLowerCase()}`;
  await bindGithubInstallationToOrg({
    db,
    installationId,
    organizationId: orgId,
    mode: "active",
  });
});

describe("handleKnowledgePush", () => {
  it("records one intent for a default-branch push and sets push liveness", async () => {
    await handleKnowledgePush(pushPayload(), "d1");
    const rows = await intents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      repoFullName: repoFullName.toLowerCase(),
      defaultBranch: "main",
      targetSha: AFTER,
    });
    const [cursor] = await db
      .select()
      .from(knowledgeCursor)
      .where(
        and(
          eq(knowledgeCursor.organizationId, orgId),
          eq(knowledgeCursor.repoFullName, repoFullName.toLowerCase()),
        ),
      );
    expect(cursor?.lastPushAt).toBeInstanceOf(Date);
    expect(cursor?.observedHeadSha).toBe(AFTER);
  });

  it.each([
    ["another branch", { ref: "refs/heads/feature" }],
    ["a tag", { ref: "refs/tags/v1" }],
    ["a deleted push", { deleted: true }],
    ["an all-zero after", { after: ZERO }],
    ["a malformed after", { after: "abc" }],
  ])("writes nothing for %s", async (_label, over) => {
    await handleKnowledgePush(pushPayload(over), "d2");
    expect(await intents()).toHaveLength(0);
  });

  it("records a forced push to the default branch", async () => {
    await handleKnowledgePush(pushPayload({ forced: true }), "d3");
    expect(await intents()).toHaveLength(1);
  });

  it("falls back to the repo installation when the payload has none", async () => {
    vi.mocked(getRepoInstallationId).mockResolvedValueOnce(installationId);
    await handleKnowledgePush(pushPayload({ installation: undefined }), "d4");
    expect(getRepoInstallationId).toHaveBeenCalledOnce();
    expect(await intents()).toHaveLength(1);
  });

  it("writes nothing for an unbound installation", async () => {
    await handleKnowledgePush(pushPayload({ installation: { id: 7 } }), "d5");
    expect(await intents()).toHaveLength(0);
  });

  it("writes nothing for an offboarded org and does not throw", async () => {
    await offboardKnowledge({ db, organizationId: orgId, actorUserId: userId });
    await expect(
      handleKnowledgePush(pushPayload(), "d6"),
    ).resolves.toBeUndefined();
    expect(await intents()).toHaveLength(0);
  });

  it("records for an Off org (engine unset)", async () => {
    await handleKnowledgePush(pushPayload(), "d7");
    expect(await intents()).toHaveLength(1);
  });

  it("is idempotent on redelivery", async () => {
    await handleKnowledgePush(pushPayload(), "d8");
    await handleKnowledgePush(pushPayload(), "d8");
    expect(await intents()).toHaveLength(1);
  });

  it("swallows an unexpected error and logs only the error name", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      handleKnowledgePush({ ref: "refs/heads/main" } as never, "d9"),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith("[knowledge push] failed", {
      deliveryId: "d9",
      error: "TypeError",
    });
    spy.mockRestore();
  });
});

describe("push through the route", () => {
  async function post(body: unknown) {
    const payload = JSON.stringify(body);
    const signature = `sha256=${crypto
      .createHmac("sha256", env.GITHUB_WEBHOOK_SECRET)
      .update(payload)
      .digest("hex")}`;
    const request = await createMockNextRequest(body, {
      "x-github-delivery": "route-1",
      "x-hub-signature-256": signature,
      "x-github-event": "push",
    });
    return POST(request);
  }

  it("acks 2xx only after the intent is durable", async () => {
    const response = await post(pushPayload());
    expect(response.status).toBe(200);
    expect(await intents()).toHaveLength(1);
  });

  it("acks 2xx for a non-default-branch push and writes nothing", async () => {
    const response = await post(pushPayload({ ref: "refs/heads/feature" }));
    expect(response.status).toBe(200);
    expect(await intents()).toHaveLength(0);
  });
});
