import { createHash } from "node:crypto";

import { canonicalJson } from "@terragon/utils/payload-seal";

import type { EgressPolicyLevel } from "../db/types";
import {
  CellEgressError,
  compileCellEgress,
  type CellEgressBundle,
  type CellEgressCatalog,
  type CellEgressSet,
} from "./cell-egress";
import {
  buildEgressPolicyShape,
  type EgressPolicyFields,
} from "./egress-policy";

/**
 * The code-reviewed bundles a cell may name (#705), plus the per-run bundle a
 * repo's own `domain` allowlist becomes. Pure: no env, no I/O. The platform
 * bundle (broker + model host) is not here: the compiler always adds it.
 *
 * A new host list is a new version (`@2`), never an edit of `@1`, so a
 * recorded digest always names the hosts that produced it.
 */

export const CELL_EGRESS_REGISTRIES_BUNDLE = "automata/registries@1";

/**
 * The common package registries, exact hosts only (a cell refuses wildcards).
 * Multi-tenant storage hosts (storage.googleapis.com, S3) are left out on
 * purpose. Registries accept uploads, so this bundle widens what a
 * prompt-injected agent can send out: it is a per-repo opt-in (OD-2).
 */
const REGISTRIES_BUNDLE: CellEgressBundle = {
  id: CELL_EGRESS_REGISTRIES_BUNDLE,
  allow: [
    // npm / yarn
    "registry.npmjs.org",
    "registry.yarnpkg.com",
    // PyPI
    "pypi.org",
    "files.pythonhosted.org",
    // pub.dev (Dart / Flutter)
    "pub.dev",
    "pub.dartlang.org",
    // Maven Central
    "repo.maven.apache.org",
    "repo1.maven.org",
    // Gradle plugin portal and wrapper distributions
    "plugins.gradle.org",
    "plugins-artifacts.gradle.org",
    "services.gradle.org",
    "downloads.gradle.org",
    // crates.io
    "crates.io",
    "index.crates.io",
    "static.crates.io",
    // Go module proxy and checksum database
    "proxy.golang.org",
    "sum.golang.org",
  ],
};

export const CELL_EGRESS_CATALOG: CellEgressCatalog = Object.freeze({
  [CELL_EGRESS_REGISTRIES_BUNDLE]: REGISTRIES_BUNDLE,
});

/** The repo-row fields a cell's egress is built from. */
export type CellEgressRepoFields = EgressPolicyFields & {
  cellEgressRegistries: boolean | null;
};

/** OD-1: a cell's policy is domain-based, so an `ip_port` repo stays on the box. */
export class CellEgressLevelUnsupportedError extends Error {
  readonly level: EgressPolicyLevel;

  constructor(level: EgressPolicyLevel) {
    super(`egress_level_unsupported: a cell cannot enforce '${level}'`);
    this.name = "CellEgressLevelUnsupportedError";
    this.level = level;
  }
}

/**
 * The per-run bundle for a repo's operator entries. Its id is
 * content-addressed (`repo/<owner>__<name>@<16 hex>`), so the same entries give
 * the same id and any change gives a new one.
 */
export function repoCellEgressBundle(
  repoFullName: string,
  entries: readonly string[],
): CellEgressBundle {
  const allow = [...entries].sort();
  const version = createHash("sha256")
    .update(canonicalJson(allow))
    .digest("hex")
    .slice(0, 16);
  const name = repoFullName.trim().toLowerCase().replace("/", "__");
  return { id: `repo/${name}@${version}`, allow };
}

export interface CellEgressForRepo {
  /** The repo's level; null when it has no row or no policy. */
  level: EgressPolicyLevel | null;
  refs: string[];
  catalog: CellEgressCatalog;
}

/**
 * The refs and catalog a cell for this repo compiles from:
 * - no row or no policy: platform only, plus registries when opted in (the
 *   box enforces nothing for such a repo, so the opt-in widens nothing);
 * - `none`: platform only. The box reaches system hosts only, so the
 *   registries opt-in is ignored (a cell never reaches more than its box);
 * - `domain`: the operator entries, validated by the box's own builder, become
 *   one per-run bundle, plus registries when opted in;
 * - `ip_port`: refused (CellEgressLevelUnsupportedError).
 * A stored policy the builder refuses throws `invalid_policy`, never echoed.
 */
export function cellEgressForRepo({
  repoFullName,
  row,
}: {
  repoFullName: string;
  row: CellEgressRepoFields | undefined;
}): CellEgressForRepo {
  let shape: ReturnType<typeof buildEgressPolicyShape> = null;
  if (row) {
    try {
      // No system hosts: the platform bundle carries the cell's own.
      shape = buildEgressPolicyShape(row, { systemHosts: [] });
    } catch {
      throw new CellEgressError(
        "invalid_policy",
        "invalid_policy: the repo's stored egress policy is invalid; not echoed",
      );
    }
  }
  if (shape?.level === "ip_port") {
    throw new CellEgressLevelUnsupportedError(shape.level);
  }
  const refs: string[] = [];
  let catalog: CellEgressCatalog = CELL_EGRESS_CATALOG;
  if (shape?.level === "domain" && shape.allowlist.length > 0) {
    const bundle = repoCellEgressBundle(repoFullName, shape.allowlist);
    catalog = { ...CELL_EGRESS_CATALOG, [bundle.id]: bundle };
    refs.push(bundle.id);
  }
  if (row?.cellEgressRegistries === true && shape?.level !== "none") {
    refs.push(CELL_EGRESS_REGISTRIES_BUNDLE);
  }
  return { level: shape?.level ?? null, refs, catalog };
}

export type CellEgressPlan =
  | ({ ok: true; set: CellEgressSet } & CellEgressForRepo)
  | {
      ok: false;
      code: "egress_level_unsupported" | "egress_compile_failed";
      /** The compiler's code (or `egress_wildcard`); absent for the level refusal. */
      reason?: string;
    };

/**
 * The repo's cell egress, compiled, or the refusal a cell-plan would answer.
 * One pure function for both seams: dispatch marks a run for a cell only when
 * this is ok (so a repo the cell cannot express stays on the box), and
 * cell-plan refuses with the same code before it opens a step. A wildcard is
 * refused here because the create plan refuses it (cell-create-plan.ts).
 * Anything but a cell egress error propagates.
 */
export function planCellEgressForRepo(args: {
  repoFullName: string;
  row: CellEgressRepoFields | undefined;
  brokerHost: string;
}): CellEgressPlan {
  try {
    const repo = cellEgressForRepo(args);
    const set = compileCellEgress(repo.refs, {
      brokerHost: args.brokerHost,
      catalog: repo.catalog,
    });
    if (set.entries.some((e) => e.wildcard)) {
      return {
        ok: false,
        code: "egress_compile_failed",
        reason: "egress_wildcard",
      };
    }
    return { ok: true, set, ...repo };
  } catch (error) {
    if (error instanceof CellEgressLevelUnsupportedError) {
      return { ok: false, code: "egress_level_unsupported" };
    }
    if (error instanceof CellEgressError) {
      return { ok: false, code: "egress_compile_failed", reason: error.code };
    }
    throw error;
  }
}
