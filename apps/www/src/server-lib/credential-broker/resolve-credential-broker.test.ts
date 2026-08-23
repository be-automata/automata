import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "@terragon/env/apps-www";
import type { SandboxProvider } from "@terragon/types/sandbox";
import {
  isCredentialBrokerEnabled,
  resolveCredentialBrokerForCreate,
} from "./resolve-credential-broker";

// The resolver reads env.SANDBOX_CREDENTIAL_BROKER on each call, so flipping the
// deploy gate per test is enough. The envsafe object is mutable under Vitest;
// snapshot + restore keeps the flip from leaking into other suites.
const RAW_TOKEN = "ghs_installation_token_do_not_leak";
const REPO = "be-automata/automata";
let originalFlag: string;

function setFlag(value: string) {
  (env as { SANDBOX_CREDENTIAL_BROKER: string }).SANDBOX_CREDENTIAL_BROKER =
    value;
}

function resolve(sandboxProvider: SandboxProvider) {
  return resolveCredentialBrokerForCreate({
    sandboxProvider,
    githubRepoFullName: REPO,
    githubAccessToken: RAW_TOKEN,
  });
}

describe("resolve-credential-broker", () => {
  beforeEach(() => {
    originalFlag = env.SANDBOX_CREDENTIAL_BROKER;
    setFlag("legacy-direct");
  });
  afterEach(() => {
    setFlag(originalFlag);
  });

  describe("isCredentialBrokerEnabled", () => {
    it("is enabled only for the exact value 'on'", () => {
      setFlag("on");
      expect(isCredentialBrokerEnabled()).toBe(true);
    });

    it("is disabled for the default 'legacy-direct'", () => {
      setFlag("legacy-direct");
      expect(isCredentialBrokerEnabled()).toBe(false);
    });

    it("is disabled for any other value (incl. empty / truthy-looking)", () => {
      for (const value of ["", "off", "ON", "true", "1", "enabled"]) {
        setFlag(value);
        expect(isCredentialBrokerEnabled()).toBe(false);
      }
    });
  });

  describe("resolveCredentialBrokerForCreate", () => {
    it("returns null when the flag is off, even for docker (raw-token path)", () => {
      setFlag("legacy-direct");
      expect(resolve("docker")).toBeNull();
    });

    it("returns null for a non-docker provider even when the flag is on", () => {
      setFlag("on");
      for (const provider of [
        "e2b",
        "daytona",
        "mock",
        "hatchet-remote",
      ] as const) {
        expect(resolve(provider)).toBeNull();
      }
    });

    it("returns a brokered shape for docker + flag on", () => {
      setFlag("on");
      const result = resolve("docker");
      expect(result).not.toBeNull();
      expect(result?.mode).toBe("brokered");
      expect(result?.shape.installationToken).toBe(RAW_TOKEN);
      expect(result?.shape.repoFullName).toBe(REPO);
      // Per-run bearer: fresh, non-empty, and NOT the raw token.
      expect(result?.shape.runBearer).toBeTruthy();
      expect(result?.shape.runBearer).not.toBe(RAW_TOKEN);
    });

    it("mints a fresh per-run bearer on each call", () => {
      setFlag("on");
      const first = resolve("docker");
      const second = resolve("docker");
      expect(first?.shape.runBearer).toBeTruthy();
      expect(second?.shape.runBearer).toBeTruthy();
      expect(first?.shape.runBearer).not.toBe(second?.shape.runBearer);
    });
  });
});
