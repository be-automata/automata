import { describe, it, vi, beforeEach, expect } from "vitest";
import { triggerAgentRun } from "./transport";

const CONFIG = {
  apiUrl: "https://tunnel.example.com/",
  tenantId: "tenant-1",
  apiToken: "secret-token",
};

const INPUT = {
  threadId: "thr_1",
  threadChatId: "tc_1",
  repoFullName: "be-automata/automata",
  branch: "main",
  daemonCallbackUrl: "https://www.example.com",
  installationToken: "inst-tok",
  daemonToken: "daemon-tok",
};

describe("triggerAgentRun (Hatchet REST v1)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("POSTs the v1 stable trigger with Bearer auth and the agent-run envelope", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ externalId: "run-123" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const res = await triggerAgentRun(INPUT, CONFIG);
    expect(res.externalId).toBe("run-123");

    const [url, init] = fetchMock.mock.calls[0];
    // Trailing slash on apiUrl is normalized.
    expect(url).toBe(
      "https://tunnel.example.com/api/v1/stable/tenants/tenant-1/workflow-runs/trigger",
    );
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer secret-token");
    const body = JSON.parse(init.body);
    expect(body.workflowName).toBe("agent-run");
    expect(body.input).toEqual(INPUT);
    expect(body.additionalMetadata).toEqual({
      threadId: "thr_1",
      threadChatId: "tc_1",
    });
    vi.unstubAllGlobals();
  });

  it("throws when the config is not fully set", async () => {
    await expect(
      triggerAgentRun(INPUT, { apiUrl: "", tenantId: "t", apiToken: "x" }),
    ).rejects.toThrow(/HATCHET_API_URL/);
  });

  it("throws on a non-2xx response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(triggerAgentRun(INPUT, CONFIG)).rejects.toThrow(/500/);
    vi.unstubAllGlobals();
  });
});
