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
    ).rejects.toThrow(/\/opt\/node20\/bin\/node reports v20\.19\.0.*22\.21\.0/s);
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
