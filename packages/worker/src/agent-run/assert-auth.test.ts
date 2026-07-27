import { describe, expect, it, vi } from "vitest";
import {
  assertAuthEnabled,
  loadAuthProbeConfig,
  type AuthProbeConfig,
} from "./assert-auth";

const CONFIG: AuthProbeConfig = {
  apiUrl: "https://engine.example.com",
  tenantId: "tenant-1",
  realToken: "real-token",
};

/** A fetch stub keyed on which token the request carried. */
function fetchByToken(byToken: (token: string) => number): typeof fetch {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const auth = String(
      (init?.headers as Record<string, string>)?.Authorization ?? "",
    );
    const token = auth.replace(/^Bearer\s+/, "");
    return new Response(null, { status: byToken(token) });
  }) as unknown as typeof fetch;
}

describe("assertAuthEnabled", () => {
  it("throws when a GARBAGE token is ACCEPTED (auth disabled)", async () => {
    // Everything returns 200 → the garbage token is accepted → auth is off.
    const fetchImpl = fetchByToken(() => 200);
    await expect(assertAuthEnabled(CONFIG, fetchImpl)).rejects.toThrow(
      /auth-DISABLED/,
    );
  });

  it("passes when garbage is rejected (401) AND the real token is accepted (200)", async () => {
    const fetchImpl = fetchByToken((token) =>
      token === CONFIG.realToken ? 200 : 401,
    );
    await expect(assertAuthEnabled(CONFIG, fetchImpl)).resolves.toBeUndefined();
  });

  it("passes with a 403 rejection of the garbage token too", async () => {
    const fetchImpl = fetchByToken((token) =>
      token === CONFIG.realToken ? 204 : 403,
    );
    await expect(assertAuthEnabled(CONFIG, fetchImpl)).resolves.toBeUndefined();
  });

  it("throws when the REAL token is rejected (misconfigured)", async () => {
    // Garbage correctly 401, but the real token is ALSO rejected → misconfigured.
    const fetchImpl = fetchByToken((token) =>
      token === CONFIG.realToken ? 401 : 401,
    );
    await expect(assertAuthEnabled(CONFIG, fetchImpl)).rejects.toThrow(
      /misconfigured/,
    );
  });

  it("throws on an ambiguous negative-probe status (not 401/403)", async () => {
    const fetchImpl = fetchByToken(() => 500);
    await expect(assertAuthEnabled(CONFIG, fetchImpl)).rejects.toThrow(
      /unexpected status 500/,
    );
  });

  it("throws (fail-closed) when the probe config is incomplete", async () => {
    const fetchImpl = fetchByToken(() => 401);
    await expect(
      assertAuthEnabled(
        { apiUrl: "", tenantId: "t", realToken: "x" },
        fetchImpl,
      ),
    ).rejects.toThrow(/fail-closed/);
  });
});

describe("loadAuthProbeConfig", () => {
  it("throws (fail-closed) when no token is present", () => {
    expect(() => loadAuthProbeConfig({})).toThrow(/fail-closed/);
  });

  it("uses explicit HATCHET_API_URL / HATCHET_TENANT_ID when set", () => {
    const cfg = loadAuthProbeConfig({
      HATCHET_API_TOKEN: "tok",
      HATCHET_API_URL: "https://x.example.com",
      HATCHET_TENANT_ID: "tid",
    });
    expect(cfg).toEqual({
      apiUrl: "https://x.example.com",
      tenantId: "tid",
      realToken: "tok",
    });
  });

  it("derives apiUrl + tenantId from the client-token JWT when not set explicitly", () => {
    const claims = Buffer.from(
      JSON.stringify({ sub: "tenant-xyz", server_url: "https://engine.local" }),
    ).toString("base64url");
    const token = `h.${claims}.sig`;
    const cfg = loadAuthProbeConfig({ HATCHET_CLIENT_TOKEN: token });
    expect(cfg.apiUrl).toBe("https://engine.local");
    expect(cfg.tenantId).toBe("tenant-xyz");
    expect(cfg.realToken).toBe(token);
  });

  it("throws when the token carries no addresses and no env override is given", () => {
    const claims = Buffer.from(JSON.stringify({ foo: "bar" })).toString(
      "base64url",
    );
    expect(() =>
      loadAuthProbeConfig({ HATCHET_CLIENT_TOKEN: `h.${claims}.sig` }),
    ).toThrow(/fail-closed/);
  });
});
