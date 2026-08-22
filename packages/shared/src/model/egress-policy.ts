import type { EgressPolicyLevel } from "../db/types";

/**
 * The ONE egress artifact that crosses the plane boundary (#66, spec §3.2).
 * Planes (worker / sandbox providers) receive this shape and nothing else:
 * they never learn the settings table, the model, or where the policy came
 * from — the composability invariant. The allowlist is FINAL: fully resolved
 * control-plane-side, system entries already merged in. Loopback is implicitly
 * allowed by every enforcer (broker + proxy live there) — not part of the shape.
 */
export type EgressPolicyShape = {
  level: EgressPolicyLevel;
  /** FINAL, fully resolved control-plane-side; includes system entries. */
  allowlist: string[];
};

export const EGRESS_POLICY_LEVELS = ["none", "ip_port", "domain"] as const;

export function isEgressPolicyLevel(
  value: string,
): value is EgressPolicyLevel {
  return (EGRESS_POLICY_LEVELS as readonly string[]).includes(value);
}

const PORT_RE = /^[0-9]{1,5}$/;
const IPV4_RE = /^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/;
// RFC-1035-ish label: alnum, hyphens inside, 1-63 chars; at least two labels.
const DOMAIN_RE =
  /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

function splitHostPort(entry: string): { host: string; port: string | null } {
  const idx = entry.lastIndexOf(":");
  if (idx === -1) return { host: entry, port: null };
  return { host: entry.slice(0, idx), port: entry.slice(idx + 1) };
}

function isValidPort(port: string): boolean {
  if (!PORT_RE.test(port)) return false;
  const n = Number(port);
  return n >= 1 && n <= 65535;
}

/**
 * Validate one OPERATOR allowlist entry against the policy level. Throws with
 * a message naming the offending entry — an invalid stored entry must fail the
 * dispatch loudly at resolve time, never silently widen or narrow the policy.
 *
 * - `ip_port` level: IPv4 address, optionally `:port`.
 * - `domain` level: domain, `*.domain` wildcard, or `host:port`.
 * - `none` level: operator entries are not consulted (system hosts only), so
 *   nothing to validate.
 */
function assertValidEntry(level: EgressPolicyLevel, entry: string): void {
  const { host, port } = splitHostPort(entry);
  if (port !== null && !isValidPort(port)) {
    throw new Error(
      `Invalid egress allowlist entry "${entry}": port "${port}" is not a valid port (1-65535)`,
    );
  }
  if (level === "ip_port") {
    if (!IPV4_RE.test(host)) {
      throw new Error(
        `Invalid egress allowlist entry "${entry}" for level "ip_port": expected an IP or IP:port`,
      );
    }
    return;
  }
  // level === "domain"
  const bare = host.startsWith("*.") ? host.slice(2) : host;
  if (!DOMAIN_RE.test(bare)) {
    throw new Error(
      `Invalid egress allowlist entry "${entry}" for level "domain": expected a domain, *.domain wildcard, or host:port`,
    );
  }
}

/**
 * Build the final `EgressPolicyShape` for one run from the stored row fields
 * plus the system hosts every run must reach (callback host, github.com until
 * #81 removes direct git, api.anthropic.com). Pure: no DB, no env — the
 * apps/www resolver supplies both inputs.
 *
 * - `row.egressPolicy` null/undefined → null (no enforcement; today's behavior).
 * - Unknown level or an invalid allowlist entry → throw (fail loud at resolve
 *   time, never a silently-wrong policy on the wire).
 * - Level 'none' → allowlist is the system hosts ONLY (operator entries ignored).
 * - Otherwise merge operator entries + system hosts, deduped, order-stable
 *   (operator entries first).
 */
export function buildEgressPolicyShape(
  row: { egressPolicy: string | null; egressAllowlist: string[] | null },
  { systemHosts }: { systemHosts: string[] },
): EgressPolicyShape | null {
  const level = row.egressPolicy;
  if (level == null) {
    return null;
  }
  if (!isEgressPolicyLevel(level)) {
    throw new Error(
      `Invalid egress policy level "${level}": expected one of ${EGRESS_POLICY_LEVELS.join(", ")}`,
    );
  }
  if (level === "none") {
    return { level, allowlist: [...new Set(systemHosts)] };
  }
  const userEntries = row.egressAllowlist ?? [];
  for (const entry of userEntries) {
    assertValidEntry(level, entry);
  }
  return { level, allowlist: [...new Set([...userEntries, ...systemHosts])] };
}
