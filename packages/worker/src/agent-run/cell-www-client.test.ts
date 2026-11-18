import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CellPlanRefusedError,
  CellPlanUnavailableError,
  fetchCellPlan,
  postCellReport,
  postCellRevoke,
  type CellPlanResult,
} from "./cell-www-client";
import type { WwwClientOpts } from "./www-client";

const opts: WwwClientOpts = {
  baseUrl: "https://www.example.com/",
  daemonToken: "daemon-token-abc",
  threadId: "thread-1",
  threadChatId: "chat-1",
};
const BODY = {
  worker: "w-1-abcd1234",
  epoch: "1",
  requestId: "req_0123456789abcdef",
};
const noSleep = async () => {};

function res(status: number, body: unknown = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function plan(attempt: number, tagAttempt = String(attempt)) {
  return {
    attempt,
    plan: {
      provider: "opensandbox",
      runtime: "runc",
      tags: { automata: "cell", attempt: tagAttempt, stepKey: "cell-k" },
      vault: [{ credential: "VAULT-CANARY" }],
    },
  };
}

/** A recorded fetch that serves the given outcomes in order (an Error means a dropped connection). */
function server(outcomes: (Response | Error)[]) {
  const calls: {
    url: string;
    body: Record<string, unknown>;
    headers: Record<string, string>;
  }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({
      url,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      headers: init.headers as Record<string, string>,
    });
    const next = outcomes.length > 1 ? outcomes.shift()! : outcomes[0]!;
    if (next instanceof Error) throw next;
    return next.clone();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

afterEach(() => vi.restoreAllMocks());

describe("fetchCellPlan", () => {
  // card: protects=a 200 plan returns the SERVER's attempt and the plan; fails_when=the attempt is dropped or the request carries an attempt; no_claim=the plan's contents
  it("returns the attempt and plan, and the body carries no attempt", async () => {
    const s = server([res(200, plan(7))]);
    const out = await fetchCellPlan(opts, BODY, {
      fetch: s.fetchImpl,
      sleep: noSleep,
    });
    expect(out).toMatchObject({ ok: true, attempt: 7 });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toBe(
      "https://www.example.com/api/daemon/cell-plan",
    );
    expect(s.calls[0]!.body).toEqual({
      threadId: "thread-1",
      threadChatId: "chat-1",
      ...BODY,
    });
    expect(s.calls[0]!.headers["x-daemon-token"]).toBe("daemon-token-abc");
  });

  // card: protects=each of the 15 refusal codes is final and carried as is, with one request; fails_when=a refusal is retried, loses its code or reaches unavailable; no_claim=www emitting only these
  it.each([
    ["invalid_body", 400],
    ["cells_disabled", 404],
    ["no_run_key", 403],
    ["invalid_run_key", 403],
    ["org_required", 403],
    ["invalid_deployment_tag", 409],
    ["agent_not_supported", 422],
    ["thread_terminal", 409],
    ["unknown_profile", 409],
    ["egress_not_enforced", 409],
    ["work_branch_unresolved", 409],
    ["no_model_credential", 422],
    ["step_done", 409],
    ["conflict", 409],
    ["attempt_limit", 409],
  ])("T-REFUSED: %s (%i) is final", async (code, status) => {
    const s = server([res(status, { error: code })]);
    const out = await fetchCellPlan(opts, BODY, {
      fetch: s.fetchImpl,
      sleep: noSleep,
    });
    expect(out).toEqual({ ok: false, code, status });
    expect(s.calls).toHaveLength(1);
  });

  // card: protects=a dropped connection and a 502 retry under the SAME request id, then a 200; fails_when=the id changes or the try count is wrong; no_claim=a redelivery's new id (workflow level)
  it("T-REPLAY: transport error, 502, 200 -> three requests, one id", async () => {
    const s = server([new Error("ECONNRESET"), res(502), res(200, plan(2))]);
    const out = await fetchCellPlan(opts, BODY, {
      fetch: s.fetchImpl,
      sleep: noSleep,
    });
    expect(out.ok).toBe(true);
    expect(s.calls.map((c) => c.body.requestId)).toEqual([
      BODY.requestId,
      BODY.requestId,
      BODY.requestId,
    ]);
  });

  // card: protects=exhausting the three tries on 5xx is cell_plan_unavailable; fails_when=it loops longer or answers a refusal; no_claim=www recovery
  it("T-REPLAY: three 503s -> cell_plan_unavailable", async () => {
    const s = server([res(503)]);
    const out = await fetchCellPlan(opts, BODY, {
      fetch: s.fetchImpl,
      sleep: noSleep,
    });
    expect(out).toEqual({
      ok: false,
      code: "cell_plan_unavailable",
      status: 503,
    });
    expect(s.calls).toHaveLength(3);
  });

  // card: protects=409 superseded retries with the same id and a later 200 wins; three of them are cell_plan_superseded with no plan; fails_when=superseded is final at once or the id changes; no_claim=the mint's server side
  it("T-SUPERSEDED: retry the same id; exhaustion is cell_plan_superseded; thread_terminal is final", async () => {
    const ok = server([res(409, { error: "superseded" }), res(200, plan(3))]);
    expect(
      (await fetchCellPlan(opts, BODY, { fetch: ok.fetchImpl, sleep: noSleep }))
        .ok,
    ).toBe(true);
    expect(new Set(ok.calls.map((c) => c.body.requestId)).size).toBe(1);

    const bad = server([res(409, { error: "superseded" })]);
    expect(
      await fetchCellPlan(opts, BODY, { fetch: bad.fetchImpl, sleep: noSleep }),
    ).toEqual({ ok: false, code: "cell_plan_superseded", status: 409 });
    expect(bad.calls).toHaveLength(3);

    const final = server([res(409, { error: "thread_terminal" })]);
    await fetchCellPlan(opts, BODY, { fetch: final.fetchImpl, sleep: noSleep });
    expect(final.calls).toHaveLength(1);
  });

  // card: protects=an attempt that disagrees with plan.tags.attempt, a bad range or a non-opensandbox provider is cell_plan_mismatch; fails_when=any is accepted; no_claim=the plan being usable
  it("T-ATTEMPT: a mismatch is cell_plan_mismatch", async () => {
    for (const body of [
      plan(7, "8"),
      plan(0, "0"),
      plan(1001, "1001"),
      { ...plan(2), plan: { ...plan(2).plan, provider: "gondolin" } },
      { attempt: "2", plan: plan(2).plan },
      { attempt: 2 },
    ]) {
      const s = server([res(200, body)]);
      expect(
        await fetchCellPlan(opts, BODY, { fetch: s.fetchImpl, sleep: noSleep }),
      ).toMatchObject({ ok: false, code: "cell_plan_mismatch" });
    }
  });

  // card: protects=a response over 256 KiB is refused; fails_when=an oversized body is parsed; no_claim=memory use of the runtime
  it("refuses a response over the 256 KiB cap", async () => {
    const huge = { ...plan(1), pad: "x".repeat(300 * 1024) };
    const s = server([res(200, huge)]);
    expect(
      await fetchCellPlan(opts, BODY, { fetch: s.fetchImpl, sleep: noSleep }),
    ).toMatchObject({ ok: false, code: "cell_plan_mismatch" });
  });

  // card: protects=a daemon-token 401 is confirmed before it refuses and a blip then 200 passes; fails_when=a single 401 refuses; no_claim=token validity
  it("confirms a 401 before refusing, and a blip recovers", async () => {
    const blip = server([
      res(401, { error: "Unauthorized" }),
      res(200, plan(1)),
    ]);
    expect(
      (
        await fetchCellPlan(opts, BODY, {
          fetch: blip.fetchImpl,
          sleep: noSleep,
        })
      ).ok,
    ).toBe(true);
    const dead = server([res(401, { error: "Unauthorized" })]);
    const out = await fetchCellPlan(opts, BODY, {
      fetch: dead.fetchImpl,
      sleep: noSleep,
    });
    expect(out).toMatchObject({ ok: false, status: 401 });
    expect(dead.calls).toHaveLength(3);
  });

  // card: protects=the refusal errors are NonRetryable with a message of code and status only; fails_when=a body fragment or the request id reaches a message; no_claim=logs elsewhere
  it("the errors carry the code and status only", () => {
    const e = new CellPlanRefusedError("no_model_credential", 422);
    expect(e.message).toBe("cell plan refused: no_model_credential (HTTP 422)");
    const u = new CellPlanUnavailableError("cell_plan_unavailable", 503);
    expect(u.message).toBe("cell_plan_unavailable (HTTP 503)");
  });

  // card: protects=the plan, its vault and the request id are never logged by the client; fails_when=a log line carries the canary; no_claim=callers' logs
  it("logs nothing of the plan", async () => {
    const spies = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ];
    const s = server([res(200, plan(1))]);
    await fetchCellPlan(opts, BODY, { fetch: s.fetchImpl, sleep: noSleep });
    for (const spy of spies)
      expect(JSON.stringify(spy.mock.calls)).not.toContain("CANARY");
  });
});

const live = () => new AbortController().signal;

describe("postCellRevoke / postCellReport", () => {
  // card: protects=the revoke body and the revoked flag; fails_when=the body differs from {threadId, threadChatId, action, attempt}; no_claim=www semantics
  it("sends the exact revoke body and reports revoked", async () => {
    const s = server([res(200, { ok: true, revoked: true })]);
    const out = await postCellRevoke(opts, 7, live(), {
      fetch: s.fetchImpl,
      sleep: noSleep,
    });
    expect(out).toEqual({ result: "ok", revoked: true });
    expect(s.calls[0]!.body).toEqual({
      threadId: "thread-1",
      threadChatId: "chat-1",
      action: "revoke",
      attempt: 7,
    });
    expect(s.calls[0]!.url).toBe(
      "https://www.example.com/api/daemon/cell-teardown",
    );
  });

  // card: protects=the confirming revoke retries 502, 502, 200; four failures fail; 401s end unauthorized; fails_when=the hook gives up early or retries a final 4xx; no_claim=the loop's use of it
  it("T-CONFIRM-RETRY: 502, 502, 200 -> ok; four transport failures -> failed; 401 -> unauthorized", async () => {
    const retry = { tries: 4, backoffMs: [1000, 2000, 4000] };
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    const ok = server([
      res(502),
      res(502),
      res(200, { ok: true, revoked: false }),
    ]);
    expect(
      await postCellRevoke(opts, 3, live(), {
        fetch: ok.fetchImpl,
        sleep,
        retry,
      }),
    ).toEqual({ result: "ok", revoked: false });
    expect(sleeps).toEqual([1000, 2000]);

    const dead = server([new Error("down")]);
    expect(
      await postCellRevoke(opts, 3, live(), {
        fetch: dead.fetchImpl,
        sleep: noSleep,
        retry,
      }),
    ).toEqual({ result: "failed" });
    expect(dead.calls).toHaveLength(4);

    const gone = server([res(401, {})]);
    expect(
      await postCellRevoke(opts, 3, live(), {
        fetch: gone.fetchImpl,
        sleep: noSleep,
        retry,
      }),
    ).toEqual({ result: "unauthorized" });

    const bad = server([res(400, {})]);
    expect(
      await postCellRevoke(opts, 3, live(), {
        fetch: bad.fetchImpl,
        sleep: noSleep,
      }),
    ).toEqual({ result: "failed" });
    expect(bad.calls).toHaveLength(1);
  });

  // card: protects=an already-aborted deadline sends nothing; fails_when=a call goes out after the deadline; no_claim=in-flight cancellation
  it("sends nothing once the deadline has aborted", async () => {
    const s = server([res(200)]);
    const ac = new AbortController();
    ac.abort();
    expect(
      await postCellRevoke(opts, 1, ac.signal, { fetch: s.fetchImpl }),
    ).toEqual({
      result: "failed",
    });
    expect(s.calls).toHaveLength(0);
  });

  // card: protects=the report body is exactly the documented shape and carries no secret; fails_when=an extra key appears; no_claim=www validation
  it("T-REPORT-PAYLOAD: exact bodies for clean and incomplete", async () => {
    const s = server([res(200, { ok: true })]);
    await postCellReport(
      opts,
      7,
      { outcome: "clean" },
      live(),
      { retired: false },
      { fetch: s.fetchImpl, sleep: noSleep },
    );
    await postCellReport(
      opts,
      7,
      { outcome: "incomplete", failedSteps: ["vault", "survivor"] },
      live(),
      { retired: false },
      { fetch: s.fetchImpl, sleep: noSleep },
    );
    expect(s.calls[0]!.body).toEqual({
      threadId: "thread-1",
      threadChatId: "chat-1",
      action: "report",
      attempt: 7,
      outcome: "clean",
    });
    expect(s.calls[1]!.body).toEqual({
      threadId: "thread-1",
      threadChatId: "chat-1",
      action: "report",
      attempt: 7,
      outcome: "incomplete",
      failedSteps: ["vault", "survivor"],
    });
  });

  // card: protects=a report retried after the token was deleted is already_reported with no alert line; a first-send 401 on a run not known retired is failed + report_unauthorized; fails_when=either mapping flips; no_claim=www's delete
  it("T-REPORT-401: already_reported after an earlier send or on a retired run", async () => {
    const warn = vi.fn();
    const afterSend = server([res(500), res(401, {})]);
    expect(
      await postCellReport(
        opts,
        2,
        { outcome: "clean" },
        live(),
        { retired: false },
        { fetch: afterSend.fetchImpl, sleep: noSleep, log: warn },
      ),
    ).toBe("already_reported");
    expect(warn).not.toHaveBeenCalled();

    const retired = server([res(401, {})]);
    expect(
      await postCellReport(
        opts,
        2,
        { outcome: "clean" },
        live(),
        { retired: true },
        { fetch: retired.fetchImpl, sleep: noSleep, log: warn },
      ),
    ).toBe("already_reported");
    expect(retired.calls).toHaveLength(1);

    const unknown = server([res(401, {})]);
    expect(
      await postCellReport(
        opts,
        2,
        { outcome: "clean" },
        live(),
        { retired: false },
        { fetch: unknown.fetchImpl, sleep: noSleep, log: warn },
      ),
    ).toBe("failed");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("report_unauthorized");

    const down = server([res(500)]);
    expect(
      await postCellReport(
        opts,
        2,
        { outcome: "clean" },
        live(),
        { retired: false },
        { fetch: down.fetchImpl, sleep: noSleep },
      ),
    ).toBe("failed");
    expect(down.calls).toHaveLength(2);
  });
});

// A type-level check that the result union is exhaustive for callers.
export const _exhaustive = (r: CellPlanResult): string =>
  r.ok ? "ok" : r.code;
