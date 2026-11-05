/**
 * protects: PIPE-05 / SC4. The post-merge audit dispatch for a merged
 *   pull_request.closed delivery is byte-identical with knowledge On, Off, and
 *   with the push listener throwing.
 * fails_when: knowledge state or the push listener changes what the merged-PR
 *   path dispatches (the newThreadInternal call the mirror lane makes).
 * no_claim: the audit's own behavior (prompt wording, skill resolution).
 *
 * One imported route module, one set of registered listeners: scenarios switch
 * knowledge state and the push handler's behavior, never by re-mocking modules
 * or re-importing the route.
 */
import crypto from "crypto";

import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import { newThreadInternal } from "@/server-lib/new-thread-internal";
import { createMockNextRequest } from "@/test-helpers/mock-next";
import { env } from "@terragon/env/apps-www";
import { knowledgeIntent } from "@terragon/shared/db/schema";
import { bindGithubInstallationToOrg } from "@terragon/shared/model/github-installation";
import { updateKnowledgeControls } from "@terragon/shared/model/knowledge-controls";
import {
  addOrganizationMember,
  createOrganization,
} from "@terragon/shared/model/organizations";
import { createTestUser } from "@terragon/shared/model/test-helpers";

import { POST } from "./route";

const hoisted = vi.hoisted(() => ({
  pushImpl: vi.fn(),
  registered: [] as string[],
}));

vi.mock("./knowledge-push", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./knowledge-push")>();
  hoisted.pushImpl.mockImplementation(actual.handleKnowledgePush);
  return {
    handleKnowledgePush: (
      ...args: Parameters<typeof actual.handleKnowledgePush>
    ) => hoisted.pushImpl(...args),
  };
});

// Records which events the route registers on its one Webhooks instance. A
// subclass wrapper (static for the file), not a per-scenario re-mock.
vi.mock("@octokit/webhooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@octokit/webhooks")>();
  class RecordingWebhooks extends actual.Webhooks {
    constructor(options: ConstructorParameters<typeof actual.Webhooks>[0]) {
      super(options);
      const original = this.on.bind(this);
      this.on = ((names: string | string[], handler: never) => {
        for (const n of Array.isArray(names) ? names : [names]) {
          hoisted.registered.push(n);
        }
        return (original as (n: unknown, h: unknown) => void)(names, handler);
      }) as typeof this.on;
    }
  }
  return { ...actual, Webhooks: RecordingWebhooks };
});

vi.mock("@/server-lib/new-thread-internal", () => ({
  newThreadInternal: vi
    .fn()
    .mockResolvedValue({ threadId: "t", threadChatId: "c" }),
}));

vi.mock("@terragon/shared/github-app", () => ({
  getRepoInstallationId: vi.fn(async () => null),
  getInstallationToken: vi.fn(async () => "mock-github-token"),
  getSandboxGithubToken: vi.fn(async () => "mock-github-token"),
  lookupInstallationId: vi.fn(async () => 424242),
}));

const REPO = "acme/golden-repo";

let orgId: string;
let userId: string;
let installationId: number;

async function post(event: string, body: unknown) {
  const payload = JSON.stringify(body);
  const signature = `sha256=${crypto
    .createHmac("sha256", env.GITHUB_WEBHOOK_SECRET)
    .update(payload)
    .digest("hex")}`;
  const request = await createMockNextRequest(body, {
    "x-github-delivery": `golden-${nanoid(6)}`,
    "x-hub-signature-256": signature,
    "x-github-event": event,
  });
  return POST(request);
}

function pushBody(after: string) {
  return {
    ref: "refs/heads/main",
    before: "b".repeat(40),
    after,
    deleted: false,
    forced: false,
    installation: { id: installationId },
    repository: {
      full_name: REPO,
      name: "golden-repo",
      default_branch: "main",
      owner: { login: "acme" },
    },
  };
}

function mergedBody() {
  return {
    action: "closed",
    installation: { id: installationId },
    pull_request: {
      id: 1,
      number: 41,
      state: "closed",
      draft: false,
      merged: true,
      title: "Fixture change",
      body: "Fixture body",
      html_url: `https://github.com/${REPO}/pull/41`,
      merge_commit_sha: "c".repeat(40),
      merged_by: { login: "fixture-merger" },
      head: { ref: "fixture-head" },
      base: { ref: "main" },
      user: { login: "fixture-author", id: 1 },
    },
    repository: {
      full_name: REPO,
      name: "golden-repo",
      default_branch: "main",
      owner: { login: "acme", id: 1 },
    },
  };
}

/** The mirror lane's dispatch, serialized with run-specific values masked. */
function capturedAudit(): string {
  const calls = vi.mocked(newThreadInternal).mock.calls;
  expect(calls).toHaveLength(1);
  return JSON.stringify(calls[0]![0], (key, value) =>
    key === "timestamp" ? "<ts>" : value,
  )
    .split(orgId)
    .join("<org>")
    .split(userId)
    .join("<user>");
}

async function intentFor(sha: string) {
  return db
    .select()
    .from(knowledgeIntent)
    .where(
      and(
        eq(knowledgeIntent.organizationId, orgId),
        eq(knowledgeIntent.targetSha, sha),
      ),
    );
}

async function runScenario(afterSha: string): Promise<{
  pushStatus: number;
  prStatus: number;
  audit: string;
}> {
  vi.mocked(newThreadInternal).mockClear();
  const pushRes = await post("push", pushBody(afterSha));
  // A push alone never reaches the audit seam.
  expect(newThreadInternal).not.toHaveBeenCalled();
  const prRes = await post("pull_request", mergedBody());
  return {
    pushStatus: pushRes.status,
    prStatus: prRes.status,
    audit: capturedAudit(),
  };
}

beforeAll(async () => {
  const { user } = await createTestUser({ db });
  userId = user.id;
  const slug = `golden-${nanoid(8).toLowerCase()}`;
  const org = await createOrganization({ db, name: slug, slug });
  orgId = org.id;
  await addOrganizationMember({
    db,
    organizationId: orgId,
    userId,
    role: "owner",
  });
  installationId = Math.floor(Math.random() * 1_000_000_000) + 1000;
  await bindGithubInstallationToOrg({
    db,
    installationId,
    organizationId: orgId,
    mode: "active",
  });
});

describe("PIPE-05 audit golden", () => {
  it("dispatches a byte-identical audit with knowledge On, Off and a throwing push listener", async () => {
    const shaOn = "1".repeat(40);
    const shaOff = "2".repeat(40);
    const shaThrow = "3".repeat(40);

    // The route's one Webhooks instance registers both listeners.
    await post("push", pushBody("4".repeat(40)));
    expect(hoisted.registered).toContain("push");
    expect(hoisted.registered).toContain("pull_request.closed");
    vi.mocked(newThreadInternal).mockClear();

    await updateKnowledgeControls({
      db,
      organizationId: orgId,
      actorUserId: userId,
      patch: { engine: true },
    });
    const on = await runScenario(shaOn);

    await updateKnowledgeControls({
      db,
      organizationId: orgId,
      actorUserId: userId,
      patch: { engine: false },
    });
    const off = await runScenario(shaOff);

    hoisted.pushImpl.mockImplementationOnce(async () => {
      throw new Error("push listener exploded");
    });
    const throwing = await runScenario(shaThrow);

    for (const s of [on, off, throwing]) {
      expect(s.pushStatus).toBe(200);
      expect(s.prStatus).toBe(200);
    }
    expect(off.audit).toBe(on.audit);
    expect(throwing.audit).toBe(on.audit);
    expect(on.audit).toMatchInlineSnapshot(
      `"{"userId":"<user>","organizationId":"<org>","shadow":false,"message":{"type":"user","model":null,"parts":[{"type":"text","text":"PR #41 in acme/golden-repo was merged. Run the post-merge follow-up (no 'github-pr-merged' skill is configured for this repository)."}],"timestamp":"<ts>"},"githubRepoFullName":"acme/golden-repo","baseBranchName":"main","githubPRNumber":41,"sourceType":"automation"}"`,
    );

    // The push handler really ran for On and Off, and really threw for the third.
    expect(await intentFor(shaOn)).toHaveLength(1);
    expect(await intentFor(shaOff)).toHaveLength(1);
    expect(await intentFor(shaThrow)).toHaveLength(0);
  });
});
