import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CreateSandboxOptions } from "../types";

// Creation-option tests: mock the SDK client and assert the EXACT network
// options passed at Sandbox.create (#66 §3.6). No real E2B calls.
vi.mock("@e2b/code-interpreter", () => ({
  Sandbox: {
    create: vi.fn(async () => ({ sandboxId: "e2b-test-sandbox" })),
    connect: vi.fn(async () => ({
      sandboxId: "e2b-test-sandbox",
      // resumeWithRetry probes the sandbox with a command after connect.
      commands: { run: vi.fn(async () => ({ stdout: "hello" })) },
    })),
  },
}));
vi.mock("@terragon/sandbox-image", () => ({
  getTemplateIdForSize: vi.fn(() => "template-small"),
}));

import { Sandbox } from "@e2b/code-interpreter";
import { E2BProvider } from "./e2b-provider";

function createOptions(
  overrides: Partial<CreateSandboxOptions> = {},
): CreateSandboxOptions {
  return {
    threadName: "test",
    agent: null,
    agentCredentials: null,
    userName: "user",
    userEmail: "user@example.com",
    githubAccessToken: "token",
    githubRepoFullName: "org/repo",
    repoBaseBranchName: "main",
    userId: "user-1",
    sandboxProvider: "e2b",
    sandboxSize: "small",
    createNewBranch: true,
    environmentVariables: [{ key: "FOO", value: "bar" }],
    autoUpdateDaemon: false,
    publicUrl: "http://localhost:3000",
    featureFlags: {},
    generateBranchName: async () => null,
    onStatusUpdate: async () => {},
    ...overrides,
  };
}

describe("E2BProvider egress creation options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes deny-all + allowlist network options when a policy is present", async () => {
    const provider = new E2BProvider();
    await provider.getOrCreateSandbox(
      null,
      createOptions({
        egressPolicy: {
          level: "domain",
          allowlist: ["example.com", "*.example.org", "api.example.com:8443"],
        },
      }),
    );
    expect(Sandbox.create).toHaveBeenCalledTimes(1);
    const [templateId, opts] = vi.mocked(Sandbox.create).mock.calls[0]! as [
      string,
      Record<string, unknown>,
    ];
    expect(templateId).toBe("template-small");
    expect(opts.network).toEqual({
      denyOut: ["0.0.0.0/0"],
      // Port pin dropped: E2B selectors are port-less (documented in egress.ts).
      allowOut: ["example.com", "*.example.org", "api.example.com"],
    });
    // v2 lifecycle replaces the old patched autoPause.
    expect(opts.lifecycle).toEqual({ onTimeout: "pause" });
    expect(opts.envs).toMatchObject({ FOO: "bar" });
  });

  it("passes ip_port-level entries through as IPs", async () => {
    const provider = new E2BProvider();
    await provider.getOrCreateSandbox(
      null,
      createOptions({
        egressPolicy: {
          level: "ip_port",
          allowlist: ["10.0.0.1", "10.0.0.2:8080", "10.1.0.0/16"],
        },
      }),
    );
    const [, opts] = vi.mocked(Sandbox.create).mock.calls[0]! as [
      string,
      Record<string, unknown>,
    ];
    expect(opts.network).toEqual({
      denyOut: ["0.0.0.0/0"],
      allowOut: ["10.0.0.1", "10.0.0.2", "10.1.0.0/16"],
    });
  });

  it("passes NO network options when no policy is present (no-regression)", async () => {
    const provider = new E2BProvider();
    await provider.getOrCreateSandbox(null, createOptions());
    const [, opts] = vi.mocked(Sandbox.create).mock.calls[0]! as [
      string,
      Record<string, unknown>,
    ];
    expect("network" in opts).toBe(false);
    expect(opts.lifecycle).toEqual({ onTimeout: "pause" });
  });

  it("resume path uses v2 connect (no network re-negotiation at resume)", async () => {
    const provider = new E2BProvider();
    await provider.getSandboxOrNull("sb-1");
    expect(Sandbox.connect).toHaveBeenCalledWith("sb-1", {
      timeoutMs: expect.any(Number),
    });
    expect(Sandbox.create).not.toHaveBeenCalled();
  });
});
