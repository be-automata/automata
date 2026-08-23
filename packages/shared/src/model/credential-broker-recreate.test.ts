import { beforeEach, describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import { createTestUser, createTestThread } from "./test-helpers";
import {
  claimBrokeredSandboxRecreate,
  getThreadMinimal,
  updateThread,
} from "./threads";
import type { User } from "../db/types";

const db = createDb(env.DATABASE_URL!);

// #114 concurrent-resume lease: a brokered Docker sandbox is non-resumable, so a
// resume must recreate it — but concurrent resumes must NOT both recreate (that
// orphans a sandbox + its sidecar/network). claimBrokeredSandboxRecreate is the
// compare-and-set that guarantees exactly one winner.
describe("claimBrokeredSandboxRecreate (#114 concurrent-resume lease)", () => {
  let user: User;

  beforeEach(async () => {
    user = (await createTestUser({ db })).user;
  });

  async function makeBrokeredThread(sandboxId: string): Promise<string> {
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: { sandboxProvider: "docker" },
    });
    await updateThread({
      db,
      userId: user.id,
      threadId,
      updates: { codesandboxId: sandboxId, credentialBrokerMode: "brokered" },
    });
    return threadId;
  }

  it("exactly ONE of many concurrent claims wins; it clears codesandboxId", async () => {
    const sandboxId = "docker-sandbox-abc";
    const threadId = await makeBrokeredThread(sandboxId);

    // 10 concurrent resumes all race to claim the recreate.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        claimBrokeredSandboxRecreate({
          db,
          userId: user.id,
          threadId,
          expectedSandboxId: sandboxId,
        }),
      ),
    );

    const winners = results.filter((r) => r.claimed).length;
    expect(winners).toBe(1); // no double-recreate → no orphan
    // The winner cleared the stale id so its recreate takes the create path.
    const thread = await getThreadMinimal({ db, threadId, userId: user.id });
    expect(thread?.codesandboxId).toBeNull();
  });

  it("a claim against a stale (already-changed) sandbox id does not win", async () => {
    const sandboxId = "docker-sandbox-def";
    const threadId = await makeBrokeredThread(sandboxId);

    // Winner claims first (clears the id).
    const first = await claimBrokeredSandboxRecreate({
      db,
      userId: user.id,
      threadId,
      expectedSandboxId: sandboxId,
    });
    expect(first.claimed).toBe(true);

    // A late loser still holding the old id must NOT win (id already cleared).
    const late = await claimBrokeredSandboxRecreate({
      db,
      userId: user.id,
      threadId,
      expectedSandboxId: sandboxId,
    });
    expect(late.claimed).toBe(false);
  });

  it("is fenced to the owning user", async () => {
    const sandboxId = "docker-sandbox-ghi";
    const threadId = await makeBrokeredThread(sandboxId);
    const other = (await createTestUser({ db })).user;

    const result = await claimBrokeredSandboxRecreate({
      db,
      userId: other.id,
      threadId,
      expectedSandboxId: sandboxId,
    });
    expect(result.claimed).toBe(false);
    // The owner can still claim — the row was untouched.
    const owner = await claimBrokeredSandboxRecreate({
      db,
      userId: user.id,
      threadId,
      expectedSandboxId: sandboxId,
    });
    expect(owner.claimed).toBe(true);
  });
});
