import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCloudflareContext: vi.fn(),
  createDb: vi.fn((url: string) => ({ driver: "createDb", url })),
  createDbFromHyperdrive: vi.fn((connectionString: string) => ({
    driver: "hyperdrive",
    url: connectionString,
  })),
}));

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: mocks.getCloudflareContext,
}));

vi.mock("@terragon/shared/db", () => ({
  createDb: mocks.createDb,
  createDbFromHyperdrive: mocks.createDbFromHyperdrive,
}));

vi.mock("@terragon/env/apps-www", () => ({
  env: { DATABASE_URL: "postgres://database-url.test/db" },
}));

const HYPERDRIVE_URL = "postgresql://user:pw@abc.hyperdrive.local:5432/db";

// The proxy forwards property reads to the resolved handle; the fakes above
// expose which factory built it.
async function loadDb(): Promise<{ driver: string; url: string }> {
  const { db } = await import("./db");
  return db as unknown as { driver: string; url: string };
}

describe("db driver selection", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.getCloudflareContext.mockReset();
    mocks.createDb.mockClear();
    mocks.createDbFromHyperdrive.mockClear();
  });

  it("uses node-postgres over Hyperdrive when the binding is present", async () => {
    mocks.getCloudflareContext.mockReturnValue({
      ctx: {},
      env: { HYPERDRIVE: { connectionString: HYPERDRIVE_URL } },
    });
    const db = await loadDb();

    expect(db.driver).toBe("hyperdrive");
    expect(db.url).toBe(HYPERDRIVE_URL);
    expect(mocks.createDb).not.toHaveBeenCalled();
  });

  it("falls back to createDb(DATABASE_URL) (neon-serverless) without the binding", async () => {
    mocks.getCloudflareContext.mockReturnValue({ ctx: {}, env: {} });
    const db = await loadDb();

    expect(db.driver).toBe("createDb");
    expect(db.url).toBe("postgres://database-url.test/db");
    expect(mocks.createDbFromHyperdrive).not.toHaveBeenCalled();
  });

  it("ignores a binding with an empty connection string", async () => {
    mocks.getCloudflareContext.mockReturnValue({
      ctx: {},
      env: { HYPERDRIVE: { connectionString: "" } },
    });
    const db = await loadDb();

    expect(db.driver).toBe("createDb");
  });

  it("builds one handle per request and a new one for the next request", async () => {
    const firstCtx = {};
    const cfEnv = { HYPERDRIVE: { connectionString: HYPERDRIVE_URL } };
    mocks.getCloudflareContext.mockReturnValue({ ctx: firstCtx, env: cfEnv });
    const db = await loadDb();

    void db.driver;
    void db.url;
    expect(mocks.createDbFromHyperdrive).toHaveBeenCalledTimes(1);

    mocks.getCloudflareContext.mockReturnValue({ ctx: {}, env: cfEnv });
    void db.driver;
    expect(mocks.createDbFromHyperdrive).toHaveBeenCalledTimes(2);
  });

  it("uses one long-lived singleton off Workers, never Hyperdrive", async () => {
    mocks.getCloudflareContext.mockImplementation(() => {
      throw new Error("context not available");
    });
    const db = await loadDb();

    expect(db.driver).toBe("createDb");
    void db.url;
    expect(mocks.createDb).toHaveBeenCalledTimes(1);
    expect(mocks.createDbFromHyperdrive).not.toHaveBeenCalled();
  });
});
