import { nanoid } from "nanoid";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import { enrollDeliveryPr } from "@terragon/shared/model/delivery-loop";
import {
  createTestOrg,
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import { isDeliveryLoopOwned } from "./exclusions";

const BRANCH = "automata/task-abcd1234";

describe("#509 isDeliveryLoopOwned", () => {
  let repoFullName: string;

  beforeEach(async () => {
    const userId = (await createTestUser({ db })).user.id;
    const organizationId = await createTestOrg({ db });
    const threadId = (await createTestThread({ db, userId })).threadId;
    repoFullName = `Acme/Widgets-${nanoid(6)}`;
    await enrollDeliveryPr(db, {
      organizationId,
      repoFullName,
      prNumber: 12,
      issueNumber: 4,
      headRef: BRANCH,
      baseRef: "main",
      headSha: "H1",
      deliveryThreadId: threadId,
      automationId: "auto-1",
      now: new Date(),
    });
  });

  it("is true only for an enrolled PR in mode on, by PR number or by head branch", async () => {
    const on = { db, loadMode: async () => "on" as const };
    expect(
      await isDeliveryLoopOwned(
        { repoFullName, headRef: BRANCH, prNumber: 12 },
        on,
      ),
    ).toBe(true);
    expect(
      await isDeliveryLoopOwned({ repoFullName, headRef: BRANCH }, on),
    ).toBe(true);
    expect(
      await isDeliveryLoopOwned(
        { repoFullName, headRef: BRANCH, prNumber: 99 },
        on,
      ),
    ).toBe(false);
  });

  it("shadow and off keep today's behaviour", async () => {
    for (const mode of ["shadow", "off"] as const) {
      expect(
        await isDeliveryLoopOwned(
          { repoFullName, headRef: BRANCH, prNumber: 12 },
          { db, loadMode: async () => mode },
        ),
      ).toBe(false);
    }
  });

  it("a branch outside automata/task-* costs no query", async () => {
    const loadMode = vi.fn(async () => "on" as const);
    const brokenDb = {
      select: () => {
        throw new Error("must not query");
      },
    } as unknown as typeof db;
    expect(
      await isDeliveryLoopOwned(
        { repoFullName, headRef: "main", prNumber: 12 },
        { db: brokenDb, loadMode },
      ),
    ).toBe(false);
    expect(
      await isDeliveryLoopOwned(
        { repoFullName, headRef: undefined },
        { db: brokenDb, loadMode },
      ),
    ).toBe(false);
    expect(loadMode).not.toHaveBeenCalled();
  });

  it("a lookup failure fails closed to today's behaviour", async () => {
    const brokenDb = {
      select: () => {
        throw new Error("db down");
      },
    } as unknown as typeof db;
    expect(
      await isDeliveryLoopOwned(
        { repoFullName, headRef: BRANCH, prNumber: 12 },
        { db: brokenDb },
      ),
    ).toBe(false);
  });
});
