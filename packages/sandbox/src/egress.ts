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
 *   `*.` wildcards, max 20 entries.
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

/** Daytona `daytona.create` param subset produced by {@link toDaytonaNetwork}. */
export type DaytonaNetworkOptions = {
  networkBlockAll?: boolean;
  networkAllowList?: string;
  domainAllowList?: string;
};

/** Daytona's documented cap on `domainAllowList` entries. */
export const DAYTONA_MAX_DOMAIN_ALLOWLIST = 20;
/** Daytona's documented cap on `networkAllowList` CIDRs (spec §3.7). */
export const DAYTONA_MAX_NETWORK_ALLOWLIST = 5;

/** `host:port` splitter — digits-only port suffix, so domains and IPv4 are safe. */
const HOST_PORT_RE = /^(.+):(\d{1,5})$/;

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV4_CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

function isIpv4(host: string): boolean {
  const m = IPV4_RE.exec(host);
  if (!m) {
    return false;
  }
  return m.slice(1).every((octet) => Number(octet) <= 255);
}

function isIpv4Cidr(entry: string): boolean {
  const m = IPV4_CIDR_RE.exec(entry);
  if (!m) {
    return false;
  }
  return (
    m.slice(1, 5).every((octet) => Number(octet) <= 255) && Number(m[5]) <= 32
  );
}

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

/** Split an entry into host + optional port pin. CIDRs never carry ports. */
function splitHostPort(entry: string): { host: string; port: number | null } {
  if (isIpv4Cidr(entry)) {
    return { host: entry, port: null };
  }
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
 * - `ip_port` → `networkAllowList` (comma-separated CIDRs). A bare IPv4
 *   becomes a `/32`; an `IP:port` entry loses its port (Daytona's CIDR list
 *   is port-less — documented limitation); a CIDR passes through. Hostname-
 *   shaped entries are the SYSTEM entries (callback host, github.com, …) the
 *   control plane merges in at EVERY level — the shape's CONTRACT NOTE says
 *   enforcers must match them by SNI/Host, never drop them — so they route to
 *   `domainAllowList` (Daytona's Host/SNI matcher). Operator entries are
 *   already constrained to IP[:port] at the write/resolve boundary. Max 5
 *   CIDRs / 20 domains — more is an error, never a silent truncation.
 * - `domain` → `domainAllowList` (comma-separated, `*.` wildcards allowed,
 *   max 20 entries — more is an error). Port pins are dropped (port-less).
 * - `none` → ERROR: `networkBlockAll` alone would sever the daemon callback
 *   (violating the callback exception, AC4) — we throw rather than create a
 *   sandbox whose daemon can never phone home.
 */
export function toDaytonaNetwork(
  policy: EgressPolicyShape,
): DaytonaNetworkOptions {
  const entries = normalizeEntries(policy.allowlist);
  switch (policy.level) {
    case "none": {
      throw new Error(
        'egress policy level "none" is unsupported on daytona: networkBlockAll would sever the daemon callback (#66 spec §3.7); refusing to create a broken sandbox',
      );
    }
    case "ip_port": {
      const cidrs: string[] = [];
      const domains: string[] = [];
      for (const entry of entries) {
        const { host } = splitHostPort(entry);
        if (isIpv4Cidr(host)) {
          if (!cidrs.includes(host)) {
            cidrs.push(host);
          }
        } else if (isIpv4(host)) {
          const cidr = `${host}/32`;
          if (!cidrs.includes(cidr)) {
            cidrs.push(cidr);
          }
        } else if (!domains.includes(host)) {
          // Hostname-shaped ⇒ a system entry (operator entries are IP[:port]
          // by write-boundary validation). CONTRACT NOTE: never drop these —
          // Daytona's domainAllowList (Host/SNI match) carries them.
          domains.push(host);
        }
      }
      if (cidrs.length > DAYTONA_MAX_NETWORK_ALLOWLIST) {
        throw new Error(
          `egress allowlist has ${cidrs.length} CIDRs but daytona networkAllowList supports at most ${DAYTONA_MAX_NETWORK_ALLOWLIST}; refusing to truncate`,
        );
      }
      if (domains.length > DAYTONA_MAX_DOMAIN_ALLOWLIST) {
        throw new Error(
          `egress allowlist has ${domains.length} domains but daytona domainAllowList supports at most ${DAYTONA_MAX_DOMAIN_ALLOWLIST}; refusing to truncate`,
        );
      }
      return {
        networkAllowList: cidrs.join(","),
        ...(domains.length > 0 ? { domainAllowList: domains.join(",") } : {}),
      };
    }
    case "domain": {
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
