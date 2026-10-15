import { entryKey, type Catalog, type CatalogKind } from "./catalog";

/**
 * A known, accepted difference. `table` is null for objects that do not
 * belong to a table (enums, sequences, extensions). `reason` is required so
 * every exemption says why it is safe.
 */
export interface AllowEntry {
  kind: CatalogKind;
  table: string | null;
  name: string;
  reason: string;
}

export type DiffChange = "only-in-a" | "only-in-b" | "differs";

export interface CatalogDiff {
  kind: CatalogKind;
  table: string | null;
  name: string;
  change: DiffChange;
  /** Definition in catalog a (absent for only-in-b). */
  a?: string;
  /** Definition in catalog b (absent for only-in-a). */
  b?: string;
}

export interface DiffResult {
  /** Differences no allowlist entry covers — each one fails the check. */
  diffs: CatalogDiff[];
  /** Differences an allowlist entry covers, with the entry's reason. */
  allowed: (CatalogDiff & { reason: string })[];
  /** Allowlist entries that matched nothing: stale, and they fail the check. */
  unusedAllow: AllowEntry[];
}

/**
 * Compares two catalog snapshots object by object, keyed on
 * (kind, table, name). An allowlist entry exempts every difference on its key;
 * one that matches no difference is reported in `unusedAllow`, so a fixed
 * drift cannot leave a silent exemption behind.
 */
export function diffCatalogs(
  a: Catalog,
  b: Catalog,
  allow: AllowEntry[],
): DiffResult {
  const left = new Map(a.entries.map((e) => [entryKey(e), e]));
  const right = new Map(b.entries.map((e) => [entryKey(e), e]));
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();

  const raw: CatalogDiff[] = [];
  for (const key of keys) {
    const l = left.get(key);
    const r = right.get(key);
    if (l && r) {
      if (l.definition !== r.definition) {
        raw.push({
          kind: l.kind,
          table: l.table,
          name: l.name,
          change: "differs",
          a: l.definition,
          b: r.definition,
        });
      }
    } else if (l) {
      raw.push({
        kind: l.kind,
        table: l.table,
        name: l.name,
        change: "only-in-a",
        a: l.definition,
      });
    } else if (r) {
      raw.push({
        kind: r.kind,
        table: r.table,
        name: r.name,
        change: "only-in-b",
        b: r.definition,
      });
    }
  }

  const allowByKey = new Map(allow.map((entry) => [entryKey(entry), entry]));
  const used = new Set<string>();
  const diffs: CatalogDiff[] = [];
  const allowed: DiffResult["allowed"] = [];
  for (const diff of raw) {
    const key = entryKey(diff);
    const entry = allowByKey.get(key);
    if (entry) {
      used.add(key);
      allowed.push({ ...diff, reason: entry.reason });
    } else {
      diffs.push(diff);
    }
  }
  const unusedAllow = allow.filter((entry) => !used.has(entryKey(entry)));
  return { diffs, allowed, unusedAllow };
}

const KINDS: readonly CatalogKind[] = [
  "table",
  "column",
  "constraint",
  "index",
  "enum",
  "sequence",
  "extension",
];

export class AllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllowlistError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates a parsed drift-allowlist.json (an array of AllowEntry). */
export function parseAllowlist(value: unknown): AllowEntry[] {
  if (!Array.isArray(value)) {
    throw new AllowlistError("allowlist must be a JSON array");
  }
  const seen = new Set<string>();
  return value.map((item: unknown, i) => {
    if (!isRecord(item)) {
      throw new AllowlistError(`allowlist[${i}] must be an object`);
    }
    const { kind, table, name, reason } = item;
    if (typeof kind !== "string" || !KINDS.includes(kind as CatalogKind)) {
      throw new AllowlistError(
        `allowlist[${i}].kind must be one of ${KINDS.join(", ")}`,
      );
    }
    if (table !== null && typeof table !== "string") {
      throw new AllowlistError(
        `allowlist[${i}].table must be a string or null`,
      );
    }
    if (typeof name !== "string" || name === "") {
      throw new AllowlistError(
        `allowlist[${i}].name must be a non-empty string`,
      );
    }
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new AllowlistError(`allowlist[${i}].reason must say why`);
    }
    const entry: AllowEntry = {
      kind: kind as CatalogKind,
      table,
      name,
      reason,
    };
    const key = entryKey(entry);
    if (seen.has(key)) {
      throw new AllowlistError(`allowlist[${i}] duplicates ${key}`);
    }
    seen.add(key);
    return entry;
  });
}

function label(diff: { kind: string; table: string | null; name: string }) {
  return diff.table && diff.table !== diff.name
    ? `${diff.kind} ${diff.table}.${diff.name}`
    : `${diff.kind} ${diff.name}`;
}

/** A plain-text report; `aLabel`/`bLabel` name the two sides. */
export function formatDiffReport(
  result: DiffResult,
  aLabel = "a",
  bLabel = "b",
): string {
  const lines: string[] = [];
  for (const diff of result.diffs) {
    if (diff.change === "only-in-a") {
      lines.push(`  ${label(diff)}: only in ${aLabel}`);
      lines.push(`      ${aLabel}: ${diff.a}`);
    } else if (diff.change === "only-in-b") {
      lines.push(`  ${label(diff)}: only in ${bLabel}`);
      lines.push(`      ${bLabel}: ${diff.b}`);
    } else {
      lines.push(`  ${label(diff)}: differs`);
      lines.push(`      ${aLabel}: ${diff.a}`);
      lines.push(`      ${bLabel}: ${diff.b}`);
    }
  }
  for (const entry of result.unusedAllow) {
    lines.push(
      `  stale allowlist entry ${label(entry)}: matches no difference — delete it`,
    );
  }
  const header =
    result.diffs.length === 0 && result.unusedAllow.length === 0
      ? `schema drift: none (${result.allowed.length} allowlisted difference(s))`
      : `schema drift: ${result.diffs.length} difference(s), ` +
        `${result.unusedAllow.length} stale allowlist entr(y/ies), ` +
        `${result.allowed.length} allowlisted`;
  return [header, ...lines].join("\n");
}
