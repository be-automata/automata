import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CreateSandboxOptions } from "../types";

// Creation-option tests: mock the SDK client and assert the EXACT network
// options passed at Sandbox.create (#66 §3.6) and the credential-broker vault +
// rule wiring (#114). No real E2B calls.
const updateNetworkMock = vi.fn(async (_network: unknown) => {});
const killMock = vi.fn(async () => {});
const setTimeoutMock = vi.fn(async (_ms: number) => {});
vi.mock("@e2b/code-interpreter", () => ({
  Sandbox: {
    create: vi.fn(async () => ({
      sandboxId: "e2b-test-sandbox",
      updateNetwork: updateNetworkMock,
      kill: killMock,
    })),
    connect: vi.fn(async () => ({
      sandboxId: "e2b-test-sandbox",
      // resumeWithRetry probes the sandbox with a command after connect.
      commands: { run: vi.fn(async () => ({ stdout: "hello" })) },
      kill: killMock,
      setTimeout: setTimeoutMock,
    })),
  },
  // E2B Secret vault (#114). `fill` mirrors the real SDK's placeholder format so
  // the injected header value can be asserted exactly.
  Secret: {
    create: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    destroy: vi.fn(async () => true),
    exists: vi.fn(async () => true),
    // #114 §7a: metadata read for the near-expiry throttle. Default = fresh
    // (updatedAt now) so the throttle SKIPS unless a test overrides it.
    getInfo: vi.fn(async (name: string) => ({
      secretId: "sec-1",
      name,
      version: 1,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    fill: vi.fn((name: string) => `\${e2b.secrets.${name}}`),
  },
  // Real SDK error class for the "secret missing" branch of the throttle.
  SecretNotFoundError: class SecretNotFoundError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = "SecretNotFoundError";
    }
  },
}));
vi.mock("@terragon/sandbox-image", () => ({
  getTemplateIdForSize: vi.fn(() => "template-small"),
}));

import { Sandbox, Secret, SecretNotFoundError } from "@e2b/code-interpreter";
import { E2BProvider, e2bBrokerSecretName } from "./e2b-provider";

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

describe("E2BProvider native credential broker (#114)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const e2bBroker = {
    kind: "e2b-native" as const,
    installationToken: "ghs_installation_token_do_not_leak",
    repoFullName: "org/repo",
  };
  const EXPECTED_SECRET = e2bBrokerSecretName("e2b-test-sandbox");
  const EXPECTED_AUTH = `token \${e2b.secrets.${EXPECTED_SECRET}}`;

  it("seeds the vault, then attaches injection rules for BOTH github hosts", async () => {
    const provider = new E2BProvider();
    await provider.getOrCreateSandbox(
      null,
      createOptions({ credentialBroker: e2bBroker }),
    );

    // Vault seeded with the real token (write-only) under the derived name.
    expect(Secret.create).toHaveBeenCalledWith(
      EXPECTED_SECRET,
      e2bBroker.installationToken,
    );

    // Create carries the firewall BASE only (no rules — the secret name is not
    // known until the sandbox exists). Crucially GitHub is NOT reachable in the
    // create window: with no egress policy the base is FULLY CLOSED (deny-all),
    // so there is no window where GitHub is open without its injection rule.
    const [, createOpts] = vi.mocked(Sandbox.create).mock.calls[0]! as [
      string,
      Record<string, any>,
    ];
    expect(createOpts.network.rules).toBeUndefined();
    expect(createOpts.network.allowOut).toEqual([]);
    expect(createOpts.network.denyOut).toEqual(["0.0.0.0/0"]);
    // GitHub is absent from the create-time allowOut.
    expect(createOpts.network.allowOut).not.toContain("github.com");
    expect(createOpts.network.allowOut).not.toContain("api.github.com");

    // updateNetwork opens GitHub `allowOut` AND attaches the injection rules
    // together in ONE atomic call, injecting the PLACEHOLDER header (never the
    // raw token) for both hosts — GitHub egress and its rule arrive together.
    expect(updateNetworkMock).toHaveBeenCalledTimes(1);
    const net = updateNetworkMock.mock.calls[0]![0] as any;
    expect(net.allowOut).toEqual(["0.0.0.0/0", "github.com", "api.github.com"]);
    expect(net.rules["github.com"]).toEqual([
      { transform: { headers: { Authorization: EXPECTED_AUTH } } },
    ]);
    expect(net.rules["api.github.com"]).toEqual([
      { transform: { headers: { Authorization: EXPECTED_AUTH } } },
    ]);
    // The raw token is NEVER in the network payload.
    expect(JSON.stringify(net)).not.toContain(e2bBroker.installationToken);
  });

  it("composes the broker rules with a per-repo egress policy WITHOUT clobbering it", async () => {
    const provider = new E2BProvider();
    await provider.getOrCreateSandbox(
      null,
      createOptions({
        credentialBroker: e2bBroker,
        egressPolicy: {
          level: "domain",
          allowlist: ["registry.npmjs.org", "example.com"],
        },
      }),
    );
    // Create base: deny-all + the repo allowlist, but GitHub is HELD BACK until
    // the rules attach (no window where GitHub is open without injection). The
    // repo allowlist is preserved (composition, not clobber).
    const [, createOpts] = vi.mocked(Sandbox.create).mock.calls[0]! as [
      string,
      Record<string, any>,
    ];
    expect(createOpts.network.denyOut).toEqual(["0.0.0.0/0"]);
    expect(createOpts.network.allowOut).toEqual([
      "registry.npmjs.org",
      "example.com",
    ]);
    expect(createOpts.network.allowOut).not.toContain("github.com");
    expect(createOpts.network.allowOut).not.toContain("api.github.com");
    // updateNetwork restores the full composition (repo allowlist + GitHub) and
    // adds the rules — GitHub allowOut and its rules arrive together.
    const net = updateNetworkMock.mock.calls[0]![0] as any;
    expect(net.denyOut).toEqual(["0.0.0.0/0"]);
    expect(net.allowOut).toEqual([
      "registry.npmjs.org",
      "example.com",
      "github.com",
      "api.github.com",
    ]);
    expect(Object.keys(net.rules).sort()).toEqual([
      "api.github.com",
      "github.com",
    ]);
  });

  it("fails closed: destroys the secret and kills the guest if rule attach throws", async () => {
    updateNetworkMock.mockRejectedValueOnce(new Error("transform plan denied"));
    const provider = new E2BProvider();
    await expect(
      provider.getOrCreateSandbox(
        null,
        createOptions({ credentialBroker: e2bBroker }),
      ),
    ).rejects.toThrow(/transform plan denied/);
    expect(Secret.destroy).toHaveBeenCalledWith(EXPECTED_SECRET);
    expect(killMock).toHaveBeenCalledTimes(1);
  });

  it("teardown (session.shutdown) destroys the vault secret", async () => {
    const provider = new E2BProvider();
    const session = await provider.getOrCreateSandbox(
      null,
      createOptions({ credentialBroker: e2bBroker }),
    );
    await session.shutdown();
    expect(killMock).toHaveBeenCalled();
    expect(Secret.destroy).toHaveBeenCalledWith(EXPECTED_SECRET);
  });

  it("resume REFRESHES the vault secret with the fresh token (rules persist)", async () => {
    const provider = new E2BProvider();
    await provider.getOrCreateSandbox(
      "e2b-test-sandbox",
      createOptions({
        credentialBroker: e2bBroker,
        credentialBrokerMode: "brokered",
      }),
    );
    expect(Secret.exists).toHaveBeenCalledWith(EXPECTED_SECRET);
    expect(Secret.update).toHaveBeenCalledWith(
      EXPECTED_SECRET,
      e2bBroker.installationToken,
    );
    // Rules persist across pause — no re-attach on resume.
    expect(updateNetworkMock).not.toHaveBeenCalled();
  });

  it("resume re-creates the vault secret if it is somehow gone", async () => {
    vi.mocked(Secret.exists).mockResolvedValueOnce(false);
    const provider = new E2BProvider();
    await provider.getOrCreateSandbox(
      "e2b-test-sandbox",
      createOptions({
        credentialBroker: e2bBroker,
        credentialBrokerMode: "brokered",
      }),
    );
    expect(Secret.update).not.toHaveBeenCalled();
    expect(Secret.create).toHaveBeenCalledWith(
      EXPECTED_SECRET,
      e2bBroker.installationToken,
    );
  });

  it("resume refreshes the vault secret BEFORE connecting (ordering)", async () => {
    const provider = new E2BProvider();
    await provider.getOrCreateSandbox(
      "e2b-test-sandbox",
      createOptions({
        credentialBroker: e2bBroker,
        credentialBrokerMode: "brokered",
      }),
    );
    // The refresh must complete before the guest is auto-resumed by connect —
    // otherwise the guest briefly runs on the prior credential.
    const updateOrder = vi.mocked(Secret.update).mock.invocationCallOrder[0]!;
    const connectOrder = vi.mocked(Sandbox.connect).mock
      .invocationCallOrder[0]!;
    expect(updateOrder).toBeLessThan(connectOrder);
  });

  it("resume fails closed: does NOT connect and throws if the vault refresh throws", async () => {
    // With refresh-before-connect, a refresh failure must mean the guest is
    // NEVER resumed — the sandbox stays paused rather than running on a possibly
    // revoked/rotated credential.
    vi.mocked(Secret.update).mockRejectedValueOnce(new Error("vault 503"));
    const provider = new E2BProvider();
    await expect(
      provider.getOrCreateSandbox(
        "e2b-test-sandbox",
        createOptions({
          credentialBroker: e2bBroker,
          credentialBrokerMode: "brokered",
        }),
      ),
    ).rejects.toThrow(/vault 503/);
    // Fail closed: never connected (so never auto-resumed), never killed. The
    // sandbox stays paused with whatever token was vaulted.
    expect(Sandbox.connect).not.toHaveBeenCalled();
    expect(killMock).not.toHaveBeenCalled();
  });

  it("teardown destroys the vault secret even when kill() rejects", async () => {
    const provider = new E2BProvider();
    const session = await provider.getOrCreateSandbox(
      null,
      createOptions({ credentialBroker: e2bBroker }),
    );
    // kill() throwing must NOT orphan the vault secret.
    killMock.mockRejectedValueOnce(new Error("kill boom"));
    await expect(session.shutdown()).rejects.toThrow(/kill boom/);
    // Destroy still ran (sequenced in a finally), so no secret is leaked.
    expect(Secret.destroy).toHaveBeenCalledWith(EXPECTED_SECRET);
  });

  it("resume fails closed when brokered provenance has no shape to refresh from", async () => {
    const provider = new E2BProvider();
    await expect(
      provider.getOrCreateSandbox(
        "e2b-test-sandbox",
        createOptions({ credentialBrokerMode: "brokered" }),
      ),
    ).rejects.toThrow(/missing the broker shape/);
    expect(Secret.update).not.toHaveBeenCalled();
  });

  it("a resumed brokered session destroys its secret on shutdown", async () => {
    const provider = new E2BProvider();
    const session = await provider.getOrCreateSandbox(
      "e2b-test-sandbox",
      createOptions({
        credentialBroker: e2bBroker,
        credentialBrokerMode: "brokered",
      }),
    );
    await session.shutdown();
    expect(Secret.destroy).toHaveBeenCalledWith(EXPECTED_SECRET);
  });

  it("shutdownById kills the guest BEFORE destroying the secret (ordering)", async () => {
    const provider = new E2BProvider();
    await provider.shutdownById!("e2b-test-sandbox");
    expect(Secret.destroy).toHaveBeenCalledWith(EXPECTED_SECRET);
    expect(killMock).toHaveBeenCalledTimes(1);
    // Kill must precede destroy: connect auto-resumes the guest, so destroying
    // the secret first would briefly resume it with rules pointing at a deleted
    // secret.
    const killOrder = killMock.mock.invocationCallOrder[0]!;
    const destroyOrder = vi.mocked(Secret.destroy).mock.invocationCallOrder[0]!;
    expect(killOrder).toBeLessThan(destroyOrder);
  });

  it("shutdownById still destroys the secret in finally when kill() rejects", async () => {
    killMock.mockRejectedValueOnce(new Error("kill boom"));
    const provider = new E2BProvider();
    // shutdownById swallows the kill error (best-effort force teardown).
    await provider.shutdownById!("e2b-test-sandbox");
    expect(Secret.destroy).toHaveBeenCalledWith(EXPECTED_SECRET);
  });

  it("teardown retries Secret.destroy once, then WARNs if it still fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Both attempts fail — the secret cannot be reclaimed, so we must WARN loudly
    // (naming the secret) rather than silently orphan it.
    vi.mocked(Secret.destroy)
      .mockRejectedValueOnce(new Error("destroy 500"))
      .mockRejectedValueOnce(new Error("destroy 500 again"));
    const provider = new E2BProvider();
    const session = await provider.getOrCreateSandbox(
      null,
      createOptions({ credentialBroker: e2bBroker }),
    );
    await session.shutdown();
    // Retried once (2 total attempts).
    expect(Secret.destroy).toHaveBeenCalledTimes(2);
    // A WARN naming the orphaned secret was emitted.
    const warnedAboutOrphan = warnSpy.mock.calls.some((args) =>
      args.some(
        (a) =>
          typeof a === "string" &&
          a.includes(EXPECTED_SECRET) &&
          /orphan/i.test(a),
      ),
    );
    expect(warnedAboutOrphan).toBe(true);
    warnSpy.mockRestore();
  });

  it("teardown Secret.destroy succeeds on the retry after one failure", async () => {
    vi.mocked(Secret.destroy).mockRejectedValueOnce(new Error("transient"));
    const provider = new E2BProvider();
    const session = await provider.getOrCreateSandbox(
      null,
      createOptions({ credentialBroker: e2bBroker }),
    );
    await session.shutdown();
    // First failed, second (retry) succeeded — 2 attempts, no throw.
    expect(Secret.destroy).toHaveBeenCalledTimes(2);
  });

  it("flag-off create is byte-identical to today: no Secret + no network", async () => {
    const provider = new E2BProvider();
    await provider.getOrCreateSandbox(null, createOptions());
    expect(Secret.create).not.toHaveBeenCalled();
    expect(updateNetworkMock).not.toHaveBeenCalled();
    const [, createOpts] = vi.mocked(Sandbox.create).mock.calls[0]! as [
      string,
      Record<string, unknown>,
    ];
    expect("network" in createOpts).toBe(false);
  });

  it("non-brokered resume touches no vault secret", async () => {
    const provider = new E2BProvider();
    await provider.getOrCreateSandbox(
      "e2b-test-sandbox",
      createOptions({ credentialBrokerMode: "legacy-direct" }),
    );
    expect(Secret.exists).not.toHaveBeenCalled();
    expect(Secret.update).not.toHaveBeenCalled();
    expect(Secret.create).not.toHaveBeenCalled();
  });
});

// #114 §7a: the SECONDARY connect paths (keepalive extendLife, admin-view
// getSandboxOrNull) now rotate the brokered vault secret BEFORE connect, but
// NEAR-EXPIRY THROTTLED so frequent keepalives don't mint a token every call.
describe("E2BProvider secondary connect paths — throttled broker refresh (#114 §7a)", () => {
  const SANDBOX_ID = "e2b-test-sandbox";
  const SECRET = e2bBrokerSecretName(SANDBOX_ID);
  const FRESH_TOKEN = "ghs_fresh_installation_token";

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset getInfo to the default (fresh) after clearAllMocks wipes impls.
    vi.mocked(Secret.getInfo).mockImplementation(async (name: string) => ({
      secretId: "sec-1",
      name,
      version: 1,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
  });

  const freshMintToken = () => vi.fn(async () => FRESH_TOKEN);

  // ---- extendLife -------------------------------------------------------

  it("extendLife: FRESH secret (<50min) → mintToken NOT called, no Secret.update, still connects", async () => {
    vi.mocked(Secret.getInfo).mockResolvedValueOnce({
      secretId: "sec-1",
      name: SECRET,
      version: 1,
      metadata: {},
      createdAt: new Date(),
      // Updated 10 min ago — well within the ~50min throttle window.
      updatedAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    const mintToken = freshMintToken();
    const provider = new E2BProvider();
    await provider.extendLife(SANDBOX_ID, { mintToken });
    // Lazy: the mint callback is never invoked when the secret is still fresh.
    expect(mintToken).not.toHaveBeenCalled();
    expect(Secret.update).not.toHaveBeenCalled();
    expect(Secret.create).not.toHaveBeenCalled();
    // Keepalive still connects and extends the timeout.
    expect(Sandbox.connect).toHaveBeenCalledWith(SANDBOX_ID);
  });

  it("extendLife: STALE secret (>50min) → mintToken called once, Secret.update BEFORE connect", async () => {
    vi.mocked(Secret.getInfo).mockResolvedValueOnce({
      secretId: "sec-1",
      name: SECRET,
      version: 1,
      metadata: {},
      createdAt: new Date(),
      // Updated 55 min ago — past the throttle window: rotate.
      updatedAt: new Date(Date.now() - 55 * 60 * 1000),
    });
    const mintToken = freshMintToken();
    const provider = new E2BProvider();
    await provider.extendLife(SANDBOX_ID, { mintToken });
    expect(mintToken).toHaveBeenCalledTimes(1);
    expect(Secret.update).toHaveBeenCalledWith(SECRET, FRESH_TOKEN);
    expect(Secret.create).not.toHaveBeenCalled();
    // Rotation must complete before the guest is auto-resumed by connect.
    const updateOrder = vi.mocked(Secret.update).mock.invocationCallOrder[0]!;
    const connectOrder = vi.mocked(Sandbox.connect).mock
      .invocationCallOrder[0]!;
    expect(updateOrder).toBeLessThan(connectOrder);
  });

  it("extendLife: MISSING secret → mintToken called, Secret.create (not update)", async () => {
    vi.mocked(Secret.getInfo).mockRejectedValueOnce(
      new SecretNotFoundError("not found"),
    );
    const mintToken = freshMintToken();
    const provider = new E2BProvider();
    await provider.extendLife(SANDBOX_ID, { mintToken });
    expect(mintToken).toHaveBeenCalledTimes(1);
    expect(Secret.create).toHaveBeenCalledWith(SECRET, FRESH_TOKEN);
    expect(Secret.update).not.toHaveBeenCalled();
  });

  it("extendLife: rotation failure → fail closed (does NOT connect, throws)", async () => {
    vi.mocked(Secret.getInfo).mockResolvedValueOnce({
      secretId: "sec-1",
      name: SECRET,
      version: 1,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(Date.now() - 55 * 60 * 1000),
    });
    vi.mocked(Secret.update).mockRejectedValueOnce(new Error("vault 503"));
    const mintToken = freshMintToken();
    const provider = new E2BProvider();
    await expect(
      provider.extendLife(SANDBOX_ID, { mintToken }),
    ).rejects.toThrow(/vault 503/);
    expect(Sandbox.connect).not.toHaveBeenCalled();
  });

  it("extendLife: no refresh handle → unbrokered behavior (no vault touch, connects)", async () => {
    const provider = new E2BProvider();
    await provider.extendLife(SANDBOX_ID);
    expect(Secret.getInfo).not.toHaveBeenCalled();
    expect(Secret.update).not.toHaveBeenCalled();
    expect(Secret.create).not.toHaveBeenCalled();
    expect(Sandbox.connect).toHaveBeenCalledWith(SANDBOX_ID);
  });

  // ---- getSandboxOrNull -------------------------------------------------

  it("getSandboxOrNull: FRESH secret → mintToken NOT called, connects and returns a session", async () => {
    vi.mocked(Secret.getInfo).mockResolvedValueOnce({
      secretId: "sec-1",
      name: SECRET,
      version: 1,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(Date.now() - 5 * 60 * 1000),
    });
    const mintToken = freshMintToken();
    const provider = new E2BProvider();
    const session = await provider.getSandboxOrNull(SANDBOX_ID, { mintToken });
    expect(session).not.toBeNull();
    expect(mintToken).not.toHaveBeenCalled();
    expect(Secret.update).not.toHaveBeenCalled();
    expect(Sandbox.connect).toHaveBeenCalled();
  });

  it("getSandboxOrNull: STALE secret → mintToken once, Secret.update BEFORE connect", async () => {
    vi.mocked(Secret.getInfo).mockResolvedValueOnce({
      secretId: "sec-1",
      name: SECRET,
      version: 1,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(Date.now() - 90 * 60 * 1000),
    });
    const mintToken = freshMintToken();
    const provider = new E2BProvider();
    await provider.getSandboxOrNull(SANDBOX_ID, { mintToken });
    expect(mintToken).toHaveBeenCalledTimes(1);
    expect(Secret.update).toHaveBeenCalledWith(SECRET, FRESH_TOKEN);
    const updateOrder = vi.mocked(Secret.update).mock.invocationCallOrder[0]!;
    const connectOrder = vi.mocked(Sandbox.connect).mock
      .invocationCallOrder[0]!;
    expect(updateOrder).toBeLessThan(connectOrder);
  });

  it("getSandboxOrNull: rotation failure → fail closed (does NOT connect, returns null)", async () => {
    vi.mocked(Secret.getInfo).mockResolvedValueOnce({
      secretId: "sec-1",
      name: SECRET,
      version: 1,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(Date.now() - 90 * 60 * 1000),
    });
    vi.mocked(Secret.update).mockRejectedValueOnce(new Error("vault down"));
    const mintToken = freshMintToken();
    const provider = new E2BProvider();
    const session = await provider.getSandboxOrNull(SANDBOX_ID, { mintToken });
    expect(session).toBeNull();
    expect(Sandbox.connect).not.toHaveBeenCalled();
  });

  it("getSandboxOrNull: ambiguous getInfo error → fail closed (returns null, no connect)", async () => {
    vi.mocked(Secret.getInfo).mockRejectedValueOnce(new Error("vault 500"));
    const mintToken = freshMintToken();
    const provider = new E2BProvider();
    const session = await provider.getSandboxOrNull(SANDBOX_ID, { mintToken });
    expect(session).toBeNull();
    // Ambiguous freshness must NOT mint or connect.
    expect(mintToken).not.toHaveBeenCalled();
    expect(Sandbox.connect).not.toHaveBeenCalled();
  });

  it("getSandboxOrNull: no refresh handle → unbrokered behavior (no vault touch)", async () => {
    const provider = new E2BProvider();
    await provider.getSandboxOrNull(SANDBOX_ID);
    expect(Secret.getInfo).not.toHaveBeenCalled();
    expect(Secret.update).not.toHaveBeenCalled();
    expect(Secret.create).not.toHaveBeenCalled();
    expect(Sandbox.connect).toHaveBeenCalled();
  });
});
