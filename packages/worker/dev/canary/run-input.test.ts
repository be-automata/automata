import { describe, expect, it } from "vitest";

import {
  generatePlaneKeyPair,
  type RunSecrets,
} from "@terragon/utils/payload-seal";

import { resolveRunLane } from "../../src/agent-run/run-lane";
import { resolveRunSecrets } from "../../src/agent-run/run-secrets";
import { resolveLocalEngine } from "./engine-guard";
import { CanaryRefusal } from "./github-token";
import {
  buildCanaryRun,
  canaryEgressPolicy,
  sealCanaryInput,
  type CanaryRunArgs,
} from "./run-input";

const BASE: CanaryRunArgs = {
  lane: "task",
  repoFullName: "be-automata/automata-container-canary",
  branch: "main",
  callbackUrl: "https://canary-stub.example.trycloudflare.com",
  orgId: "canary-org",
  policy: "newest-wins",
  prompt: "hi",
  model: "sonnet",
  permissionMode: "allowAll",
  threadId: "11111111-2222-3333-4444-555555555555",
  threadChatId: "chat-1",
};

function jwt(claims: Record<string, unknown>): string {
  const b = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "HS256" })}.${b(claims)}.sig`;
}

describe("canary run input", () => {
  // card: protects=each lane resolves to the worker lane and workflow www would use (task/mention → agent-run, review → policy variant + prKey); fails_when=a canary review runs as a task (no review fence) or hits an unregistered workflow; no_claim=www's settings-row resolution
  it("maps lanes to www's workflow and the worker's lane", () => {
    const task = buildCanaryRun(BASE);
    expect(task.workflowName).toBe("agent-run");
    expect(task.input.workBranch).toBe("automata/task-11111111");
    expect(resolveRunLane(task.input)).toBe("task");

    const mention = buildCanaryRun({
      ...BASE,
      lane: "mention",
      prNumber: 7,
      branch: "feat",
    });
    expect(mention.workflowName).toBe("agent-run");
    expect(resolveRunLane(mention.input)).toBe("pr");

    const review = buildCanaryRun({
      ...BASE,
      lane: "review",
      prNumber: 7,
      branch: "feat",
      baseBranch: "main",
      permissionMode: "review",
    });
    expect(review.workflowName).toBe("agent-run-newest");
    expect(review.input).toMatchObject({
      prKey: "canary-org/be-automata/automata-container-canary/7",
      supersedePolicy: "newest-wins",
      baseBranch: "main",
      reviewAgent: { mode: "classic", commandTimeoutMs: 60000 },
    });
    expect(review.additionalMetadata).toMatchObject({
      lane: "review",
      prNumber: "7",
    });
    expect(resolveRunLane(review.input)).toBe("review");
    expect(() => buildCanaryRun({ ...BASE, lane: "review" })).toThrow(/--pr/);
  });

  // card: protects=the sealed canary input is accepted by the worker's strict resolveRunSecrets and carries no plain-text secret; fails_when=the AAD binding or envelope shape drifts from what the worker unseals; no_claim=the box's real key ring
  it("seals so the worker's resolveRunSecrets unseals it", async () => {
    const { publicKey, privateKey } = await generatePlaneKeyPair("canary-test");
    const run = buildCanaryRun({
      ...BASE,
      egressPolicy: canaryEgressPolicy(BASE.callbackUrl, [
        "registry.npmjs.org",
      ]),
    });
    const secrets: RunSecrets = {
      installationToken: "ghs_canaryInstall0123456789",
      daemonToken: "daemon-canary-0123456789abcdef",
    };
    const wire = await sealCanaryInput(run.input, secrets, publicKey);
    const text = JSON.stringify(wire);
    expect(text).not.toContain(secrets.installationToken);
    expect(text).not.toContain(secrets.daemonToken);
    const { input, secrets: out } = await resolveRunSecrets({
      wire: JSON.parse(text),
      keys: [privateKey],
    });
    expect(out).toEqual(secrets);
    expect(input.egressPolicy).toEqual({
      level: "domain",
      allowlist: [
        "registry.npmjs.org",
        "canary-stub.example.trycloudflare.com",
        "api.anthropic.com",
      ],
    });
  });
});

describe("canary engine guard", () => {
  // card: protects=dispatch only ever triggers the box's own loopback engine; fails_when=a prod engine token (non-loopback claims or env override) is accepted; no_claim=TLS settings
  it("accepts loopback engines and refuses any other", () => {
    const local = jwt({
      grpc_broadcast_address: "127.0.0.1:7077",
      server_url: "http://localhost:8888",
    });
    expect(resolveLocalEngine({ HATCHET_CLIENT_TOKEN: local })).toMatchObject({
      hostPort: "127.0.0.1:7077",
      apiUrl: "http://localhost:8888",
    });
    const prod = jwt({
      grpc_broadcast_address: "engine.example.com:443",
      server_url: "https://engine.example.com",
    });
    expect(() => resolveLocalEngine({ HATCHET_CLIENT_TOKEN: prod })).toThrow(
      CanaryRefusal,
    );
    expect(() =>
      resolveLocalEngine({
        HATCHET_CLIENT_TOKEN: local,
        HATCHET_CLIENT_HOST_PORT: "10.0.0.5:7077",
      }),
    ).toThrow(CanaryRefusal);
    expect(() => resolveLocalEngine({})).toThrow(CanaryRefusal);
  });
});
