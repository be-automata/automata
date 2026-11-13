import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import {
  signCallbackCapability,
  verifyCallbackCapability,
} from "@/server-lib/addon/callback-capability";
import { env } from "@terragon/env/apps-www";
import * as addonCalls from "@terragon/shared/model/addon-calls";
import { createTestOrg } from "@terragon/shared/model/test-helpers";

import { POST } from "./route";

// One switch to make the next delivery write fail, calling through otherwise
// (ESM namespaces cannot be spied on directly).
const failNext = vi.hoisted(() => ({ on: false }));
vi.mock("@terragon/shared/model/addon-calls", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@terragon/shared/model/addon-calls")>();
  return {
    ...real,
    recordAddonDelivery: vi.fn(
      async (args: Parameters<typeof real.recordAddonDelivery>[0]) => {
        if (failNext.on) {
          failNext.on = false;
          throw new Error("db down");
        }
        return real.recordAddonDelivery(args);
      },
    ),
  };
});

const SECRET = "addon-callback-test-secret";
const setSecret = (v: string): void => {
  (env as { ADDON_CALLBACK_SECRET: string }).ADDON_CALLBACK_SECRET = v;
};

interface Fixture {
  organizationId: string;
  callId: string;
  groupId: string;
  capability: string;
}

async function recordedCall(): Promise<Fixture> {
  const organizationId = await createTestOrg({ db });
  const callId = `call-${randomUUID()}`;
  const groupId = `grp-${randomUUID().slice(0, 8)}`;
  await addonCalls.recordAddonCall({
    db,
    call: {
      id: callId,
      organizationId,
      threadId: null,
      transport: "rap",
      groupId,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  const capability = signCallbackCapability(SECRET, {
    callId,
    groupId,
    organizationId,
    expiresAt: Date.now() + 3_600_000,
  });
  return { organizationId, callId, groupId, capability };
}

function post(
  capability: string,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  const req = new NextRequest(
    `http://localhost/api/addon-callback/${capability}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    },
  );
  return POST(req, { params: Promise.resolve({ capability }) });
}

const result = (f: Fixture, text = "done") => ({
  type: "tool_result",
  group_id: f.groupId,
  id: f.callId,
  call_id: null,
  text,
});
const deliveries = (f: Fixture) =>
  addonCalls.listAddonDeliveries({
    db,
    callId: f.callId,
    organizationId: f.organizationId,
  });

beforeEach(() => {
  failNext.on = false;
  setSecret(SECRET);
});

describe("callback capability", () => {
  it("round-trips, and refuses tampering, another key, expiry and an empty secret", () => {
    const claims = {
      callId: "c1",
      groupId: "g1",
      organizationId: "o1",
      expiresAt: Date.now() + 60_000,
    };
    const cap = signCallbackCapability(SECRET, claims);
    expect(verifyCallbackCapability(SECRET, cap)).toEqual(claims);
    const [p = "", s = ""] = cap.split(".");
    expect(
      verifyCallbackCapability(SECRET, `${p}.${s.slice(0, -2)}AA`),
    ).toBeNull();
    expect(verifyCallbackCapability("another-key", cap)).toBeNull();
    expect(
      verifyCallbackCapability(SECRET, cap, claims.expiresAt + 1),
    ).toBeNull();
    expect(verifyCallbackCapability("", cap)).toBeNull();
    expect(() => signCallbackCapability("", claims)).toThrow();
  });
});

describe("POST /api/addon-callback/[capability]", () => {
  it("stores a result for a recorded call, once: a retried delivery is a duplicate", async () => {
    const f = await recordedCall();
    const first = await post(f.capability, result(f), {
      "x-rap-delivery-id": "000001-00000001",
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, delivery: "stored" });
    const retry = await post(f.capability, result(f), {
      "x-rap-delivery-id": "000001-00000001",
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ok: true, delivery: "duplicate" });
    const rows = await deliveries(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "tool_result",
      final: false,
      body: result(f),
    });
  });

  it("without a delivery id, dedups by body: an identical retry is not applied twice", async () => {
    const f = await recordedCall();
    expect((await post(f.capability, result(f))).status).toBe(200);
    expect(await (await post(f.capability, result(f))).json()).toEqual({
      ok: true,
      delivery: "duplicate",
    });
    expect(await deliveries(f)).toHaveLength(1);
  });

  it("keeps streamed events apart by delivery id and marks the final one", async () => {
    const f = await recordedCall();
    const ev = (text: string, final = false) => ({
      type: "subscription_event",
      group_id: f.groupId,
      tool_call_id: f.callId,
      text,
      associative: true,
      ...(final ? { final: true } : {}),
    });
    await post(f.capability, ev("line\n"), { "x-rap-delivery-id": "e-001" });
    await post(f.capability, ev("line\n"), { "x-rap-delivery-id": "e-002" });
    await post(f.capability, ev("end\n", true), {
      "x-rap-delivery-id": "e-003",
    });
    const rows = await deliveries(f);
    expect(rows.map((r) => r.final)).toEqual([false, false, true]);
  });

  it("refuses a forged, foreign-key, expired or disabled capability with 401 and stores nothing", async () => {
    const f = await recordedCall();
    const [p = "", s = ""] = f.capability.split(".");
    const expired = signCallbackCapability(SECRET, {
      callId: f.callId,
      groupId: f.groupId,
      organizationId: f.organizationId,
      expiresAt: Date.now() - 1,
    });
    const foreign = signCallbackCapability("another-key", {
      callId: f.callId,
      groupId: f.groupId,
      organizationId: f.organizationId,
      expiresAt: Date.now() + 60_000,
    });
    for (const cap of [
      `${p}.${s.slice(0, -2)}AA`,
      expired,
      foreign,
      "not-a-capability",
    ]) {
      expect((await post(cap, result(f))).status).toBe(401);
    }
    setSecret("");
    expect((await post(f.capability, result(f))).status).toBe(401);
    expect(await deliveries(f)).toEqual([]);
  });

  it("refuses a callback for another call or group with 409, and a call never recorded with 404", async () => {
    const f = await recordedCall();
    expect(
      (await post(f.capability, { ...result(f), id: "someone-else" })).status,
    ).toBe(409);
    expect(
      (await post(f.capability, { ...result(f), group_id: "other-group" }))
        .status,
    ).toBe(409);
    const unrecorded = signCallbackCapability(SECRET, {
      callId: `call-${randomUUID()}`,
      groupId: f.groupId,
      organizationId: f.organizationId,
      expiresAt: Date.now() + 60_000,
    });
    const cid = verifyCallbackCapability(SECRET, unrecorded)?.callId ?? "";
    expect((await post(unrecorded, { ...result(f), id: cid })).status).toBe(
      404,
    );
    const otherOrg = await createTestOrg({ db });
    const crossOrg = signCallbackCapability(SECRET, {
      callId: f.callId,
      groupId: f.groupId,
      organizationId: otherOrg,
      expiresAt: Date.now() + 60_000,
    });
    expect((await post(crossOrg, result(f))).status).toBe(404);
    expect(await deliveries(f)).toEqual([]);
  });

  it("refuses bad JSON, a non-object body, a malformed delivery id and an oversize body", async () => {
    const f = await recordedCall();
    expect((await post(f.capability, "{not json")).status).toBe(400);
    expect((await post(f.capability, "[1,2]")).status).toBe(400);
    expect(
      (
        await post(f.capability, result(f), {
          "x-rap-delivery-id": "bad id with spaces",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(f.capability, {
          ...result(f),
          text: "x".repeat(1024 * 1024 + 1),
        })
      ).status,
    ).toBe(413);
    expect(await deliveries(f)).toEqual([]);
  });

  it("answers 503 when the write fails, so a retrying add-on tries again", async () => {
    const f = await recordedCall();
    failNext.on = true;
    expect((await post(f.capability, result(f))).status).toBe(503);
    expect((await post(f.capability, result(f))).status).toBe(200);
    expect(await deliveries(f)).toHaveLength(1);
  });
});
