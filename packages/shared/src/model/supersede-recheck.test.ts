import { beforeEach, describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import { nanoid } from "nanoid";
import {
  createTestOrg,
  createTestThread,
  createTestUser,
} from "./test-helpers";
import {
  buildPrKey,
  claimRecheck,
  countRechecks,
  getDesiredHead,
  upsertDesiredHead,
} from "./supersede-recheck";

const db = createDb(env.DATABASE_URL!);

describe("#125 C5 desired head (CAS) + recheck ledger", () => {
  let prKey: string;
  beforeEach(() => {
    prKey = buildPrKey({
      orgId: nanoid(6),
      repoFullName: "Acme/Widgets",
      prNumber: 7,
    });
  });

  it("buildPrKey normalises the slug exactly like dispatch does", () => {
    expect(
      buildPrKey({ orgId: "o", repoFullName: " Acme/Widgets ", prNumber: 1 }),
    ).toBe("o/acme/widgets/1");
  });

  it("out-of-order webhooks never move the head backwards; ties break on the greater delivery id (AC3)", async () => {
    const t1 = new Date("2026-08-24T10:00:00Z");
    const t2 = new Date("2026-08-24T10:00:05Z");
    expect(
      await upsertDesiredHead({
        db,
        prKey,
        sha: "sha-2",
        webhookAt: t2,
        deliveryId: "d2",
      }),
    ).toBe(true);
    // A late delivery of an OLDER push: rejected.
    expect(
      await upsertDesiredHead({
        db,
        prKey,
        sha: "sha-1",
        webhookAt: t1,
        deliveryId: "d1",
      }),
    ).toBe(false);
    expect((await getDesiredHead({ db, prKey }))?.sha).toBe("sha-2");
    // Same timestamp, lexicographically greater delivery id wins…
    expect(
      await upsertDesiredHead({
        db,
        prKey,
        sha: "sha-3",
        webhookAt: t2,
        deliveryId: "d3",
      }),
    ).toBe(true);
    // …and a smaller one loses.
    expect(
      await upsertDesiredHead({
        db,
        prKey,
        sha: "sha-x",
        webhookAt: t2,
        deliveryId: "d0",
      }),
    ).toBe(false);
    expect((await getDesiredHead({ db, prKey }))?.sha).toBe("sha-3");
    // A genuinely newer push moves it forward.
    expect(
      await upsertDesiredHead({
        db,
        prKey,
        sha: "sha-4",
        webhookAt: new Date("2026-08-24T10:01:00Z"),
        deliveryId: "d4",
      }),
    ).toBe(true);
    expect((await getDesiredHead({ db, prKey }))?.sha).toBe("sha-4");
  });

  it("claimRecheck: exactly one winner per (prKey, sha), even under a race; a new sha claims again", async () => {
    const userId = (await createTestUser({ db })).user.id;
    const orgId = await createTestOrg({ db });
    const { threadId } = await createTestThread({
      db,
      userId,
      overrides: { organizationId: orgId },
    });
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        claimRecheck({
          db,
          prKey,
          desiredHeadSha: "sha-9",
          triggeredByThreadId: threadId,
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await countRechecks({ db, prKey })).toBe(1);
    expect(
      await claimRecheck({
        db,
        prKey,
        desiredHeadSha: "sha-10",
        triggeredByThreadId: threadId,
      }),
    ).toBe(true);
    expect(await countRechecks({ db, prKey })).toBe(2);
  });
});
