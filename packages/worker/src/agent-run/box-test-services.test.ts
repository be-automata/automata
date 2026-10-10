import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readBoxTestServicesEnv,
  receivesBoxTestServices,
} from "./box-test-services";

const SECRET_URL =
  "postgresql://automata_test:s3cr3tpw0123456789abcdef@127.0.0.1:25432/postgres";
const REPO = "be-automata/automata";

let dir: string;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bts-"));
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A file as the installer leaves it: 0640. `mode` overrides. */
function envFile(text: string, mode = 0o640): string {
  const p = path.join(dir, "agent-test-services.env");
  fs.writeFileSync(p, text);
  fs.chmodSync(p, mode);
  return p;
}

function expectOneWarningWithoutValues(): void {
  expect(warn).toHaveBeenCalledTimes(1);
  const logged = JSON.stringify(warn.mock.calls);
  expect(logged).not.toContain("s3cr3tpw");
  expect(logged).not.toContain("tok_secret");
}

describe("readBoxTestServicesEnv", () => {
  it("reads the allowlisted keys for a listed repo, skipping blanks, comments and other keys", () => {
    const p = envFile(
      [
        "# managed by install-test-postgres.sh",
        "",
        `TEST_DATABASE_ADMIN_URL=${SECRET_URL}`,
        "TEST_REDIS_HTTP_URL=http://127.0.0.1:18079",
        "TEST_REDIS_HTTP_TOKEN=tok_secret=with=equals",
        "NODE_OPTIONS=--require /tmp/x.js",
        "TEST_SERVICES_REPOS=acme/widgets, Be-Automata/Automata",
        "",
      ].join("\n"),
    );
    expect(readBoxTestServicesEnv(REPO, p)).toEqual({
      TEST_DATABASE_ADMIN_URL: SECRET_URL,
      TEST_REDIS_HTTP_URL: "http://127.0.0.1:18079",
      TEST_REDIS_HTTP_TOKEN: "tok_secret=with=equals",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("is {} for a repo TEST_SERVICES_REPOS does not list", () => {
    const p = envFile(
      `TEST_DATABASE_ADMIN_URL=${SECRET_URL}\nTEST_SERVICES_REPOS=${REPO}\n`,
    );
    expect(readBoxTestServicesEnv("someone/else", p)).toEqual({});
    // A prefix or a suffix of a listed repo is not the repo.
    expect(readBoxTestServicesEnv("be-automata/automata-x", p)).toEqual({});
  });

  it("is {} for every repo when TEST_SERVICES_REPOS is absent", () => {
    const p = envFile(`TEST_DATABASE_ADMIN_URL=${SECRET_URL}\n`);
    expect(readBoxTestServicesEnv(REPO, p)).toEqual({});
  });

  it("is {} and silent when the file does not exist (every non-box host)", () => {
    expect(readBoxTestServicesEnv(REPO, path.join(dir, "missing.env"))).toEqual(
      {},
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses a world-accessible file", () => {
    const p = envFile(
      `TEST_DATABASE_ADMIN_URL=${SECRET_URL}\nTEST_SERVICES_REPOS=${REPO}\n`,
      0o644,
    );
    expect(readBoxTestServicesEnv(REPO, p)).toEqual({});
    expectOneWarningWithoutValues();
    expect(String(warn.mock.calls[0]?.[0])).toContain("world-accessible");
  });

  it("refuses a symlink, even to a well-formed file", () => {
    const target = envFile(
      `TEST_DATABASE_ADMIN_URL=${SECRET_URL}\nTEST_SERVICES_REPOS=${REPO}\n`,
    );
    const link = path.join(dir, "link.env");
    fs.symlinkSync(target, link);
    expect(readBoxTestServicesEnv(REPO, link)).toEqual({});
    expectOneWarningWithoutValues();
  });

  it("refuses a directory and a file over 64 KiB", () => {
    expect(readBoxTestServicesEnv(REPO, dir)).toEqual({});
    const p = envFile(`# ${"x".repeat(64 * 1024)}\n`);
    expect(readBoxTestServicesEnv(REPO, p)).toEqual({});
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a line without '='", `TEST_DATABASE_ADMIN_URL ${SECRET_URL}`],
    ["an empty value", "TEST_DATABASE_ADMIN_URL="],
    ["an export prefix", `export TEST_DATABASE_ADMIN_URL=${SECRET_URL}`],
  ])("is {} with one warning (no value) on %s", (_label, badLine) => {
    const p = envFile(
      `TEST_REDIS_HTTP_TOKEN=tok_secret\nTEST_SERVICES_REPOS=${REPO}\n${badLine}\n`,
    );
    expect(readBoxTestServicesEnv(REPO, p)).toEqual({});
    expectOneWarningWithoutValues();
  });
});

describe("receivesBoxTestServices", () => {
  it("a task or PR (mention) run may get it", () => {
    expect(receivesBoxTestServices({}, "task")).toBe(true);
    expect(receivesBoxTestServices({}, "pr")).toBe(true);
  });

  it("a review-lane run does not", () => {
    expect(receivesBoxTestServices({}, "review")).toBe(false);
  });

  it("a run carrying review-agent settings does not, whatever its lane", () => {
    const reviewAgent = {
      mode: "classic" as const,
      batteries: [],
      runTests: false,
      commandTimeoutMs: 1000,
    };
    expect(receivesBoxTestServices({ reviewAgent }, "pr")).toBe(false);
    expect(receivesBoxTestServices({ reviewAgent }, "task")).toBe(false);
  });

  it("a self-heal run does not", () => {
    expect(
      receivesBoxTestServices(
        { selfHeal: { kind: "audit", checks: [], checkToken: "ck" } },
        "task",
      ),
    ).toBe(false);
  });
});
