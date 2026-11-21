import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { DB } from "@terragon/shared/db";
import {
  ACTIVE_ORGANIZATION_CHANGED_MESSAGE,
  getTenantContextOrNull,
} from "@/lib/auth-server";
import {
  upsertRepoReviewSetting,
  removeRepoReviewSetting,
  RepoReviewSettingConflictError,
  getRepoReviewSetting,
} from "@terragon/shared/model/repo-review-settings";
import {
  findEgressPatchErrorResponse,
  findHarnessPacksGateResponse,
  parseEgressPatch,
  parseReviewAgentPatch,
  parseReviewDraftPrs,
  parseSelfHealPatch,
  parseSupersedePatch,
  recordSelfHealSettingsChange,
  toRepoReviewSettingDto,
} from "../../review-settings-route-shared";
import {
  REVIEW_AGENT_FIELDS,
  type ReviewAgentField,
  type ReviewAgentFieldsPatch,
} from "@terragon/shared/model/review-agent-settings";
import {
  SELF_HEAL_FIELDS,
  type SelfHealField,
  type SelfHealFieldsPatch,
} from "@terragon/shared/model/self-heal-settings";
import { checkRepoWriteAccess } from "@/lib/repo-write-access";
import {
  BLOCK_TOLERANCES,
  isBlockTolerance,
} from "@terragon/review/severity-policy";
import { getPostHogServer } from "@/lib/posthog-server";

/**
 * PUT/DELETE /api/review-settings/[owner]/[repo]
 *
 * Set or clear a per-repo REQUESTED_CHANGES tolerance (ADR-036 review floor) for
 * the caller's active organization. Every mutation is fenced to the session's
 * active org — one org can never write another's override — and validated
 * against {@link BLOCK_TOLERANCES}. A PostHog event per mutation is the audit
 * trail (who/what/when), alongside the row's own `updatedByUserId`/`updatedAt`.
 */

function repoFromParams(owner: string, repo: string): string {
  return `${decodeURIComponent(owner)}/${decodeURIComponent(repo)}`;
}

/**
 * #728 (AC-13): the caller may name the org it means (`organizationId` in the
 * PUT body, `?organizationId=` on DELETE). When it differs from the session's
 * active org — another tab switched orgs — the request is refused before any
 * read or write, so it can never land in the wrong org. Ids are opaque: the
 * match is exact (no trim, no case folding), and the 409 echoes neither id.
 * Absent keeps today's behaviour (the OD-5 grace period). Returns a NextResponse to send, or null.
 */
function findOrgMismatchResponse(
  requested: unknown,
  activeOrganizationId: string,
): NextResponse | null {
  if (requested === undefined) return null;
  if (typeof requested !== "string" || requested.length === 0) {
    return NextResponse.json(
      { error: "organizationId must be a string" },
      { status: 400 },
    );
  }
  if (requested !== activeOrganizationId) {
    return NextResponse.json(
      {
        error: "active_org_changed",
        message: ACTIVE_ORGANIZATION_CHANGED_MESSAGE,
      },
      { status: 409 },
    );
  }
  return null;
}

/**
 * #125 C6 two-level permission for repo-level writes (all three settings of
 * the family, plus the phase 4 review-agent family), decided by
 * {@link checkRepoWriteAccess} and rendered here as this route's human 403
 * copy. Returns a NextResponse to send, or null when allowed.
 */
async function requireRepoWriteAccess({
  userId,
  organizationId,
  repoFullName,
}: {
  userId: string;
  organizationId: string;
  repoFullName: string;
}): Promise<NextResponse | null> {
  const access = await checkRepoWriteAccess({
    db,
    userId,
    organizationId,
    repoFullName,
  });
  if (access === "allowed") return null;
  if (access === "lookup_failed") {
    return NextResponse.json(
      {
        error:
          "We couldn't verify your permission on GitHub for this repository. Try again in a moment.",
      },
      { status: 403 },
    );
  }
  return NextResponse.json(
    {
      error:
        "Only organization admins or admins of this repository can change its review settings.",
    },
    { status: 403 },
  );
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ owner: string; repo: string }> },
): Promise<NextResponse> {
  const ctx = await getTenantContextOrNull();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!ctx.organizationId) {
    return NextResponse.json(
      { error: "No active organization" },
      { status: 400 },
    );
  }

  let body: {
    blockTolerance?: unknown;
    reviewDraftPrs?: unknown;
    supersedePolicy?: unknown;
    recheckOnComplete?: unknown;
    egressPolicy?: unknown;
    egressAllowlist?: unknown;
    cellEgressRegistries?: unknown;
    expectedUpdatedAt?: unknown;
    organizationId?: unknown;
  } & Partial<Record<ReviewAgentField | SelfHealField, unknown>>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const orgMismatch = findOrgMismatchResponse(
    body.organizationId,
    ctx.organizationId,
  );
  if (orgMismatch) return orgMismatch;

  const patch: {
    blockTolerance?: string;
    reviewDraftPrs?: boolean | null;
    supersedePolicy?: string | null;
    recheckOnComplete?: boolean;
    egressPolicy?: string | null;
    egressAllowlist?: string[] | null;
    cellEgressRegistries?: boolean | null;
  } & ReviewAgentFieldsPatch &
    SelfHealFieldsPatch = {};
  if (body.blockTolerance !== undefined) {
    if (!isBlockTolerance(body.blockTolerance)) {
      return NextResponse.json(
        {
          error: `blockTolerance must be one of ${BLOCK_TOLERANCES.join(", ")}`,
        },
        { status: 400 },
      );
    }
    patch.blockTolerance = body.blockTolerance;
  }
  const drafts = parseReviewDraftPrs(body);
  if ("errorResponse" in drafts) return drafts.errorResponse;
  if (drafts.reviewDraftPrs !== undefined)
    patch.reviewDraftPrs = drafts.reviewDraftPrs;
  const supersede = parseSupersedePatch(body);
  if ("errorResponse" in supersede) return supersede.errorResponse;
  Object.assign(patch, supersede.patch);
  const egress = parseEgressPatch(body);
  if ("errorResponse" in egress) return egress.errorResponse;
  Object.assign(patch, egress.patch);
  const reviewAgent = parseReviewAgentPatch(body);
  if ("errorResponse" in reviewAgent) return reviewAgent.errorResponse;
  Object.assign(patch, reviewAgent.patch);
  const selfHeal = parseSelfHealPatch(body, { isOrgDefaultRow: false });
  if ("errorResponse" in selfHeal) return selfHeal.errorResponse;
  Object.assign(patch, selfHeal.patch);
  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      {
        error:
          "provide blockTolerance, reviewDraftPrs, supersedePolicy, recheckOnComplete, egressPolicy, egressAllowlist, cellEgressRegistries and/or a review-agent field or self-heal field",
      },
      { status: 400 },
    );
  }

  const { owner, repo } = await params;
  const repoFullName = repoFromParams(owner, repo);

  // #125 C6: two-level permission — previously ANY member with an active org
  // could write. Applies to all three settings of the family and to the
  // phase 4 review-agent family.
  const denied = await requireRepoWriteAccess({
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    repoFullName,
  });
  if (denied) return denied;
  const harnessGate = await findHarnessPacksGateResponse({
    db,
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    repoFullName,
    patch,
  });
  if (harnessGate) return harnessGate;
  // #66: the stored egress policy is read at every dispatch and THROWS there
  // when invalid, so the write is refused here with the same validator.
  const egressError = await findEgressPatchErrorResponse({
    db,
    organizationId: ctx.organizationId,
    repoFullName,
    patch,
  });
  if (egressError) return egressError;

  // Optimistic concurrency, enforced by the DATABASE in the write itself
  // (ON CONFLICT … DO UPDATE … WHERE updated_at = expected): two admins who
  // read the same version can never both win — the loser gets a 409, never
  // a silent last-write-wins.
  // `expectedUpdatedAt: null` is the FIRST-WRITE fence: the caller read "no
  // override yet" and the write must only apply while that is still true.
  // Phase 4: a review-agent-only first write is sent only when the repo has
  // no row at all, so it takes the whole-row fence — the per-family
  // supersede fence would let a racing review-agent first write slip
  // through. Exactly one fence is ever passed.
  const firstWrite = body.expectedUpdatedAt === null;
  const reviewAgentOnly = Object.keys(patch).every(
    (key) =>
      (REVIEW_AGENT_FIELDS as readonly string[]).includes(key) ||
      (SELF_HEAL_FIELDS as readonly string[]).includes(key),
  );
  const expectRowAbsent = firstWrite && reviewAgentOnly ? true : undefined;
  const expectAbsentSupersedeOverride =
    firstWrite && !reviewAgentOnly ? true : undefined;
  const expectedUpdatedAt =
    typeof body.expectedUpdatedAt === "string"
      ? new Date(body.expectedUpdatedAt)
      : undefined;
  if (expectedUpdatedAt && Number.isNaN(expectedUpdatedAt.getTime())) {
    return NextResponse.json(
      { error: "expectedUpdatedAt must be an ISO timestamp" },
      { status: 400 },
    );
  }
  let row;
  try {
    // One transaction: the settings write and its OBS-01 actor-log row land
    // together or not at all, so an applied change (the kill switch above all)
    // is never left unattributed, and a failed log never reports a 500 for a
    // write that already took effect.
    const organizationId = ctx.organizationId;
    const actorUserId = ctx.userId;
    row = await db.transaction(async (tx) => {
      const txDb = tx as unknown as DB;
      const written = await upsertRepoReviewSetting({
        db: txDb,
        organizationId,
        repoFullName,
        patch,
        updatedByUserId: actorUserId,
        expectedUpdatedAt,
        expectAbsentSupersedeOverride,
        expectRowAbsent,
      });
      await recordSelfHealSettingsChange({
        db: txDb,
        organizationId,
        actorUserId,
        repoFullName: written.repoFullName,
        patch,
      });
      return written;
    });
  } catch (error) {
    if (error instanceof RepoReviewSettingConflictError) {
      const current = await getRepoReviewSetting({
        db,
        organizationId: ctx.organizationId,
        repoFullName: repoFullName,
      });
      return NextResponse.json(
        {
          error: "conflict",
          currentUpdatedAt: current?.updatedAt?.toISOString() ?? null,
        },
        { status: 409 },
      );
    }
    throw error;
  }

  getPostHogServer().capture({
    distinctId: ctx.userId,
    event: "review_tolerance_set",
    properties: {
      organizationId: ctx.organizationId,
      repoFullName: row.repoFullName,
      blockTolerance: row.blockTolerance,
      reviewDraftPrs: row.reviewDraftPrs,
      supersedePolicy: row.supersedePolicy,
      recheckOnComplete: row.recheckOnComplete,
      // The level only: allowlist entries may name internal hosts.
      egressPolicy: row.egressPolicy,
      // #705: the cell registries opt-in widens a cell's egress.
      cellEgressRegistries: row.cellEgressRegistries,
      // What THIS write changed — the audit trail must show the delta, not
      // just the resulting row.
      changed: Object.keys(patch),
    },
  });

  return NextResponse.json({ setting: toRepoReviewSettingDto(row) });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ owner: string; repo: string }> },
): Promise<NextResponse> {
  const ctx = await getTenantContextOrNull();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!ctx.organizationId) {
    return NextResponse.json(
      { error: "No active organization" },
      { status: 400 },
    );
  }
  const searchParams = request.nextUrl.searchParams;
  // A repeated param stays an array, so it is a 400 rather than "the first
  // one wins" (`?organizationId=<active>&organizationId=<other>` must not pass).
  const requestedOrgs = searchParams.getAll("organizationId");
  const orgMismatch = findOrgMismatchResponse(
    requestedOrgs.length > 1 ? requestedOrgs : requestedOrgs[0],
    ctx.organizationId,
  );
  if (orgMismatch) return orgMismatch;

  const { owner, repo } = await params;
  const repoFullName = repoFromParams(owner, repo);

  const denied = await requireRepoWriteAccess({
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    repoFullName,
  });
  if (denied) return denied;

  // Optional CAS on the reset path too (?expectedUpdatedAt=<iso>).
  const expectedRaw = searchParams.get("expectedUpdatedAt");
  const expectedUpdatedAt = expectedRaw ? new Date(expectedRaw) : undefined;
  if (expectedUpdatedAt && Number.isNaN(expectedUpdatedAt.getTime())) {
    return NextResponse.json(
      { error: "expectedUpdatedAt must be an ISO timestamp" },
      { status: 400 },
    );
  }
  const { removed, conflict } = await removeRepoReviewSetting({
    db,
    organizationId: ctx.organizationId,
    repoFullName,
    expectedUpdatedAt,
  });
  if (conflict) {
    // Same 409 shape as PUT (review-settings-route-shared.ts): the client's
    // ConflictError parser reads currentUpdatedAt on every conflict.
    const current = await getRepoReviewSetting({
      db,
      organizationId: ctx.organizationId,
      repoFullName,
    });
    return NextResponse.json(
      {
        error: "conflict",
        currentUpdatedAt: current?.updatedAt?.toISOString() ?? null,
      },
      { status: 409 },
    );
  }

  getPostHogServer().capture({
    distinctId: ctx.userId,
    event: "review_tolerance_cleared",
    properties: {
      organizationId: ctx.organizationId,
      repoFullName: repoFullName.toLowerCase(),
      removed,
    },
  });

  return NextResponse.json({ removed });
}
