import type {
  EgressEntryCode,
  EgressWarningCode,
} from "@terragon/types/egress";

import type { EgressPolicyLevel } from "../db/types";
import {
  CELL_EGRESS_MAX_ENTRIES,
  CellEgressError,
  cellEgressKey,
  normalizeCellEgressEntry,
  platformCellEgressBundle,
  toAgent37Network,
  type CellEgressEntry,
  type CellEgressErrorCode,
} from "./cell-egress";
import {
  CELL_EGRESS_CATALOG,
  CELL_EGRESS_REGISTRIES_BUNDLE,
  planCellEgressForRepo,
} from "./cell-egress-catalog";
import {
  canonicalizeEgressEntries,
  findEgressPolicyError,
} from "./egress-policy";

/**
 * Per-entry classification of a repo's egress allowlist for the egress API
 * (#728, OD-2). It maps the existing validators, it re-parses nothing: the
 * cell's `normalizeCellEgressEntry`, the box's `findEgressPolicyError`, and the
 * cell compiler `planCellEgressForRepo` for the set-level cap. So the API, the
 * UI (through the API's dry run) and the CLI refuse with the same words a
 * dispatch would. Pure: no env, no I/O. Imports `node:crypto` and `psl`
 * through `cell-egress.ts`, so it is not for client bundles.
 */

export interface EgressEntryError {
  code: EgressEntryCode;
  message: string;
  /** The entry, or null when it may carry a secret (never echoed) or for a set-level code. */
  entry: string | null;
  /** Index in the CANONICAL list (`entries` of the result); null for a set-level code. */
  index: number | null;
}

export interface EgressBudget {
  /** Rendered cell entries, platform and registries hosts included, deduped. */
  used: number;
  /** The cell's cap on that rendered list. */
  max: number;
}

export interface EgressClassification {
  /** The canonical list: trimmed, lowercased, empties dropped, deduped, order-stable. */
  entries: string[];
  /** Every refusal at once (not first-throw), in index order, set-level codes last. */
  errors: EgressEntryError[];
  budget: EgressBudget;
}

/** Stands in for the www public host when the caller has none (the CLI). It never equals a repo host. */
export const CLASSIFY_BROKER_PLACEHOLDER = "broker.invalid";

/** The cell refusals one host can raise, as API codes. Any other cell code is unreachable for one host. */
const CELL_ENTRY_CODES: Partial<Record<CellEgressErrorCode, EgressEntryCode>> =
  {
    invalid_host: "invalid_host",
    public_suffix_wildcard: "public_suffix_wildcard",
    ip_literal: "ip_not_allowed",
    ipv6: "ipv6_not_allowed",
    port_not_443: "port_not_allowed",
  };

type EntryResult =
  | { ok: true; entry: CellEgressEntry }
  | { ok: false; error: EgressEntryError };

function classifyOne(entry: string, index: number): EntryResult {
  let normalized: CellEgressEntry;
  try {
    normalized = normalizeCellEgressEntry(entry);
  } catch (error) {
    const code =
      error instanceof CellEgressError
        ? CELL_ENTRY_CODES[error.code]
        : undefined;
    if (!(error instanceof CellEgressError) || code === undefined) {
      throw error;
    }
    // `error.entry` is unset exactly when the cell refuses to echo the entry.
    return {
      ok: false,
      error: {
        code,
        message: error.message,
        entry: error.entry ?? null,
        index,
      },
    };
  }
  // The cell normalizer accepted it, so it is a bare host and safe to echo.
  if (normalized.wildcard) {
    return {
      ok: false,
      error: {
        code: "wildcard_not_allowed",
        message: `wildcard_not_allowed: '${entry}' is a wildcard; a cell allows exact hosts only`,
        entry,
        index,
      },
    };
  }
  // What the cell accepts and the box does not (a trailing dot, for one).
  const boxError = findEgressPolicyError({
    egressPolicy: "domain",
    egressAllowlist: [entry],
  });
  if (boxError !== undefined) {
    return {
      ok: false,
      error: { code: "invalid_host", message: boxError, entry, index },
    };
  }
  return { ok: true, entry: normalized };
}

/** Distinct rendered names of platform + registries + exact repo hosts (no wildcard is ever accepted). */
function renderedCount(
  accepted: readonly CellEgressEntry[],
  registries: boolean,
  brokerHost: string,
): number {
  const names = new Set<string>();
  for (const raw of platformCellEgressBundle(brokerHost).allow ?? []) {
    names.add(cellEgressKey(normalizeCellEgressEntry(raw)));
  }
  if (registries) {
    for (const raw of CELL_EGRESS_CATALOG[CELL_EGRESS_REGISTRIES_BUNDLE]
      ?.allow ?? []) {
      names.add(cellEgressKey(normalizeCellEgressEntry(raw)));
    }
  }
  for (const entry of accepted) names.add(cellEgressKey(entry));
  return names.size;
}

/**
 * Classify the RESULTING list of a change (stored with the patch applied).
 *
 * - `ip_port`: one `level_unsupported_in_cell`, entries not classified.
 * - Any other level (null and `none` included, so nothing a cell cannot use is
 *   stored): each canonical entry is checked by the cell normalizer, then for
 *   a wildcard, then by the box builder; every refusal is returned.
 * - With no per-entry refusal, the list is compiled as a `domain` cell would
 *   compile it (registries counted unless the level is `none`, which ignores
 *   them); over the cap is one `too_many_entries`.
 *
 * `budget.used` is the compiled plan's rendered count when it compiles, else
 * the same deduped count over the entries that passed.
 */
export function classifyEgressEntries(input: {
  level: EgressPolicyLevel | null;
  entries: readonly string[];
  registries: boolean | null;
  brokerHost?: string;
}): EgressClassification {
  const brokerHost = input.brokerHost ?? CLASSIFY_BROKER_PLACEHOLDER;
  const entries = canonicalizeEgressEntries(input.entries);
  const registries = input.registries === true && input.level !== "none";
  const errors: EgressEntryError[] = [];
  const accepted: CellEgressEntry[] = [];
  const max = CELL_EGRESS_MAX_ENTRIES;

  if (input.level === "ip_port") {
    errors.push({
      code: "level_unsupported_in_cell",
      message:
        "level_unsupported_in_cell: a cell's egress is domain-based; ip_port is not supported",
      entry: null,
      index: null,
    });
    return {
      entries,
      errors,
      budget: { used: renderedCount([], registries, brokerHost), max },
    };
  }

  for (const [index, entry] of entries.entries()) {
    const result = classifyOne(entry, index);
    if (result.ok) accepted.push(result.entry);
    else errors.push(result.error);
  }
  if (errors.length > 0) {
    return {
      entries,
      errors,
      budget: { used: renderedCount(accepted, registries, brokerHost), max },
    };
  }

  const plan = planCellEgressForRepo({
    repoFullName: "acme/check",
    row: {
      egressPolicy: "domain",
      egressAllowlist: entries,
      cellEgressRegistries: registries,
    },
    brokerHost,
  });
  if (plan.ok) {
    return {
      entries,
      errors,
      budget: { used: toAgent37Network(plan.set).allow.length, max },
    };
  }
  if (plan.reason !== "too_many_entries") {
    // Every per-entry refusal was caught above; reaching this is a bug (the parity test guards it).
    throw new Error(
      `classifyEgressEntries: unexpected cell refusal ${plan.code}/${plan.reason ?? "none"} after per-entry checks`,
    );
  }
  const used = renderedCount(accepted, registries, brokerHost);
  errors.push({
    code: "too_many_entries",
    message: `too_many_entries: ${used} rendered entries (platform${registries ? " and registries" : ""} hosts included) exceed the cap of ${max}`,
    entry: null,
    index: null,
  });
  return { entries, errors, budget: { used, max } };
}

/**
 * Multi-tenant storage hosts (#719): allowing one lets an agent upload to
 * ANYONE's bucket there, not only the repo's. Frozen on purpose: widening it
 * is a reviewed code change.
 */
const GCS_HOST = "storage.googleapis.com";
const AWS_APEX = "amazonaws.com";
/** Labels that may sit between an S3 label and `amazonaws.com`: a region or `dualstack`. */
const S3_TAIL_LABEL_RE = /^(dualstack|[a-z]{2}(-[a-z]+)+-[0-9]+)$/;

/**
 * An S3 name: an `s3` or `s3-…` label (`s3`, `s3-<region>`, `s3-accelerate`,
 * `s3-website`, `s3-accesspoint`, …) followed only by region or `dualstack`
 * labels before `amazonaws.com`, with anything (a bucket) to its left. So
 * `s3-proxy-1.us-east-1.elb.amazonaws.com`, a load balancer someone named
 * `s3-proxy`, is not one.
 */
function isS3Name(name: string): boolean {
  if (!name.endsWith(`.${AWS_APEX}`)) return false;
  const labels = name.slice(0, -(AWS_APEX.length + 1)).split(".");
  return labels.some(
    (label, i) =>
      (label === "s3" || label.startsWith("s3-")) &&
      labels.slice(i + 1).every((tail) => S3_TAIL_LABEL_RE.test(tail)),
  );
}

function isMultiTenantName(name: string): boolean {
  return name === GCS_HOST || name.endsWith(`.${GCS_HOST}`) || isS3Name(name);
}

/**
 * True for a GCS or S3 upload host: `storage.googleapis.com` and buckets under
 * it, and S3 names (`s3.amazonaws.com`, `s3.<region>`, `s3-<region>`,
 * `<bucket>.s3.<region>`, `s3.dualstack.<region>`, `s3-accelerate`, see
 * `isS3Name`). A wildcard counts when it covers one (`*.amazonaws.com`,
 * `*.us-east-1.amazonaws.com`, `*.googleapis.com`), even a public-suffix one
 * (`*.s3.amazonaws.com`). A `:443` port, case and a trailing dot are ignored;
 * any other entry the cell cannot read is not a host.
 */
export function detectMultiTenantUploadHost(entry: string): boolean {
  let normalized: CellEgressEntry;
  try {
    normalized = normalizeCellEgressEntry(entry);
  } catch (error) {
    if (!(error instanceof CellEgressError)) throw error;
    // `*.s3.amazonaws.com` is itself a public suffix: refused by a cell, but a
    // legacy-stored one still opens every bucket on the box.
    if (error.code !== "public_suffix_wildcard" || !error.entry) return false;
    normalized = { name: error.entry.slice(2), wildcard: true };
  }
  const { name, wildcard } = normalized;
  // `*.x` covers `s3.x` and `storage.x`: when either is an upload host, so is the wildcard.
  const covered = wildcard ? [name, `s3.${name}`, `storage.${name}`] : [name];
  return covered.some(isMultiTenantName);
}

export interface EgressWarning {
  code: EgressWarningCode;
  /** The entry the warning is about; null for a level-wide warning. */
  entry: string | null;
}

/**
 * Advisory notes for a stored (or about-to-be-stored) egress setting, in this
 * order: `multi_tenant_upload_host` per entry, `domain_governs_box`,
 * `no_policy_box_open`, `registries_ignored`, then `cell_refuses_wildcard` /
 * `cell_refuses_port` per entry. The last two are only reachable for rows the
 * legacy PUT wrote (the new API refuses those entries), and only under
 * `domain`: at any other level a cell does not read the list.
 */
export function egressWarnings(input: {
  level: EgressPolicyLevel | null;
  entries: readonly string[];
  registries: boolean | null;
}): EgressWarning[] {
  const entries = canonicalizeEgressEntries(input.entries);
  const warnings: EgressWarning[] = [];
  for (const entry of entries) {
    if (detectMultiTenantUploadHost(entry)) {
      warnings.push({ code: "multi_tenant_upload_host", entry });
    }
  }
  if (input.level === "domain") {
    warnings.push({ code: "domain_governs_box", entry: null });
  }
  if (input.level === null) {
    warnings.push({ code: "no_policy_box_open", entry: null });
  }
  if (input.registries === true && input.level === "none") {
    warnings.push({ code: "registries_ignored", entry: null });
  }
  if (input.level === "domain") {
    const { errors } = classifyEgressEntries({
      level: "domain",
      entries,
      registries: input.registries,
    });
    for (const error of errors) {
      if (error.code === "wildcard_not_allowed") {
        warnings.push({ code: "cell_refuses_wildcard", entry: error.entry });
      } else if (error.code === "port_not_allowed") {
        warnings.push({ code: "cell_refuses_port", entry: error.entry });
      }
    }
  }
  return warnings;
}
