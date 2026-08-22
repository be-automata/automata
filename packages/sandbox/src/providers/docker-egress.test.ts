import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  EGRESS_PROXY_ALIAS,
  EGRESS_PROXY_PORT,
  EGRESS_PROXY_SCRIPT_CONTAINER_PATH,
  buildEgressNetworkCreateCommand,
  buildEgressSidecarBridgeConnectCommand,
  buildEgressSidecarRunCommand,
  buildEgressTeardownCommands,
  buildSandboxEgressRunFlags,
  egressNetworkName,
  egressSidecarName,
} from "./docker-egress";
import { EGRESS_PROXY_SCRIPT } from "../egress-proxy-standalone.generated";

const require = createRequire(import.meta.url);

describe("docker egress command builders (pure — no docker daemon)", () => {
  it("derives network and sidecar names from the container name", () => {
    expect(egressNetworkName("terragon-sandbox-x")).toBe(
      "automata-egress-terragon-sandbox-x",
    );
    expect(egressSidecarName("terragon-sandbox-x")).toBe(
      "terragon-sandbox-x-egress",
    );
  });

  it("creates the network as --internal (no direct route out)", () => {
    expect(buildEgressNetworkCreateCommand("automata-egress-n")).toBe(
      "docker network create --internal automata-egress-n",
    );
  });

  it("builds the sidecar run command: internal net, alias, ro mount, shape-only env", () => {
    const command = buildEgressSidecarRunCommand({
      sidecarName: "sb-egress",
      networkName: "automata-egress-sb",
      baseImage: "ghcr.io/terragon-labs/containers-test",
      scriptHostPath: "/tmp/x/egress-proxy.cjs",
      policy: { level: "domain", allowlist: ["example.com", "*.example.org"] },
    });
    expect(command).toContain("docker run -d --name sb-egress");
    expect(command).toContain("--network automata-egress-sb");
    expect(command).toContain(`--network-alias ${EGRESS_PROXY_ALIAS}`);
    expect(command).toContain(
      `-v '/tmp/x/egress-proxy.cjs':${EGRESS_PROXY_SCRIPT_CONTAINER_PATH}:ro`,
    );
    expect(command).toContain(
      `-e EGRESS_POLICY_JSON='{"level":"domain","allowlist":["example.com","*.example.org"]}'`,
    );
    expect(command).toContain(`-e EGRESS_PROXY_PORT=${EGRESS_PROXY_PORT}`);
    expect(command).toContain(
      `ghcr.io/terragon-labs/containers-test node ${EGRESS_PROXY_SCRIPT_CONTAINER_PATH}`,
    );
    // Composability invariant: only the shape crosses — never table/model names.
    expect(command).not.toContain("repoReviewSettings");
    expect(command).not.toContain("egress_policy");
  });

  it("connects only the sidecar to the bridge", () => {
    expect(buildEgressSidecarBridgeConnectCommand("sb-egress")).toBe(
      "docker network connect bridge sb-egress",
    );
  });

  it("builds sandbox run flags: internal network + proxy env, NO_PROXY loopback", () => {
    const flags = buildSandboxEgressRunFlags("automata-egress-sb");
    expect(flags).toContain("--network automata-egress-sb");
    const proxyUrl = `http://${EGRESS_PROXY_ALIAS}:${EGRESS_PROXY_PORT}`;
    for (const key of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "http_proxy",
      "https_proxy",
    ]) {
      expect(flags).toContain(`-e ${key}='${proxyUrl}'`);
    }
    for (const key of ["NO_PROXY", "no_proxy"]) {
      expect(flags).toContain(`-e ${key}='127.0.0.1,localhost'`);
    }
  });

  it("tears down sidecar then network", () => {
    expect(buildEgressTeardownCommands("sb")).toEqual([
      "docker rm -f sb-egress",
      "docker network rm automata-egress-sb",
    ]);
  });
});

describe("egress-proxy-standalone.cjs", () => {
  it("generated TS module is in sync with the .cjs source (run pnpm -C packages/sandbox build-egress-proxy)", () => {
    const source = readFileSync(
      join(__dirname, "..", "egress-proxy-standalone.cjs"),
      "utf8",
    );
    expect(EGRESS_PROXY_SCRIPT).toBe(source);
  });

  // The matcher below MIRRORS packages/worker/src/agent-run/egress-proxy.ts
  // (one matcher source per package). These table tests pin the mirrored
  // semantics at this plane.
  const {
    matchEgress,
    parsePolicy,
  } = require("../egress-proxy-standalone.cjs");

  describe("matchEgress (mirrored from the worker proxy)", () => {
    it("domain level: exact match on ports 80/443 only", () => {
      const policy = { level: "domain", allowlist: ["example.com"] };
      expect(matchEgress(policy, "example.com", 443)).toBe(true);
      expect(matchEgress(policy, "example.com", 80)).toBe(true);
      expect(matchEgress(policy, "example.com", 8443)).toBe(false);
      expect(matchEgress(policy, "evil.com", 443)).toBe(false);
    });

    it("domain level: *.wildcard suffix match", () => {
      const policy = { level: "domain", allowlist: ["*.example.com"] };
      expect(matchEgress(policy, "a.example.com", 443)).toBe(true);
      expect(matchEgress(policy, "a.b.example.com", 443)).toBe(true);
      expect(matchEgress(policy, "example.com", 443)).toBe(false);
      expect(matchEgress(policy, "notexample.com", 443)).toBe(false);
    });

    it("domain level: host:port entry pins the port", () => {
      const policy = { level: "domain", allowlist: ["example.com:8443"] };
      expect(matchEgress(policy, "example.com", 8443)).toBe(true);
      expect(matchEgress(policy, "example.com", 443)).toBe(false);
    });

    it("ip_port level: bare IP matches any port, IP:port pins it", () => {
      const policy = {
        level: "ip_port",
        allowlist: ["10.0.0.1", "10.0.0.2:9000"],
      };
      expect(matchEgress(policy, "10.0.0.1", 1234)).toBe(true);
      expect(matchEgress(policy, "10.0.0.2", 9000)).toBe(true);
      expect(matchEgress(policy, "10.0.0.2", 9001)).toBe(false);
      expect(matchEgress(policy, "10.0.0.3", 443)).toBe(false);
    });

    it("none level: only the (system) allowlist matches", () => {
      const policy = { level: "none", allowlist: ["callback.example.com"] };
      expect(matchEgress(policy, "callback.example.com", 443)).toBe(true);
      expect(matchEgress(policy, "github.com", 443)).toBe(false);
    });

    it("loopback is implicitly allowed at every level", () => {
      for (const level of ["none", "ip_port", "domain"]) {
        const policy = { level, allowlist: [] };
        expect(matchEgress(policy, "127.0.0.1", 5555)).toBe(true);
        expect(matchEgress(policy, "localhost", 5555)).toBe(true);
        expect(matchEgress(policy, "::1", 5555)).toBe(true);
      }
    });

    it("fails closed on empty host and normalizes trailing-dot FQDNs", () => {
      const policy = { level: "domain", allowlist: ["example.com"] };
      expect(matchEgress(policy, "", 443)).toBe(false);
      expect(matchEgress(policy, "example.com.", 443)).toBe(true);
    });
  });

  describe("parsePolicy", () => {
    it("accepts a valid shape", () => {
      expect(
        parsePolicy('{"level":"domain","allowlist":["example.com"]}'),
      ).toEqual({ level: "domain", allowlist: ["example.com"] });
    });

    it("fails closed on garbage", () => {
      expect(() => parsePolicy("")).toThrow(/not JSON/);
      expect(() => parsePolicy('{"level":"nope","allowlist":[]}')).toThrow(
        /policy must be/,
      );
      expect(() => parsePolicy('{"level":"domain"}')).toThrow(/policy must be/);
      expect(() => parsePolicy('{"level":"domain","allowlist":[1]}')).toThrow(
        /policy must be/,
      );
    });
  });
});
