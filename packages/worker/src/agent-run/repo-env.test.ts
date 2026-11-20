import { describe, expect, it } from "vitest";

import { CELL_DAEMON_ENV } from "./cell-image";
import { isReservedRepoEnvKey } from "./daemon-env";
import { filterRepoEnv, repoEnvDroppedNote } from "./repo-env";

/** Names in `CELL_DAEMON_ENV` an owner may still set: build-tool settings with no platform role. */
const OWNER_OVERRIDABLE: readonly string[] = [
  "CI",
  "DEBIAN_FRONTEND",
  "PUB_CACHE",
  "FLUTTER_ROOT",
  "FLUTTER_SUPPRESS_ANALYTICS",
  "DART_SUPPRESS_ANALYTICS",
];

describe("filterRepoEnv (#706, #717)", () => {
  // card: protects=ordinary owner names reach the agent with their exact values; fails_when=a plain name is dropped or a value changes; no_claim=the agent's env (UAT)
  it("keeps ordinary names, credential-shaped ones included", () => {
    const out = filterRepoEnv({
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

  // card: protects=the shared reserved rule holds, case-insensitively; fails_when=a reserved name is kept; no_claim=the call sites (container-daemon-process.test.ts, cell-run.test.ts)
  it("drops the reserved names", () => {
    const out = filterRepoEnv({
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

  // card: protects=names the runtime sets for the agent (the daemon, OpenSandbox, the batteries image) are reserved by the one rule both paths use; fails_when=any is settable; no_claim=names set by a future runtime change
  it("reserves the runtime's own names (#717)", () => {
    for (const key of [
      "DAEMON_TOKEN",
      "bash_max_timeout_ms",
      "BASH_DEFAULT_TIMEOUT_MS",
      "OPENSANDBOX_MERGED_CA_PATH",
      "opensandbox_egress_mitmproxy_transparent",
      "SOMNIO_ROOT",
      "vendor_skills_root",
      "ROBOREV_TELEMETRY_ENABLED",
    ]) {
      expect(isReservedRepoEnvKey(key), key).toBe(true);
    }
    expect(isReservedRepoEnvKey("BASH_ENV_EXTRA")).toBe(false);
  });

  // card: protects=every name the cell entry starts the daemon with is reserved by the shared rule or a named exception, so a new image name fails here until both paths reserve it; fails_when=a CELL_DAEMON_ENV name is settable without being listed, or an exception is reserved; no_claim=names the image sets outside CELL_DAEMON_ENV
  it("reserves every CELL_DAEMON_ENV name but the named exceptions", () => {
    for (const name of CELL_DAEMON_ENV) {
      expect(isReservedRepoEnvKey(name), name).toBe(
        !OWNER_OVERRIDABLE.includes(name),
      );
    }
    for (const name of OWNER_OVERRIDABLE) {
      expect(CELL_DAEMON_ENV, name).toContain(name);
    }
  });

  // card: protects=an invalid name is counted, never listed, and a NUL value is dropped by name; fails_when=a free-text name reaches the dropped list or a NUL value is kept; no_claim=the log line
  it("counts invalid names and drops NUL values", () => {
    const out = filterRepoEnv({
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
    expect(filterRepoEnv(undefined)).toEqual(empty);
    expect(filterRepoEnv({})).toEqual(empty);
  });

  // card: protects=the note both paths log names the dropped names and counts invalid ones, never a value; fails_when=a value appears in the note or dropped, or a clean env yields a note; no_claim=the log sinks
  it("reports names only, never values", () => {
    const canary = "canary-7d1f0c";
    const out = filterRepoEnv({
      VENDOR_SKILLS_ROOT: canary,
      SOMNIO_ROOT: canary,
      "BAD-NAME": canary,
      KEEP: "k",
    });
    expect(out.env).toEqual({ KEEP: "k" });
    const note = repoEnvDroppedNote(out);
    expect(note).toBe(
      "repo env names not set (reserved): SOMNIO_ROOT, VENDOR_SKILLS_ROOT (+1 not an env name)",
    );
    expect(JSON.stringify(out.dropped) + note).not.toContain(canary);
    expect(repoEnvDroppedNote(filterRepoEnv({ KEEP: "k" }))).toBeNull();
  });
});
