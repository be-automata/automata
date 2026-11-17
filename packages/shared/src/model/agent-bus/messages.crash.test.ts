import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../../db";
import { agentApplied, agentMessages, threadChat } from "../../db/schema";
import {
  createTestOrg,
  createTestThread,
  createTestUser,
} from "../test-helpers";
import { createChildRun, ensureRootRun } from "./agent-run";
import { insertMessage } from "./messages";

// Non-null: set by the shared globalSetup.
const db = createDb(env.DATABASE_URL!);
const PACKAGE_DIR = fileURLToPath(new URL("../../..", import.meta.url));
const CHILD = "src/model/agent-bus/__fixtures__/messages-crash-child.ts";
const SPAWN_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 90_000;

interface Delivery {
  killed: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

const children = new Set<ChildProcess>();

afterEach(() => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
});

/** Spawn the child once; SIGKILL (or exit 137) counts as "killed, redeliver". */
function runChild(childEnv: Record<string, string>): Promise<Delivery> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", CHILD], {
      cwd: PACKAGE_DIR,
      timeout: SPAWN_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: {
        ...process.env,
        // Non-null: set by the shared globalSetup.
        DATABASE_URL: env.DATABASE_URL!,
        ...childEnv,
      },
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      children.delete(child);
      resolve({
        killed: signal === "SIGKILL" || code === 137,
        code,
        stdout,
        stderr,
      });
    });
  });
}

function resultOf<T>(d: Delivery): T {
  if (d.code !== 0) throw new Error(`child failed: ${d.stderr}`);
  const line = d.stdout.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(`no RESULT line: ${d.stdout}`);
  return JSON.parse(line.slice("RESULT ".length)) as T;
}

function expectKilled(d: Delivery) {
  expect(d.killed).toBe(true);
  expect(d.stderr).toContain("killing at after-apply");
}

/** A root (task) sender and a task child target with a primary thread chat. */
async function scenario() {
  const organizationId = await createTestOrg({ db });
  const { user } = await createTestUser({ db });
  const rootId = (
    await createTestThread({
      db,
      userId: user.id,
      overrides: { organizationId },
    })
  ).threadId;
  const root = await ensureRootRun({
    db,
    threadId: rootId,
    organizationId,
    lane: "task",
  });
  if (!root) throw new Error("root not created");
  const targetId = (
    await createTestThread({
      db,
      userId: user.id,
      overrides: { organizationId, parentThreadId: rootId },
    })
  ).threadId;
  const child = await createChildRun({
    db,
    organizationId,
    parentThreadId: rootId,
    childThreadId: targetId,
    request: { lane: "task" },
  });
  if (!child.ok) throw new Error("child not created");
  // The test thread is legacy (no chat rows): give it a primary chat.
  const [chat] = await db
    .insert(threadChat)
    .values({
      userId: user.id,
      threadId: targetId,
      organizationId,
      agent: "claudeCode" as const,
    })
    .returning({ id: threadChat.id });
  if (!chat) throw new Error("chat not created");
  return { organizationId, rootId, targetId, chatId: chat.id };
}

async function seed(from: string, to: string, n: number) {
  for (let i = 0; i < n; i++) {
    const res = await insertMessage({
      db,
      from,
      to,
      key: `k${i}`,
      body: `body ${i}`,
    });
    if ("conflict" in res) throw new Error("unexpected conflict");
  }
}

async function state(targetId: string, chatId: string) {
  const messages = await db
    .select({ id: agentMessages.id, consumedAt: agentMessages.consumedAt })
    .from(agentMessages)
    .where(eq(agentMessages.toRun, targetId));
  const applied = await db
    .select({ id: agentApplied.msgId })
    .from(agentApplied)
    .where(
      inArray(
        agentApplied.msgId,
        messages.map((m) => m.id),
      ),
    );
  const [chat] = await db
    .select({ queued: threadChat.queuedMessages })
    .from(threadChat)
    .where(eq(threadChat.id, chatId));
  return {
    messages: messages.length,
    consumed: messages.filter((m) => m.consumedAt !== null).length,
    applied: applied.length,
    queued: chat?.queued?.length ?? 0,
  };
}

async function receiveDrill(unsafe: boolean) {
  const s = await scenario();
  await seed(s.rootId, s.targetId, 3);
  const base = { MODE: "receive", TO_RUN: s.targetId };

  const killed = await runChild({
    ...base,
    KILL_POINT: "after-apply",
    KILL_AT_APPLY: "2",
    ...(unsafe ? { UNSAFE: "1" } : {}),
  });
  expectKilled(killed);

  const rerun = await runChild({ ...base, ...(unsafe ? { UNSAFE: "1" } : {}) });
  expect(rerun.code).toBe(0);
  return state(s.targetId, s.chatId);
}

describe("agent bus crash drills (#660)", () => {
  it(
    "AC1: a receiver killed after the effect, before COMMIT, applies 3 messages exactly once",
    async () => {
      const after = await receiveDrill(false);
      expect(after).toEqual({
        messages: 3,
        consumed: 3,
        applied: 3,
        queued: 3,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "AC2: a sender killed in apply (insert committed) retries to a duplicate, delivered once",
    async () => {
      const s = await scenario();
      const send = {
        MODE: "send",
        ORG_ID: s.organizationId,
        FROM: s.rootId,
        TO: s.targetId,
        KEY: "crash-key",
        BODY: "hello",
      };

      const killed = await runChild({ ...send, KILL_POINT: "after-apply" });
      expectKilled(killed);
      expect(await state(s.targetId, s.chatId)).toEqual({
        messages: 1,
        consumed: 0,
        applied: 0,
        queued: 0,
      });
      const [stored] = await db
        .select({ id: agentMessages.id })
        .from(agentMessages)
        .where(eq(agentMessages.toRun, s.targetId));

      const retry = await runChild(send);
      expect(resultOf(retry)).toMatchObject({
        ok: true,
        duplicate: true,
        id: stored?.id,
      });
      expect(await state(s.targetId, s.chatId)).toEqual({
        messages: 1,
        consumed: 1,
        applied: 1,
        queued: 1,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "AC3 (negative control): apply outside the transaction queues 4 follow-ups for 3 messages",
    async () => {
      const after = await receiveDrill(true);
      expect(after.applied).toBe(3);
      expect(after.consumed).toBe(3);
      expect(after.queued).toBe(4);
    },
    TEST_TIMEOUT_MS,
  );
});
