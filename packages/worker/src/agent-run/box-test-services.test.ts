import { describe, expect, it, vi } from "vitest";

import {
  BOX_TEST_SERVICES_ENV_PATH,
  readBoxTestServicesEnv,
  receivesBoxTestServices,
} from "./box-test-services";

const SECRET_URL =
  "postgresql://automata_test:s3cr3tpw0123456789abcdef@127.0.0.1:25432/postgres";

function fileWith(text: string) {
  return { readFileSync: () => text };
}

function failingWith(code: string) {
  return {
    readFileSync: (): string => {
      throw Object.assign(new Error(`${code}: nope`), { code });
    },
  };
}

function expectNoValueIn(warn: ReturnType<typeof vi.fn>): void {
  const logged = JSON.stringify(warn.mock.calls);
  expect(logged).not.toContain("s3cr3tpw");
  expect(logged).not.toContain("tok_secret");
}

describe("readBoxTestServicesEnv", () => {
  it("defaults to the path install-test-postgres.sh writes", () => {
    expect(BOX_TEST_SERVICES_ENV_PATH).toBe(
      "/etc/automata/agent-test-services.env",
    );
  });

  it("reads the allowlisted keys, skipping blanks and comments", () => {
    const warn = vi.fn();
    const env = readBoxTestServicesEnv(
      "/x.env",
      fileWith(
        [
          "# managed by install-test-postgres.sh",
          "",
          `TEST_DATABASE_ADMIN_URL=${SECRET_URL}`,
          "  ",
          "TEST_REDIS_HTTP_URL=http://127.0.0.1:18079",
          "TEST_REDIS_HTTP_TOKEN=tok_secret=with=equals\r",
          "",
        ].join("\n"),
      ),
      warn,
    );
    expect(env).toEqual({
      TEST_DATABASE_ADMIN_URL: SECRET_URL,
      TEST_REDIS_HTTP_URL: "http://127.0.0.1:18079",
      TEST_REDIS_HTTP_TOKEN: "tok_secret=with=equals",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops keys outside the allowlist, naming the key but not the value", () => {
    const warn = vi.fn();
    const env = readBoxTestServicesEnv(
      "/x.env",
      fileWith(
        `TEST_DATABASE_ADMIN_URL=${SECRET_URL}\nNODE_OPTIONS=--require /tmp/s3cr3tpw.js\nPATH=/evil\n`,
      ),
      warn,
    );
    expect(env).toEqual({ TEST_DATABASE_ADMIN_URL: SECRET_URL });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      keys: ["NODE_OPTIONS", "PATH"],
    });
    expectNoValueIn(warn);
  });

  it("is {} and silent when the file does not exist (every non-box host)", () => {
    const warn = vi.fn();
    expect(
      readBoxTestServicesEnv("/x.env", failingWith("ENOENT"), warn),
    ).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  it("really reads the filesystem by default, and a missing path is {}", () => {
    expect(
      readBoxTestServicesEnv("/nonexistent/automata/agent-test-services.env"),
    ).toEqual({});
  });

  it("is {} with a warning when the file is unreadable", () => {
    const warn = vi.fn();
    expect(
      readBoxTestServicesEnv("/x.env", failingWith("EACCES"), warn),
    ).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      path: "/x.env",
      code: "EACCES",
    });
  });

  it.each([
    ["a line without '='", `TEST_DATABASE_ADMIN_URL ${SECRET_URL}`],
    ["an empty value", "TEST_DATABASE_ADMIN_URL="],
    ["an export prefix", `export TEST_DATABASE_ADMIN_URL=${SECRET_URL}`],
  ])("is {} with a warning (no value) on %s", (_label, badLine) => {
    const warn = vi.fn();
    const env = readBoxTestServicesEnv(
      "/x.env",
      fileWith(`TEST_REDIS_HTTP_TOKEN=tok_secret\n${badLine}\n`),
      warn,
    );
    expect(env).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ path: "/x.env", line: 2 });
    expectNoValueIn(warn);
  });
});

describe("receivesBoxTestServices (mirrors www dispatch isPlainTaskRun)", () => {
  const org = { orgId: "org_1" };

  it("an org task run gets it", () => {
    expect(receivesBoxTestServices(org)).toBe(true);
  });

  it("an org PR-scoped non-review run (a mention) gets it", () => {
    expect(receivesBoxTestServices({ ...org, prNumber: 7 })).toBe(true);
  });

  it("a review-plan run does not", () => {
    expect(
      receivesBoxTestServices({
        ...org,
        prNumber: 7,
        prKey: "org_1/o/r/7",
        supersedePolicy: "newest-wins",
      }),
    ).toBe(false);
    expect(
      receivesBoxTestServices({ ...org, supersedePolicy: "newest-wins" }),
    ).toBe(false);
  });

  it("a personal (no-org) run does not", () => {
    expect(receivesBoxTestServices({ orgId: "u:user_1" })).toBe(false);
    expect(receivesBoxTestServices({ orgId: "u:user_1", prNumber: 7 })).toBe(
      false,
    );
  });

  it("a self-heal run does not", () => {
    expect(
      receivesBoxTestServices({
        ...org,
        selfHeal: { kind: "audit", checks: [], checkToken: "ck" },
      }),
    ).toBe(false);
  });
});
