import { describe, expect, it } from "vitest";
import {
  assertNodeBinSupportsEnvProxy,
  nodeSupportsEnvProxy,
  parseNodeVersion,
} from "./node-floor";

describe("nodeSupportsEnvProxy", () => {
  it("accepts the documented floors", () => {
    expect(nodeSupportsEnvProxy("v22.21.0")).toBe(true);
    expect(nodeSupportsEnvProxy("v22.22.1")).toBe(true);
    expect(nodeSupportsEnvProxy("v24.0.0")).toBe(true);
    expect(nodeSupportsEnvProxy("v25.1.0")).toBe(true);
  });

  it("rejects everything below the floor, including EOL 20.x and 23.x", () => {
    expect(nodeSupportsEnvProxy("v22.20.9")).toBe(false);
    expect(nodeSupportsEnvProxy("v20.19.0")).toBe(false);
    expect(nodeSupportsEnvProxy("v23.11.0")).toBe(false);
  });

  it("fails closed on an unparseable version string", () => {
    expect(nodeSupportsEnvProxy("")).toBe(false);
    expect(nodeSupportsEnvProxy("not-a-version")).toBe(false);
    expect(parseNodeVersion("garbage")).toBeNull();
  });

  // #108 F6: the regex is anchored at BOTH ends. An unanchored tail let any
  // string that merely started with a version clear the floor.
  it.each([
    ["v22.21.0", [22, 21, 0], true],
    ["22.21.0", [22, 21, 0], true],
    ["v24.0.0", [24, 0, 0], true],
    ["v22.21.0-nightly1", [22, 21, 0], true],
    ["v24.1.0+build.7", [24, 1, 0], true],
    ["v22.21.0garbage", null, false],
    ["v24.0.0-not-node", [24, 0, 0], true],
    ["v24.0.0 && rm -rf /", null, false],
    ["v22.21", null, false],
    ["22.21.0.1", null, false],
    ["vv22.21.0", null, false],
    ["prefix v24.0.0", null, false],
  ] as const)("parses %s to %j (supported: %s)", (raw, expected, supported) => {
    expect(parseNodeVersion(raw)).toEqual(
      expected === null ? null : [...expected],
    );
    expect(nodeSupportsEnvProxy(raw)).toBe(supported);
  });

  it("tolerates a missing leading v and trailing newline", () => {
    expect(nodeSupportsEnvProxy("22.21.0\n")).toBe(true);
    expect(parseNodeVersion("v22.22.1\n")).toEqual([22, 22, 1]);
  });
});

describe("assertNodeBinSupportsEnvProxy", () => {
  it("resolves for a supported node", async () => {
    await expect(
      assertNodeBinSupportsEnvProxy({
        nodeBin: "/usr/local/automata/bin/node",
        exec: async () => ({ stdout: "v22.22.1\n" }),
      }),
    ).resolves.toBeUndefined();
  });

  it("throws, naming the binary and the floor, for an unsupported node", async () => {
    await expect(
      assertNodeBinSupportsEnvProxy({
        nodeBin: "/opt/node20/bin/node",
        exec: async () => ({ stdout: "v20.19.0\n" }),
      }),
    ).rejects.toThrow(
      /\/opt\/node20\/bin\/node reports v20\.19\.0.*22\.21\.0/s,
    );
  });

  it("throws when the probe itself fails rather than assuming support", async () => {
    await expect(
      assertNodeBinSupportsEnvProxy({
        nodeBin: "/nope/node",
        exec: async () => {
          throw new Error("ENOENT");
        },
      }),
    ).rejects.toThrow(/could not be probed: ENOENT/);
  });
});
