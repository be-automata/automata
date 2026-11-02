import { describe, expect, it, vi } from "vitest";

import {
  MAX_PUBLISH_BODY_BYTES,
  RECONCILE_PATHS,
  RECONCILE_TOKEN_HEADER,
} from "@terragon/knowledge/reconcile-wire";

import { createReconcileClient } from "./www-client";

const SECRET = "reconcile-secret-value";
const INTENT = "intent-1";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function setup(responses: Array<Response | Error>) {
  const queue = [...responses];
  const fetchImpl = vi.fn(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn(async (_ms: number) => {});
  const log = vi.fn();
  const client = createReconcileClient({
    baseUrl: "https://www.example.test/",
    secret: SECRET,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep,
    log,
  });
  return { client, fetchImpl, sleep, log };
}

const DONE = { status: "done", purgedOrganizationIds: [] };

describe("createReconcileClient", () => {
  it("POSTs the intent id with the secret header to the context path", async () => {
    const { client, fetchImpl } = setup([json(DONE)]);
    const res = await client.context(INTENT);
    expect(res).toEqual({ kind: "ok", value: DONE });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`https://www.example.test${RECONCILE_PATHS.context}`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers[RECONCILE_TOKEN_HEADER]).toBe(SECRET);
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ intentId: INTENT });
  });

  it("retries a 500 once after a sleep, then returns the value", async () => {
    const { client, sleep, fetchImpl } = setup([json({}, 500), json(DONE)]);
    const res = await client.context(INTENT);
    expect(res.kind).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("gives up as unreachable after three 503s", async () => {
    const { client, sleep, fetchImpl } = setup([
      json({}, 503),
      json({}, 503),
      json({}, 503),
    ]);
    expect(await client.context(INTENT)).toEqual({ kind: "unreachable" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2_000, 4_000]);
  });

  it("retries a network error", async () => {
    const { client, fetchImpl } = setup([new TypeError("boom"), json(DONE)]);
    expect((await client.context(INTENT)).kind).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404, 413, 422])(
    "does not retry a %i",
    async (status) => {
      const { client, fetchImpl, sleep } = setup([json({}, status)]);
      expect(await client.context(INTENT)).toEqual({
        kind: "rejected",
        status,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it("rejects a 200 body that fails the wire guard", async () => {
    const { client } = setup([json({ status: "weird" })]);
    expect(await client.context(INTENT)).toEqual({
      kind: "rejected",
      status: 200,
    });
  });

  it("parses publish and fail responses", async () => {
    const { client } = setup([
      json({ result: "published", opsInserted: 2 }),
      json({ state: "pending", attempts: 1, code: "fetch_failed" }),
    ]);
    const pub = await client.publish({
      intentId: INTENT,
      fromSha: null,
      toSha: "a".repeat(40),
      mode: "full",
      ops: [],
    });
    expect(pub).toEqual({
      kind: "ok",
      value: { result: "published", opsInserted: 2 },
    });
    const fail = await client.fail(INTENT, "fetch_failed");
    expect(fail.kind).toBe("ok");
  });

  it("refuses an oversized publish body without sending", async () => {
    const { client, fetchImpl } = setup([]);
    const res = await client.publish({
      intentId: INTENT,
      fromSha: null,
      toSha: "a".repeat(40),
      mode: "full",
      ops: [
        {
          id: "op",
          claimId: "c",
          kind: "review",
          baseVersion: 1,
          proposal: "x".repeat(MAX_PUBLISH_BODY_BYTES),
        },
      ],
    });
    expect(res).toEqual({ kind: "rejected", status: 413 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never logs the secret", async () => {
    const { client, log } = setup([
      new TypeError(`fail ${SECRET}`),
      json({}, 503),
      json({}, 401),
    ]);
    await client.context(INTENT);
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
    expect(log).toHaveBeenCalled();
  });
});
