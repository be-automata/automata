import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CELL_TEST_DB_ROLE_SH,
  CELL_TEST_DB_START_SH,
  CELL_TEST_DB_STOP_SH,
  cellTestDbUrl,
  planCellTestDb,
} from "./cell-test-db";

const dir = mkdtempSync(join(tmpdir(), "cell-tdb-unit-"));
const LISTED = join(dir, "listed.env");
writeFileSync(LISTED, "TEST_SERVICES_REPOS=acme/widgets\n", { mode: 0o640 });
const input = { repoFullName: "Acme/Widgets" };

describe("planCellTestDb (#707)", () => {
  const plan = (over: Partial<Parameters<typeof planCellTestDb>[0]> = {}) =>
    planCellTestDb({
      input,
      lane: "task",
      repoEnv: {},
      envPath: LISTED,
      ...over,
    });

  // card: protects=the gate: a listed repo starts one, an unlisted one or no file does not, the owner's own variable wins; fails_when=any of the three is decided otherwise; no_claim=the steps (cell-run.test.ts)
  it("starts for a listed repo, not otherwise, and the owner's variable wins", () => {
    expect(plan()).toBe("start");
    expect(plan({ input: { repoFullName: "other/repo" } })).toBe("off");
    expect(plan({ envPath: join(dir, "missing.env") })).toBe("off");
    expect(
      plan({ repoEnv: { TEST_DATABASE_ADMIN_URL: "postgresql://mine" } }),
    ).toBe("owner");
  });

  // card: protects=the box's lane rule holds for a cell: no database for a review or a self-heal audit; fails_when=either starts one; no_claim=cells running those lanes (run-executor refuses them today)
  it("starts none for a review lane or a self-heal audit", () => {
    expect(plan({ lane: "review" })).toBe("off");
    expect(
      plan({ input: { ...input, selfHeal: { kind: "audit" } as never } }),
    ).toBe("off");
  });
});

describe("cellTestDbUrl (#707)", () => {
  // card: protects=the URL shape the box uses, and a password that is not the worker's hex is refused without echoing it; fails_when=the URL differs or a bad password is accepted or echoed; no_claim=none
  it("builds the box-shaped URL and refuses a non-hex password", () => {
    const pw = "ab".repeat(24);
    expect(cellTestDbUrl(pw)).toBe(
      `postgresql://automata_test:${pw}@127.0.0.1:25432/postgres`,
    );
    expect(() => cellTestDbUrl("x'; drop role y; --")).toThrow(
      /^cell test database password is not 32\+ hex chars$/,
    );
    expect(() => cellTestDbUrl("ab".repeat(8))).toThrow();
  });
});

describe("the test database scripts parse (#707)", () => {
  // card: protects=the three scripts are valid bash (quoting, the heredoc); fails_when=bash -n rejects one; no_claim=their behaviour in the image (verify.sh, IT-E1 f)
  it.each([
    ["start", CELL_TEST_DB_START_SH],
    ["role", CELL_TEST_DB_ROLE_SH],
    ["stop", CELL_TEST_DB_STOP_SH],
  ])("%s passes bash -n", (_name, script) => {
    const out = spawnSync("bash", ["-n", "-c", script], { encoding: "utf8" });
    expect(out.stderr).toBe("");
    expect(out.status).toBe(0);
  });

  // card: protects=the bash -n check fails on a broken script; fails_when=an unterminated quote passes; no_claim=none
  it("negative control: an unterminated quote fails bash -n", () => {
    const out = spawnSync("bash", ["-n", "-c", `${CELL_TEST_DB_START_SH}\n"`]);
    expect(out.status).not.toBe(0);
  });
});
