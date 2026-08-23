import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CreateSandboxOptions } from "../types";

// Creation-option tests: mock the SDK client and assert the EXACT network
// params passed at daytona.create (#66 §3.7) and the credential-broker secret
// wiring (#114). No real Daytona calls.
const createMock = vi.fn();
const getMock = vi.fn();
const secretCreateMock = vi.fn();
const secretUpdateMock = vi.fn();
const secretDeleteMock = vi.fn();
const secretListMock = vi.fn();

vi.mock("@daytonaio/sdk", () => {
  // Defined INSIDE the factory: vi.mock is hoisted above module-body
  // declarations, so a class declared outside would be in its TDZ here. The
  // conflict-upsert branch does `instanceof DaytonaConflictError`, so the test
  // re-imports this exact class below.
  class DaytonaConflictError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = "DaytonaConflictError";
    }
  }
  return {
    Daytona: vi.fn(() => ({
      create: createMock,
      get: getMock,
      secret: {
        create: secretCreateMock,
        update: secretUpdateMock,
        delete: secretDeleteMock,
        list: secretListMock,
      },
    })),
    Sandbox: class {},
    DaytonaConflictError,
  };
});
vi.mock("@terragon/sandbox-image", () => ({
  getTemplateIdForSize: vi.fn(() => "snapshot-small"),
}));

import { DaytonaProvider } from "./daytona-provider";
import { DAYTONA_BROKER_GITHUB_HOSTS } from "../egress";
import { DaytonaConflictError } from "@daytonaio/sdk";

// A fake sandbox usable for BOTH create and resume: it carries everything the
// provider / DaytonaSession touch (id, process, lifecycle, stop/delete).
function fakeDaytonaSandbox(overrides: Record<string, unknown> = {}) {
  return {
    id: "daytona-test-sandbox",
    state: "started",
    // setupDaytonaOneTime runs a command through process.executeCommand.
    process: {
      executeCommand: vi.fn(async () => ({ exitCode: 0, result: "" })),
    },
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    waitUntilStarted: vi.fn(async () => {}),
    waitUntilStopped: vi.fn(async () => {}),
    ...overrides,
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

  it("non-brokered create touches NO secret API and mounts NO secrets map", async () => {
    const provider = new DaytonaProvider();
    await provider.getOrCreateSandbox(null, createOptions());
    expect(secretCreateMock).not.toHaveBeenCalled();
    expect(secretUpdateMock).not.toHaveBeenCalled();
    expect(secretDeleteMock).not.toHaveBeenCalled();
    expect(secretListMock).not.toHaveBeenCalled();
    const params = createMock.mock.calls[0]![0] as Record<string, unknown>;
    expect("secrets" in params).toBe(false);
  });
});

describe("DaytonaProvider native credential broker (#114)", () => {
  const SECRET_NAME = "gh-inst-thread_abc123";
  const SECRET_ID = "sec-123";
  const SANDBOX_ID_FOR_TEARDOWN = "daytona-test-sandbox";
  const daytonaBroker = {
    kind: "daytona-native" as const,
    installationToken: "ghs_installation_token_do_not_leak",
    repoFullName: "org/repo",
    secretName: SECRET_NAME,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    createMock.mockImplementation(async () => fakeDaytonaSandbox());
    getMock.mockImplementation(async () => fakeDaytonaSandbox());
    secretCreateMock.mockImplementation(async () => ({
      id: SECRET_ID,
      name: SECRET_NAME,
      placeholder: `dtn_secret_${SECRET_ID}`,
      updatedAt: new Date().toISOString(),
    }));
    secretUpdateMock.mockImplementation(async () => ({ id: SECRET_ID }));
    secretDeleteMock.mockImplementation(async () => {});
    secretListMock.mockImplementation(async () => ({
      items: [
        {
          id: SECRET_ID,
          name: SECRET_NAME,
          updatedAt: new Date().toISOString(),
        },
      ],
    }));
    vi.stubEnv("DAYTONA_API_KEY", "test-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates the org secret BEFORE the sandbox, mounts it via the secrets map, allowed on both github hosts", async () => {
    const provider = new DaytonaProvider();
    await provider.getOrCreateSandbox(
      null,
      createOptions({ credentialBroker: daytonaBroker }),
    );
    // Secret seeded with the real token (write-only) under the derived name,
    // scoped to the github hosts.
    expect(secretCreateMock).toHaveBeenCalledWith({
      name: SECRET_NAME,
      value: daytonaBroker.installationToken,
      hosts: [...DAYTONA_BROKER_GITHUB_HOSTS],
    });
    // Ordering: the secret must exist before create references it.
    const secretOrder = secretCreateMock.mock.invocationCallOrder[0]!;
    const createOrder = createMock.mock.invocationCallOrder[0]!;
    expect(secretOrder).toBeLessThan(createOrder);
    // The sandbox references the secret by NAME via the secrets map.
    const params = createMock.mock.calls[0]![0] as Record<string, any>;
    expect(params.secrets).toEqual({
      GH_TOKEN: SECRET_NAME,
      GITHUB_TOKEN: SECRET_NAME,
    });
    // The raw token is NEVER in the daytona.create payload (only the secret name).
    expect(JSON.stringify(params)).not.toContain(
      daytonaBroker.installationToken,
    );
  });

  it("strips GH_TOKEN/GITHUB_TOKEN from envVars so the placeholder is authoritative", async () => {
    const provider = new DaytonaProvider();
    await provider.getOrCreateSandbox(
      null,
      createOptions({
        credentialBroker: daytonaBroker,
        environmentVariables: [
          { key: "GH_TOKEN", value: "user-token" },
          { key: "GITHUB_TOKEN", value: "user-token-2" },
          { key: "FOO", value: "bar" },
        ],
      }),
    );
    const params = createMock.mock.calls[0]![0] as Record<string, any>;
    expect(params.envVars.GH_TOKEN).toBeUndefined();
    expect(params.envVars.GITHUB_TOKEN).toBeUndefined();
    expect(params.envVars.FOO).toBe("bar");
  });

  it("create-upsert: on name conflict, lists and UPDATES the existing secret", async () => {
    secretCreateMock.mockRejectedValueOnce(
      new DaytonaConflictError("name exists"),
    );
    const provider = new DaytonaProvider();
    await provider.getOrCreateSandbox(
      null,
      createOptions({ credentialBroker: daytonaBroker }),
    );
    expect(secretListMock).toHaveBeenCalledWith({ name: SECRET_NAME });
    expect(secretUpdateMock).toHaveBeenCalledWith(SECRET_ID, {
      value: daytonaBroker.installationToken,
    });
    // Create still proceeds with the (now-updated) secret.
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed: deletes the secret and does NOT leave a sandbox if create throws", async () => {
    createMock.mockRejectedValue(new Error("create boom"));
    const provider = new DaytonaProvider();
    await expect(
      provider.getOrCreateSandbox(
        null,
        createOptions({ credentialBroker: daytonaBroker }),
      ),
    ).rejects.toThrow(/create boom/);
    // The secret we created is deleted (no orphaned live credential).
    expect(secretDeleteMock).toHaveBeenCalledWith(SECRET_ID);
  });

  it("fails closed: tears the sandbox down (which deletes the secret) if one-time setup throws", async () => {
    const stop = vi.fn(async () => {});
    const del = vi.fn(async () => {});
    createMock.mockImplementation(async () =>
      fakeDaytonaSandbox({
        stop,
        delete: del,
        process: {
          executeCommand: vi.fn(async () => {
            throw new Error("setup boom");
          }),
        },
      }),
    );
    const provider = new DaytonaProvider();
    await expect(
      provider.getOrCreateSandbox(
        null,
        createOptions({ credentialBroker: daytonaBroker }),
      ),
    ).rejects.toThrow(/setup boom/);
    expect(stop).toHaveBeenCalled();
    expect(del).toHaveBeenCalled();
    expect(secretDeleteMock).toHaveBeenCalledWith(SECRET_ID);
  });

  it("teardown (session.shutdown) deletes the org secret", async () => {
    const provider = new DaytonaProvider();
    const session = await provider.getOrCreateSandbox(
      null,
      createOptions({ credentialBroker: daytonaBroker }),
    );
    await session.shutdown();
    expect(secretDeleteMock).toHaveBeenCalledWith(SECRET_ID);
  });

  it("teardown deletes the secret even when stop() rejects (finally)", async () => {
    const stop = vi.fn(async () => {
      throw new Error("stop boom");
    });
    createMock.mockImplementation(async () => fakeDaytonaSandbox({ stop }));
    const provider = new DaytonaProvider();
    const session = await provider.getOrCreateSandbox(
      null,
      createOptions({ credentialBroker: daytonaBroker }),
    );
    await expect(session.shutdown()).rejects.toThrow(/stop boom/);
    // Delete still ran (sequenced in a finally), so no secret is leaked.
    expect(secretDeleteMock).toHaveBeenCalledWith(SECRET_ID);
  });

  it("teardown retries the delete once, then WARNs if it still fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    secretDeleteMock
      .mockRejectedValueOnce(new Error("delete 500"))
      .mockRejectedValueOnce(new Error("delete 500 again"));
    const provider = new DaytonaProvider();
    const session = await provider.getOrCreateSandbox(
      null,
      createOptions({ credentialBroker: daytonaBroker }),
    );
    await session.shutdown();
    expect(secretDeleteMock).toHaveBeenCalledTimes(2);
    const warnedAboutOrphan = warnSpy.mock.calls.some((args) =>
      args.some(
        (a) =>
          typeof a === "string" && a.includes(SECRET_NAME) && /orphan/i.test(a),
      ),
    );
    expect(warnedAboutOrphan).toBe(true);
    warnSpy.mockRestore();
  });

  it("resume REFRESHES the secret value with the fresh token BEFORE resuming", async () => {
    const provider = new DaytonaProvider();
    await provider.getOrCreateSandbox(
      "daytona-test-sandbox",
      createOptions({
        credentialBroker: daytonaBroker,
        credentialBrokerMode: "brokered",
      }),
    );
    // Resume uses the expect-exists path: list → exact match → update (the org
    // Secret persists across pause), NOT create-first — so the common case is 2
    // API round-trips, not 3 (no forced conflict).
    expect(secretListMock).toHaveBeenCalledWith({ name: SECRET_NAME });
    expect(secretUpdateMock).toHaveBeenCalledWith(SECRET_ID, {
      value: daytonaBroker.installationToken,
    });
    expect(secretCreateMock).not.toHaveBeenCalled();
    // The refresh must complete before the guest is resumed (daytona.get/start).
    const updateOrder = secretUpdateMock.mock.invocationCallOrder[0]!;
    const getOrder = getMock.mock.invocationCallOrder[0]!;
    expect(updateOrder).toBeLessThan(getOrder);
  });

  it("resume re-creates the secret when it is gone (list miss → create fallback)", async () => {
    // Secret destroyed out of band: the expect-exists list finds no match, so
    // the refresh falls back to create (re-scoped to the github hosts).
    secretListMock.mockImplementationOnce(async () => ({ items: [] }));
    const provider = new DaytonaProvider();
    await provider.getOrCreateSandbox(
      "daytona-test-sandbox",
      createOptions({
        credentialBroker: daytonaBroker,
        credentialBrokerMode: "brokered",
      }),
    );
    expect(secretCreateMock).toHaveBeenCalledWith({
      name: SECRET_NAME,
      value: daytonaBroker.installationToken,
      hosts: [...DAYTONA_BROKER_GITHUB_HOSTS],
    });
    expect(getMock).toHaveBeenCalled();
  });

  it("resume fails closed: does NOT resume and throws if the secret refresh throws", async () => {
    // Expect-exists path: the update on the existing secret throws → propagates.
    secretUpdateMock.mockRejectedValueOnce(new Error("secret 503"));
    const provider = new DaytonaProvider();
    await expect(
      provider.getOrCreateSandbox(
        "daytona-test-sandbox",
        createOptions({
          credentialBroker: daytonaBroker,
          credentialBrokerMode: "brokered",
        }),
      ),
    ).rejects.toThrow(/secret 503/);
    // Fail closed: never resumed.
    expect(getMock).not.toHaveBeenCalled();
  });

  it("resume fails closed when brokered provenance has no shape to refresh from", async () => {
    const provider = new DaytonaProvider();
    await expect(
      provider.getOrCreateSandbox(
        "daytona-test-sandbox",
        createOptions({ credentialBrokerMode: "brokered" }),
      ),
    ).rejects.toThrow(/missing the broker shape/);
    expect(secretCreateMock).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
  });

  it("a resumed brokered session deletes its secret on shutdown", async () => {
    const provider = new DaytonaProvider();
    const session = await provider.getOrCreateSandbox(
      "daytona-test-sandbox",
      createOptions({
        credentialBroker: daytonaBroker,
        credentialBrokerMode: "brokered",
      }),
    );
    await session.shutdown();
    expect(secretDeleteMock).toHaveBeenCalledWith(SECRET_ID);
  });

  it("non-brokered resume touches no secret API", async () => {
    const provider = new DaytonaProvider();
    await provider.getOrCreateSandbox(
      "daytona-test-sandbox",
      createOptions({ credentialBrokerMode: "legacy-direct" }),
    );
    expect(secretCreateMock).not.toHaveBeenCalled();
    expect(secretUpdateMock).not.toHaveBeenCalled();
    expect(secretListMock).not.toHaveBeenCalled();
    expect(getMock).toHaveBeenCalled();
  });

  // shutdownById: force-destroy by id WITHOUT reviving the guest, deleting the
  // (thread-derived) org secret so a by-id teardown of a fresh/unmarked session
  // never orphans the token-holding secret.
  it("shutdownById deletes the sandbox by id WITHOUT starting/resuming it", async () => {
    const start = vi.fn(async () => {});
    const del = vi.fn(async () => {});
    getMock.mockImplementation(async () =>
      fakeDaytonaSandbox({ start, delete: del }),
    );
    const provider = new DaytonaProvider();
    await provider.shutdownById!(SANDBOX_ID_FOR_TEARDOWN, SECRET_NAME);
    expect(getMock).toHaveBeenCalledWith(SANDBOX_ID_FOR_TEARDOWN);
    expect(del).toHaveBeenCalledTimes(1);
    // Never revived: no start/resume of the paused guest.
    expect(start).not.toHaveBeenCalled();
  });

  it("shutdownById deletes the org secret (list → delete by matched id) when a name is given", async () => {
    secretListMock.mockImplementation(async () => ({
      items: [
        {
          id: SECRET_ID,
          name: SECRET_NAME,
          updatedAt: new Date().toISOString(),
        },
      ],
    }));
    const provider = new DaytonaProvider();
    await provider.shutdownById!(SANDBOX_ID_FOR_TEARDOWN, SECRET_NAME);
    expect(secretListMock).toHaveBeenCalledWith({ name: SECRET_NAME });
    expect(secretDeleteMock).toHaveBeenCalledWith(SECRET_ID);
  });

  it("shutdownById is a no-op on the secret when NO name is given (E2B/Docker/non-brokered)", async () => {
    const del = vi.fn(async () => {});
    getMock.mockImplementation(async () => fakeDaytonaSandbox({ delete: del }));
    const provider = new DaytonaProvider();
    await provider.shutdownById!(SANDBOX_ID_FOR_TEARDOWN);
    expect(del).toHaveBeenCalledTimes(1);
    // Guest destroyed, but the secret API is never touched without a name.
    expect(secretListMock).not.toHaveBeenCalled();
    expect(secretDeleteMock).not.toHaveBeenCalled();
  });

  it("shutdownById is best-effort: does NOT reject if the secret delete throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    secretListMock.mockImplementation(async () => ({
      items: [
        {
          id: SECRET_ID,
          name: SECRET_NAME,
          updatedAt: new Date().toISOString(),
        },
      ],
    }));
    // Both attempts fail — retry-then-WARN, never throws.
    secretDeleteMock
      .mockRejectedValueOnce(new Error("delete 500"))
      .mockRejectedValueOnce(new Error("delete 500 again"));
    const provider = new DaytonaProvider();
    await expect(
      provider.shutdownById!(SANDBOX_ID_FOR_TEARDOWN, SECRET_NAME),
    ).resolves.toBeUndefined();
    expect(secretDeleteMock).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("shutdownById still deletes the secret in finally when the guest delete throws", async () => {
    getMock.mockImplementation(async () =>
      fakeDaytonaSandbox({
        delete: vi.fn(async () => {
          throw new Error("guest delete boom");
        }),
      }),
    );
    secretListMock.mockImplementation(async () => ({
      items: [
        {
          id: SECRET_ID,
          name: SECRET_NAME,
          updatedAt: new Date().toISOString(),
        },
      ],
    }));
    const provider = new DaytonaProvider();
    // A guest-delete throw is swallowed (best-effort force teardown) and the
    // secret is still deleted (finally).
    await expect(
      provider.shutdownById!(SANDBOX_ID_FOR_TEARDOWN, SECRET_NAME),
    ).resolves.toBeUndefined();
    expect(secretDeleteMock).toHaveBeenCalledWith(SECRET_ID);
  });
});

// #114 §7a: the SECONDARY connect paths (keepalive extendLife, admin-view
// getSandboxOrNull) rotate the brokered org secret BEFORE resume, near-expiry
// THROTTLED so frequent keepalives don't mint a token every call.
describe("DaytonaProvider secondary connect paths — throttled broker refresh (#114 §7a)", () => {
  const SANDBOX_ID = "daytona-test-sandbox";
  const SECRET_NAME = "gh-inst-thread_abc123";
  const SECRET_ID = "sec-123";
  const FRESH_TOKEN = "ghs_fresh_installation_token";

  beforeEach(() => {
    vi.clearAllMocks();
    getMock.mockImplementation(async () => fakeDaytonaSandbox());
    secretUpdateMock.mockImplementation(async () => ({ id: SECRET_ID }));
    secretCreateMock.mockImplementation(async () => ({ id: SECRET_ID }));
    vi.stubEnv("DAYTONA_API_KEY", "test-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const freshMintToken = () => vi.fn(async () => FRESH_TOKEN);
  const listReturns = (updatedAt: Date) =>
    secretListMock.mockImplementation(async () => ({
      items: [
        {
          id: SECRET_ID,
          name: SECRET_NAME,
          updatedAt: updatedAt.toISOString(),
        },
      ],
    }));

  // ---- extendLife -------------------------------------------------------

  it("extendLife: FRESH secret (<50min) → mintToken NOT called, no update, still resumes", async () => {
    listReturns(new Date(Date.now() - 10 * 60 * 1000));
    const mintToken = freshMintToken();
    const provider = new DaytonaProvider();
    await provider.extendLife(SANDBOX_ID, {
      mintToken,
      secretName: SECRET_NAME,
    });
    expect(mintToken).not.toHaveBeenCalled();
    expect(secretUpdateMock).not.toHaveBeenCalled();
    expect(secretCreateMock).not.toHaveBeenCalled();
    expect(getMock).toHaveBeenCalled();
  });

  it("extendLife: STALE secret (>50min) → mintToken once, update BEFORE resume", async () => {
    listReturns(new Date(Date.now() - 55 * 60 * 1000));
    const mintToken = freshMintToken();
    const provider = new DaytonaProvider();
    await provider.extendLife(SANDBOX_ID, {
      mintToken,
      secretName: SECRET_NAME,
    });
    expect(mintToken).toHaveBeenCalledTimes(1);
    expect(secretUpdateMock).toHaveBeenCalledWith(SECRET_ID, {
      value: FRESH_TOKEN,
    });
    const updateOrder = secretUpdateMock.mock.invocationCallOrder[0]!;
    const getOrder = getMock.mock.invocationCallOrder[0]!;
    expect(updateOrder).toBeLessThan(getOrder);
  });

  it("extendLife: MISSING secret → mintToken called, create (not update)", async () => {
    secretListMock.mockImplementation(async () => ({ items: [] }));
    const mintToken = freshMintToken();
    const provider = new DaytonaProvider();
    await provider.extendLife(SANDBOX_ID, {
      mintToken,
      secretName: SECRET_NAME,
    });
    expect(mintToken).toHaveBeenCalledTimes(1);
    expect(secretCreateMock).toHaveBeenCalledWith({
      name: SECRET_NAME,
      value: FRESH_TOKEN,
      hosts: [...DAYTONA_BROKER_GITHUB_HOSTS],
    });
    expect(secretUpdateMock).not.toHaveBeenCalled();
  });

  it("extendLife: rotation failure → fail closed (does NOT resume, throws)", async () => {
    listReturns(new Date(Date.now() - 55 * 60 * 1000));
    secretUpdateMock.mockRejectedValueOnce(new Error("secret 503"));
    const mintToken = freshMintToken();
    const provider = new DaytonaProvider();
    await expect(
      provider.extendLife(SANDBOX_ID, { mintToken, secretName: SECRET_NAME }),
    ).rejects.toThrow(/secret 503/);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("extendLife: no refresh handle → unbrokered behavior (no secret touch, resumes)", async () => {
    const provider = new DaytonaProvider();
    await provider.extendLife(SANDBOX_ID);
    expect(secretListMock).not.toHaveBeenCalled();
    expect(secretUpdateMock).not.toHaveBeenCalled();
    expect(secretCreateMock).not.toHaveBeenCalled();
    expect(getMock).toHaveBeenCalled();
  });

  // ---- getSandboxOrNull -------------------------------------------------

  it("getSandboxOrNull: FRESH secret → mintToken NOT called, resumes and returns a session", async () => {
    listReturns(new Date(Date.now() - 5 * 60 * 1000));
    const mintToken = freshMintToken();
    const provider = new DaytonaProvider();
    const session = await provider.getSandboxOrNull(SANDBOX_ID, {
      mintToken,
      secretName: SECRET_NAME,
    });
    expect(session).not.toBeNull();
    expect(mintToken).not.toHaveBeenCalled();
    expect(secretUpdateMock).not.toHaveBeenCalled();
    expect(getMock).toHaveBeenCalled();
  });

  it("getSandboxOrNull: STALE secret → mintToken once, update BEFORE resume", async () => {
    listReturns(new Date(Date.now() - 90 * 60 * 1000));
    const mintToken = freshMintToken();
    const provider = new DaytonaProvider();
    await provider.getSandboxOrNull(SANDBOX_ID, {
      mintToken,
      secretName: SECRET_NAME,
    });
    expect(mintToken).toHaveBeenCalledTimes(1);
    expect(secretUpdateMock).toHaveBeenCalledWith(SECRET_ID, {
      value: FRESH_TOKEN,
    });
    const updateOrder = secretUpdateMock.mock.invocationCallOrder[0]!;
    const getOrder = getMock.mock.invocationCallOrder[0]!;
    expect(updateOrder).toBeLessThan(getOrder);
  });

  it("getSandboxOrNull: rotation failure → fail closed (does NOT resume, returns null)", async () => {
    listReturns(new Date(Date.now() - 90 * 60 * 1000));
    secretUpdateMock.mockRejectedValueOnce(new Error("secret down"));
    const mintToken = freshMintToken();
    const provider = new DaytonaProvider();
    const session = await provider.getSandboxOrNull(SANDBOX_ID, {
      mintToken,
      secretName: SECRET_NAME,
    });
    expect(session).toBeNull();
    expect(getMock).not.toHaveBeenCalled();
  });

  it("getSandboxOrNull: ambiguous list error → fail closed (returns null, no resume)", async () => {
    secretListMock.mockRejectedValueOnce(new Error("list 500"));
    const mintToken = freshMintToken();
    const provider = new DaytonaProvider();
    const session = await provider.getSandboxOrNull(SANDBOX_ID, {
      mintToken,
      secretName: SECRET_NAME,
    });
    expect(session).toBeNull();
    expect(mintToken).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
  });

  it("getSandboxOrNull: refresh missing the secret name → fail closed (returns null)", async () => {
    const mintToken = freshMintToken();
    const provider = new DaytonaProvider();
    const session = await provider.getSandboxOrNull(SANDBOX_ID, { mintToken });
    expect(session).toBeNull();
    expect(getMock).not.toHaveBeenCalled();
  });

  it("getSandboxOrNull: no refresh handle → unbrokered behavior (no secret touch)", async () => {
    const provider = new DaytonaProvider();
    await provider.getSandboxOrNull(SANDBOX_ID);
    expect(secretListMock).not.toHaveBeenCalled();
    expect(secretUpdateMock).not.toHaveBeenCalled();
    expect(secretCreateMock).not.toHaveBeenCalled();
    expect(getMock).toHaveBeenCalled();
  });
});
