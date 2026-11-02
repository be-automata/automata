import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { nanoid } from "nanoid";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import { postKnowledgeIntentFailedAlert } from "@/server-lib/knowledge/ops-alert";
import { env } from "@terragon/env/apps-www";
import {
  MAX_PUBLISH_BODY_BYTES,
  RECONCILE_PATHS,
  RECONCILE_TOKEN_HEADER,
} from "@terragon/knowledge/reconcile-wire";
import {
  getReadOnlyInstallationToken,
  getRepoInstallationId,
} from "@terragon/shared/github-app";
import * as schema from "@terragon/shared/db/schema";
import { bindGithubInstallationToOrg } from "@terragon/shared/model/github-installation";
import { createOrganization } from "@terragon/shared/model/organizations";

import { POST as contextPost } from "./context/route";
import { POST as failPost } from "./fail/route";
import { POST as publishPost } from "./publish/route";

vi.mock("@terragon/shared/github-app", () => ({
  getRepoInstallationId: vi.fn(),
  getReadOnlyInstallationToken: vi.fn(),
}));
vi.mock("@/server-lib/knowledge/ops-alert", () => ({
  postKnowledgeIntentFailedAlert: vi.fn(async () => ({ sent: true })),
}));

const SECRET = "reconcile-test-secret";
const TOKEN = "ghs_installation_token_value";
const SHA1 = "a".repeat(40);
const SHA2 = "b".repeat(40);
const REPO = "Fixture-Owner/docs";

let orgId: string;
let installationId: number;
let intentId: string;

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = { [RECONCILE_TOKEN_HEADER]: SECRET },
): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function seedIntent(
  state: schema.KnowledgeIntentState = "processing",
  attempts = 1,
) {
  await db.insert(schema.knowledgeIntent).values({
    id: intentId,
    organizationId: orgId,
    repoFullName: REPO,
    defaultBranch: "main",
    targetSha: SHA2,
    state,
    attempts,
    nextAttemptAt: new Date(),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  (env as { KNOWLEDGE_RECONCILE_SECRET: string }).KNOWLEDGE_RECONCILE_SECRET =
    SECRET;
  const slug = `kr-${nanoid(8).toLowerCase()}`;
  orgId = (await createOrganization({ db, name: slug, slug })).id;
  installationId = Math.floor(Math.random() * 1_000_000_000) + 1000;
  await bindGithubInstallationToOrg({
    db,
    installationId,
    organizationId: orgId,
    mode: "active",
  });
  await db
    .insert(schema.organizationReviewSettings)
    .values({ organizationId: orgId, knowledgeEngine: true })
    .onConflictDoUpdate({
      target: [schema.organizationReviewSettings.organizationId],
      set: { knowledgeEngine: true },
    });
  intentId = `intent:${orgId}:${REPO}@${SHA2}`;
  vi.mocked(getRepoInstallationId).mockResolvedValue(installationId);
  vi.mocked(getReadOnlyInstallationToken).mockResolvedValue({
    token: TOKEN,
    expiresAt: "2099-01-01T00:00:00Z",
  });
});

const routes = [
  ["context", contextPost, RECONCILE_PATHS.context],
  ["publish", publishPost, RECONCILE_PATHS.publish],
  ["fail", failPost, RECONCILE_PATHS.fail],
] as const;

describe.each(routes)("%s auth", (_name, handler, path) => {
  it("answers 401 for a missing header, a wrong secret and a disabled secret", async () => {
    const missing = await handler(post(path, {}, {}));
    const wrong = await handler(
      post(path, {}, { [RECONCILE_TOKEN_HEADER]: "x" }),
    );
    (env as { KNOWLEDGE_RECONCILE_SECRET: string }).KNOWLEDGE_RECONCILE_SECRET =
      "";
    const disabled = await handler(
      post(path, {}, { [RECONCILE_TOKEN_HEADER]: "" }),
    );
    const disabledWithValue = await handler(
      post(path, {}, { [RECONCILE_TOKEN_HEADER]: SECRET }),
    );
    for (const response of [missing, wrong, disabled, disabledWithValue]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Unauthorized" });
    }
  });
});

describe("context", () => {
  const call = (body: unknown) =>
    contextPost(post(RECONCILE_PATHS.context, body));

  it("answers not_found for an unknown id", async () => {
    const response = await call({ intentId: "nope" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "not_found" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers gated when the engine is off", async () => {
    await db
      .update(schema.organizationReviewSettings)
      .set({ knowledgeEngine: false })
      .where(eq(schema.organizationReviewSettings.organizationId, orgId));
    await seedIntent();
    const response = await call({ intentId });
    expect(await response.json()).toMatchObject({ status: "gated" });
  });

  it("delivers a minted read-only token, no-store, and logs outcome only", async () => {
    await seedIntent();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await call({ intentId });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const json = await response.json();
    expect(json.status).toBe("ready");
    expect(json.installationToken).toBe(TOKEN);
    expect(json.intent.organizationId).toBe(orgId);
    expect(getReadOnlyInstallationToken).toHaveBeenCalledWith(
      "Fixture-Owner",
      "docs",
      installationId,
    );
    const lines = log.mock.calls.filter(
      (c) => c[0] === "[knowledge-reconcile] context token",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.[1]).toEqual({ intentId, outcome: "minted" });
    for (const c of [...log.mock.calls, ...error.mock.calls]) {
      expect(JSON.stringify(c)).not.toContain(TOKEN);
    }
    log.mockRestore();
    error.mockRestore();
  });

  it("answers no_access when the mint fails", async () => {
    await seedIntent();
    vi.mocked(getReadOnlyInstallationToken).mockRejectedValue(
      new Error(`boom ${TOKEN}`),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await call({ intentId });
    const json = await response.json();
    expect(json.status).toBe("no_access");
    expect(json.installationToken).toBeUndefined();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(log.mock.calls[0]?.[1]).toMatchObject({ outcome: "mint_failed" });
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
    log.mockRestore();
  });

  it("answers no_access when the installation belongs to another org", async () => {
    await seedIntent();
    const slug = `kr-${nanoid(8).toLowerCase()}`;
    const other = await createOrganization({ db, name: slug, slug });
    const otherInstallation = installationId + 1;
    await bindGithubInstallationToOrg({
      db,
      installationId: otherInstallation,
      organizationId: other.id,
      mode: "active",
    });
    vi.mocked(getRepoInstallationId).mockResolvedValue(otherInstallation);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const json = await (await call({ intentId })).json();
    expect(json.status).toBe("no_access");
    expect(getReadOnlyInstallationToken).not.toHaveBeenCalled();
    expect(log.mock.calls[0]?.[1]).toMatchObject({ outcome: "org_mismatch" });
    log.mockRestore();
  });

  it("answers no_access when the repo has no installation", async () => {
    await seedIntent();
    vi.mocked(getRepoInstallationId).mockResolvedValue(null);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await (await call({ intentId })).json()).status).toBe("no_access");
    log.mockRestore();
  });

  it("rejects a body organizationId and malformed JSON", async () => {
    expect((await call({ intentId, organizationId: "x" })).status).toBe(400);
    expect((await call("{not json")).status).toBe(400);
  });
});

describe("publish", () => {
  const call = (body: unknown) =>
    publishPost(post(RECONCILE_PATHS.publish, body));
  const valid = () => ({
    intentId,
    fromSha: SHA1,
    toSha: SHA2,
    mode: "range",
    ops: [],
  });

  it("publishes and returns the model result", async () => {
    await seedIntent();
    await db.insert(schema.knowledgeCursor).values({
      organizationId: orgId,
      repoFullName: REPO,
      defaultBranch: "main",
      lastSha: SHA1,
      observedHeadSha: SHA2,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await call(valid());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      result: "published",
      opsInserted: 0,
    });
    log.mockRestore();
  });

  it("answers 200 stale_claim with zero ops when a base version is stale", async () => {
    await seedIntent();
    const claimId = `claim-${nanoid(8)}`;
    await db.insert(schema.knowledgeClaim).values({
      id: claimId,
      organizationId: orgId,
      repoFullName: REPO,
      page: "docs/a.md",
      statement: "Trials last 14 days.",
      version: 3,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const op = {
      id: "op-1",
      claimId,
      kind: "update",
      baseVersion: 2,
      proposal: {
        id: "op-1",
        claimId,
        op: "update",
        auto: false,
        before: "Trials last 14 days.",
        after: "Trials last 30 days.",
        why: "Changed.",
        evidence: ["repo://src/pricing.ts#L1-L2"],
        evidenceFingerprint: "0123456789abcdef",
      },
    };
    const response = await call({ ...valid(), ops: [op] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      result: "stale_claim",
      opsInserted: 0,
    });
    log.mockRestore();
  });

  it("rejects an oversized body with 413", async () => {
    const big = JSON.stringify({ pad: "x".repeat(MAX_PUBLISH_BODY_BYTES + 1) });
    expect((await call(big)).status).toBe(413);
  });

  it("rejects malformed JSON, a bad sha and an extra organizationId with 400", async () => {
    for (const body of [
      "{not json",
      { ...valid(), toSha: "nothex" },
      { ...valid(), organizationId: "other-org" },
    ]) {
      const response = await call(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid body" });
    }
  });

  it("answers 422 invalid_publish for an op on an unknown claim", async () => {
    await seedIntent();
    const op = {
      id: "op-x",
      claimId: "missing-claim",
      kind: "update",
      baseVersion: 1,
      proposal: {},
    };
    const response = await call({ ...valid(), ops: [op] });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "invalid_publish" });
  });
});

describe("fail", () => {
  const call = (body: unknown) => failPost(post(RECONCILE_PATHS.fail, body));

  it("rejects a code outside the worker enum and an extra organizationId", async () => {
    expect((await call({ intentId, code: "lease_expired" })).status).toBe(400);
    expect(
      (await call({ intentId, code: "worker_error", organizationId: "x" }))
        .status,
    ).toBe(400);
  });

  it("records a pending retry without alerting", async () => {
    await seedIntent("processing", 1);
    const response = await call({ intentId, code: "fetch_failed" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: "pending",
      attempts: 2,
      code: "fetch_failed",
    });
    expect(postKnowledgeIntentFailedAlert).not.toHaveBeenCalled();
  });

  it("flips to failed on the 8th failure, alerts once, and 409s a replay", async () => {
    await seedIntent("processing", 7);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await call({ intentId, code: "engine_failed" });
    expect(await response.json()).toMatchObject({
      state: "failed",
      attempts: 8,
    });
    expect(postKnowledgeIntentFailedAlert).toHaveBeenCalledTimes(1);
    expect(postKnowledgeIntentFailedAlert).toHaveBeenCalledWith({
      organizationId: orgId,
      repoFullName: REPO,
      code: "engine_failed",
      attempts: 8,
    });
    const replay = await call({ intentId, code: "engine_failed" });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ error: "not_processing" });
    expect(postKnowledgeIntentFailedAlert).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
