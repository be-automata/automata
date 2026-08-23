import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "@terragon/env/apps-www";
import type { FeatureFlagName } from "@terragon/shared";
import type { SandboxProvider } from "@terragon/types/sandbox";
import {
  isCredentialBrokerEnabled,
  isCredentialBrokerEnvForceOn,
  resolveCredentialBrokerForCreate,
  resolveCredentialBrokerForResume,
} from "./resolve-credential-broker";

// #114: the broker is gated on the `sandboxCredentialBroker` feature flag,
// resolved SERVER-SIDE by the caller (getFeatureFlagsForUser) and passed into the
// resolver as a per-user flag map. The SANDBOX_CREDENTIAL_BROKER env var stays a
// global force-on override. Tests drive both inputs directly — no DB needed.
const RAW_TOKEN = "ghs_installation_token_do_not_leak";
const REPO = "be-automata/automata";
let originalEnv: string;

function setEnv(value: string) {
  (env as { SANDBOX_CREDENTIAL_BROKER: string }).SANDBOX_CREDENTIAL_BROKER =
    value;
}

type Flags = Partial<Record<FeatureFlagName, boolean>> | null | undefined;
const FLAG_ON: Flags = { sandboxCredentialBroker: true };
const FLAG_OFF: Flags = { sandboxCredentialBroker: false };

function resolve(sandboxProvider: SandboxProvider, featureFlags: Flags) {
  return resolveCredentialBrokerForCreate({
    sandboxProvider,
    githubRepoFullName: REPO,
    githubAccessToken: RAW_TOKEN,
    featureFlags,
  });
}

describe("resolve-credential-broker", () => {
  beforeEach(() => {
    originalEnv = env.SANDBOX_CREDENTIAL_BROKER;
    setEnv("legacy-direct");
  });
  afterEach(() => {
    setEnv(originalEnv);
  });

  describe("isCredentialBrokerEnvForceOn", () => {
    it("is force-on only for the exact value 'on'", () => {
      setEnv("on");
      expect(isCredentialBrokerEnvForceOn()).toBe(true);
    });

    it("is off for the default 'legacy-direct'", () => {
      setEnv("legacy-direct");
      expect(isCredentialBrokerEnvForceOn()).toBe(false);
    });

    it("is off for any other value (incl. empty / truthy-looking)", () => {
      for (const value of ["", "off", "ON", "true", "1", "enabled"]) {
        setEnv(value);
        expect(isCredentialBrokerEnvForceOn()).toBe(false);
      }
    });
  });

  describe("isCredentialBrokerEnabled", () => {
    it("is enabled when the per-user flag is on (env not force-on)", () => {
      expect(isCredentialBrokerEnabled(FLAG_ON)).toBe(true);
    });

    it("is disabled (default OFF) when the flag is off and env is not force-on", () => {
      expect(isCredentialBrokerEnabled(FLAG_OFF)).toBe(false);
    });

    it("fails safe to OFF when the flag map is missing/undefined", () => {
      // A missing map (flag lookup gap) must never enable brokering.
      expect(isCredentialBrokerEnabled(undefined)).toBe(false);
      expect(isCredentialBrokerEnabled(null)).toBe(false);
      expect(isCredentialBrokerEnabled({})).toBe(false);
    });

    it("is force-on via the env kill switch regardless of the flag", () => {
      setEnv("on");
      expect(isCredentialBrokerEnabled(FLAG_OFF)).toBe(true);
      expect(isCredentialBrokerEnabled(undefined)).toBe(true);
    });
  });

  describe("resolveCredentialBrokerForCreate", () => {
    it("returns null when the flag is off, even for docker (raw-token path)", () => {
      expect(resolve("docker", FLAG_OFF)).toBeNull();
    });

    it("returns null (fail-safe) for docker when the flag map is missing", () => {
      expect(resolve("docker", undefined)).toBeNull();
      expect(resolve("docker", null)).toBeNull();
    });

    it("returns null for an unbrokered provider even when the flag is on", () => {
      for (const provider of ["daytona", "mock", "hatchet-remote"] as const) {
        expect(resolve(provider, FLAG_ON)).toBeNull();
      }
    });

    it("returns null for any provider when the flag is off (fail-safe)", () => {
      for (const provider of ["docker", "e2b"] as const) {
        expect(resolve(provider, FLAG_OFF)).toBeNull();
        expect(resolve(provider, undefined)).toBeNull();
      }
    });

    it("returns a docker-sidecar shape for docker + flag on", () => {
      const result = resolve("docker", FLAG_ON);
      expect(result).not.toBeNull();
      expect(result?.mode).toBe("brokered");
      if (result?.shape.kind !== "docker-sidecar") {
        throw new Error("expected a docker-sidecar shape");
      }
      expect(result.shape.installationToken).toBe(RAW_TOKEN);
      expect(result.shape.repoFullName).toBe(REPO);
      // Per-run bearer: fresh, non-empty, and NOT the raw token.
      expect(result.shape.runBearer).toBeTruthy();
      expect(result.shape.runBearer).not.toBe(RAW_TOKEN);
    });

    it("returns an e2b-native shape for e2b + flag on (no bearer)", () => {
      const result = resolve("e2b", FLAG_ON);
      expect(result).not.toBeNull();
      expect(result?.mode).toBe("brokered");
      if (result?.shape.kind !== "e2b-native") {
        throw new Error("expected an e2b-native shape");
      }
      // The token seeds E2B's vault; the guest never receives it.
      expect(result.shape.installationToken).toBe(RAW_TOKEN);
      expect(result.shape.repoFullName).toBe(REPO);
      // No per-run bearer on the E2B path.
      expect("runBearer" in result.shape).toBe(false);
    });

    it("returns an e2b-native shape via the env force-on override (flag off)", () => {
      setEnv("on");
      const result = resolve("e2b", FLAG_OFF);
      expect(result?.shape.kind).toBe("e2b-native");
      expect(result?.mode).toBe("brokered");
    });

    it("returns a docker-sidecar shape for docker via env force-on (flag off)", () => {
      setEnv("on");
      const result = resolve("docker", FLAG_OFF);
      expect(result).not.toBeNull();
      expect(result?.mode).toBe("brokered");
      expect(result?.shape.kind).toBe("docker-sidecar");
      expect(result?.shape.installationToken).toBe(RAW_TOKEN);
    });

    it("mints a fresh per-run bearer on each docker call", () => {
      const first = resolve("docker", FLAG_ON);
      const second = resolve("docker", FLAG_ON);
      if (
        first?.shape.kind !== "docker-sidecar" ||
        second?.shape.kind !== "docker-sidecar"
      ) {
        throw new Error("expected docker-sidecar shapes");
      }
      expect(first.shape.runBearer).toBeTruthy();
      expect(second.shape.runBearer).toBeTruthy();
      expect(first.shape.runBearer).not.toBe(second.shape.runBearer);
    });
  });

  describe("resolveCredentialBrokerForResume", () => {
    function resume(
      sandboxProvider: SandboxProvider,
      persistedBrokerMode: "brokered" | "legacy-direct" | null | undefined,
    ) {
      return resolveCredentialBrokerForResume({
        sandboxProvider,
        githubRepoFullName: REPO,
        githubAccessToken: RAW_TOKEN,
        persistedBrokerMode,
      });
    }

    it("returns an e2b-native refresh shape for e2b + persisted brokered", () => {
      const result = resume("e2b", "brokered");
      expect(result).not.toBeNull();
      if (result?.shape.kind !== "e2b-native") {
        throw new Error("expected an e2b-native shape");
      }
      // Carries the FRESH token so the provider can refresh the vault secret.
      expect(result.shape.installationToken).toBe(RAW_TOKEN);
      expect(result.shape.repoFullName).toBe(REPO);
    });

    it("is gated on the PERSISTED mode, not the current flag (flag not consulted)", () => {
      // No flag input at all — resume relies on persisted provenance only.
      setEnv("legacy-direct");
      expect(resume("e2b", "brokered")?.shape.kind).toBe("e2b-native");
    });

    it("returns null for e2b when the thread was never brokered", () => {
      expect(resume("e2b", "legacy-direct")).toBeNull();
      expect(resume("e2b", null)).toBeNull();
      expect(resume("e2b", undefined)).toBeNull();
    });

    it("returns null for docker (docker recreates on resume, never in place)", () => {
      expect(resume("docker", "brokered")).toBeNull();
    });

    it("returns null for other providers even when persisted brokered", () => {
      for (const provider of ["daytona", "mock", "hatchet-remote"] as const) {
        expect(resume(provider, "brokered")).toBeNull();
      }
    });
  });
});
