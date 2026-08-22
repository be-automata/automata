import { describe, expect, it } from "vitest";
import { buildEgressPolicyShape } from "./egress-policy";

/**
 * Pure shape-builder tests (#66 spec §3.2): level mapping, system-host merge +
 * dedupe, `none` ⇒ system-only, entry validation per level (throw on invalid —
 * a run must fail loudly at resolve time, never launch with a silently-wrong
 * policy).
 */

const systemHosts = ["app.example.com", "github.com", "api.anthropic.com"];

describe("buildEgressPolicyShape", () => {
  it("null egressPolicy → null (no enforcement, today's behavior)", () => {
    expect(
      buildEgressPolicyShape(
        { egressPolicy: null, egressAllowlist: ["1.2.3.4"] },
        { systemHosts },
      ),
    ).toBeNull();
  });

  it("unknown level → throws with a clear message", () => {
    expect(() =>
      buildEgressPolicyShape(
        { egressPolicy: "everything", egressAllowlist: null },
        { systemHosts },
      ),
    ).toThrow(/Invalid egress policy level "everything"/);
  });

  it("'none' → system hosts ONLY (operator entries ignored, never validated)", () => {
    const shape = buildEgressPolicyShape(
      // Deliberately-garbage entries: level 'none' never consults them.
      { egressPolicy: "none", egressAllowlist: ["!!not-a-host!!"] },
      { systemHosts },
    );
    expect(shape).toEqual({ level: "none", allowlist: systemHosts });
  });

  it("'ip_port' → merges IP / IP:port entries with system hosts, deduped", () => {
    const shape = buildEgressPolicyShape(
      {
        egressPolicy: "ip_port",
        // Duplicate entry → deduped in the final allowlist.
        egressAllowlist: ["10.0.0.5", "192.168.1.7:8443", "10.0.0.5"],
      },
      { systemHosts },
    );
    expect(shape).toEqual({
      level: "ip_port",
      // Operator entries first, deduped, then system hosts.
      allowlist: ["10.0.0.5", "192.168.1.7:8443", ...systemHosts],
    });
  });

  it("'ip_port' rejects a domain entry", () => {
    expect(() =>
      buildEgressPolicyShape(
        { egressPolicy: "ip_port", egressAllowlist: ["evil.example.com"] },
        { systemHosts },
      ),
    ).toThrow(/expected an IP or IP:port/);
  });

  it("'ip_port' rejects an out-of-range port", () => {
    expect(() =>
      buildEgressPolicyShape(
        { egressPolicy: "ip_port", egressAllowlist: ["10.0.0.5:70000"] },
        { systemHosts },
      ),
    ).toThrow(/port "70000"/);
  });

  it("'domain' accepts domain, *.domain wildcard, and host:port; merges + dedupes system hosts", () => {
    const shape = buildEgressPolicyShape(
      {
        egressPolicy: "domain",
        egressAllowlist: [
          "registry.npmjs.org",
          "*.githubusercontent.com",
          "artifacts.internal.corp:8443",
          "github.com", // already a system host → deduped
        ],
      },
      { systemHosts },
    );
    expect(shape).toEqual({
      level: "domain",
      allowlist: [
        "registry.npmjs.org",
        "*.githubusercontent.com",
        "artifacts.internal.corp:8443",
        "github.com",
        "app.example.com",
        "api.anthropic.com",
      ],
    });
  });

  it("'domain' rejects a garbage entry, naming it", () => {
    expect(() =>
      buildEgressPolicyShape(
        { egressPolicy: "domain", egressAllowlist: ["not a host"] },
        { systemHosts },
      ),
    ).toThrow(/Invalid egress allowlist entry "not a host"/);
  });

  it("'domain' rejects a bare wildcard and a single label", () => {
    expect(() =>
      buildEgressPolicyShape(
        { egressPolicy: "domain", egressAllowlist: ["*."] },
        { systemHosts },
      ),
    ).toThrow(/Invalid egress allowlist entry/);
    expect(() =>
      buildEgressPolicyShape(
        { egressPolicy: "domain", egressAllowlist: ["localhost"] },
        { systemHosts },
      ),
    ).toThrow(/Invalid egress allowlist entry/);
  });

  it("empty/null operator allowlist → system hosts only at enforcing levels", () => {
    expect(
      buildEgressPolicyShape(
        { egressPolicy: "domain", egressAllowlist: null },
        { systemHosts },
      ),
    ).toEqual({ level: "domain", allowlist: systemHosts });
  });
});
