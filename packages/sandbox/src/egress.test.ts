import { describe, it, expect } from "vitest";
import {
  toE2bNetwork,
  toDaytonaNetwork,
  DAYTONA_MAX_DOMAIN_ALLOWLIST,
  DAYTONA_MAX_NETWORK_ALLOWLIST,
  type EgressPolicyShape,
} from "./egress";

function policy(
  level: EgressPolicyShape["level"],
  allowlist: string[],
): EgressPolicyShape {
  return { level, allowlist };
}

describe("toE2bNetwork", () => {
  it("maps domain level to deny-all + allowlist", () => {
    expect(
      toE2bNetwork(policy("domain", ["example.com", "api.example.com"])),
    ).toEqual({
      denyOut: ["0.0.0.0/0"],
      allowOut: ["example.com", "api.example.com"],
    });
  });

  it("keeps wildcard entries verbatim", () => {
    expect(toE2bNetwork(policy("domain", ["*.example.com"])).allowOut).toEqual([
      "*.example.com",
    ]);
  });

  it("strips port pins (E2B selectors are port-less)", () => {
    expect(
      toE2bNetwork(policy("domain", ["example.com:8443", "example.com"]))
        .allowOut,
    ).toEqual(["example.com"]);
  });

  it("maps ip_port level: bare IPs and IP:port both become the bare IP", () => {
    expect(
      toE2bNetwork(policy("ip_port", ["10.0.0.1", "10.0.0.2:8080"])),
    ).toEqual({
      denyOut: ["0.0.0.0/0"],
      allowOut: ["10.0.0.1", "10.0.0.2"],
    });
  });

  it("passes CIDR entries through untouched (never mistaken for host:port)", () => {
    expect(toE2bNetwork(policy("ip_port", ["10.0.0.0/24"])).allowOut).toEqual([
      "10.0.0.0/24",
    ]);
  });

  it("maps none level to deny-all + the (system-only) allowlist", () => {
    expect(
      toE2bNetwork(policy("none", ["callback.example.com", "github.com"])),
    ).toEqual({
      denyOut: ["0.0.0.0/0"],
      allowOut: ["callback.example.com", "github.com"],
    });
  });

  it("normalizes: trims, lowercases, drops empties, dedupes", () => {
    expect(
      toE2bNetwork(policy("domain", [" Example.COM ", "", "example.com", "  "]))
        .allowOut,
    ).toEqual(["example.com"]);
  });

  it("an empty allowlist still deny-alls (never fails open)", () => {
    expect(toE2bNetwork(policy("domain", []))).toEqual({
      denyOut: ["0.0.0.0/0"],
      allowOut: [],
    });
  });
});

describe("toDaytonaNetwork", () => {
  describe("ip_port level", () => {
    it("converts a bare IPv4 to /32", () => {
      expect(toDaytonaNetwork(policy("ip_port", ["10.0.0.1"]))).toEqual({
        networkAllowList: "10.0.0.1/32",
      });
    });

    it("drops the port from IP:port entries (CIDR list is port-less)", () => {
      expect(toDaytonaNetwork(policy("ip_port", ["10.0.0.1:8080"]))).toEqual({
        networkAllowList: "10.0.0.1/32",
      });
    });

    it("passes CIDRs through and joins with commas", () => {
      expect(
        toDaytonaNetwork(policy("ip_port", ["10.0.0.0/24", "192.168.1.5"])),
      ).toEqual({
        networkAllowList: "10.0.0.0/24,192.168.1.5/32",
      });
    });

    it("dedupes entries that collapse to the same CIDR", () => {
      expect(
        toDaytonaNetwork(policy("ip_port", ["10.0.0.1", "10.0.0.1:443"])),
      ).toEqual({ networkAllowList: "10.0.0.1/32" });
    });

    it("routes hostname-shaped (system) entries to domainAllowList — never drops or rejects them (CONTRACT NOTE)", () => {
      // buildEgressPolicyShape merges hostname system entries (callback host,
      // github.com, api.github.com, api.anthropic.com) into the FINAL
      // allowlist at EVERY level, including ip_port. This is the exact shape
      // real dispatch hands the mapper: it must create, not throw.
      expect(
        toDaytonaNetwork(
          policy("ip_port", [
            "10.0.0.1:8080",
            "callback.example.com",
            "github.com",
            "api.github.com",
            "api.anthropic.com",
          ]),
        ),
      ).toEqual({
        networkAllowList: "10.0.0.1/32",
        domainAllowList:
          "callback.example.com,github.com,api.github.com,api.anthropic.com",
      });
    });

    it("a non-IPv4 look-alike (out-of-range octet) falls to domainAllowList — fail-closed, never widened", () => {
      // Operator entries are constrained to IP[:port] at the write boundary,
      // so this can't come from an operator; as a "domain" it matches nothing.
      expect(toDaytonaNetwork(policy("ip_port", ["999.0.0.1"]))).toEqual({
        networkAllowList: "",
        domainAllowList: "999.0.0.1",
      });
    });

    it(`rejects more than ${DAYTONA_MAX_DOMAIN_ALLOWLIST} hostname entries at ip_port level instead of truncating`, () => {
      const entries = Array.from(
        { length: DAYTONA_MAX_DOMAIN_ALLOWLIST + 1 },
        (_, i) => `host${i}.example.com`,
      );
      expect(() => toDaytonaNetwork(policy("ip_port", entries))).toThrow(
        /refusing to truncate/,
      );
    });

    it(`rejects more than ${DAYTONA_MAX_NETWORK_ALLOWLIST} CIDRs instead of truncating`, () => {
      const entries = Array.from(
        { length: DAYTONA_MAX_NETWORK_ALLOWLIST + 1 },
        (_, i) => `10.0.0.${i}`,
      );
      expect(() => toDaytonaNetwork(policy("ip_port", entries))).toThrow(
        /refusing to truncate/,
      );
    });

    it(`accepts exactly ${DAYTONA_MAX_NETWORK_ALLOWLIST} CIDRs`, () => {
      const entries = Array.from(
        { length: DAYTONA_MAX_NETWORK_ALLOWLIST },
        (_, i) => `10.0.0.${i}`,
      );
      const result = toDaytonaNetwork(policy("ip_port", entries));
      expect(result.networkAllowList!.split(",")).toHaveLength(
        DAYTONA_MAX_NETWORK_ALLOWLIST,
      );
    });
  });

  describe("domain level", () => {
    it("joins domains with commas, keeping wildcards", () => {
      expect(
        toDaytonaNetwork(policy("domain", ["example.com", "*.example.org"])),
      ).toEqual({
        domainAllowList: "example.com,*.example.org",
      });
    });

    it("drops port pins (domain list is port-less)", () => {
      expect(toDaytonaNetwork(policy("domain", ["example.com:8443"]))).toEqual({
        domainAllowList: "example.com",
      });
    });

    it("normalizes and dedupes", () => {
      expect(
        toDaytonaNetwork(policy("domain", [" Example.com", "example.com", ""])),
      ).toEqual({ domainAllowList: "example.com" });
    });

    it(`rejects more than ${DAYTONA_MAX_DOMAIN_ALLOWLIST} domains instead of truncating`, () => {
      const entries = Array.from(
        { length: DAYTONA_MAX_DOMAIN_ALLOWLIST + 1 },
        (_, i) => `host${i}.example.com`,
      );
      expect(() => toDaytonaNetwork(policy("domain", entries))).toThrow(
        /refusing to truncate/,
      );
    });

    it(`accepts exactly ${DAYTONA_MAX_DOMAIN_ALLOWLIST} domains`, () => {
      const entries = Array.from(
        { length: DAYTONA_MAX_DOMAIN_ALLOWLIST },
        (_, i) => `host${i}.example.com`,
      );
      const result = toDaytonaNetwork(policy("domain", entries));
      expect(result.domainAllowList!.split(",")).toHaveLength(
        DAYTONA_MAX_DOMAIN_ALLOWLIST,
      );
    });
  });

  describe("none level", () => {
    it("throws — networkBlockAll would sever the daemon callback", () => {
      expect(() =>
        toDaytonaNetwork(policy("none", ["callback.example.com"])),
      ).toThrow(/unsupported on daytona/);
    });
  });
});
