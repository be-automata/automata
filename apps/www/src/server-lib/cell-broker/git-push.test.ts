import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import type { DB } from "@terragon/shared/db";
import { cellEffect, cellStep, thread } from "@terragon/shared/db/schema";
import {
  beginEffect,
  mintBearer,
  openStep,
} from "@terragon/shared/model/cell-authority";
import {
  createTestOrg,
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import {
  createGitBrokerHandler,
  pushIdempotencyKey,
  type GitBrokerDeps,
} from "./git";
import { parseReportStatus } from "./report-status";

const STEP_TIMEOUT = 30 * 60_000;
const SENTINEL = "ghs_SENTINEL_write_token";
const URL_PUSH =
  "https://www.example.com/api/cell/git/acme/widgets.git/git-receive-pack";
const OLD = "1".repeat(40);
const NEW_A = "a".repeat(40);
const NEW_B = "b".repeat(40);
const REF = "refs/heads/feat/x";
const enc = new TextEncoder();

function pkt(payload: string | Uint8Array): Uint8Array {
  const body = typeof payload === "string" ? enc.encode(payload) : payload;
  const len = (body.length + 4).toString(16).padStart(4, "0");
  return concat(enc.encode(len), body);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const FLUSH = enc.encode("0000");
const PACK = enc.encode("PACK-bytes-0123456789");

function commandSection(newSha = NEW_A, ref = REF): Uint8Array {
  return concat(
    pkt(`${OLD} ${newSha} ${ref}\0report-status side-band-64k\n`),
    FLUSH,
  );
}

const pushBody = (newSha = NEW_A) => concat(commandSection(newSha), PACK);

const REPORT_OK = concat(pkt("unpack ok\n"), pkt(`ok ${REF}\n`), FLUSH);

async function fixture(effectBudget: number | null = null) {
  const organizationId = await createTestOrg({ db });
  const { user } = await createTestUser({ db });
  const { threadId } = await createTestThread({
    db,
    userId: user.id,
    overrides: { githubRepoFullName: "acme/widgets" },
  });
  await db
    .update(thread)
    .set({ organizationId })
    .where(eq(thread.id, threadId));
  const stepKey = `run-${randomUUID()}/agent`;
  const open = (attempt: number) =>
    openStep({
      db,
      step: {
        stepKey,
        organizationId,
        threadId,
        attempt,
        stepTimeoutMs: STEP_TIMEOUT,
        effectBudget,
      },
    });
  const bearer = async (attempt: number) => {
    const m = await mintBearer({ db, stepKey, attempt, ttlMs: STEP_TIMEOUT });
    if (!m.ok) throw new Error(m.reason);
    return m.token;
  };
  await open(1);
  return { stepKey, open, bearer, token: await bearer(1) };
}

async function effectsUsed(stepKey: string): Promise<number> {
  const rows = await db
    .select({ used: cellStep.effectsUsed })
    .from(cellStep)
    .where(eq(cellStep.stepKey, stepKey));
  return rows[0]?.used ?? -1;
}

async function effectRows(stepKey: string, key?: string): Promise<number> {
  const rows = await db
    .select({ key: cellEffect.idempotencyKey })
    .from(cellEffect)
    .where(
      key
        ? and(
            eq(cellEffect.stepKey, stepKey),
            eq(cellEffect.idempotencyKey, key),
          )
        : eq(cellEffect.stepKey, stepKey),
    );
  return rows.length;
}

async function readAll(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ReadableStream) {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const parts: Uint8Array[] = [];
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return concat(...parts);
      parts.push(chunk.value);
    }
  }
  throw new Error("unexpected body type");
}

interface Answer {
  status?: number;
  body?: Uint8Array;
  contentType?: string;
  throws?: boolean;
}

function harness(
  answer: Answer | (() => Promise<Answer> | Answer) = {},
  over: Partial<GitBrokerDeps> = {},
) {
  const calls: { url: string; body: Uint8Array; headers: Headers }[] = [];
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = await readAll(init?.body as BodyInit | null | undefined);
      calls.push({
        url: String(input),
        body,
        headers: new Headers(init?.headers),
      });
      const a = typeof answer === "function" ? await answer() : answer;
      if (a.throws) throw new Error("network down");
      return new Response(a.body ?? REPORT_OK, {
        status: a.status ?? 200,
        headers: {
          "content-type":
            a.contentType ?? "application/x-git-receive-pack-result",
        },
      });
    },
  );
  const mintReadToken = vi.fn(async () => ({ token: SENTINEL }));
  const mintWriteToken = vi.fn(async () => ({ token: SENTINEL }));
  const handler = createGitBrokerHandler({
    db,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    mintReadToken,
    mintWriteToken,
    sideEffectsEnabled: () => true,
    enabled: () => true,
    ...over,
  });
  return { handler, calls, fetchImpl, mintReadToken, mintWriteToken };
}

function captureLogs() {
  const spies = (["error", "warn", "log"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
  return {
    text: () =>
      spies
        .flatMap((spy) => spy.mock.calls.flat())
        .map((arg) =>
          arg instanceof Error ? `${arg.message}\n${arg.stack}` : String(arg),
        )
        .join("\n"),
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}

/** The real db with some methods replaced (a failing database, in effect). */
function dbWith(
  overrides: Record<string, (...args: unknown[]) => unknown>,
): DB {
  return new Proxy(db, {
    get(target, prop) {
      const override = overrides[String(prop)];
      if (override) return override;
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DB;
}

const basic = (pass: string) => `Basic ${btoa(`x-access-token:${pass}`)}`;

function push(
  token: string,
  body: Uint8Array | ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
): Request {
  return new Request(URL_PUSH, {
    method: "POST",
    body: body as BodyInit,
    headers: { authorization: basic(token), ...headers },
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[i++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
}

async function json(res: Response): Promise<{ error?: string }> {
  return (await res.json()) as { error?: string };
}

describe("git broker push", () => {
  it("AC4 forwards a push once, stores it and replays an identical retry; a different push uses a second unit", async () => {
    const f = await fixture();
    const h = harness();
    const first = await h.handler(push(f.token, pushBody()));
    expect(first.status).toBe(200);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(REPORT_OK);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.url).toBe(
      "https://github.com/acme/widgets.git/git-receive-pack",
    );
    expect(h.calls[0]?.body).toEqual(pushBody());
    expect(h.calls[0]?.headers.get("authorization")).toBe(basic(SENTINEL));
    expect(await effectRows(f.stepKey)).toBe(1);
    expect(await effectsUsed(f.stepKey)).toBe(1);

    const again = await h.handler(push(f.token, pushBody()));
    expect(again.status).toBe(200);
    expect(again.headers.get("content-type")).toBe(
      "application/x-git-receive-pack-result",
    );
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(REPORT_OK);
    expect(h.calls).toHaveLength(1);
    expect(await effectsUsed(f.stepKey)).toBe(1);

    const other = await h.handler(push(f.token, pushBody(NEW_B)));
    expect(other.status).toBe(200);
    expect(h.calls).toHaveLength(2);
    expect(await effectsUsed(f.stepKey)).toBe(2);
  });

  it("AC4 answers 429 without calling GitHub once the budget is spent", async () => {
    const f = await fixture(1);
    const h = harness();
    expect((await h.handler(push(f.token, pushBody()))).status).toBe(200);
    const res = await h.handler(push(f.token, pushBody(NEW_B)));
    expect([res.status, (await json(res)).error]).toEqual([
      429,
      "effect_budget_exhausted",
    ]);
    expect(h.calls).toHaveLength(1);
  });

  it("AC11 push side: the POST mints the write token and never the read token", async () => {
    const f = await fixture();
    const h = harness();
    await h.handler(push(f.token, pushBody()));
    expect(h.mintWriteToken).toHaveBeenCalledWith("acme", "widgets");
    expect(h.mintReadToken).not.toHaveBeenCalled();
  });

  it("AC5 stores a 200 whose report-status says ng, and a 4xx, and replays both", async () => {
    const ng = concat(
      pkt(
        concat(
          Uint8Array.of(1),
          concat(pkt("unpack ok\n"), pkt(`ng ${REF} hook declined\n`), FLUSH),
        ),
      ),
      FLUSH,
    );
    const f = await fixture();
    const h = harness({ body: ng });
    const first = await h.handler(push(f.token, pushBody()));
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(ng);
    const replay = await h.handler(push(f.token, pushBody()));
    expect(new Uint8Array(await replay.arrayBuffer())).toEqual(ng);
    expect(h.calls).toHaveLength(1);

    const g = await fixture();
    const denied = harness({
      status: 403,
      body: enc.encode("Permission denied"),
      contentType: "text/plain",
    });
    const a = await denied.handler(push(g.token, pushBody()));
    expect([a.status, await a.text()]).toEqual([403, "Permission denied"]);
    const b = await denied.handler(push(g.token, pushBody()));
    expect([b.status, b.headers.get("content-type"), await b.text()]).toEqual([
      403,
      "text/plain",
      "Permission denied",
    ]);
    expect(denied.calls).toHaveLength(1);
  });

  it("AC10 refuses a declared length over the cap before any claim", async () => {
    const f = await fixture();
    const h = harness({}, { maxPushBytes: 1000 });
    const res = await h.handler(
      push(f.token, pushBody(), { "content-length": "1001" }),
    );
    expect(res.status).toBe(413);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(await effectRows(f.stepKey)).toBe(0);
    expect(await effectsUsed(f.stepKey)).toBe(0);
  });

  it("AC10 aborts a streamed body over the cap, releases the claim and answers 413", async () => {
    const f = await fixture();
    const h = harness({}, { maxPushBytes: 1000 });
    const chunks = [
      commandSection(),
      ...Array.from({ length: 5 }, () => new Uint8Array(400).fill(7)),
    ];
    const res = await h.handler(push(f.token, streamOf(chunks)));
    expect([res.status, (await json(res)).error]).toEqual([
      413,
      "payload_too_large",
    ]);
    expect(await effectRows(f.stepKey)).toBe(0);
    expect(await effectsUsed(f.stepKey)).toBe(1);
  });

  it("AC10 a cap crossed while GitHub's early answer is still being read is a 413 that releases the claim", async () => {
    const f = await fixture();
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const consumed = readAll(init?.body as BodyInit | null | undefined);
        consumed.catch(() => undefined);
        // Headers arrive at once; the body only ends after the request is read.
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await consumed;
              controller.enqueue(REPORT_OK);
              controller.close();
            },
          }),
          { status: 200 },
        );
      },
    );
    const handler = createGitBrokerHandler({
      db,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      mintReadToken: async () => ({ token: SENTINEL }),
      mintWriteToken: async () => ({ token: SENTINEL }),
      sideEffectsEnabled: () => true,
      enabled: () => true,
      maxPushBytes: 1000,
    });
    const chunks = [
      commandSection(),
      ...Array.from({ length: 5 }, () => new Uint8Array(400).fill(7)),
    ];
    const res = await handler(push(f.token, streamOf(chunks)));
    expect([res.status, (await json(res)).error]).toEqual([
      413,
      "payload_too_large",
    ]);
    expect(await effectRows(f.stepKey)).toBe(0);
    expect(await effectsUsed(f.stepKey)).toBe(1);
  });

  it("a database failure while resolving the bearer is a 500 internal_error and logs no error message", async () => {
    const f = await fixture();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failing = new Proxy({} as DB, {
        get() {
          throw new Error(`db down ${SENTINEL}`);
        },
      });
      const h = harness({}, { db: failing });
      const res = await h.handler(push(f.token, pushBody()));
      expect([res.status, (await json(res)).error]).toEqual([
        500,
        "internal_error",
      ]);
      expect(h.fetchImpl).not.toHaveBeenCalled();
      expect(JSON.stringify(logged.mock.calls)).not.toContain(SENTINEL);
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("AC12 a cell disconnect after the command section is a 502 that releases the claim", async () => {
    const f = await fixture();
    const h = harness();
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(commandSection());
          return;
        }
        controller.error(new Error("client went away"));
      },
    });
    const res = await h.handler(push(f.token, body));
    expect([res.status, (await json(res)).error]).toEqual([
      502,
      "upstream_error",
    ]);
    expect(await effectRows(f.stepKey)).toBe(0);
    expect(await effectsUsed(f.stepKey)).toBe(1);
  });

  it("a stored result that fails validation is a 500 corrupt_effect_result with no upstream call", async () => {
    const f = await fixture();
    const h = harness();
    expect((await h.handler(push(f.token, pushBody()))).status).toBe(200);
    const key = await pushIdempotencyKey([
      { oldSha: OLD, newSha: NEW_A, ref: REF },
    ]);
    await db
      .update(cellEffect)
      .set({ result: { httpStatus: "x" } })
      .where(
        and(
          eq(cellEffect.stepKey, f.stepKey),
          eq(cellEffect.idempotencyKey, key),
        ),
      );
    const res = await h.handler(push(f.token, pushBody()));
    expect([res.status, (await json(res)).error]).toEqual([
      500,
      "corrupt_effect_result",
    ]);
    expect(h.calls).toHaveLength(1);
  });

  it("a beginEffect failure is a 500 internal_error, with no upstream call and nothing sensitive logged", async () => {
    const f = await fixture();
    const logs = captureLogs();
    try {
      const h = harness(
        {},
        {
          db: dbWith({
            transaction: () => {
              throw new Error(`tx down ${SENTINEL}`);
            },
          }),
        },
      );
      const res = await h.handler(push(f.token, pushBody()));
      expect([res.status, (await json(res)).error]).toEqual([
        500,
        "internal_error",
      ]);
      expect(h.fetchImpl).not.toHaveBeenCalled();
      expect(logs.text()).not.toContain(SENTINEL);
      expect(logs.text()).not.toContain(f.token);
      expect(await effectRows(f.stepKey)).toBe(0);
    } finally {
      logs.restore();
    }
  });

  it("a completeEffect failure after GitHub answered still returns GitHub's bytes and leaves the claim pending", async () => {
    const f = await fixture();
    const logs = captureLogs();
    try {
      const h = harness(
        {},
        {
          db: dbWith({
            update: () => {
              throw new Error(`update down ${SENTINEL}`);
            },
          }),
        },
      );
      const first = await h.handler(push(f.token, pushBody()));
      expect(first.status).toBe(200);
      expect(new Uint8Array(await first.arrayBuffer())).toEqual(REPORT_OK);
      const rows = await db
        .select({ result: cellEffect.result })
        .from(cellEffect)
        .where(eq(cellEffect.stepKey, f.stepKey));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.result).toBeNull();

      const again = await h.handler(push(f.token, pushBody()));
      expect([again.status, (await json(again)).error]).toEqual([
        409,
        "effect_in_progress",
      ]);
      expect(h.calls).toHaveLength(1);
      expect(logs.text()).not.toContain(SENTINEL);
      expect(logs.text()).not.toContain(f.token);
    } finally {
      logs.restore();
    }
  });

  it("a releaseEffect failure still answers 502 and logs nothing sensitive", async () => {
    const f = await fixture();
    const logs = captureLogs();
    try {
      let transactions = 0;
      const realTransaction = db.transaction.bind(db) as (
        ...args: unknown[]
      ) => unknown;
      const h = harness(
        { status: 503 },
        {
          db: dbWith({
            transaction: (...args: unknown[]) => {
              transactions += 1;
              // The first transaction is beginEffect, the second the release.
              if (transactions > 1) {
                throw new Error(`release down ${SENTINEL}`);
              }
              return realTransaction(...args);
            },
          }),
        },
      );
      const res = await h.handler(push(f.token, pushBody()));
      expect([res.status, (await json(res)).error]).toEqual([
        502,
        "upstream_error",
      ]);
      expect(logs.text()).not.toContain(SENTINEL);
      expect(logs.text()).not.toContain(f.token);
    } finally {
      logs.restore();
    }
  });

  it("with side effects off a push POST is a 503 before any mint, claim or upstream call", async () => {
    const f = await fixture();
    const h = harness({}, { sideEffectsEnabled: () => false });
    const res = await h.handler(push(f.token, pushBody()));
    expect([res.status, (await json(res)).error]).toEqual([
      503,
      "side_effects_disabled",
    ]);
    expect(h.mintWriteToken).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(await effectRows(f.stepKey)).toBe(0);
    expect(await effectsUsed(f.stepKey)).toBe(0);
  });

  it("AC12 a GitHub 503 releases the claim; an identical retry is forwarded and uses a second unit", async () => {
    const f = await fixture();
    let status = 503;
    const h = harness(() => ({ status }));
    const failed = await h.handler(push(f.token, pushBody()));
    expect([failed.status, (await json(failed)).error]).toEqual([
      502,
      "upstream_error",
    ]);
    expect(await effectRows(f.stepKey)).toBe(0);
    expect(await effectsUsed(f.stepKey)).toBe(1);

    status = 200;
    const retry = await h.handler(push(f.token, pushBody()));
    expect(retry.status).toBe(200);
    expect(h.calls).toHaveLength(2);
    expect(await effectsUsed(f.stepKey)).toBe(2);
    expect(await effectRows(f.stepKey)).toBe(1);
  });

  it("AC12 a network error and a 3xx also release the claim", async () => {
    const f = await fixture();
    const thrown = harness({ throws: true });
    const a = await thrown.handler(push(f.token, pushBody()));
    expect(a.status).toBe(502);
    expect(await effectRows(f.stepKey)).toBe(0);

    const redirected = harness({ status: 302 });
    const b = await redirected.handler(push(f.token, pushBody()));
    expect(b.status).toBe(502);
    expect(await effectRows(f.stepKey)).toBe(0);
    expect(await effectsUsed(f.stepKey)).toBe(2);
  });

  it("a response over the 1 MiB read cap is released with a 502", async () => {
    const f = await fixture();
    const h = harness({ body: new Uint8Array(1024 * 1024 + 1) });
    const res = await h.handler(push(f.token, pushBody()));
    expect(res.status).toBe(502);
    expect(await effectRows(f.stepKey)).toBe(0);
  });

  it("probe: a bare 0000 is forwarded with the write token and no effect; 0000 plus bytes is 400", async () => {
    const f = await fixture();
    const h = harness({ body: enc.encode("probe-ok") });
    const probe = await h.handler(push(f.token, FLUSH));
    expect([probe.status, await probe.text()]).toEqual([200, "probe-ok"]);
    expect(h.calls[0]?.body).toEqual(FLUSH);
    expect(h.mintWriteToken).toHaveBeenCalledTimes(1);
    expect(await effectRows(f.stepKey)).toBe(0);
    expect(await effectsUsed(f.stepKey)).toBe(0);

    const trailing = await h.handler(push(f.token, concat(FLUSH, PACK)));
    expect(trailing.status).toBe(400);
    expect(h.calls).toHaveLength(1);
  });

  it("415 for an encoded body (identity is fine), 400 for a malformed section, 413 for an oversized one", async () => {
    const f = await fixture();
    const h = harness();
    const gz = await h.handler(
      push(f.token, pushBody(), { "content-encoding": "gzip" }),
    );
    expect(gz.status).toBe(415);
    const identity = await h.handler(
      push(f.token, pushBody(), { "content-encoding": "identity" }),
    );
    expect(identity.status).toBe(200);
    expect(h.calls).toHaveLength(1);

    const malformed = await h.handler(push(f.token, enc.encode("zzzzPACK")));
    expect(malformed.status).toBe(400);
    const truncated = await h.handler(
      push(f.token, commandSection().subarray(0, 20)),
    );
    expect(truncated.status).toBe(400);

    // 700 update commands and no flush-pkt: the section never completes.
    const commands = Array.from({ length: 700 }, (_, i) =>
      pkt(`${OLD} ${NEW_A} refs/heads/branch-${i}-${"x".repeat(60)}\n`),
    );
    const huge = await h.handler(push(f.token, streamOf(commands)));
    expect(huge.status).toBe(413);
    expect(h.calls).toHaveLength(1);
  });

  it("a failed token mint is a 502 with no claim", async () => {
    const f = await fixture();
    const h = harness(
      {},
      {
        mintWriteToken: async () => {
          throw new Error(`boom ${SENTINEL}`);
        },
      },
    );
    const res = await h.handler(push(f.token, pushBody()));
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain(SENTINEL);
    expect(await effectRows(f.stepKey)).toBe(0);
    expect(await effectsUsed(f.stepKey)).toBe(0);
  });

  it("takeover: when a newer attempt took the claim, the older push still returns GitHub's bytes", async () => {
    const f = await fixture();
    const key = await pushIdempotencyKey([
      { oldSha: OLD, newSha: NEW_A, ref: REF },
    ]);
    const h = harness(async () => {
      await f.open(2);
      const token2 = await f.bearer(2);
      const taken = await beginEffect({
        db,
        token: token2,
        idempotencyKey: key,
      });
      expect(taken.kind).toBe("go");
      return {};
    });
    const res = await h.handler(push(f.token, pushBody()));
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(REPORT_OK);
    // The claim is still there (now attempt 2) and holds no stored result.
    expect(await effectRows(f.stepKey, key)).toBe(1);
  });
});

describe("parseReportStatus", () => {
  it("reads a plain report", () => {
    expect(parseReportStatus(REPORT_OK)).toEqual({
      unpack: "ok",
      refs: [{ ref: REF, ok: true }],
    });
  });

  it("reads side-band-64k with a pkt-line spanning two band-1 packets, skipping band 2", () => {
    const inner = concat(pkt("unpack ok\n"), pkt(`ok ${REF}\n`), FLUSH);
    const cut = 7;
    const body = concat(
      pkt(concat(Uint8Array.of(2), enc.encode("Resolving deltas\n"))),
      pkt(concat(Uint8Array.of(1), inner.subarray(0, cut))),
      pkt(concat(Uint8Array.of(2), enc.encode("progress\n"))),
      pkt(concat(Uint8Array.of(1), inner.subarray(cut))),
      FLUSH,
    );
    expect(parseReportStatus(body)).toEqual({
      unpack: "ok",
      refs: [{ ref: REF, ok: true }],
    });
  });

  it("reads ng with its reason and an unpack error", () => {
    expect(
      parseReportStatus(
        concat(pkt("unpack ok\n"), pkt(`ng ${REF} hook declined\n`), FLUSH),
      ),
    ).toEqual({
      unpack: "ok",
      refs: [{ ref: REF, ok: false, reason: "hook declined" }],
    });
    expect(
      parseReportStatus(
        concat(
          pkt("unpack index-pack abnormal exit\n"),
          pkt(`ng ${REF} unpacker error\n`),
          FLUSH,
        ),
      )?.unpack,
    ).toBe("index-pack abnormal exit");
  });

  it("ignores report-status-v2 option lines", () => {
    const body = concat(
      pkt("unpack ok\n"),
      pkt(`ok ${REF}\n`),
      pkt(`option refname ${REF}\n`),
      pkt(`option new-oid ${NEW_A}\n`),
      FLUSH,
    );
    expect(parseReportStatus(body)).toEqual({
      unpack: "ok",
      refs: [{ ref: REF, ok: true }],
    });
  });

  it("is null for malformed, empty or non-report input", () => {
    expect(parseReportStatus(new Uint8Array(0))).toBeNull();
    expect(parseReportStatus(enc.encode("Permission denied"))).toBeNull();
    expect(parseReportStatus(enc.encode("00ffunpack ok\n"))).toBeNull();
    expect(parseReportStatus(FLUSH)).toBeNull();
    expect(
      parseReportStatus(pkt(concat(Uint8Array.of(1), enc.encode("00")))),
    ).toBeNull();
  });
});
