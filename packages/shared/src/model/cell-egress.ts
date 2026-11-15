import { createHash } from "node:crypto";

import { canonicalJson } from "@terragon/utils/payload-seal";

import { DOMAIN_RE, IPV4_RE, type EgressPolicyShape } from "./egress-policy";

/**
 * Egress a remote cell receives (#611): compiled once from named bundles into
 * one plane-neutral set, then rendered for the provider (Agent37 `{allow}`) and
 * for the proxy shape. Pure: no env, no I/O, no clock. The broker host is
 * injected.
 *
 * The set is HTTPS/443 only. `host` means that name; `*.host` means that name
 * AND every name under it. Deny wins. Anything a plane cannot express throws
 * and is never widened.
 */

/** A named, versioned bundle. */
export interface CellEgressBundle {
  id: string; // "<namespace>/<name>@<version>"
  extends?: readonly string[];
  allow?: readonly string[];
  deny?: readonly string[];
}
export type CellEgressCatalog = Readonly<Record<string, CellEgressBundle>>;

export interface CellEgressEntry {
  name: string; // lowercase, no trailing dot, no port
  wildcard: boolean; // true = name and every subdomain
}

export interface CellEgressSet {
  entries: readonly CellEgressEntry[]; // deduped, sorted by key (code-unit order)
  bundles: readonly string[]; // every bundle id visited, sorted
  digest: string; // sha256 hex of canonicalJson({ bundles, entries: keys })
}

export interface CompileCellEgressDeps {
  brokerHost: string; // bare hostname of the www public host
  catalog?: CellEgressCatalog; // defaults to {} (platform only)
  narrowTo?: readonly string[]; // a template's entries; may only narrow
}

export const CELL_EGRESS_PLATFORM_BUNDLE = "automata/platform@1";
export const CELL_EGRESS_MODEL_HOST = "api.anthropic.com";
/** Agent37 allow-list cap; counted over the RENDERED list (a wildcard also emits its apex). */
export const CELL_EGRESS_MAX_ENTRIES = 100;

export type CellEgressErrorCode =
  | "unknown_bundle"
  | "extends_cycle"
  | "platform_override"
  | "invalid_host"
  | "ip_literal"
  | "ipv6"
  | "port_not_443"
  | "platform_denied"
  | "inexpressible"
  | "template_widens"
  | "too_many_entries"
  | "empty_set";

export class CellEgressError extends Error {
  readonly code: CellEgressErrorCode;
  readonly entry?: string;

  constructor(code: CellEgressErrorCode, message: string, entry?: string) {
    super(message);
    this.name = "CellEgressError";
    this.code = code;
    this.entry = entry;
  }
}

export function platformCellEgressBundle(brokerHost: string): CellEgressBundle {
  return {
    id: CELL_EGRESS_PLATFORM_BUNDLE,
    allow: [brokerHost, CELL_EGRESS_MODEL_HOST],
  };
}

export function cellEgressKey(entry: CellEgressEntry): string {
  return entry.wildcard ? `*.${entry.name}` : entry.name;
}

function normalizeEntry(raw: string): CellEgressEntry {
  const text = raw.trim().toLowerCase();
  if (text.includes("[") || text.includes("]") || text.split(":").length > 2) {
    throw new CellEgressError("ipv6", `ipv6: '${raw}' is not supported`, raw);
  }
  let hostPart = text;
  const colon = text.indexOf(":");
  if (colon !== -1) {
    hostPart = text.slice(0, colon);
    if (text.slice(colon + 1) !== "443") {
      throw new CellEgressError(
        "port_not_443",
        `port_not_443: '${raw}' pins a port other than 443`,
        raw,
      );
    }
  }
  hostPart = hostPart.replace(/\.$/, "");
  const wildcard = hostPart.startsWith("*.");
  const name = wildcard ? hostPart.slice(2) : hostPart;
  const lastLabel = name.slice(name.lastIndexOf(".") + 1);
  // A host whose last label is all digits is an IP literal even when DOMAIN_RE accepts it.
  if (
    IPV4_RE.test(name) ||
    (DOMAIN_RE.test(name) && /^[0-9]+$/.test(lastLabel))
  ) {
    throw new CellEgressError(
      "ip_literal",
      `ip_literal: '${raw}' is an IP address`,
      raw,
    );
  }
  if (!DOMAIN_RE.test(name)) {
    throw new CellEgressError(
      "invalid_host",
      `invalid_host: '${raw}' is not a domain or *.domain`,
      raw,
    );
  }
  return { name, wildcard };
}

/** Names `d` matches: its own name, plus every subdomain when it is a wildcard. */
function coversName(d: CellEgressEntry, name: string): boolean {
  return d.name === name || (d.wildcard && name.endsWith(`.${d.name}`));
}

/** True when every name `a` matches is matched by `d`. */
function coversEntry(d: CellEgressEntry, a: CellEgressEntry): boolean {
  return a.wildcard
    ? d.wildcard && coversName(d, a.name)
    : coversName(d, a.name);
}

interface Collected {
  allows: { entry: CellEgressEntry; platform: boolean }[];
  denies: CellEgressEntry[];
  bundles: Set<string>;
}

function collect(
  brokerHost: string,
  catalog: CellEgressCatalog,
  refs: readonly string[],
): Collected {
  const out: Collected = { allows: [], denies: [], bundles: new Set() };
  const done = new Set<string>();

  const take = (bundle: CellEgressBundle, platform: boolean): void => {
    out.bundles.add(bundle.id);
    for (const raw of bundle.allow ?? []) {
      out.allows.push({ entry: normalizeEntry(raw), platform });
    }
    for (const raw of bundle.deny ?? []) {
      out.denies.push(normalizeEntry(raw));
    }
  };

  const visit = (ref: string, chain: readonly string[]): void => {
    if (ref === CELL_EGRESS_PLATFORM_BUNDLE) return; // always visited first
    if (chain.includes(ref)) {
      throw new CellEgressError(
        "extends_cycle",
        `extends_cycle: ${[...chain, ref].join(" -> ")}`,
        ref,
      );
    }
    if (done.has(ref)) return;
    const bundle = Object.hasOwn(catalog, ref) ? catalog[ref] : undefined;
    if (!bundle) {
      throw new CellEgressError(
        "unknown_bundle",
        `unknown_bundle: '${ref}' is not in the catalog`,
        ref,
      );
    }
    if (bundle.id === CELL_EGRESS_PLATFORM_BUNDLE) {
      throw new CellEgressError(
        "platform_override",
        `platform_override: '${ref}' cannot replace the platform bundle`,
        ref,
      );
    }
    for (const parent of bundle.extends ?? []) visit(parent, [...chain, ref]);
    done.add(ref);
    take(bundle, false);
  };

  for (const [key, bundle] of Object.entries(catalog)) {
    if (
      key === CELL_EGRESS_PLATFORM_BUNDLE ||
      bundle.id === CELL_EGRESS_PLATFORM_BUNDLE
    ) {
      throw new CellEgressError(
        "platform_override",
        `platform_override: '${key}' cannot replace the platform bundle`,
        key,
      );
    }
  }
  take(platformCellEgressBundle(brokerHost), true);
  for (const ref of refs) visit(ref, []);
  return out;
}

function renderedNames(entries: readonly CellEgressEntry[]): string[] {
  const names = new Set<string>();
  for (const e of entries) {
    names.add(cellEgressKey(e));
    if (e.wildcard) names.add(e.name);
  }
  return [...names];
}

function assertWithinCap(entries: readonly CellEgressEntry[]): void {
  const count = renderedNames(entries).length;
  if (count > CELL_EGRESS_MAX_ENTRIES) {
    throw new CellEgressError(
      "too_many_entries",
      `too_many_entries: ${count} rendered entries exceed the cap of ${CELL_EGRESS_MAX_ENTRIES}; refusing to truncate`,
    );
  }
}

function byKey(a: CellEgressEntry, b: CellEgressEntry): number {
  const ka = cellEgressKey(a);
  const kb = cellEgressKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

function dedupeSorted(entries: readonly CellEgressEntry[]): CellEgressEntry[] {
  const seen = new Map<string, CellEgressEntry>();
  for (const e of entries) seen.set(cellEgressKey(e), e);
  return [...seen.values()].sort(byKey);
}

export function compileCellEgress(
  refs: readonly string[],
  deps: CompileCellEgressDeps,
): CellEgressSet {
  const { allows, denies, bundles } = collect(
    deps.brokerHost,
    deps.catalog ?? {},
    refs,
  );

  // Deny wins: drop every allow that some deny covers.
  const kept: { entry: CellEgressEntry; platform: boolean }[] = [];
  for (const allow of allows) {
    const deny = denies.find((d) => coversEntry(d, allow.entry));
    if (!deny) {
      kept.push(allow);
    } else if (allow.platform) {
      throw new CellEgressError(
        "platform_denied",
        `platform_denied: deny '${cellEgressKey(deny)}' covers platform entry '${cellEgressKey(allow.entry)}'`,
        cellEgressKey(allow.entry),
      );
    }
  }

  // No carve-outs: the provider has no deny list, so a deny inside an allowed wildcard would be allowed.
  for (const { entry: allow } of kept) {
    if (!allow.wildcard) continue;
    for (const deny of denies) {
      if (coversName(allow, deny.name)) {
        throw new CellEgressError(
          "inexpressible",
          `inexpressible: deny '${cellEgressKey(deny)}' inside allowed '${cellEgressKey(allow)}'`,
          cellEgressKey(deny),
        );
      }
    }
  }

  // Templates only narrow.
  let result: CellEgressEntry[] = kept.map((k) => k.entry);
  if (deps.narrowTo) {
    const keptEntries = result;
    const narrowed = deps.narrowTo.map(normalizeEntry);
    for (const [i, entry] of narrowed.entries()) {
      const allowed = keptEntries.some((k) => coversEntry(k, entry));
      if (!allowed) {
        const raw = deps.narrowTo[i] ?? cellEgressKey(entry);
        throw new CellEgressError(
          "template_widens",
          `template widens: '${raw}' is not allowed by its bundles`,
          raw,
        );
      }
    }
    result = [
      ...kept.filter((k) => k.platform).map((k) => k.entry),
      ...narrowed,
    ];
  }

  const entries = dedupeSorted(result);
  assertWithinCap(entries);
  const bundleIds = [...bundles].sort();
  const digest = createHash("sha256")
    .update(
      canonicalJson({
        bundles: bundleIds,
        entries: entries.map(cellEgressKey),
      }),
    )
    .digest("hex");
  return { entries, bundles: bundleIds, digest };
}

/** Agent37 `network`: an allowlist only, never "allow-all". A wildcard also lists its apex. */
export function toAgent37Network(set: CellEgressSet): { allow: string[] } {
  if (set.entries.length === 0) {
    throw new CellEgressError("empty_set", "empty_set: nothing to allow");
  }
  assertWithinCap(set.entries);
  return { allow: renderedNames(set.entries) };
}

/** The shared proxy shape: every entry pinned to :443, a wildcard also emits its apex. */
export function toProxyShape(set: CellEgressSet): EgressPolicyShape {
  if (set.entries.length === 0) {
    throw new CellEgressError("empty_set", "empty_set: nothing to allow");
  }
  return {
    level: "domain",
    allowlist: renderedNames(set.entries).map((name) => `${name}:443`),
  };
}
