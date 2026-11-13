import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import {
  getAddonCall,
  listAddonDeliveries,
  recordAddonCall,
  recordAddonDelivery,
} from "./addon-calls";
import { createTestOrg } from "./test-helpers";

const db = createDb(env.DATABASE_URL!);

async function newCall(organizationId: string) {
  const call = {
    id: `call-${randomUUID()}`,
    organizationId,
    threadId: null,
    transport: "rap" as const,
    groupId: `grp-${randomUUID().slice(0, 8)}`,
    expiresAt: new Date(Date.now() + 3_600_000),
  };
  return { call, result: await recordAddonCall({ db, call }) };
}

describe("addon calls", () => {
  it("records a call once; a second record of the same id reports exists", async () => {
    const organizationId = await createTestOrg({ db });
    const { call, result } = await newCall(organizationId);
    expect(result).toBe("created");
    expect(await recordAddonCall({ db, call })).toBe("exists");
    expect(
      await getAddonCall({ db, callId: call.id, organizationId }),
    ).toMatchObject({ id: call.id, groupId: call.groupId });
  });

  it("never returns a call to another organization", async () => {
    const owner = await createTestOrg({ db });
    const other = await createTestOrg({ db });
    const { call } = await newCall(owner);
    expect(
      await getAddonCall({ db, callId: call.id, organizationId: other }),
    ).toBeNull();
    expect(
      await listAddonDeliveries({ db, callId: call.id, organizationId: other }),
    ).toEqual([]);
  });

  it("applies a delivery once: a retried delivery key is refused as exists", async () => {
    const organizationId = await createTestOrg({ db });
    const { call } = await newCall(organizationId);
    const delivery = {
      callId: call.id,
      deliveryKey: "000001-00000001",
      kind: "tool_result" as const,
      body: { text: "done" },
      final: false,
    };
    expect(await recordAddonDelivery({ db, delivery })).toBe("created");
    expect(await recordAddonDelivery({ db, delivery })).toBe("exists");
    const rows = await listAddonDeliveries({
      db,
      callId: call.id,
      organizationId,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toEqual({ text: "done" });
  });

  it("keeps two genuine identical events apart when their delivery keys differ", async () => {
    const organizationId = await createTestOrg({ db });
    const { call } = await newCall(organizationId);
    for (const key of ["e-001", "e-002"]) {
      await recordAddonDelivery({
        db,
        delivery: {
          callId: call.id,
          deliveryKey: key,
          kind: "subscription_event",
          body: { text: "line\n" },
          final: false,
        },
      });
    }
    expect(
      await listAddonDeliveries({ db, callId: call.id, organizationId }),
    ).toHaveLength(2);
  });
});
