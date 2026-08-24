import { describe, it, vi, beforeEach, expect } from "vitest";
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
import {
  createReviewAutomation,
  createBootingPRThread,
  routedHatchetFetch,
  triggerBody,
} from "./__fixtures__/review-thread";

/**
 * #125/#127 IRON regression golden: with the `supersedePolicy` feature flag OFF
 * (its default), the Hatchet dispatch payload — workflowName, input, and
 * additionalMetadata — must be EXACTLY the payload main produced before the
 * supersede-policy work landed. Literal deep equality against a versioned
 * fixture, not an exclusion list.
 *
 * The fixture was captured from the pre-change dispatch path. Run-specific
 * values (ids, the minted daemon token, the traceparent) are stored as
 * __PLACEHOLDER__ strings and substituted with the live values before
 * comparison — every key is still compared, nothing is skipped; the two
 * random fields are additionally shape-asserted.
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

describe("dispatch golden (flag OFF byte-identical)", () => {
  let user: User;
  let orgId: string;

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
  function assertOrRecordGolden(
    key: "plain" | "review",
    body: unknown,
    t: { threadId: string; threadChatId: string },
  ) {
    // The two per-dispatch random fields are pinned as placeholders AFTER a
    // shape assertion — they are still compared, never excluded.
    const input = (body as { input: Record<string, unknown> }).input;
    expect(input.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(input.daemonToken).toMatch(/^[A-Za-z0-9_-]{64}$/);
    const values: Placeholders = {
      __THREAD_ID__: t.threadId,
      __THREAD_CHAT_ID__: t.threadChatId,
      __ORG_ID__: orgId,
      __TRACEPARENT__: input.traceparent as string,
      __DAEMON_TOKEN__: input.daemonToken as string,
    };
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
    assertOrRecordGolden("plain", body, t);
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
    assertOrRecordGolden("review", body, t);
  });
});
