import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CreateSandboxOptions } from "../types";

// Creation-option tests: mock the SDK client and assert the EXACT network
// params passed at daytona.create (#66 §3.7). No real Daytona calls.
const createMock = vi.fn();

vi.mock("@daytonaio/sdk", () => ({
  Daytona: vi.fn(() => ({ create: createMock })),
  Sandbox: class {},
}));
vi.mock("@terragon/sandbox-image", () => ({
  getTemplateIdForSize: vi.fn(() => "snapshot-small"),
}));

import { DaytonaProvider } from "./daytona-provider";

function fakeDaytonaSandbox() {
  return {
    id: "daytona-test-sandbox",
    // setupDaytonaOneTime runs a command through process.executeCommand.
    process: {
      executeCommand: vi.fn(async () => ({ exitCode: 0, result: "" })),
    },
  };
}

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
    sandboxProvider: "daytona",
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

describe("DaytonaProvider egress creation options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMock.mockImplementation(async () => fakeDaytonaSandbox());
    vi.stubEnv("DAYTONA_API_KEY", "test-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects an ip_port-level policy BEFORE creating any sandbox (CIDR list cannot carry system hostnames)", async () => {
    const provider = new DaytonaProvider();
    await expect(
      provider.getOrCreateSandbox(
        null,
        createOptions({
          egressPolicy: {
            level: "ip_port",
            // Real dispatch always merges hostname system entries in.
            allowlist: ["10.0.0.1", "10.0.0.2:8080", "callback.example.com"],
          },
        }),
      ),
    ).rejects.toThrow(/"ip_port" is unsupported on the daytona provider/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("passes domainAllowList for a domain policy", async () => {
    const provider = new DaytonaProvider();
    await provider.getOrCreateSandbox(
      null,
      createOptions({
        egressPolicy: {
          level: "domain",
          allowlist: ["example.com", "*.example.org"],
        },
      }),
    );
    const params = createMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.domainAllowList).toBe("example.com,*.example.org");
    expect(params.networkAllowList).toBeUndefined();
  });

  it("rejects a none-level policy BEFORE creating any sandbox", async () => {
    const provider = new DaytonaProvider();
    await expect(
      provider.getOrCreateSandbox(
        null,
        createOptions({
          egressPolicy: { level: "none", allowlist: ["callback.example.com"] },
        }),
      ),
    ).rejects.toThrow(/"none" is unsupported on the daytona provider/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("passes NO network params when no policy is present (no-regression)", async () => {
    const provider = new DaytonaProvider();
    await provider.getOrCreateSandbox(null, createOptions());
    const params = createMock.mock.calls[0]![0] as Record<string, unknown>;
    expect("networkAllowList" in params).toBe(false);
    expect("domainAllowList" in params).toBe(false);
    expect("networkBlockAll" in params).toBe(false);
  });
});
