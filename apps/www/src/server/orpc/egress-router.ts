import type {
  RepoEgressAuditLog,
  RepoReviewSetting,
} from "@terragon/shared/db/types";
import type { DB } from "@terragon/shared/db";
import {
  canonicalizeEgressEntries,
  isEgressPolicyLevel,
} from "@terragon/shared/model/egress-policy";
import type { EgressEntryError } from "@terragon/shared/model/egress-entries";
import {
  listRepoEgressChanges,
  recordRepoEgressChange,
} from "@terragon/shared/model/repo-egress-audit-log";
import {
  getRepoReviewSetting,
  listRepoReviewSettings,
  RepoReviewSettingConflictError,
  upsertRepoReviewSetting,
} from "@terragon/shared/model/repo-review-settings";
import { sql } from "drizzle-orm";

import { RepoPath } from "@terragon/cli-api-contract";

import { db } from "@/lib/db";
import { getPostHogServer } from "@/lib/posthog-server";
import { checkCliEgressWriteRateLimit } from "@/lib/rate-limit";
import { cellBrokerHostOrUndefined } from "@/server-lib/compute/cell-gate";
import {
  computeEgressChange,
  patchShapeErrors,
  type EgressFields,
  type EgressPatch,
} from "@/server-lib/egress/egress-update";
import {
  getRepoEgressView,
  storedEgressLevel,
  type EgressRow,
} from "@/server-lib/egress/repo-egress-view";

import { orpcBase as base } from "./base";
import { invalidInputError } from "./api-version";
import {
  assertRepoInOrg,
  assertRepoWriteAccess,
  assertSessionWriteOrigin,
  readEditAccess,
  resolveEgressOrg,
  resolveEgressPrincipal,
  type EgressOrg,
  type EgressPrincipal,
  type RepoInOrg,
} from "./principal";

/** What the egress middleware puts on the context of every procedure. */
export interface EgressTarget {
  principal: EgressPrincipal;
  org: EgressOrg;
  /** Set when the path names a repo (`get`, `update`, `history`); not for `list`. */
  repoFullName?: string;
  row?: RepoReviewSetting;
}

/** `list` names no repo; the others name both segments. */
const PathTarget = RepoPath.partial({ owner: true, repo: true });

/**
 * The ONE authorization sequence of the egress API (spec 4.4): credential,
 * `{org}`, then repo in org when the path names one. It is mounted on the
 * `egress` namespace, and this file builds every procedure from `egressBase`,
 * so a new egress procedure cannot forget it. oRPC runs its input validation
 * after the namespace middlewares by its index; this parse exists to put the
 * credential first, so a bad shape never answers before an unauthenticated
 * 401. It uses the contract's own `RepoPath`, so a malformed segment is a 400
 * and never a repo-in-org lookup.
 */
const egressBase = base.egress.use(
  async ({ context, next, errors, procedure }, rawInput) => {
    const principal = await resolveEgressPrincipal(context, errors);
    // Step 2: every procedure the contract routes as a write.
    const method = procedure["~orpc"].route.method ?? "POST";
    if (method !== "GET" && method !== "HEAD") {
      await assertSessionWriteOrigin(principal, context.headers, errors);
    }
    const path = PathTarget.safeParse(rawInput);
    if (!path.success) {
      throw errors.BAD_REQUEST({
        data: invalidInputError(
          path.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        ),
      });
    }
    const org = await resolveEgressOrg(principal, path.data.org, errors);
    const { owner, repo } = path.data;
    if (owner === undefined && repo === undefined) {
      return next({ context: { principal, org } satisfies EgressTarget });
    }
    if (owner === undefined || repo === undefined) {
      throw errors.BAD_REQUEST({
        data: invalidInputError(["owner and repo go together"]),
      });
    }
    const found = await assertRepoInOrg({ org, owner, repo, errors });
    return next({
      context: { principal, org, ...found } satisfies EgressTarget,
    });
  },
);

/** The repo half of the context; a procedure whose path has no repo never asks for it. */
function repoTarget(context: EgressTarget): EgressTarget & RepoInOrg {
  if (context.repoFullName === undefined) {
    throw new Error("egress procedure without a repo in its path");
  }
  return { ...context, repoFullName: context.repoFullName, row: context.row };
}

const get = egressBase.get.handler(async ({ context }) => {
  const { principal, org, repoFullName, row } = repoTarget(context);
  const access = await readEditAccess({
    userId: principal.userId,
    organizationId: org.id,
    repoFullName,
  });
  const brokerHost = cellBrokerHostOrUndefined();
  return getRepoEgressView({ org, repoFullName, row, brokerHost, ...access });
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

const history = egressBase.history.handler(
  async ({ input, context, errors }) => {
    const { org, repoFullName } = repoTarget(context);
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

const list = egressBase.list.handler(async ({ context }) => {
  const { org } = context;
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

/** The stored fields of a row, in the form a change is computed on. */
function fieldsOfRow(row: EgressRow | undefined): EgressFields {
  return {
    level: storedEgressLevel(row?.egressPolicy ?? null),
    allowlist: canonicalizeEgressEntries(row?.egressAllowlist ?? []),
    registries: row?.cellEgressRegistries ?? null,
  };
}

/** The three stored columns of a set of fields. */
function columnsOf(fields: EgressFields) {
  return {
    egressPolicy: fields.level,
    egressAllowlist: fields.allowlist,
    cellEgressRegistries: fields.registries,
  };
}

/** The row a dry run would produce: the stored provenance with the result's three fields. */
function projectedRow(row: EgressRow | undefined, after: EgressFields) {
  return {
    ...columnsOf(after),
    updatedAt: row?.updatedAt ?? null,
    updatedByUserId: row?.updatedByUserId ?? null,
  } satisfies EgressRow;
}

/** `audit` is set only for an applied change: the applied flag, the audit id and the analytics event all derive from it. */
interface UpdateOutcome {
  before: EgressRow | undefined;
  after: EgressRow | undefined;
  audit: RepoEgressAuditLog | null;
}

type UpdateInput = EgressPatch & {
  expectedUpdatedAt?: string | null;
  dryRun?: boolean;
};

interface UpdateErrors {
  BAD_REQUEST: (options: {
    data: ReturnType<typeof invalidInputError> | { errors: EgressEntryError[] };
  }) => Error;
  CONFLICT: (options: { data: { currentUpdatedAt: string | null } }) => Error;
}

interface UpdateScope {
  org: EgressOrg;
  repoFullName: string;
  principal: EgressPrincipal;
  input: UpdateInput;
  errors: UpdateErrors;
  /** Resolved once per request. */
  brokerHost: string | undefined;
}

/** Step 3, the compare-and-set: a sent token must still name the stored version. */
function assertExpectedVersion(
  expected: string | null | undefined,
  stored: RepoReviewSetting | undefined,
  errors: UpdateErrors,
): void {
  if (expected === undefined) return;
  const at = expected === null ? null : new Date(expected).getTime();
  if (Number.isNaN(at)) {
    throw errors.BAD_REQUEST({
      data: invalidInputError(["expectedUpdatedAt is not a date"]),
    });
  }
  const holds =
    at === null ? stored === undefined : stored?.updatedAt.getTime() === at;
  if (holds) return;
  throw errors.CONFLICT({
    data: { currentUpdatedAt: stored?.updatedAt.toISOString() ?? null },
  });
}

/**
 * A stored level this build does not know (only a raw SQL write puts one
 * there) must never be read as "no policy": writing the three fields back
 * would store NULL and open the box. The patch must send a `level` to replace it.
 */
function assertStoredLevelReplaceable(
  stored: RepoReviewSetting | undefined,
  input: UpdateInput,
  errors: UpdateErrors,
): void {
  const raw = stored?.egressPolicy ?? null;
  if (raw === null || isEgressPolicyLevel(raw) || input.level !== undefined) {
    return;
  }
  throw errors.BAD_REQUEST({
    data: {
      errors: [
        {
          code: "invalid_input",
          message:
            "the stored egress level is not valid; send a level to replace it",
          entry: null,
          index: null,
        },
      ],
    },
  });
}

/** Write the change and its audit row; both land in the caller's transaction. */
async function writeChange(
  scope: UpdateScope,
  txDb: DB,
  stored: RepoReviewSetting | undefined,
  fields: { before: EgressFields; after: EgressFields },
): Promise<UpdateOutcome> {
  const { org, repoFullName, principal } = scope;
  const written = await upsertRepoReviewSetting({
    db: txDb,
    organizationId: org.id,
    repoFullName,
    patch: columnsOf(fields.after),
    updatedByUserId: principal.userId,
    expectedUpdatedAt: stored?.updatedAt,
    expectRowAbsent: stored ? undefined : true,
  });
  const audit = await recordRepoEgressChange({
    db: txDb,
    organizationId: org.id,
    repoFullName,
    actorUserId: principal.userId,
    authKind: principal.authKind,
    credentialId: principal.credentialId,
    before: fields.before,
    after: fields.after,
  });
  return { before: stored, after: written, audit };
}

/** Steps 1 to 7 of the handler (spec 4.6), inside one transaction. */
async function updateInTransaction(
  scope: UpdateScope,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
): Promise<UpdateOutcome> {
  const { org, repoFullName, input, errors } = scope;
  const txDb = tx as unknown as DB;
  // Serializes new-API writers on one (org, repo), the no-row case too.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${org.id}/${repoFullName}`}, 0))`,
  );
  const stored = await getRepoReviewSetting({
    db: txDb,
    organizationId: org.id,
    repoFullName,
  });
  assertExpectedVersion(input.expectedUpdatedAt, stored, errors);
  assertStoredLevelReplaceable(stored, input, errors);
  const before = fieldsOfRow(stored);
  const change = computeEgressChange(before, input, scope.brokerHost);
  if (!change.ok) {
    throw errors.BAD_REQUEST({ data: { errors: change.errors } });
  }
  if (input.dryRun) {
    const after = projectedRow(stored, change.after);
    return { before: stored, after, audit: null };
  }
  if (!change.changed) {
    return { before: stored, after: stored, audit: null };
  }
  return writeChange(scope, txDb, stored, { before, after: change.after });
}

/**
 * After commit: the analytics event. It carries counts and levels, NEVER a
 * host (an allowlist entry can name an internal service). A failure of the
 * analytics client must not fail a change that already committed.
 */
function captureEgressChanged(
  scope: Pick<UpdateScope, "org" | "repoFullName" | "principal">,
  audit: RepoEgressAuditLog,
): void {
  const { org, repoFullName, principal } = scope;
  try {
    getPostHogServer().capture({
      distinctId: principal.userId,
      event: "repo_egress_changed",
      properties: {
        organizationId: org.id,
        repoFullName,
        authKind: principal.authKind,
        levelBefore: storedEgressLevel(audit.levelBefore),
        levelAfter: storedEgressLevel(audit.levelAfter),
        registriesBefore: audit.registriesBefore,
        registriesAfter: audit.registriesAfter,
        addedCount: audit.hostsAdded.length,
        removedCount: audit.hostsRemoved.length,
      },
    });
  } catch (error) {
    console.error("repo_egress_changed capture failed", {
      error: error instanceof Error ? error.name : typeof error,
    });
  }
}

const update = egressBase.update.handler(async ({ input, context, errors }) => {
  const { principal, org, repoFullName } = repoTarget(context);
  await assertRepoWriteAccess({
    userId: principal.userId,
    organizationId: org.id,
    repoFullName,
    errors,
  });
  // A malformed patch spends no budget and opens no transaction.
  const shape = patchShapeErrors(input);
  if (shape.length > 0) {
    throw errors.BAD_REQUEST({ data: { errors: shape } });
  }
  const limited =
    !input.dryRun && !(await checkCliEgressWriteRateLimit(principal.userId));
  if (limited) {
    throw errors.RATE_LIMIT_EXCEEDED({
      message: "Too many egress changes. Try again later.",
    });
  }
  const brokerHost = cellBrokerHostOrUndefined();
  const scope = { org, repoFullName, principal, input, errors, brokerHost };
  let outcome: UpdateOutcome;
  try {
    outcome = await db.transaction((tx) => updateInTransaction(scope, tx));
  } catch (error) {
    // A racing legacy PUT does not take the advisory lock: the DB fence caught it.
    if (!(error instanceof RepoReviewSettingConflictError)) throw error;
    const current = await getRepoReviewSetting({
      db,
      organizationId: org.id,
      repoFullName,
    });
    throw errors.CONFLICT({
      data: { currentUpdatedAt: current?.updatedAt.toISOString() ?? null },
    });
  }
  if (outcome.audit) captureEgressChanged(scope, outcome.audit);
  const access = { canEdit: true, readOnlyReason: null } as const;
  const view = (row: EgressRow | undefined) =>
    getRepoEgressView({ org, repoFullName, row, brokerHost, ...access });
  const before = view(outcome.before);
  return {
    applied: outcome.audit !== null,
    before,
    after: outcome.after === outcome.before ? before : view(outcome.after),
    auditId: outcome.audit?.id ?? null,
  };
});

/** The egress procedures: the same router serves `/api/cli` (RPC) and `/api/v1` (REST). */
export const egressRouter = { get, update, history, list };
