import type { RepoEgressAuditLog } from "@terragon/shared/db/types";
import { listRepoEgressChanges } from "@terragon/shared/model/repo-egress-audit-log";
import { listRepoReviewSettings } from "@terragon/shared/model/repo-review-settings";

import { db } from "@/lib/db";
import {
  getRepoEgressView,
  storedEgressLevel,
} from "@/server-lib/egress/repo-egress-view";

import { orpcBase as base } from "./base";
import { invalidInputError } from "./api-version";
import {
  assertRepoInOrg,
  readEditAccess,
  resolveEgressOrg,
  resolveEgressPrincipal,
  type EgressOrg,
  type EgressPrincipal,
  type EgressRequestContext,
  type PrincipalErrors,
  type RepoInOrg,
} from "./principal";

interface OrgTarget {
  principal: EgressPrincipal;
  org: EgressOrg;
}

/** Steps 1 and 3 of the principal: credential, then `{org}`. */
async function authorizeOrg(
  context: EgressRequestContext,
  orgParam: string,
  errors: PrincipalErrors,
): Promise<OrgTarget> {
  const principal = await resolveEgressPrincipal(context, errors);
  const org = await resolveEgressOrg(principal, orgParam, errors);
  return { principal, org };
}

/** Steps 1, 3 and 4 of the principal: credential, `{org}`, repo in the org. */
async function authorizeRepo(
  context: EgressRequestContext,
  input: { org: string; owner: string; repo: string },
  errors: PrincipalErrors,
): Promise<OrgTarget & RepoInOrg> {
  const target = await authorizeOrg(context, input.org, errors);
  const repo = await assertRepoInOrg({
    org: target.org,
    owner: input.owner,
    repo: input.repo,
    errors,
  });
  return { ...target, ...repo };
}

const get = base.egress.get.handler(async ({ input, context, errors }) => {
  const { principal, org, repoFullName, row } = await authorizeRepo(
    context,
    input,
    errors,
  );
  const access = await readEditAccess({
    userId: principal.userId,
    organizationId: org.id,
    repoFullName,
  });
  return getRepoEgressView({ org, repoFullName, row, ...access });
});

interface HistoryCursor {
  createdAt: Date;
  id: string;
}

const CURSOR_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The cursor is opaque on the wire: base64url of `{createdAt, id}`. */
function encodeCursor(cursor: HistoryCursor): string {
  const json = JSON.stringify({
    createdAt: cursor.createdAt.toISOString(),
    id: cursor.id,
  });
  return Buffer.from(json).toString("base64url");
}

function decodeCursor(raw: string): HistoryCursor | null {
  try {
    const { createdAt, id } = (JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) ?? {}) as { createdAt?: unknown; id?: unknown };
    if (typeof createdAt !== "string" || typeof id !== "string") return null;
    // Only the form encodeCursor writes (the regex, then a round trip; an
    // invalid date throws into the catch), for a year Postgres can hold: an
    // expanded (`+275760-…`) or year-0 date would fail the query with a 500.
    if (!CURSOR_DATE.test(createdAt)) return null;
    const date = new Date(createdAt);
    const valid =
      date.toISOString() === createdAt && date.getUTCFullYear() >= 1;
    return valid ? { createdAt: date, id } : null;
  } catch {
    return null;
  }
}

function historyEntry(row: RepoEgressAuditLog) {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    actorUserId: row.actorUserId,
    authKind: row.authKind,
    levelBefore: storedEgressLevel(row.levelBefore),
    levelAfter: storedEgressLevel(row.levelAfter),
    hostsAdded: row.hostsAdded,
    hostsRemoved: row.hostsRemoved,
    registriesBefore: row.registriesBefore,
    registriesAfter: row.registriesAfter,
  };
}

const history = base.egress.history.handler(
  async ({ input, context, errors }) => {
    const { org, repoFullName } = await authorizeRepo(context, input, errors);
    const before = input.before ? decodeCursor(input.before) : undefined;
    if (before === null) {
      throw errors.BAD_REQUEST({
        data: invalidInputError([
          "before is not a cursor returned by this endpoint",
        ]),
      });
    }
    const page = await listRepoEgressChanges({
      db,
      organizationId: org.id,
      repoFullName,
      limit: input.limit,
      before,
    });
    return {
      entries: page.entries.map(historyEntry),
      nextBefore: page.nextBefore ? encodeCursor(page.nextBefore) : null,
    };
  },
);

const list = base.egress.list.handler(async ({ input, context, errors }) => {
  const { org } = await authorizeOrg(context, input.org, errors);
  const rows = await listRepoReviewSettings({ db, organizationId: org.id });
  const repos = rows
    .filter(
      (row) =>
        row.egressPolicy !== null ||
        row.egressAllowlist !== null ||
        row.cellEgressRegistries !== null,
    )
    .map((row) => ({
      repo: row.repoFullName,
      level: storedEgressLevel(row.egressPolicy),
      allowlistCount: row.egressAllowlist?.length ?? 0,
      registries: row.cellEgressRegistries,
      updatedAt: row.updatedAt.toISOString(),
    }))
    .sort((a, b) => a.repo.localeCompare(b.repo));
  return { org, repos };
});

/** The egress procedures: the same router serves `/api/cli` (RPC) and `/api/v1` (REST). */
export const egressRouter = { get, history, list };
