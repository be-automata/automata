import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import {
  ProvisionError,
  assertLoopbackEngineUrl,
  describeAdminFailure,
  tokenExpiry,
  createTenant,
  engineLogin,
  extractSessionCookie,
  hatchetAdminTokenArgs,
  parseMintedToken,
  provisionTenant,
  readAdminPassword,
} from "./hatchet-tenant";
import type { ProvisionDeps } from "./hatchet-tenant";

const PASSWORD = "s3cret-admin-password";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0In0.c2lnbmF0dXJl";
const TENANT = "11111111-2222-3333-4444-555555555555";
const API = "http://127.0.0.1:8888";

const DIR = mkdtempSync(path.join(tmpdir(), "provision-unit-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));
const UID = process.getuid?.() ?? 0;
let fileSeq = 0;

/** What `fn` threw; fails the test when it returns. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
}

/** A real credential file with `mode`, so the guarded open is what's tested. */
function credFile(mode = 0o600, content = `${PASSWORD}\n`): string {
  const p = path.join(DIR, `pass-${fileSeq++}`);
  writeFileSync(p, content);
  chmodSync(p, mode);
  return p;
}

function response(
  status: number,
  body: unknown,
  setCookie: string[] = [],
): Response {
  const headers = new Headers({ "content-type": "application/json" });
  for (const c of setCookie) headers.append("set-cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
}

describe("assertLoopbackEngineUrl", () => {
  it.each([
    ["http://127.0.0.1:8888", "http://127.0.0.1:8888"],
    ["http://127.0.0.1:8888/", "http://127.0.0.1:8888"],
    ["http://[::1]:8888", "http://[::1]:8888"],
    ["http://127.1:8888", "http://127.0.0.1:8888"],
  ])("accepts %s", (raw, origin) => {
    expect(assertLoopbackEngineUrl(raw)).toBe(origin);
  });

  it.each([
    "https://hatchet.beautomata.com",
    "http://10.0.0.5:8888",
    "http://138.201.174.63:8888",
    "http://127.0.0.1.nip.io:8888",
    "http://localhost.evil.test",
    "http://localhost:8888",
    "http://0.0.0.0:8888",
    "http://[::ffff:127.0.0.1]:8888",
    "ftp://127.0.0.1",
    "http://admin:pw@127.0.0.1:8888",
    "not a url",
  ])("refuses %s", (raw) => {
    expect(() => assertLoopbackEngineUrl(raw)).toThrow(ProvisionError);
  });
});

describe("readAdminPassword", () => {
  it("returns the trimmed password from an owner-only file", () => {
    expect(readAdminPassword(credFile(0o600), UID)).toBe(PASSWORD);
    expect(readAdminPassword(credFile(0o400), UID)).toBe(PASSWORD);
  });

  it("refuses a missing file", () => {
    expect(() => readAdminPassword(path.join(DIR, "absent"), UID)).toThrow(
      /unreadable \(ENOENT\)/,
    );
  });

  it.each([0o640, 0o604, 0o644, 0o660])("refuses mode %o", (mode) => {
    expect(() => readAdminPassword(credFile(mode), UID)).toThrow(
      /(group|world)-accessible/,
    );
  });

  it("refuses a file owned by another uid", () => {
    expect(() => readAdminPassword(credFile(), UID + 1)).toThrow(
      new RegExp(`owned by uid ${UID}, not uid ${UID + 1}`),
    );
  });

  it("refuses a symlink, a directory and an empty file", () => {
    const link = path.join(DIR, "link");
    symlinkSync(credFile(), link);
    expect(() => readAdminPassword(link, UID)).toThrow(ProvisionError);
    expect(() => readAdminPassword(DIR, UID)).toThrow(ProvisionError);
    expect(() => readAdminPassword(credFile(0o600, " \n"), UID)).toThrow(
      /empty/,
    );
  });

  it("never puts the password in a refusal", () => {
    const err = thrown(() => readAdminPassword(credFile(0o644), UID));
    expect(err).toBeInstanceOf(ProvisionError);
    expect(String(err)).not.toContain(PASSWORD);
  });
});

describe("engine session", () => {
  it("extracts the hatchet cookie pair only", () => {
    expect(
      extractSessionCookie([
        "other=1; Path=/",
        "hatchet=abc123; Path=/; Domain=localhost; HttpOnly",
      ]),
    ).toBe("hatchet=abc123");
    expect(extractSessionCookie(["hatchet=; Path=/"])).toBeNull();
    expect(extractSessionCookie([])).toBeNull();
  });

  it("logs in and returns the cookie; a refused login names the status, never the password", async () => {
    const ok = vi.fn(async () =>
      response(200, {}, ["hatchet=sess; Path=/; HttpOnly"]),
    );
    await expect(
      engineLogin({
        apiUrl: API,
        email: "ops@x",
        password: PASSWORD,
        fetch: ok,
      }),
    ).resolves.toBe("hatchet=sess");
    expect(ok).toHaveBeenCalledWith(
      `${API}/api/v1/users/login`,
      expect.objectContaining({ method: "POST" }),
    );

    const refused = async () => response(400, { errors: [] });
    const err = await engineLogin({
      apiUrl: API,
      email: "ops@x",
      password: PASSWORD,
      fetch: refused,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProvisionError);
    expect(String(err)).toContain("HTTP 400");
    expect(String(err)).not.toContain(PASSWORD);
  });

  it("refuses a 200 without a session cookie", async () => {
    await expect(
      engineLogin({
        apiUrl: API,
        email: "ops@x",
        password: PASSWORD,
        fetch: async () => response(200, {}),
      }),
    ).rejects.toThrow(/no session cookie/);
  });
});

describe("createTenant", () => {
  it("posts name+slug+V1 with the session cookie and returns metadata.id", async () => {
    const f = vi.fn(async () =>
      response(200, { metadata: { id: TENANT }, version: "V1" }),
    );
    await expect(
      createTenant({
        apiUrl: API,
        cookie: "hatchet=sess",
        name: "Client A",
        slug: "client-a",
        fetch: f,
      }),
    ).resolves.toBe(TENANT);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API}/api/v1/tenants`);
    expect(JSON.parse(String(init.body))).toEqual({
      name: "Client A",
      slug: "client-a",
      engineVersion: "V1",
    });
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>).cookie).toBe(
      "hatchet=sess",
    );
  });

  it("surfaces the engine's validation descriptions on a 400", async () => {
    const f = async () =>
      response(400, {
        errors: [{ description: "slug already exists", field: "slug" }],
      });
    await expect(
      createTenant({
        apiUrl: API,
        cookie: "hatchet=s",
        name: "n",
        slug: "dup-slug",
        fetch: f,
      }),
    ).rejects.toThrow("tenant create failed (HTTP 400): slug already exists");
  });

  it.each([
    "A",
    "ab",
    "Upper-Case",
    "-lead",
    "trail-",
    "has space",
    "x".repeat(64),
  ])("refuses slug %j without calling the engine", async (slug) => {
    const f = vi.fn();
    await expect(
      createTenant({ apiUrl: API, cookie: "c", name: "n", slug, fetch: f }),
    ).rejects.toThrow(ProvisionError);
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses a tenant the engine created on V0", async () => {
    await expect(
      createTenant({
        apiUrl: API,
        cookie: "c",
        name: "n",
        slug: "abc",
        fetch: async () =>
          response(200, { metadata: { id: TENANT }, version: "V0" }),
      }),
    ).rejects.toThrow(/engine version V0, not V1/);
  });

  it("refuses a 200 with no tenant id", async () => {
    await expect(
      createTenant({
        apiUrl: API,
        cookie: "c",
        name: "n",
        slug: "abc",
        fetch: async () => response(200, { metadata: {} }),
      }),
    ).rejects.toThrow(/no tenant id/);
  });
});

describe("token mint", () => {
  it("builds the hatchet-admin argv with --config /config and --tenant-id", () => {
    const adminArgs = hatchetAdminTokenArgs({
      tenantId: TENANT,
      name: "www",
      expiresIn: "8760h",
    });
    expect(adminArgs).toEqual([
      "/hatchet-admin",
      "token",
      "create",
      "--config",
      "/config",
      "--tenant-id",
      TENANT,
      "--name",
      "www",
      "--expiresIn",
      "8760h",
    ]);
  });

  it("parses the JWT on the last line and never echoes stdout on refusal", () => {
    expect(parseMintedToken(`some log line\n${TOKEN}\n`)).toBe(TOKEN);
    for (const notToken of ["v0.94.10", "config.server.url", "a.b.c"]) {
      expect(() => parseMintedToken(`ok\n${notToken}\n`)).toThrow(
        ProvisionError,
      );
    }
    const noisy = "level=info secret-ish output\nnot-a-token";
    const err = thrown(() => parseMintedToken(noisy));
    expect(err).toBeInstanceOf(ProvisionError);
    expect(String(err)).not.toContain("secret-ish");
  });
});

describe("hatchet-admin failures and token expiry", () => {
  it("keeps the exit code and a redacted stderr tail, never the argv", () => {
    const err = describeAdminFailure(
      Object.assign(
        new Error(
          `Command failed: docker exec engine /hatchet-admin --tenant-id ${TENANT}`,
        ),
        {
          code: 1,
          stderr:
            "could not load config: postgres://hatchet:dbpass123@db:5432/hatchet unreachable\n" +
            `leaked ${TOKEN}`,
        },
      ),
    );
    expect(err).toBeInstanceOf(ProvisionError);
    expect(err.message).toMatch(/^hatchet-admin failed \(exit 1\): /);
    expect(err.message).not.toContain("dbpass123");
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain("Command failed");
    expect(describeAdminFailure({ killed: true }).message).toBe(
      "hatchet-admin timed out",
    );
  });

  it("reads exp from the token, null when it has none", () => {
    const body = Buffer.from(JSON.stringify({ exp: 1830297600 })).toString(
      "base64url",
    );
    expect(tokenExpiry(`aaaa.${body}.bbbb`)).toBe("2028-01-01T00:00:00.000Z");
    expect(tokenExpiry(TOKEN)).toBeNull();
    expect(tokenExpiry("not-a-jwt")).toBeNull();
  });
});

describe("provisionTenant", () => {
  const NOW = new Date("2026-10-26T00:00:00.000Z");
  function deps(over: Partial<ProvisionDeps> = {}): ProvisionDeps {
    return {
      uid: UID,
      now: () => NOW,
      fetch: vi.fn(async (url: string) =>
        url.endsWith("/users/login")
          ? response(200, {}, ["hatchet=sess; HttpOnly"])
          : response(200, { metadata: { id: TENANT }, version: "V1" }),
      ),
      runAdmin: vi.fn(async () => `${TOKEN}\n`),
      ...over,
    };
  }
  const base = {
    apiUrl: API,
    adminEmail: "ops@beautomata.com",
    passwordFile: credFile(),
    tokenName: "www",
    expiresIn: "8760h",
  };

  it("logs in, creates the tenant, mints a token scoped to it", async () => {
    const d = deps();
    await expect(
      provisionTenant({ ...base, tenant: { name: "A", slug: "client-a" } }, d),
    ).resolves.toEqual({
      tenantId: TENANT,
      token: TOKEN,
      expiresAt: "2027-10-26T00:00:00.000Z",
    });
    expect(d.runAdmin).toHaveBeenCalledWith(
      expect.arrayContaining(["--tenant-id", TENANT, "--name", "www"]),
    );
  });

  it("mint-only needs no credential file, login or create", async () => {
    const d = deps();
    await expect(
      provisionTenant(
        {
          ...base,
          passwordFile: path.join(DIR, "absent"),
          tokenName: "box-2",
          expiresIn: "24h",
          tenant: { tenantId: TENANT },
        },
        d,
      ),
    ).resolves.toEqual({
      tenantId: TENANT,
      token: TOKEN,
      expiresAt: "2026-10-27T00:00:00.000Z",
    });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("refuses a non-loopback engine before touching the credential file or network", async () => {
    const d = deps();
    await expect(
      provisionTenant(
        {
          ...base,
          apiUrl: "https://hatchet.beautomata.com",
          tenant: { name: "A", slug: "client-a" },
        },
        d,
      ),
    ).rejects.toThrow(/loopback/);
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.runAdmin).not.toHaveBeenCalled();
  });

  it.each(["90d", "0h", "8760", "1h; rm -rf /"])(
    "refuses expiry %j",
    async (expiresIn) => {
      await expect(
        provisionTenant(
          { ...base, expiresIn, tenant: { tenantId: TENANT } },
          deps(),
        ),
      ).rejects.toThrow(/whole hours/);
    },
  );

  it.each(["default", "-".repeat(36)])(
    "refuses tenant id %j in mint-only mode",
    async (tenantId) => {
      await expect(
        provisionTenant({ ...base, tenant: { tenantId } }, deps()),
      ).rejects.toThrow(/UUID/);
    },
  );

  it("lowercases an uppercase tenant id", async () => {
    const d = deps();
    await expect(
      provisionTenant(
        { ...base, tenant: { tenantId: TENANT.toUpperCase() } },
        d,
      ),
    ).resolves.toMatchObject({ tenantId: TENANT });
  });

  it("a mint that fails after create names the tenant and the mint-only re-run", async () => {
    const created: string[] = [];
    const d = deps({
      runAdmin: async () => "no token here",
      onTenantCreated: (id) => created.push(id),
    });
    await expect(
      provisionTenant({ ...base, tenant: { name: "A", slug: "client-a" } }, d),
    ).rejects.toThrow(
      `tenant ${TENANT} was created but the token mint failed (hatchet-admin did not print a token); re-run with --tenant-id ${TENANT} --token-name www --expires-in 8760h`,
    );
    expect(created).toEqual([TENANT]);
  });

  it("does not mint when the credential file is world-readable", async () => {
    const d = deps();
    await expect(
      provisionTenant(
        {
          ...base,
          passwordFile: credFile(0o644),
          tenant: { name: "A", slug: "client-a" },
        },
        d,
      ),
    ).rejects.toThrow(/world-accessible/);
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.runAdmin).not.toHaveBeenCalled();
  });
});
