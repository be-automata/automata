import { describe, expect, it } from "vitest";

import { CELL_DAEMON_ENV } from "./cell-image";
import {
  CELL_OWNER_OVERRIDABLE,
  cellRepoEnv,
  isReservedCellRepoEnvKey,
} from "./cell-repo-env";

describe("cellRepoEnv (#706)", () => {
  // card: protects=ordinary owner names reach the agent with their exact values; fails_when=a plain name is dropped or a value changes; no_claim=the agent's env (UAT)
  it("keeps ordinary names, credential-shaped ones included", () => {
    const out = cellRepoEnv({
      FOO_TOKEN: "v-1",
      CI: "true",
      lower_case: "x",
    });
    expect(out).toEqual({
      env: { FOO_TOKEN: "v-1", CI: "true", lower_case: "x" },
      dropped: [],
      invalidNames: 0,
    });
  });

  // card: protects=the box's reserved rule holds in a cell, case-insensitively; fails_when=a box-reserved name is kept; no_claim=the box path
  it("drops the box's reserved names", () => {
    const out = cellRepoEnv({
      ANTHROPIC_API_KEY: "a",
      claude_code_simple: "1",
      PATH: "/evil",
      GH_TOKEN: "g",
      NODE_EXTRA_CA_CERTS: "/ca",
      KEEP: "k",
    });
    expect(out.env).toEqual({ KEEP: "k" });
    expect(out.dropped).toEqual([
      "ANTHROPIC_API_KEY",
      "GH_TOKEN",
      "NODE_EXTRA_CA_CERTS",
      "PATH",
      "claude_code_simple",
    ]);
  });

  // card: protects=names the cell's own runtime sets for the agent cannot be overridden by settings env; fails_when=any is kept; no_claim=names set by a future runtime change
  it("drops the cell-only reserved names", () => {
    for (const key of [
      "DAEMON_TOKEN",
      "bash_max_timeout_ms",
      "BASH_DEFAULT_TIMEOUT_MS",
      "OPENSANDBOX_MERGED_CA_PATH",
      "opensandbox_egress_mitmproxy_transparent",
    ]) {
      expect(isReservedCellRepoEnvKey(key), key).toBe(true);
    }
    expect(isReservedCellRepoEnvKey("BASH_ENV_EXTRA")).toBe(false);
  });

  // card: protects=every name the entry starts the daemon with is reserved or a named exception, so a new image name is reserved by default; fails_when=a CELL_DAEMON_ENV name is overridable without being listed, or an exception is reserved; no_claim=names the image sets outside CELL_DAEMON_ENV
  it("reserves every CELL_DAEMON_ENV name but the named exceptions", () => {
    for (const name of CELL_DAEMON_ENV) {
      expect(isReservedCellRepoEnvKey(name), name).toBe(
        !CELL_OWNER_OVERRIDABLE.includes(name),
      );
    }
    for (const name of ["SOMNIO_ROOT", "vendor_skills_root", "HOME"]) {
      expect(isReservedCellRepoEnvKey(name), name).toBe(true);
    }
  });

  // card: protects=an invalid name is counted, never listed, and a NUL value is dropped by name; fails_when=a free-text name reaches the dropped list or a NUL value is kept; no_claim=the log line
  it("counts invalid names and drops NUL values", () => {
    const out = cellRepoEnv({
      "1BAD": "x",
      "A-B": "y",
      "npm_config_//r.org/:_authToken": "z",
      NUL_VALUE: "a\0b",
      OK: "ok",
    });
    expect(out).toEqual({
      env: { OK: "ok" },
      dropped: ["NUL_VALUE"],
      invalidNames: 3,
    });
  });

  // card: protects=no repo env is no change; fails_when=undefined or {} yields anything; no_claim=none
  it("absent or empty is empty", () => {
    const empty = { env: {}, dropped: [], invalidNames: 0 };
    expect(cellRepoEnv(undefined)).toEqual(empty);
    expect(cellRepoEnv({})).toEqual(empty);
  });
});
