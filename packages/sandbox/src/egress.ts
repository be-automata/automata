/**
 * Provider-plane egress policy mappers (#66 slice 3, spec §3.5–§3.7).
 *
 * The control plane resolves a per-repo egress policy into a SHAPE — level +
 * FINAL allowlist (system entries such as the daemon callback host already
 * merged in control-plane-side) — and ships it on `CreateSandboxOptions`.
 * These pure helpers translate that shape into each provider's native
 * network primitives. They know NOTHING about where the policy came from
 * (no settings table, no control-plane concept — the composability
 * invariant): only the shape comes in, provider options come out.
 *
 * Provider capability cheat-sheet (why the mappings are lossy where they are):
 * - E2B (`network.allowOut`/`denyOut`): domains (incl. `*.` wildcards), IPs
 *   and CIDRs — but NO port syntax, and domain filtering only applies to
 *   ports 80/443 (Host/SNI-based). A `host:port` entry maps to its host; the
 *   port pin is lost at this plane (the worker-plane proxy still honours it).
 * - Daytona (`networkAllowList`): comma-separated CIDRs only — port-less and
 *   domain-less. (`domainAllowList`, 0.190+): comma-separated domains with
 *   `*.` wildcards, max 20 entries. The two (and `networkBlockAll`) are
 *   MUTUALLY EXCLUSIVE at creation — so only `domain` level is mappable
 *   (system entries are hostnames at every level).
 * - Docker: no native primitive — enforced by the sidecar proxy instead
 *   (providers/docker-egress.ts + egress-proxy-standalone.cjs), which reuses
 *   the worker proxy's full matching semantics including port pins.
 */

import type { EgressPolicyShape } from "./types";

// The ONE shape crossing into this plane — declared in types.ts (next to
// `CreateSandboxOptions.egressPolicy`), re-exported here for the mappers'
// consumers.
export type { EgressPolicyShape } from "./types";

/** E2B `Sandbox.create` `network` option subset produced by {@link toE2bNetwork}. */
export type E2bNetworkOptions = {
  denyOut: string[];
  allowOut: string[];
};

/**
 * Daytona `daytona.create` param subset produced by {@link toDaytonaNetwork}.
 * Only `domainAllowList` is ever produced: Daytona's three network params
 * (`networkBlockAll` / `networkAllowList` / `domainAllowList`) are mutually
 * exclusive at creation, and only the domain list can carry the hostname
 * system entries every policy level requires (see {@link toDaytonaNetwork}).
 */
export type DaytonaNetworkOptions = {
  domainAllowList: string;
};

/** Daytona's documented cap on `domainAllowList` entries. */
export const DAYTONA_MAX_DOMAIN_ALLOWLIST = 20;

/** `host:port` splitter — digits-only port suffix, so domains and IPv4 are safe. */
const HOST_PORT_RE = /^(.+):(\d{1,5})$/;

/** Trim, lowercase, drop empties, dedupe — every mapper's first pass. */
function normalizeEntries(allowlist: string[]): string[] {
  const out: string[] = [];
  for (const raw of allowlist) {
    const entry = raw.trim().toLowerCase();
    if (entry.length > 0 && !out.includes(entry)) {
      out.push(entry);
    }
  }
  return out;
}

/**
 * Split an entry into host + optional port pin. CIDRs need no special case:
 * an IPv4 CIDR has no colon and an IPv6 CIDR ends in `/nn`, so the regex
 * never matches one and it falls through whole.
 */
function splitHostPort(entry: string): { host: string; port: number | null } {
  const m = HOST_PORT_RE.exec(entry);
  if (m) {
    return { host: m[1]!, port: Number(m[2]) };
  }
  return { host: entry, port: null };
}

/**
 * Translate the shape into E2B's native firewall options (spec §3.6):
 * deny-all (`0.0.0.0/0`) plus the resolved allowlist. Port pins are dropped
 * (E2B selectors carry no port syntax) and, for `domain` level, non-80/443
 * traffic to an allowed domain is already denied by E2B itself — its domain
 * filtering only matches ports 80/443, everything else falls through to the
 * deny-all. `none` maps identically: the shape's allowlist is already just
 * the control-plane-resolved system entries.
 */
export function toE2bNetwork(policy: EgressPolicyShape): E2bNetworkOptions {
  const allowOut: string[] = [];
  for (const entry of normalizeEntries(policy.allowlist)) {
    const { host } = splitHostPort(entry);
    if (!allowOut.includes(host)) {
      allowOut.push(host);
    }
  }
  return {
    denyOut: ["0.0.0.0/0"],
    allowOut,
  };
}

/**
 * Translate the shape into Daytona create-time network params (spec §3.7).
 *
 * - `domain` → `domainAllowList` (comma-separated, `*.` wildcards allowed,
 *   max 20 entries — more is an error). Port pins are dropped (port-less).
 * - `ip_port` → ERROR: Daytona's `networkAllowList` (CIDR-only) and
 *   `domainAllowList` are MUTUALLY EXCLUSIVE at creation (provider spike on
 *   #66), so a CIDR list cannot also carry the hostname SYSTEM entries
 *   (callback host, github.com, api.github.com, api.anthropic.com) the
 *   control plane merges in at every level. Dropping them would sever the
 *   daemon callback and violate the shape's CONTRACT NOTE ("never drop");
 *   DNS-resolving them to CIDRs control-plane-side is unacceptable (GitHub/
 *   Anthropic IPs rotate — a stale IP bricks runs silently). Daytona is
 *   `domain`-level only in v1.
 * - `none` → ERROR: `networkBlockAll` alone would sever the daemon callback
 *   (violating the callback exception, AC4) — we throw rather than create a
 *   sandbox whose daemon can never phone home.
 */
/** One template for every level Daytona cannot express (#66 spec §3.7). */
function daytonaUnsupported(level: string, reason: string, remedy: string) {
  return new Error(
    `egress policy level "${level}" is unsupported on the daytona provider: ${reason} (#66 spec §3.7); ${remedy}`,
  );
}

export function toDaytonaNetwork(
  policy: EgressPolicyShape,
): DaytonaNetworkOptions {
  switch (policy.level) {
    case "none": {
      throw daytonaUnsupported(
        "none",
        "networkBlockAll would sever the daemon callback",
        "refusing to create a broken sandbox",
      );
    }
    case "ip_port": {
      // networkAllowList (CIDR-only) and domainAllowList are mutually
      // exclusive at creation (provider spike on #66) — a CIDR list cannot
      // carry the hostname system entries, and dropping or pre-resolving
      // them is forbidden (CONTRACT NOTE / rotating IPs). Fail loudly.
      throw daytonaUnsupported(
        "ip_port",
        "networkAllowList (CIDR-only) is mutually exclusive with domainAllowList, so the required system hostnames (daemon callback, github.com, api.github.com, api.anthropic.com) cannot be expressed",
        'use "domain" level',
      );
    }
    case "domain": {
      const entries = normalizeEntries(policy.allowlist);
      const domains: string[] = [];
      for (const entry of entries) {
        const { host } = splitHostPort(entry);
        if (!domains.includes(host)) {
          domains.push(host);
        }
      }
      if (domains.length > DAYTONA_MAX_DOMAIN_ALLOWLIST) {
        throw new Error(
          `egress allowlist has ${domains.length} domains but daytona domainAllowList supports at most ${DAYTONA_MAX_DOMAIN_ALLOWLIST}; refusing to truncate`,
        );
      }
      return { domainAllowList: domains.join(",") };
    }
    default: {
      const _exhaustive: never = policy.level;
      throw new Error(`unknown egress policy level: ${_exhaustive}`);
    }
  }
}
