import { describe, expect, it } from "vitest";

import {
  assertSafeTestDbName,
  redactDatabaseUrl,
  resolveTestServicesMode,
  testDatabaseUrl,
} from "@terragon/dev-env/test-services-mode";

// @terragon/dev-env has no test runner of its own; its pure helpers are tested
// here, in the suite that consumes them through test-global-setup.

const ADMIN_URL = "postgresql://automata_test:s3cret@127.0.0.1:15432/postgres";

describe("resolveTestServicesMode", () => {
  it("keeps the docker compose path when TEST_DATABASE_ADMIN_URL is unset or blank", () => {
    expect(resolveTestServicesMode({})).toEqual({ kind: "docker" });
    expect(resolveTestServicesMode({ TEST_DATABASE_ADMIN_URL: "" })).toEqual({
      kind: "docker",
    });
    expect(resolveTestServicesMode({ TEST_DATABASE_ADMIN_URL: "  " })).toEqual({
      kind: "docker",
    });
  });

  it("selects external mode with empty Redis (in-memory stand-in) by default", () => {
    expect(
      resolveTestServicesMode({ TEST_DATABASE_ADMIN_URL: ADMIN_URL }),
    ).toEqual({
      kind: "external",
      adminUrl: ADMIN_URL,
      redisHttpUrl: "",
      redisHttpToken: "",
    });
  });

  it("passes an Upstash-compatible Redis HTTP endpoint through", () => {
    expect(
      resolveTestServicesMode({
        TEST_DATABASE_ADMIN_URL: ADMIN_URL,
        TEST_REDIS_HTTP_URL: "http://127.0.0.1:18079",
        TEST_REDIS_HTTP_TOKEN: "tok",
      }),
    ).toMatchObject({
      kind: "external",
      redisHttpUrl: "http://127.0.0.1:18079",
      redisHttpToken: "tok",
    });
  });

  it("rejects a Redis URL without its token", () => {
    expect(() =>
      resolveTestServicesMode({
        TEST_DATABASE_ADMIN_URL: ADMIN_URL,
        TEST_REDIS_HTTP_URL: "http://127.0.0.1:18079",
      }),
    ).toThrow(/TEST_REDIS_HTTP_TOKEN/);
  });

  it("rejects a non-postgres or unparseable admin URL without echoing it", () => {
    expect(() =>
      resolveTestServicesMode({
        TEST_DATABASE_ADMIN_URL: "mysql://u:pw-should-not-leak@h/db",
      }),
    ).toThrow(/postgres/);
    let message = "";
    try {
      resolveTestServicesMode({
        TEST_DATABASE_ADMIN_URL: "not a url pw-should-not-leak",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/not a valid URL/);
    expect(message).not.toContain("pw-should-not-leak");
  });
});

describe("testDatabaseUrl", () => {
  it("swaps only the database name, keeping credentials, host, port and params", () => {
    const url = new URL(
      testDatabaseUrl(`${ADMIN_URL}?sslmode=disable`, "test_123_abc_def"),
    );
    expect(url.protocol).toBe("postgresql:");
    expect(url.username).toBe("automata_test");
    expect(url.password).toBe("s3cret");
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.port).toBe("15432");
    expect(url.pathname).toBe("/test_123_abc_def");
    expect(url.searchParams.get("sslmode")).toBe("disable");
  });

  it("keeps percent-encoded credentials intact", () => {
    const url = testDatabaseUrl(
      "postgresql://u:p%40ss%2Fw@localhost:5432/postgres",
      "test_1_a_b",
    );
    expect(url).toBe("postgresql://u:p%40ss%2Fw@localhost:5432/test_1_a_b");
  });

  it("refuses any name that is not the generated safe shape", () => {
    for (const bad of [
      "postgres",
      "test_x; DROP DATABASE postgres",
      'test_a"b',
      "TEST_UPPER",
      "test_",
      `test_${"a".repeat(59)}`,
    ]) {
      expect(() => testDatabaseUrl(ADMIN_URL, bad), bad).toThrow(/Refusing/);
      expect(() => assertSafeTestDbName(bad), bad).toThrow(/Refusing/);
    }
    expect(() => assertSafeTestDbName("test_4242_mgk1x2_ab12cd")).not.toThrow();
  });
});

describe("redactDatabaseUrl", () => {
  it("hides the password and keeps everything else", () => {
    const redacted = redactDatabaseUrl(ADMIN_URL);
    expect(redacted).not.toContain("s3cret");
    expect(redacted).toBe(
      "postgresql://automata_test:REDACTED@127.0.0.1:15432/postgres",
    );
  });
});
