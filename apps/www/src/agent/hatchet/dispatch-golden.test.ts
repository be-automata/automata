import {
  describe,
  it,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  expect,
} from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import { createOrganization } from "@terragon/shared/model/organizations";
import { nanoid } from "nanoid";
import { User } from "@terragon/shared";
import { dispatchAgentRun } from "./dispatch";
import { env } from "@terragon/env/apps-www";
import {
  formatPlanePublicKey,
  generatePlaneKeyPair,
  unsealRunSecrets,
  type SealedRunSecrets,
} from "@terragon/utils/payload-seal";
import {
  createReviewAutomation,
  createBootingPRThread,
  routedHatchetFetch,
  triggerBody,
} from "./__fixtures__/review-thread";

/**
 * IRON regression golden for the Hatchet dispatch payload — workflowName,
 * input, and additionalMetadata compared literally against a versioned
 * fixture, not an exclusion list. Since #165 the review case is the VARIANT
 * payload (engine-owned supersession; the flag and legacy review path are
 * gone); the plain-thread case remains the legacy `agent-run` payload,
 * byte-identical for non-review lanes.
 *
 * The fixture was captured from the pre-change dispatch path. Run-specific
 * values (ids, the traceparent, and since #380 the three random envelope
 * fields epk/iv/ct) are stored as __PLACEHOLDER__ strings and substituted
 * with the live values before comparison — every key is still compared,
 * nothing is skipped; every random field is additionally shape-asserted,
 * and the envelope is OPENED with the test plane key so the golden proves
 * the sealed tokens are the minted ones (never pin the RNG by call count).
 *
 * To regenerate (ONLY for a deliberate, reviewed contract change):
 *   UPDATE_DISPATCH_GOLDEN=1 pnpm -C apps/www exec vitest run src/agent/hatchet/dispatch-golden.test.ts
 */

const FIXTURE_PATH = join(__dirname, "__fixtures__", "transport.golden.json");

const GOLDEN_PR_NUMBER = 4242;

type Placeholders = Record<string, string>;

/** Deep-substitute __PLACEHOLDER__ leaf strings with this run's live values. */
function materialize(node: unknown, values: Placeholders): unknown {
  if (typeof node === "string") {
    return node in values ? values[node] : node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => materialize(child, values));
  }
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [k, materialize(v, values)]),
    );
  }
  return node;
}

/** Reverse: replace live values with placeholders (capture mode only). */
function abstract(node: unknown, values: Placeholders): unknown {
  const reverse = Object.fromEntries(
    Object.entries(values).map(([k, v]) => [v, k]),
  );
  return materialize(node, reverse);
}

describe("dispatch golden (payload contract)", () => {
  let user: User;
  let orgId: string;
  // #380: the golden is the SEALED contract (the plane key is set for every
  // case; its kid is pinned literally in the fixture).
  let plane: Awaited<ReturnType<typeof generatePlaneKeyPair>>;

  beforeAll(async () => {
    plane = await generatePlaneKeyPair("plane-golden");
    (env as { HATCHET_PAYLOAD_SEAL_KEY: string }).HATCHET_PAYLOAD_SEAL_KEY =
      formatPlanePublicKey(plane.publicKey);
  });
  afterAll(() => {
    (env as { HATCHET_PAYLOAD_SEAL_KEY: string }).HATCHET_PAYLOAD_SEAL_KEY = "";
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    user = (await createTestUser({ db })).user;
    const org = await createOrganization({
      db,
      name: "Golden Org",
      slug: `org-${nanoid(8).toLowerCase()}`,
    });
    orgId = org.id;
  });

  async function captureDispatchBody(args: {
    threadId: string;
    threadChatId: string;
    branch: string;
  }): Promise<unknown> {
    const { mock } = routedHatchetFetch("golden-run");
    vi.stubGlobal("fetch", mock);
    try {
      await dispatchAgentRun({
        userId: user.id,
        threadId: args.threadId,
        threadChatId: args.threadChatId,
        repoFullName: "be-automata/automata",
        branch: args.branch,
      });
      return triggerBody(mock);
    } finally {
      vi.unstubAllGlobals();
    }
  }

  /** Compare against the fixture, or (UPDATE_DISPATCH_GOLDEN=1) record it. */
  async function assertOrRecordGolden(
    key: "plain" | "review",
    body: unknown,
    t: { threadId: string; threadChatId: string },
  ) {
    // The per-dispatch random fields are pinned as placeholders AFTER a
    // shape assertion — they are still compared, never excluded.
    const input = (body as { input: Record<string, unknown> }).input;
    expect(input.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    // #380: the three secrets travel only inside the envelope. Shape first,
    // then OPEN it: the installation token is the mocked mint and the daemon
    // token is a fresh 64-char key — proof the sealed values are the real ones.
    const sealed = input.sealedSecrets as SealedRunSecrets;
    expect(sealed).toMatchObject({ v: 1, kid: "plane-golden" });
    expect(sealed.epk).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sealed.iv).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(sealed.ct).toMatch(/^[A-Za-z0-9_-]{24,}$/);
    const secrets = await unsealRunSecrets(
      [plane.privateKey],
      sealed,
      t.threadChatId,
    );
    expect(secrets.installationToken).toBe("mock-github-token");
    expect(secrets.daemonToken).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(JSON.stringify(body)).not.toContain(secrets.daemonToken);
    expect(JSON.stringify(body)).not.toContain("mock-github-token");
    const values: Placeholders = {
      __THREAD_ID__: t.threadId,
      __THREAD_CHAT_ID__: t.threadChatId,
      __ORG_ID__: orgId,
      __TRACEPARENT__: input.traceparent as string,
      __SEALED_EPK__: sealed.epk,
      __SEALED_IV__: sealed.iv,
      __SEALED_CT__: sealed.ct,
    };
    if (key === "plain") {
      // A task run on its base branch works on its own branch, named from the
      // thread id: shape-asserted, then pinned like the other per-run fields.
      expect(input.workBranch).toBe(
        `automata/task-${t.threadId.slice(0, 8).toLowerCase()}`,
      );
      values.__WORK_BRANCH__ = input.workBranch as string;
    }
    if (key === "review") {
      // #165: the review payload is the VARIANT contract. Its two composite
      // per-run fields are shape-asserted, then pinned as placeholders —
      // compared like every other key, never excluded.
      expect(input.prKey).toBe(`${orgId}/be-automata/automata/4242`);
      expect(input.deliveryId).toMatch(
        new RegExp(`^manual:${t.threadId}:[0-9a-f]{16}$`),
      );
      values.__PR_KEY__ = input.prKey as string;
      values.__DELIVERY_ID__ = input.deliveryId as string;
    }
    let fixture: Record<string, unknown> = {};
    try {
      fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    } catch {
      if (!process.env.UPDATE_DISPATCH_GOLDEN)
        throw new Error("missing golden");
    }
    if (process.env.UPDATE_DISPATCH_GOLDEN) {
      fixture[key] = abstract(body, values);
      writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2) + "\n");
      return;
    }
    expect(body).toEqual(materialize(fixture[key], values));
  }

  it("plain org thread (no PR): payload matches the golden literally", async () => {
    const t = await createTestThread({
      db,
      userId: user.id,
      overrides: { organizationId: orgId },
    });
    const body = await captureDispatchBody({
      threadId: t.threadId,
      threadChatId: t.threadChatId,
      branch: "main",
    });
    await assertOrRecordGolden("plain", body, t);
  });

  it("PR-review thread: payload matches the golden literally", async () => {
    const t = await createBootingPRThread({
      userId: user.id,
      orgId,
      automationId: await createReviewAutomation({ userId: user.id, orgId }),
      prNumber: GOLDEN_PR_NUMBER,
    });

    const body = await captureDispatchBody({
      threadId: t.threadId,
      threadChatId: t.threadChatId,
      branch: "feature-golden",
    });
    await assertOrRecordGolden("review", body, t);
  });
});
