import type { RepoReviewSetting } from "@terragon/shared/db/types";
import {
  CELL_EGRESS_CATALOG,
  CELL_EGRESS_REGISTRIES_BUNDLE,
  planCellEgressForRepo,
  type CellEgressPlan,
} from "@terragon/shared/model/cell-egress-catalog";
import {
  cellEgressKey,
  platformCellEgressBundle,
} from "@terragon/shared/model/cell-egress";
import { canonicalizeEgressEntries } from "@terragon/shared/model/egress-policy";
import {
  classifyEgressEntries,
  egressWarnings,
} from "@terragon/shared/model/egress-entries";
import type { EgressWarningCode } from "@terragon/types/egress";

import { cellBrokerHost } from "@/server-lib/compute/cell-gate";

import {
  egressPolicyFromRow,
  systemEgressHosts,
} from "./resolve-egress-policy";

export type EgressLayer = "system" | "platform" | "registries" | "repo";

export interface EgressHostEntry {
  host: string;
  layer: EgressLayer;
}

export type CellView =
  | {
      ok: true;
      entries: EgressHostEntry[];
      bundles: string[];
      digest: string;
    }
  | {
      ok: false;
      code:
        | "egress_level_unsupported"
        | "egress_compile_failed"
        | "broker_host_unavailable";
      reason: string | null;
    };

export interface EgressView {
  org: { id: string; slug: string };
  repo: string;
  stored: {
    level: "none" | "ip_port" | "domain" | null;
    allowlist: string[];
    registries: boolean | null;
    updatedAt: string | null;
    updatedByUserId: string | null;
  };
  box: {
    enforced: boolean;
    allowlist: EgressHostEntry[];
    error: "invalid_policy" | null;
  };
  cell: CellView;
  warnings: { code: EgressWarningCode; entry: string | null }[];
  canEdit: boolean;
  readOnlyReason: "not_repo_admin" | "permission_unverified" | null;
  budget: { used: number; max: number };
}

type Row = RepoReviewSetting | undefined;

/** The box the worker enforces for this row; the builder's own refusal is `invalid_policy`. */
function boxView(row: Row): EgressView["box"] {
  try {
    const shape = egressPolicyFromRow(row, "worker");
    if (!shape) return { enforced: false, allowlist: [], error: null };
    const system = new Set(systemEgressHosts("worker"));
    return {
      enforced: true,
      allowlist: shape.allowlist.map((host) => ({
        host,
        layer: system.has(host) ? "system" : "repo",
      })),
      error: null,
    };
  } catch {
    // Dispatch would fail these runs; the read must not 500.
    return { enforced: true, allowlist: [], error: "invalid_policy" };
  }
}

/** A host the repo lists itself is `repo`, even when a bundle also carries it. */
function layerOf(
  host: string,
  sets: { platform: ReadonlySet<string>; repo: ReadonlySet<string> },
  registries: ReadonlySet<string>,
): EgressLayer {
  if (sets.platform.has(host)) return "platform";
  if (sets.repo.has(host)) return "repo";
  return registries.has(host) ? "registries" : "repo";
}

function cellFromPlan(
  plan: CellEgressPlan,
  brokerHost: string,
  repoHosts: ReadonlySet<string>,
): CellView {
  if (!plan.ok) {
    return { ok: false, code: plan.code, reason: plan.reason ?? null };
  }
  const platform = new Set(platformCellEgressBundle(brokerHost).allow);
  const registries = new Set(
    plan.refs.includes(CELL_EGRESS_REGISTRIES_BUNDLE)
      ? (CELL_EGRESS_CATALOG[CELL_EGRESS_REGISTRIES_BUNDLE]?.allow ?? [])
      : [],
  );
  const sets = { platform, repo: repoHosts };
  return {
    ok: true,
    entries: plan.set.entries.map((entry) => {
      const host = cellEgressKey(entry);
      return { host, layer: layerOf(host, sets, registries) };
    }),
    bundles: [...plan.set.bundles],
    digest: plan.set.digest,
  };
}

/** The cell plan, or `broker_host_unavailable` when the public host cannot be a broker host. */
function cellView(
  repoFullName: string,
  row: Row,
  repoHosts: ReadonlySet<string>,
): { cell: CellView; brokerHost: string | undefined } {
  let brokerHost: string;
  try {
    brokerHost = cellBrokerHost();
  } catch {
    // A single-label or missing public host: never a 500 on a read.
    return {
      cell: { ok: false, code: "broker_host_unavailable", reason: null },
      brokerHost: undefined,
    };
  }
  const plan = planCellEgressForRepo({ repoFullName, row, brokerHost });
  return { cell: cellFromPlan(plan, brokerHost, repoHosts), brokerHost };
}

type StoredLevel = EgressView["stored"]["level"];
const KNOWN_LEVELS: ReadonlySet<string> = new Set([
  "none",
  "ip_port",
  "domain",
]);

/**
 * A stored level the contract knows, else null. Only a raw SQL write can put
 * another value there (both writers validate it); reporting it as null keeps
 * the read a 200, and `box.error: "invalid_policy"` still says the row is bad.
 */
export function storedEgressLevel(value: string | null): StoredLevel {
  return value !== null && KNOWN_LEVELS.has(value)
    ? (value as NonNullable<StoredLevel>)
    : null;
}

/**
 * The effective egress of one repo in one org: what is stored, what the box
 * enforces, what a cell would compile, the advisory warnings and the cell's
 * host budget. It calls the two existing builders and the PR-2 classifier; it
 * holds no second copy of any rule.
 */
export function getRepoEgressView(args: {
  org: { id: string; slug: string };
  repoFullName: string;
  row: Row;
  canEdit: boolean;
  readOnlyReason: EgressView["readOnlyReason"];
}): EgressView {
  const { org, repoFullName, row } = args;
  const level = storedEgressLevel(row?.egressPolicy ?? null);
  const allowlist = row?.egressAllowlist ?? [];
  const registries = row?.cellEgressRegistries ?? null;
  const repoHosts = new Set(canonicalizeEgressEntries(allowlist));
  const { cell, brokerHost } = cellView(repoFullName, row, repoHosts);
  return {
    org,
    repo: repoFullName,
    stored: {
      level,
      allowlist: [...allowlist],
      registries,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedByUserId: row?.updatedByUserId ?? null,
    },
    box: boxView(row),
    cell,
    warnings: egressWarnings({ level, entries: allowlist, registries }),
    canEdit: args.canEdit,
    readOnlyReason: args.readOnlyReason,
    budget: classifyEgressEntries({
      level,
      entries: allowlist,
      registries,
      brokerHost,
    }).budget,
  };
}
