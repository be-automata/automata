import { describe, it, vi, beforeEach, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import { createOrganization } from "@terragon/shared/model/organizations";
import { createAutomation } from "@terragon/shared/model/automations";
import { nanoid } from "nanoid";
import { User } from "@terragon/shared";
import { thread as threadTable } from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { dispatchAgentRun } from "./dispatch";

/**
 * #125/#127 IRON regression golden: with the `supersedePolicy` feature flag OFF
 * (its default), the Hatchet dispatch payload — workflowName, input, and
 * additionalMetadata — must be EXACTLY the payload main produced before the
 * supersede-policy work landed. Literal deep equality against a versioned
 * fixture, not an exclusion list.
 *
 * The fixture was captured from the pre-change dispatch path with every
 * nondeterministic input pinned (tokens, traceparent, ids). Run-specific ids
 * are stored as __PLACEHOLDER__ strings and substituted with the live values
 * before comparison — every key is still compared, nothing is skipped.
 *
 * To regenerate (ONLY for a deliberate, reviewed contract change):
 *   UPDATE_DISPATCH_GOLDEN=1 pnpm -C apps/www exec vitest run src/agent/hatchet/dispatch-golden.test.ts
 */

const FIXTURE_PATH = join(__dirname, "__fixtures__", "transport.golden.json");

const GOLDEN_PR_NUMBER = 4242;

/**
 * Deterministic-but-unique RNG for the dispatch windows: each getRandomValues
 * call fills the buffer with the next counter byte. Unique per call (so two
 * dispatches never mint colliding apikey ids) yet identical across runs (so the
 * traceparent/token bytes in the fixture reproduce), as long as the number of
 * RNG calls per dispatch is stable — which it is, same code path. The counter
 * is FILE-GLOBAL and never resets, mirroring capture order = verify order.
 */
let rngCallCounter = 0;

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
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/tasks/cancel")) {
        return new Response("{}", { status: 200 });
      }
      return new Response(
        JSON.stringify({ run: { metadata: { id: "golden-run" } } }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    // Counter RNG for the DISPATCH WINDOW ONLY (deterministic traceparent +
    // daemon token). Scoped here so test-data id generation stays random.
    const rngSpy = vi
      .spyOn(globalThis.crypto, "getRandomValues")
      .mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((buf: any) => {
          rngCallCounter = (rngCallCounter + 1) & 0xff;
          if (buf) new Uint8Array(buf.buffer ?? buf).fill(rngCallCounter);
          return buf;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
      );
    try {
      await dispatchAgentRun({
        userId: user.id,
        threadId: args.threadId,
        threadChatId: args.threadChatId,
        repoFullName: "be-automata/automata",
        branch: args.branch,
      });
      const triggerCall = (
        fetchMock.mock.calls as unknown as [string, RequestInit][]
      ).find(([u]) => String(u).includes("/workflow-runs/trigger"));
      expect(triggerCall).toBeDefined();
      return JSON.parse(triggerCall![1].body as string);
    } finally {
      rngSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  }

  function loadFixture(): { plain: unknown; review: unknown } {
    return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
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
    const values: Placeholders = {
      __THREAD_ID__: t.threadId,
      __THREAD_CHAT_ID__: t.threadChatId,
      __ORG_ID__: orgId,
    };
    if (process.env.UPDATE_DISPATCH_GOLDEN) {
      const current = loadFixtureOrEmpty();
      current.plain = abstract(body, values);
      writeFileSync(FIXTURE_PATH, JSON.stringify(current, null, 2) + "\n");
      return;
    }
    expect(body).toEqual(materialize(loadFixture().plain, values));
  });

  it("PR-review thread: payload matches the golden literally", async () => {
    const automation = await createAutomation({
      db,
      userId: user.id,
      accessTier: "pro",
      organizationId: orgId,
      automation: {
        name: "pull_request automation",
        repoFullName: "be-automata/automata",
        branchName: "main",
        enabled: true,
        triggerType: "pull_request",
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
    const t = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        organizationId: orgId,
        githubRepoFullName: "be-automata/automata",
        githubPRNumber: GOLDEN_PR_NUMBER,
        automationId: automation.id,
      },
    });
    await db
      .update(threadTable)
      .set({ status: "booting" })
      .where(eq(threadTable.id, t.threadId));

    const body = await captureDispatchBody({
      threadId: t.threadId,
      threadChatId: t.threadChatId,
      branch: "feature-golden",
    });
    const values: Placeholders = {
      __THREAD_ID__: t.threadId,
      __THREAD_CHAT_ID__: t.threadChatId,
      __ORG_ID__: orgId,
    };
    if (process.env.UPDATE_DISPATCH_GOLDEN) {
      const current = loadFixtureOrEmpty();
      current.review = abstract(body, values);
      writeFileSync(FIXTURE_PATH, JSON.stringify(current, null, 2) + "\n");
      return;
    }
    expect(body).toEqual(materialize(loadFixture().review, values));
  });

  function loadFixtureOrEmpty(): Record<string, unknown> {
    try {
      return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    } catch {
      return {};
    }
  }
});
