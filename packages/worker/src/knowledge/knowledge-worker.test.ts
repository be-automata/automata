import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hatchet } from "@hatchet-dev/typescript-sdk";

function fakeHatchetToken(): string {
  const enc = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none", typ: "JWT" })}.${enc({
    sub: "tenant-test",
    server_url: "http://localhost:8888",
    grpc_broadcast_address: "localhost:7070",
  })}.sig`;
}
process.env.HATCHET_CLIENT_TOKEN = fakeHatchetToken();
process.env.HATCHET_CLIENT_TLS_STRATEGY = "none";

let kw: typeof import("./knowledge-worker");
beforeAll(async () => {
  kw = await import("./knowledge-worker");
});
afterEach(() => vi.restoreAllMocks());

function fakeHatchet(startImpl: () => Promise<unknown> = async () => {}) {
  const start = vi.fn(startImpl);
  const worker = vi.fn(async () => ({ start }));
  return { hatchet: { worker }, worker, start };
}

describe("knowledgeWorkerOptions", () => {
  it("is the knowledge workflows, the slot count and handleKill false, nothing else", () => {
    const opts = kw.knowledgeWorkerOptions({ slots: 2 });
    expect(Object.keys(opts).sort()).toEqual([
      "handleKill",
      "slots",
      "workflows",
    ]);
    expect(opts.slots).toBe(2);
    expect(opts.handleKill).toBe(false);
    expect(
      opts.workflows.map((w) => (w as unknown as { name: string }).name),
    ).toEqual(["knowledge-reconcile", "knowledge-mirror-purge"]);
    expect(kw.KNOWLEDGE_WORKER_NAME_PREFIX).toBe("automata-knowledge-");
  });
});

describe("startKnowledgeWorker", () => {
  it("creates exactly one worker named by box and starts it", async () => {
    const f = fakeHatchet();
    const log = vi.fn();
    await kw.startKnowledgeWorker({
      hatchet: f.hatchet,
      boxId: "box1",
      env: {},
      log,
    });
    expect(f.worker).toHaveBeenCalledTimes(1);
    const [name, opts] = f.worker.mock.calls[0] as unknown as [
      string,
      { slots: number; handleKill: boolean },
    ];
    expect(name).toBe("automata-knowledge-box1");
    expect(opts.slots).toBe(1);
    expect(opts.handleKill).toBe(false);
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it("an invalid config creates no worker, logs the knob and resolves", async () => {
    const f = fakeHatchet();
    const log = vi.fn();
    await kw.startKnowledgeWorker({
      hatchet: f.hatchet,
      boxId: "box1",
      env: { WORKER_MIRROR_ROOT: "relative" },
      log,
    });
    expect(f.worker).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "[worker-boot] knowledge worker: OFF (config invalid: WORKER_MIRROR_ROOT)",
    );
  });

  it("a rejecting start logs one registration line and resolves", async () => {
    const f = fakeHatchet(async () => {
      throw new TypeError("secret detail");
    });
    const log = vi.fn();
    await expect(
      kw.startKnowledgeWorker({
        hatchet: f.hatchet,
        boxId: "box1",
        env: {},
        log,
      }),
    ).resolves.toBeUndefined();
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes("registration failed"))).toEqual([
      "[worker-boot] knowledge worker: registration failed (TypeError)",
    ]);
    expect(lines.join("\n")).not.toContain("secret detail");
  });

  it("logs config warnings by enum and never the secret", async () => {
    const f = fakeHatchet();
    const log = vi.fn();
    await kw.startKnowledgeWorker({
      hatchet: f.hatchet,
      boxId: "box1",
      env: { KNOWLEDGE_RECONCILE_SECRET: "hunter2" },
      log,
    });
    const lines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(lines).toContain("reconcile_half_configured");
    expect(lines).not.toContain("hunter2");
  });
});

describe("signal path (PD-18 handleKill)", () => {
  type Internal = {
    handle_kill: boolean;
    client: { durableListener: { stop(): Promise<void> } };
    exitGracefully(handleKill: boolean): Promise<void>;
  };
  const internalOf = (w: unknown) => (w as { _internal: Internal })._internal;

  it("the knowledge worker's exit path never calls process.exit; the default worker's does", async () => {
    const hatchet = Hatchet.init();
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    // No engine in a unit test: the shared durable listener has nothing to stop.
    const stubClient = (i: Internal) => {
      i.client.durableListener.stop = async () => {};
    };
    const knowledge = await hatchet.worker(
      "it-knowledge-signal",
      // workflows emptied: registering them needs a live engine.
      { ...kw.knowledgeWorkerOptions({ slots: 1 }), workflows: [] },
    );
    const k = internalOf(knowledge);
    stubClient(k);
    expect(k.handle_kill).toBe(false);
    await k.exitGracefully(k.handle_kill);
    expect(exit).not.toHaveBeenCalled();

    const review = await hatchet.worker("it-review-signal", { workflows: [] });
    const r = internalOf(review);
    stubClient(r);
    expect(r.handle_kill).toBe(true);
    await r.exitGracefully(r.handle_kill);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
