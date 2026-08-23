import { describe, it, expect } from "vitest";
import {
  toE2bNetwork,
  toE2bBrokeredNetwork,
  E2B_BROKER_GITHUB_HOSTS,
  toDaytonaNetwork,
  DAYTONA_MAX_DOMAIN_ALLOWLIST,
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
    it("throws — networkAllowList (CIDR-only) is mutually exclusive with domainAllowList, so the hostname system entries cannot be expressed", () => {
      // buildEgressPolicyShape merges hostname system entries (callback host,
      // github.com, api.github.com, api.anthropic.com) into the FINAL
      // allowlist at EVERY level, including ip_port — the shape's CONTRACT
      // NOTE forbids dropping them, and Daytona's CIDR list cannot carry
      // them (nor can it coexist with domainAllowList at creation). The
      // mapper must refuse loudly at create time, exactly like "none".
      expect(() =>
        toDaytonaNetwork(
          policy("ip_port", [
            "10.0.0.1:8080",
            "callback.example.com",
            "github.com",
            "api.github.com",
            "api.anthropic.com",
          ]),
        ),
      ).toThrow(/"ip_port" is unsupported on the daytona provider/);
    });

    it("throws even for a pure-IP allowlist — the system hostnames are always merged in by real dispatch", () => {
      expect(() =>
        toDaytonaNetwork(policy("ip_port", ["10.0.0.1", "10.0.0.0/24"])),
      ).toThrow(/use "domain" level/);
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
      ).toThrow(/"none" is unsupported on the daytona provider/);
    });
  });
});

describe("toE2bBrokeredNetwork (#114)", () => {
  const AUTH = "token ${e2b.secrets.gh-inst-sb1}";

  it("registers a header-injection rule for BOTH github hosts", () => {
    const net = toE2bBrokeredNetwork({ authHeaderValue: AUTH });
    for (const host of E2B_BROKER_GITHUB_HOSTS) {
      expect(net.rules[host]).toEqual([
        { transform: { headers: { Authorization: AUTH } } },
      ]);
    }
    expect(Object.keys(net.rules).sort()).toEqual(
      [...E2B_BROKER_GITHUB_HOSTS].sort(),
    );
  });

  it("no egress policy: keeps OPEN internet (0.0.0.0/0) + hosts, no denyOut", () => {
    const net = toE2bBrokeredNetwork({ authHeaderValue: AUTH });
    expect(net.allowOut).toEqual(["0.0.0.0/0", "github.com", "api.github.com"]);
    expect(net.denyOut).toBeUndefined();
  });

  it("with egress policy: composes deny-all + MERGES hosts into the allowlist (never clobbers)", () => {
    const net = toE2bBrokeredNetwork({
      authHeaderValue: AUTH,
      egressPolicy: {
        level: "domain",
        allowlist: ["example.com", "registry.npmjs.org"],
      },
    });
    expect(net.denyOut).toEqual(["0.0.0.0/0"]);
    // Repo allowlist entries preserved, github hosts appended.
    expect(net.allowOut).toEqual([
      "example.com",
      "registry.npmjs.org",
      "github.com",
      "api.github.com",
    ]);
    // The rules still fire for both hosts.
    expect(Object.keys(net.rules).sort()).toEqual(
      [...E2B_BROKER_GITHUB_HOSTS].sort(),
    );
  });

  it("does NOT duplicate a github host already in the egress allowlist", () => {
    const net = toE2bBrokeredNetwork({
      authHeaderValue: AUTH,
      egressPolicy: {
        level: "domain",
        allowlist: ["github.com", "api.github.com", "example.com"],
      },
    });
    expect(net.allowOut).toEqual([
      "github.com",
      "api.github.com",
      "example.com",
    ]);
  });

  it("carries no secret material — only the caller-built placeholder header", () => {
    const net = toE2bBrokeredNetwork({ authHeaderValue: AUTH });
    // The mapper never sees a raw token; the value it stores is the inert
    // placeholder the caller passed in.
    expect(JSON.stringify(net)).toContain("${e2b.secrets.gh-inst-sb1}");
    expect(JSON.stringify(net)).not.toContain("ghs_");
  });
});
