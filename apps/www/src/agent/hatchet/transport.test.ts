import { describe, it, vi, beforeEach, expect } from "vitest";
import {
  triggerAgentRun,
  cancelAgentRun,
  getAgentRunStatus,
  POLICY_TO_WORKFLOW,
  workflowNameForPolicy,
  validateRunMetadata,
} from "./transport";
import {
  SUPERSEDE_POLICIES,
  type SupersedePolicy,
} from "@terragon/shared/model/repo-review-settings";

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
    // The v1 stable trigger returns a V1WorkflowRunDetails body; the run id lives
    // at run.metadata.id (NOT a top-level externalId).
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ run: { metadata: { id: "run-123" } } }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await triggerAgentRun(INPUT, CONFIG);
    expect(res.externalId).toBe("run-123");

    const [url, init] = fetchMock.mock.calls[0]!;
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

  it("returns externalId undefined when the response has no run.metadata.id", async () => {
    // A body that isn't the expected V1WorkflowRunDetails shape must not throw —
    // it degrades to undefined (callers ignore it today; #8 will require it later).
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await triggerAgentRun(INPUT, CONFIG);
    expect(res.externalId).toBeUndefined();
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

describe("cancelAgentRun (#8 supersede)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("POSTs the v1 stable tasks/cancel with Bearer auth and the externalIds batch", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await cancelAgentRun(["run-a", "run-b"], CONFIG);

    const [url, init] = fetchMock.mock.calls[0]!;
    // Trailing slash on apiUrl is normalized.
    expect(url).toBe(
      "https://tunnel.example.com/api/v1/stable/tenants/tenant-1/tasks/cancel",
    );
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer secret-token");
    expect(JSON.parse(init.body)).toEqual({ externalIds: ["run-a", "run-b"] });
    vi.unstubAllGlobals();
  });

  it("is a no-op (no fetch) when the externalIds list is empty", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await cancelAgentRun([], CONFIG);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("throws on a non-2xx so the caller can log (supersede stays best-effort)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(cancelAgentRun(["run-a"], CONFIG)).rejects.toThrow(/404/);
    vi.unstubAllGlobals();
  });
});

describe("POLICY_TO_WORKFLOW / workflowNameForPolicy (#125/#127)", () => {
  it("maps every policy in the union — exhaustive, no silent undefined", () => {
    for (const policy of SUPERSEDE_POLICIES) {
      expect(typeof workflowNameForPolicy(policy)).toBe("string");
      expect(workflowNameForPolicy(policy)).toBe(POLICY_TO_WORKFLOW[policy]);
    }
    expect(POLICY_TO_WORKFLOW).toEqual({
      "newest-wins": "agent-run-newest",
      "complete-run-queue": "agent-run-strict",
      "complete-run-discard": "agent-run-discard",
      "app-side": "agent-run",
    });
  });

  it("throws on a policy outside the union (fail-loud)", () => {
    expect(() =>
      workflowNameForPolicy("bogus" as unknown as SupersedePolicy),
    ).toThrow(/Unknown supersede policy: bogus/);
  });

  it("triggerAgentRun with opts sends the variant name + enriched metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ run: { metadata: { id: "r" } } }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await triggerAgentRun(INPUT, CONFIG, {
      workflowName: "agent-run-discard",
      additionalMetadata: { metaVersion: "1", threadId: "thr_1" },
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.workflowName).toBe("agent-run-discard");
    expect(body.additionalMetadata).toEqual({
      metaVersion: "1",
      threadId: "thr_1",
    });
    vi.unstubAllGlobals();
  });
});

describe("validateRunMetadata (#127 AC5)", () => {
  it("accepts ≤12 keys with ≤256-char values", () => {
    const ok = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`k${i}`, "x".repeat(256)]),
    );
    expect(validateRunMetadata(ok)).toBe(ok);
  });
  it("rejects >12 keys", () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: 13 }, (_, i) => [`k${i}`, "v"]),
    );
    expect(() => validateRunMetadata(tooMany)).toThrow(/exceeds 12 keys/);
  });
  it("rejects a value >256 chars", () => {
    expect(() => validateRunMetadata({ a: "x".repeat(257) })).toThrow(
      /exceeds 256 chars/,
    );
  });
});

describe("getAgentRunStatus (#125 C4 sweep reader)", () => {
  it("maps the v1 run status, 404 → NOT_FOUND, other non-2xx throws", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ run: { status: "CANCELLED" } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response("nope", { status: 404 }))
      .mockResolvedValueOnce(new Response("boom", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getAgentRunStatus("r1", CONFIG)).toBe("CANCELLED");
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://tunnel.example.com/api/v1/stable/tenants/tenant-1/workflow-runs/r1",
    );
    expect(await getAgentRunStatus("r2", CONFIG)).toBe("NOT_FOUND");
    await expect(getAgentRunStatus("r3", CONFIG)).rejects.toThrow(/502/);
    vi.unstubAllGlobals();
  });
});
