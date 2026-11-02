import { beforeAll, describe, expect, it } from "vitest";

// hatchet.workflow()/task() run Hatchet.init() at import, which needs a token.
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
process.env.WORKER_BATTERIES_IMAGE = `ghcr.io/be-automata/automata-batteries@sha256:${"ab".repeat(32)}`;
process.env.WORKER_RUN_MEMORY_MAX = "1500M";

const nameOf = (w: unknown) => (w as { name: string }).name;

let reviewNames: string[];
let knowledgeNames: string[];

beforeAll(async () => {
  const { buildWorkflows } = await import("./registry");
  const { buildKnowledgeWorkflows } = await import("./knowledge/workflow");
  reviewNames = buildWorkflows({ globalMaxRuns: 1, perOrgMaxRuns: 1 }).map(
    nameOf,
  );
  knowledgeNames = buildKnowledgeWorkflows().map(nameOf);
});

describe("workflow registry separation (PD-18)", () => {
  it("the review set is unchanged", () => {
    expect([...reviewNames].sort()).toEqual(
      [
        "agent-run",
        "agent-run-newest",
        "agent-run-strict",
        "agent-run-discard",
        "hello",
      ].sort(),
    );
  });

  it("the knowledge set is exactly the two knowledge workflows", () => {
    expect(knowledgeNames).toEqual([
      "knowledge-reconcile",
      "knowledge-mirror-purge",
    ]);
  });

  it("the two sets are disjoint", () => {
    expect(reviewNames.filter((n) => knowledgeNames.includes(n))).toEqual([]);
  });
});
