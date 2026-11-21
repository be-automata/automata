import { implement } from "@orpc/server";
import { cliAPIContract } from "@terragon/cli-api-contract";
import type { RepoEgressAuditLog } from "@terragon/shared/db/types";
import { listRepoEgressChanges } from "@terragon/shared/model/repo-egress-audit-log";
import {
  getRepoReviewSetting,
  listRepoReviewSettings,
} from "@terragon/shared/model/repo-review-settings";

import { db } from "@/lib/db";
import { getRepoEgressView } from "@/server-lib/egress/repo-egress-view";

import {
  assertRepoInOrg,
  readEditAccess,
  resolveEgressOrg,
  resolveEgressPrincipal,
  type EgressOrg,
  type EgressPrincipal,
  type EgressRequestContext,
  type PrincipalErrors,
} from "./principal";

const base = implement(cliAPIContract).$context<EgressRequestContext>();

interface RepoTarget {
  principal: EgressPrincipal;
  org: EgressOrg;
  repoFullName: string;
}

/** Steps 1, 3 and 4 of the principal: credential, `{org}`, repo in the org. */
async function authorizeRepo(
  context: EgressRequestContext,
  input: { org: string; owner: string; repo: string },
  errors: PrincipalErrors,
): Promise<RepoTarget> {
  const principal = await resolveEgressPrincipal(context, errors);
  const org = await resolveEgressOrg(principal, input.org, errors);
  const repoFullName = await assertRepoInOrg({
    org,
    owner: input.owner,
    repo: input.repo,
    errors,
  });
  return { principal, org, repoFullName };
}

const get = base.egress.get.handler(async ({ input, context, errors }) => {
  const { principal, org, repoFullName } = await authorizeRepo(
    context,
    input,
    errors,
  );
  const [row, access] = await Promise.all([
    getRepoReviewSetting({ db, organizationId: org.id, repoFullName }),
    readEditAccess({ userId: principal.userId, org, repoFullName }),
  ]);
  return getRepoEgressView({ org, repoFullName, row, ...access });
});

interface HistoryCursor {
  createdAt: Date;
  id: string;
}

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
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    const { createdAt, id } = parsed as { createdAt?: unknown; id?: unknown };
    if (typeof createdAt !== "string" || typeof id !== "string") return null;
    const date = new Date(createdAt);
    return Number.isNaN(date.getTime()) ? null : { createdAt: date, id };
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
    levelBefore: row.levelBefore as "none" | "ip_port" | "domain" | null,
    levelAfter: row.levelAfter as "none" | "ip_port" | "domain" | null,
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
        data: {
          errors: [
            {
              code: "invalid_input",
              message: "before is not a cursor returned by this endpoint",
              entry: null,
              index: null,
            },
          ],
        },
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
  const principal = await resolveEgressPrincipal(context, errors);
  const org = await resolveEgressOrg(principal, input.org, errors);
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
      level: row.egressPolicy as "none" | "ip_port" | "domain" | null,
      allowlistCount: row.egressAllowlist?.length ?? 0,
      registries: row.cellEgressRegistries,
      updatedAt: row.updatedAt.toISOString(),
    }))
    .sort((a, b) => a.repo.localeCompare(b.repo));
  return { org, repos };
});

/** The egress procedures: the same router serves `/api/cli` (RPC) and `/api/v1` (REST). */
export const egressRouter = { get, history, list };
