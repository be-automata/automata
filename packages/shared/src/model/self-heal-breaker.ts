import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  gt,
  inArray,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import type { DB } from "../db";
import {
  selfHealAdminLog,
  selfHealBreaker,
  selfHealBreakerEvent,
} from "../db/schema";
import { withSelfHealTx, type SelfHealTx } from "./self-heal-tx";

/**
 * Postgres-backed breakers for the self-heal loop (BRK-01 subset, RESILIENCE
 * 3-4). Workers isolates share nothing and production has no Redis, so every
 * piece of state lives in self_heal_breaker / self_heal_breaker_event and every
 * transition is `UPDATE ... WHERE version = $v RETURNING` inside withSelfHealTx:
 * two isolates racing one transition get exactly one winner.
 *
 * Signals here are GitHub API outcomes and the permission latch only. There is
 * deliberately no spend, balance or auth-failure input: the operator decided
 * against spend limits, and an expired or exhausted login is never a reason to
 * open a breaker.
 *
 * All clocks are injected (`now`) so tests drive a virtual clock, and all
 * timestamp comparisons use the query builder (the column encoder), never a raw
 * sql parameter: a raw Date is serialised in the process timezone and
 * mis-compares against these timestamp-without-tz columns.
 *
 * MULTI-TENANT (ADR-001): every function takes `organizationId` except the ones
 * named in UNFENCED_SELF_HEAL_MODEL_FUNCTIONS.
 */

export type BreakerRow = typeof selfHealBreaker.$inferSelect;
export type BreakerScopeKind = BreakerRow["scopeKind"];
export type BreakerState = BreakerRow["state"];
export type BreakerEventOutcome =
  (typeof selfHealBreakerEvent.$inferSelect)["outcome"];
export type PermissionName =
  | "issues"
  | "pull_requests"
  | "contents"
  | "checks"
  | "actions";

/** Injected so library code never imports a logger (and tests can assert on it). */
export type BreakerLogger = (
  message: string,
  fields: Record<string, unknown>,
) => void;

export interface BreakerTransition {
  from: BreakerState;
  to: BreakerState;
  reason: string;
  tripCount: number;
  openUntil: Date | null;
}

/** Functions that read or sweep across organizations, and why (TIER-01). */
export const UNFENCED_SELF_HEAL_MODEL_FUNCTIONS: Record<string, string> = {
  listReclaimableAuditRuns:
    "sweep reclaims expired audit-run leases across all orgs",
  getAuditRunForCheckReport:
    "the check token is the authority; the row carries organizationId",
  claimDueEffects:
    "cron outbox drainer; rows carry organizationId and callers re-fence",
  pruneSelfHealRows: "retention sweep deletes by age across all orgs",
  listExpiredFixClaims:
    "reconcile sweep finds lost fix dispatches across all orgs; rows carry organizationId",
  listStaleDispatchedAttempts:
    "reconcile reads lost fix dispatches back from Hatchet across all orgs; rows carry organizationId",
  listTerminalUnreportedAttempts:
    "reconcile classifies terminal unreported fix runs across all orgs; rows carry organizationId",
  listFixReadyFindings:
    "dispatcher selector across all orgs; callers re-fence by the row's organizationId",
  getFixAttemptForGateReport:
    "the gate token is the authority; the row carries organizationId",
  listPendingPrOpens:
    "tick sweep resumes draft-PR opens across all orgs; rows carry organizationId",
  getFixAttemptByPr:
    "the pull_request webhook signature is the authority; the row carries organizationId",
  listUnsettledFixPrs:
    "lifecycle sweep settles merged/closed fix PRs across all orgs; rows carry organizationId",
  listOpenReadyFixPrs:
    "expiry sweep finds unreviewed ready fix PRs across all orgs; rows carry organizationId",
  listRegressionCandidates:
    "daily regression sweep reads merged fix PRs across all orgs; rows carry organizationId",
  acquireSelfHealSlot: "platform-wide single box slot",
  setSlotHolderThread: "platform-wide single box slot",
  releaseSelfHealSlot: "platform-wide single box slot",
  getSelfHealSlot: "platform-wide single box slot",
};

export const GH_CREATE_SIGNAL = "gh_create";

const DAY_MS = 86_400_000;
const DECAY_PERIOD_MS = 14 * DAY_MS;
const FIVE_MIN_MS = 300_000;
const MIN_WINDOW_EVENTS = 20;
const MIN_VOLUME = 10;
const TRIP_FAILURE_RATIO = 0.5;
const CONSECUTIVE_TIMEOUTS = 3;
const EVENT_SCAN_LIMIT = 200;

interface CooldownConfig {
  baseMs: number;
  capMs: number;
}

/** The breakers whose cooldown doubles per trip (loop breakers escalate instead). */
type DoublingBreakerKind =
  | "github_write"
  | "github_read"
  | "hatchet_dispatch"
  | "exec_plane";

const COOLDOWNS: Record<DoublingBreakerKind, CooldownConfig> = {
  github_write: { baseMs: 60_000, capMs: 15 * 60_000 },
  github_read: { baseMs: 30_000, capMs: 5 * 60_000 },
  hatchet_dispatch: { baseMs: 120_000, capMs: 30 * 60_000 },
  exec_plane: { baseMs: 3_600_000, capMs: 12 * 3_600_000 },
};

function isDoublingBreakerKind(
  scopeKind: BreakerScopeKind,
): scopeKind is DoublingBreakerKind {
  return Object.hasOwn(COOLDOWNS, scopeKind);
}

/**
 * base * 2^(tripCount-1), capped (github write 60 s → 15 min, read 30 s →
 * 5 min, hatchet 120 s → 30 min, exec 1 h → 12 h). tripCount below 1 is
 * treated as 1.
 */
export function breakerCooldownMs(
  scopeKind: DoublingBreakerKind,
  tripCount: number,
): number {
  const { baseMs, capMs } = COOLDOWNS[scopeKind];
  const exp = Math.min(Math.max(tripCount, 1) - 1, 20);
  return Math.min(baseMs * 2 ** exp, capMs);
}

function scopeWhere(
  organizationId: string,
  scopeKind: BreakerScopeKind,
  scopeKey: string,
) {
  return and(
    eq(selfHealBreaker.organizationId, organizationId),
    eq(selfHealBreaker.scopeKind, scopeKind),
    eq(selfHealBreaker.scopeKey, scopeKey),
  );
}

function eventScopeWhere(
  organizationId: string,
  scopeKind: BreakerScopeKind,
  scopeKey: string,
) {
  return and(
    eq(selfHealBreakerEvent.organizationId, organizationId),
    eq(selfHealBreakerEvent.scopeKind, scopeKind),
    eq(selfHealBreakerEvent.scopeKey, scopeKey),
  );
}

/** The row, or a synthetic closed one with version -1 when none exists. */
export async function getBreakerState({
  db,
  organizationId,
  scopeKind,
  scopeKey,
}: {
  db: DB;
  organizationId: string;
  scopeKind: BreakerScopeKind;
  scopeKey: string;
}): Promise<BreakerRow> {
  const [row] = await db
    .select()
    .from(selfHealBreaker)
    .where(scopeWhere(organizationId, scopeKind, scopeKey))
    .limit(1);
  return row ?? syntheticClosed(organizationId, scopeKind, scopeKey);
}

/**
 * Every installation-scoped breaker row of the org (github_write, github_read,
 * permission, hatchet_dispatch, exec_plane): the admin view of "its
 * installation". Repo-scoped loop breakers come from getBreakerState.
 */
export async function listInstallationBreakers({
  db,
  organizationId,
}: {
  db: DB;
  organizationId: string;
}): Promise<BreakerRow[]> {
  return db
    .select()
    .from(selfHealBreaker)
    .where(
      and(
        eq(selfHealBreaker.organizationId, organizationId),
        notInArray(selfHealBreaker.scopeKind, ["loop_audit", "loop_fix"]),
      ),
    )
    .orderBy(asc(selfHealBreaker.scopeKind), asc(selfHealBreaker.scopeKey));
}

function syntheticClosed(
  organizationId: string,
  scopeKind: BreakerScopeKind,
  scopeKey: string,
): BreakerRow {
  return {
    id: "",
    organizationId,
    scopeKind,
    scopeKey,
    state: "closed",
    openedAt: null,
    openUntil: null,
    halfOpenProbesLeft: 0,
    probeInFlightUntil: null,
    tripCount: 0,
    lastTripReason: null,
    lastTripEvidence: null,
    rateLimitedUntil: null,
    version: -1,
    updatedAt: new Date(0),
  };
}

export async function recordBreakerEvent({
  db,
  organizationId,
  scopeKind,
  scopeKey,
  outcome,
  signal,
  latencyMs,
  now,
}: {
  db: DB;
  organizationId: string;
  scopeKind: BreakerScopeKind;
  scopeKey: string;
  outcome: BreakerEventOutcome;
  signal?: string;
  latencyMs?: number;
  now?: Date;
}): Promise<void> {
  await db.insert(selfHealBreakerEvent).values({
    organizationId,
    scopeKind,
    scopeKey,
    outcome,
    signal: signal ?? null,
    latencyMs: latencyMs ?? null,
    ...(now ? { createdAt: now } : {}),
  });
}

export async function countRecentEvents({
  db,
  organizationId,
  scopeKind,
  scopeKey,
  signal,
  since,
}: {
  db: DB;
  organizationId: string;
  scopeKind: BreakerScopeKind;
  scopeKey: string;
  signal: string;
  since: Date;
}): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(selfHealBreakerEvent)
    .where(
      and(
        eventScopeWhere(organizationId, scopeKind, scopeKey),
        eq(selfHealBreakerEvent.signal, signal),
        gte(selfHealBreakerEvent.createdAt, since),
      ),
    );
  return row?.n ?? 0;
}

/** Version-CAS update; null when another writer won. */
async function casUpdate(
  tx: SelfHealTx,
  row: BreakerRow,
  patch: Partial<typeof selfHealBreaker.$inferInsert>,
  now: Date,
): Promise<BreakerRow | null> {
  const [updated] = await tx
    .update(selfHealBreaker)
    .set({ ...patch, version: row.version + 1, updatedAt: now })
    .where(
      and(
        eq(selfHealBreaker.id, row.id),
        eq(selfHealBreaker.version, row.version),
      ),
    )
    .returning();
  return updated ?? null;
}

/**
 * Evaluate a github_write / github_read breaker against its event window and
 * apply at most one transition (RESILIENCE 3.2):
 * - closed: trip on >=50% failures/timeouts over >=10 events of the larger of
 *   the last 20 events or the last 5 min, or on 3 consecutive timeouts;
 *   trip_count decays by 1 per 14 closed days first.
 * - open: becomes half_open (one probe) once open_until has passed.
 * - half_open: the first outcome after entry decides; success closes, failure
 *   re-opens with the escalated cooldown.
 * Exactly one log line per transition won; null when nothing changed.
 */
export async function evaluateApiBreaker({
  db,
  organizationId,
  scopeKind,
  scopeKey,
  now = new Date(),
  logger,
}: {
  db: DB;
  organizationId: string;
  scopeKind: "github_write" | "github_read";
  scopeKey: string;
  now?: Date;
  logger?: BreakerLogger;
}): Promise<BreakerTransition | null> {
  const transition = await withSelfHealTx(db, async (tx) => {
    let [row] = await tx
      .select()
      .from(selfHealBreaker)
      .where(scopeWhere(organizationId, scopeKind, scopeKey))
      .limit(1);

    // Only counted outcomes matter; newest first.
    const recent = await tx
      .select({
        outcome: selfHealBreakerEvent.outcome,
        createdAt: selfHealBreakerEvent.createdAt,
      })
      .from(selfHealBreakerEvent)
      .where(
        and(
          eventScopeWhere(organizationId, scopeKind, scopeKey),
          inArray(selfHealBreakerEvent.outcome, [
            "success",
            "failure",
            "timeout",
          ]),
          row?.openedAt
            ? gt(selfHealBreakerEvent.createdAt, row.openedAt)
            : undefined,
        ),
      )
      .orderBy(
        desc(selfHealBreakerEvent.createdAt),
        desc(selfHealBreakerEvent.id),
      )
      .limit(EVENT_SCAN_LIMIT);

    if (row?.state === "open") {
      if (!row.openUntil || row.openUntil > now) return null;
      const next = await casUpdate(
        tx,
        row,
        { state: "half_open", halfOpenProbesLeft: 1, probeInFlightUntil: null },
        now,
      );
      return next ? toTransition(row, next, "cooldown_elapsed") : null;
    }

    if (row?.state === "half_open") {
      const verdict = recent.find((e) => e.createdAt >= row!.updatedAt);
      if (!verdict) return null;
      if (verdict.outcome === "success") {
        const next = await casUpdate(
          tx,
          row,
          {
            state: "closed",
            halfOpenProbesLeft: 0,
            probeInFlightUntil: null,
            openUntil: null,
          },
          now,
        );
        return next ? toTransition(row, next, "probe_succeeded") : null;
      }
      return openBreaker(tx, row, scopeKind, "probe_failed", recent, now);
    }

    if (row?.state === "paused_manual") return null;

    // closed (or no row yet)
    const tripReason = closedTripReason(recent, now);
    if (!tripReason) {
      if (row) await decayTripCount(tx, row, now);
      return null;
    }
    if (!row) {
      await tx
        .insert(selfHealBreaker)
        .values({
          organizationId,
          scopeKind,
          scopeKey,
          state: "closed",
          updatedAt: now,
        })
        .onConflictDoNothing();
      [row] = await tx
        .select()
        .from(selfHealBreaker)
        .where(scopeWhere(organizationId, scopeKind, scopeKey))
        .limit(1);
      // Another isolate created or moved the row while we waited: it won.
      if (!row || row.state !== "closed" || row.version !== 0) return null;
    }
    const decayed = await decayTripCount(tx, row, now);
    if (!decayed) return null;
    return openBreaker(tx, decayed, scopeKind, tripReason, recent, now);
  });

  if (transition && logger) {
    logger("[self-heal:breaker] transition", {
      org: organizationId,
      scopeKind,
      scopeKey,
      from: transition.from,
      to: transition.to,
      reason: transition.reason,
      tripCount: transition.tripCount,
      openUntil: transition.openUntil?.toISOString() ?? null,
    });
  }
  return transition;
}

function toTransition(
  from: BreakerRow,
  to: BreakerRow,
  reason: string,
): BreakerTransition {
  return {
    from: from.state,
    to: to.state,
    reason,
    tripCount: to.tripCount,
    openUntil: to.openUntil,
  };
}

function isFailure(outcome: BreakerEventOutcome): boolean {
  return outcome === "failure" || outcome === "timeout";
}

function closedTripReason(
  recent: { outcome: BreakerEventOutcome; createdAt: Date }[],
  now: Date,
): string | null {
  const lastThree = recent.slice(0, CONSECUTIVE_TIMEOUTS);
  if (
    lastThree.length === CONSECUTIVE_TIMEOUTS &&
    lastThree.every((e) => e.outcome === "timeout")
  ) {
    return "consecutive_timeouts";
  }
  const inFiveMin = recent.filter(
    (e) => e.createdAt.getTime() >= now.getTime() - FIVE_MIN_MS,
  );
  const window =
    inFiveMin.length > MIN_WINDOW_EVENTS
      ? inFiveMin
      : recent.slice(0, MIN_WINDOW_EVENTS);
  if (window.length < MIN_VOLUME) return null;
  const failures = window.filter((e) => isFailure(e.outcome)).length;
  return failures / window.length >= TRIP_FAILURE_RATIO ? "error_rate" : null;
}

/** trip_count -1 per full 14 closed days; keeps the remainder of the clock. */
async function decayTripCount(
  tx: SelfHealTx,
  row: BreakerRow,
  now: Date,
): Promise<BreakerRow | null> {
  if (row.state !== "closed" || row.tripCount <= 0) return row;
  const periods = Math.floor(
    (now.getTime() - row.updatedAt.getTime()) / DECAY_PERIOD_MS,
  );
  if (periods <= 0) return row;
  return casUpdate(
    tx,
    row,
    { tripCount: Math.max(0, row.tripCount - periods) },
    new Date(row.updatedAt.getTime() + periods * DECAY_PERIOD_MS),
  );
}

async function openBreaker(
  tx: SelfHealTx,
  row: BreakerRow,
  scopeKind: "github_write" | "github_read",
  reason: string,
  recent: { outcome: BreakerEventOutcome }[],
  now: Date,
): Promise<BreakerTransition | null> {
  const tripCount = row.tripCount + 1;
  const openUntil = new Date(
    now.getTime() + breakerCooldownMs(scopeKind, tripCount),
  );
  const next = await casUpdate(
    tx,
    row,
    {
      state: "open",
      openedAt: now,
      openUntil,
      halfOpenProbesLeft: 0,
      probeInFlightUntil: null,
      tripCount,
      lastTripReason: reason,
      lastTripEvidence: {
        events: recent.length,
        failures: recent.filter((e) => isFailure(e.outcome)).length,
      },
    },
    now,
  );
  if (!next) return null;
  await tx.insert(selfHealBreakerEvent).values({
    organizationId: row.organizationId,
    scopeKind,
    scopeKey: row.scopeKey,
    outcome: "trip",
    signal: reason,
    createdAt: now,
  });
  return toTransition(row, next, reason);
}

/**
 * Move the Retry-After horizon forward, never back (GREATEST), creating the
 * github_write row when absent. Outbox rows of the org are not due until it passes.
 */
export async function extendRateLimitedUntil({
  db,
  organizationId,
  installationKey,
  until,
}: {
  db: DB;
  organizationId: string;
  installationKey: string;
  until: Date;
}): Promise<void> {
  await withSelfHealTx(db, async (tx) => {
    await tx
      .insert(selfHealBreaker)
      .values({
        organizationId,
        scopeKind: "github_write",
        scopeKey: installationKey,
        rateLimitedUntil: until,
      })
      .onConflictDoUpdate({
        target: [
          selfHealBreaker.organizationId,
          selfHealBreaker.scopeKind,
          selfHealBreaker.scopeKey,
        ],
        set: {
          rateLimitedUntil: sql`GREATEST(coalesce(${selfHealBreaker.rateLimitedUntil}, excluded.rate_limited_until), excluded.rate_limited_until)`,
          version: sql`${selfHealBreaker.version} + 1`,
          updatedAt: new Date(),
        },
      });
  });
}

function permissionKey(installationId: string, permission: PermissionName) {
  return `${installationId}:${permission}`;
}

async function setPermissionState(
  db: DB,
  organizationId: string,
  installationId: string,
  permission: PermissionName,
  state: "open" | "closed",
  reason: string,
  now: Date,
): Promise<void> {
  await withSelfHealTx(db, async (tx) => {
    await tx
      .insert(selfHealBreaker)
      .values({
        organizationId,
        scopeKind: "permission",
        scopeKey: permissionKey(installationId, permission),
        state,
        openedAt: state === "open" ? now : null,
        lastTripReason: reason,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          selfHealBreaker.organizationId,
          selfHealBreaker.scopeKind,
          selfHealBreaker.scopeKey,
        ],
        set: {
          state,
          openedAt: state === "open" ? now : null,
          lastTripReason: reason,
          version: sql`${selfHealBreaker.version} + 1`,
          updatedAt: now,
        },
      });
  });
}

/** One non-rate-limit 403, or a preflight showing a permission other than write. */
export async function setPermissionLatch({
  db,
  organizationId,
  installationId,
  permission,
  reason,
  now = new Date(),
}: {
  db: DB;
  organizationId: string;
  installationId: string;
  permission: PermissionName;
  reason: string;
  now?: Date;
}): Promise<void> {
  await setPermissionState(
    db,
    organizationId,
    installationId,
    permission,
    "open",
    reason,
    now,
  );
}

/** Only a preflight showing `write` clears the latch. */
export async function clearPermissionLatch({
  db,
  organizationId,
  installationId,
  permission,
  reason,
  now = new Date(),
}: {
  db: DB;
  organizationId: string;
  installationId: string;
  permission: PermissionName;
  reason: string;
  now?: Date;
}): Promise<void> {
  await setPermissionState(
    db,
    organizationId,
    installationId,
    permission,
    "closed",
    reason,
    now,
  );
}

/**
 * Take the single half-open probe: one CAS from probes_left 1 to 0 with a lease
 * on the in-flight probe. An expired probe lease may be re-taken. Pass `tx` to
 * join an outer claim transaction.
 */
export async function acquireHalfOpenProbe({
  db,
  organizationId,
  scopeKind,
  scopeKey,
  leaseMs = 30_000,
  now = new Date(),
  tx,
}: {
  db: DB;
  organizationId: string;
  scopeKind: BreakerScopeKind;
  scopeKey: string;
  leaseMs?: number;
  now?: Date;
  tx?: SelfHealTx;
}): Promise<boolean> {
  const run = async (t: SelfHealTx) => {
    const rows = await t
      .update(selfHealBreaker)
      .set({
        halfOpenProbesLeft: 0,
        probeInFlightUntil: new Date(now.getTime() + leaseMs),
        version: sql`${selfHealBreaker.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          scopeWhere(organizationId, scopeKind, scopeKey),
          eq(selfHealBreaker.state, "half_open"),
          or(
            gt(selfHealBreaker.halfOpenProbesLeft, 0),
            lt(selfHealBreaker.probeInFlightUntil, now),
          ),
        ),
      )
      .returning({ id: selfHealBreaker.id });
    return rows.length === 1;
  };
  return tx ? run(tx) : withSelfHealTx(db, run);
}

/** Operator reset: closed, trip_count kept, actor recorded in the same transaction. */
export async function resetBreaker({
  db,
  organizationId,
  scopeKind,
  scopeKey,
  actorUserId,
  now = new Date(),
}: {
  db: DB;
  organizationId: string;
  scopeKind: BreakerScopeKind;
  scopeKey: string;
  actorUserId: string;
  now?: Date;
}): Promise<void> {
  await withSelfHealTx(db, async (tx) => {
    await tx
      .update(selfHealBreaker)
      .set({
        state: "closed",
        openUntil: null,
        halfOpenProbesLeft: 0,
        probeInFlightUntil: null,
        version: sql`${selfHealBreaker.version} + 1`,
        updatedAt: now,
      })
      .where(scopeWhere(organizationId, scopeKind, scopeKey));
    await tx.insert(selfHealAdminLog).values({
      organizationId,
      actorUserId,
      action: "breaker_reset",
      target: { scopeKind, scopeKey },
    });
  });
}

// ---------------------------------------------------------------------------
// Loop and plane breakers (BRK-01 remainder, RESILIENCE 3.2-3.3, phase 9).
// ---------------------------------------------------------------------------

/** loop_fix / loop_audit: 24 h, then 72 h; the third trip in 30 days pauses. */
export const LOOP_COOLDOWNS_MS = [86_400_000, 259_200_000] as const;
export const LOOP_ESCALATION_WINDOW_MS = 30 * DAY_MS;

export type TripCooldown = number | "paused_manual";

const LOOP_KINDS: ReadonlySet<BreakerScopeKind> = new Set([
  "loop_fix",
  "loop_audit",
]);

export function isLoopBreakerKind(scopeKind: BreakerScopeKind): boolean {
  return LOOP_KINDS.has(scopeKind);
}

/** The loop escalation: trips already recorded in the last 30 days → cooldown. */
export function loopCooldown(priorTripsIn30d: number): TripCooldown {
  return LOOP_COOLDOWNS_MS[priorTripsIn30d] ?? "paused_manual";
}

/** PostHog-shaped sink, injected (shared code never imports PostHog). */
export type BreakerCapture = (
  event: string,
  properties: Record<string, string>,
) => void;

/** Trips ('trip' events) of one scope since `since`. */
export async function countTripsSince({
  db,
  tx,
  organizationId,
  scopeKind,
  scopeKey,
  since,
}: {
  db: DB;
  tx?: SelfHealTx;
  organizationId: string;
  scopeKind: BreakerScopeKind;
  scopeKey: string;
  since: Date;
}): Promise<number> {
  const [row] = await (tx ?? db)
    .select({ n: count() })
    .from(selfHealBreakerEvent)
    .where(
      and(
        eventScopeWhere(organizationId, scopeKind, scopeKey),
        eq(selfHealBreakerEvent.outcome, "trip"),
        gte(selfHealBreakerEvent.createdAt, since),
      ),
    );
  return row?.n ?? 0;
}

function evidenceAttemptIds(evidence: unknown): string[] {
  if (evidence === null || typeof evidence !== "object") return [];
  const ids = (evidence as Record<string, unknown>).attemptIds;
  return Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === "string").slice(0, 3)
    : [];
}

/**
 * The single transition line (and PostHog event) of RESILIENCE §8; a loop
 * breaker that leaves `closed`/`half_open` for `open`/`paused_manual` also
 * gets the LOOP_OPEN line and `self_heal_loop_paused`. Callers that tripped
 * inside their own transaction call this after it commits.
 */
export function emitBreakerTransition({
  organizationId,
  scopeKind,
  scopeKey,
  transition,
  evidence,
  logger,
  capture,
}: {
  organizationId: string;
  scopeKind: BreakerScopeKind;
  scopeKey: string;
  transition: BreakerTransition;
  evidence?: unknown;
  logger?: BreakerLogger;
  capture?: BreakerCapture;
}): void {
  const openUntil = transition.openUntil?.toISOString() ?? null;
  logger?.("[self-heal:breaker] transition", {
    org: organizationId,
    scopeKind,
    scopeKey,
    from: transition.from,
    to: transition.to,
    reason: transition.reason,
    tripCount: transition.tripCount,
    openUntil,
  });
  capture?.("self_heal_breaker_transition", {
    org: organizationId,
    scopeKind,
    scopeKey,
    from: transition.from,
    to: transition.to,
    reason: transition.reason,
    tripCount: String(transition.tripCount),
    openUntil: openUntil ?? "",
  });
  const loopOpened =
    isLoopBreakerKind(scopeKind) &&
    (transition.to === "open" || transition.to === "paused_manual");
  if (!loopOpened) return;
  const attemptIds = evidenceAttemptIds(evidence);
  logger?.("[self-heal:breaker] LOOP_OPEN", {
    org: organizationId,
    scopeKind,
    repo: scopeKey,
    to: transition.to,
    reason: transition.reason,
    tripCount: transition.tripCount,
    openUntil,
    attemptIds,
  });
  capture?.("self_heal_loop_paused", {
    org: organizationId,
    scopeKind,
    repo: scopeKey,
    to: transition.to,
    reason: transition.reason,
    attemptIds: attemptIds.join(","),
  });
}

async function cooldownFor(
  tx: SelfHealTx,
  db: DB,
  row: BreakerRow,
  now: Date,
): Promise<TripCooldown> {
  const kind = row.scopeKind;
  if (kind === "loop_fix" || kind === "loop_audit") {
    const prior = await countTripsSince({
      db,
      tx,
      organizationId: row.organizationId,
      scopeKind: kind,
      scopeKey: row.scopeKey,
      since: new Date(now.getTime() - LOOP_ESCALATION_WINDOW_MS),
    });
    return loopCooldown(prior);
  }
  if (isDoublingBreakerKind(kind)) {
    return breakerCooldownMs(kind, row.tripCount + 1);
  }
  throw new Error(`tripBreaker: ${kind} is a latch, not a tripping breaker`);
}

/** The row, created closed (version 0) when absent; null when another writer moved it first. */
async function rowForTransition(
  tx: SelfHealTx,
  organizationId: string,
  scopeKind: BreakerScopeKind,
  scopeKey: string,
  now: Date,
): Promise<BreakerRow | null> {
  const [existing] = await tx
    .select()
    .from(selfHealBreaker)
    .where(scopeWhere(organizationId, scopeKind, scopeKey))
    .limit(1);
  if (existing) return existing;
  await tx
    .insert(selfHealBreaker)
    .values({
      organizationId,
      scopeKind,
      scopeKey,
      state: "closed",
      updatedAt: now,
    })
    .onConflictDoNothing();
  const [created] = await tx
    .select()
    .from(selfHealBreaker)
    .where(scopeWhere(organizationId, scopeKind, scopeKey))
    .limit(1);
  // Another isolate created and moved the row while we waited: it won.
  if (!created || created.state !== "closed" || created.version !== 0) {
    return null;
  }
  return created;
}

/**
 * Trip a breaker (version CAS, so two concurrent trips give one transition).
 * From `closed` or `half_open` (a failed probe); from `open` only to pause it.
 * `paused_manual` is never left here: only resetBreaker (an attributed admin
 * action) does that. Without `cooldownMs` the kind's policy applies: loop
 * kinds 24 h → 72 h → paused_manual at the third trip in 30 days, plane kinds
 * doubling with their caps. Pass `tx` to join an outer transaction (it then
 * rolls back with it, and the caller emits the transition after the commit).
 * There is deliberately no cost or credential input.
 */
export async function tripBreaker({
  db,
  tx,
  organizationId,
  scopeKind,
  scopeKey,
  reason,
  evidence,
  cooldownMs,
  now = new Date(),
  logger,
  capture,
}: {
  db: DB;
  tx?: SelfHealTx;
  organizationId: string;
  scopeKind: BreakerScopeKind;
  scopeKey: string;
  reason: string;
  evidence: Record<string, unknown>;
  cooldownMs?: TripCooldown;
  now?: Date;
  logger?: BreakerLogger;
  capture?: BreakerCapture;
}): Promise<BreakerTransition | null> {
  const run = async (t: SelfHealTx): Promise<BreakerTransition | null> => {
    const row = await rowForTransition(
      t,
      organizationId,
      scopeKind,
      scopeKey,
      now,
    );
    if (!row) return null;
    const cooldown = cooldownMs ?? (await cooldownFor(t, db, row, now));
    const pausing = cooldown === "paused_manual";
    const allowed =
      row.state === "closed" ||
      row.state === "half_open" ||
      (row.state === "open" && pausing);
    if (!allowed) return null;
    const next = await casUpdate(
      t,
      row,
      {
        state: pausing ? "paused_manual" : "open",
        openedAt: now,
        openUntil: pausing ? null : new Date(now.getTime() + cooldown),
        halfOpenProbesLeft: 0,
        probeInFlightUntil: null,
        tripCount: row.tripCount + 1,
        lastTripReason: reason,
        lastTripEvidence: evidence,
      },
      now,
    );
    if (!next) return null;
    await t.insert(selfHealBreakerEvent).values({
      organizationId,
      scopeKind,
      scopeKey,
      outcome: "trip",
      signal: reason,
      createdAt: now,
    });
    return toTransition(row, next, reason);
  };

  if (tx) return run(tx);
  const transition = await withSelfHealTx(db, run);
  if (transition) {
    emitBreakerTransition({
      organizationId,
      scopeKind,
      scopeKey,
      transition,
      evidence,
      logger,
      capture,
    });
  }
  return transition;
}

/** Shared shape of the CAS-only transitions below. */
async function transitionFrom({
  db,
  organizationId,
  scopeKind,
  scopeKey,
  from,
  patch,
  reason,
  now,
  guard,
  logger,
  capture,
}: {
  db: DB;
  organizationId: string;
  scopeKind: BreakerScopeKind;
  scopeKey: string;
  from: BreakerState;
  patch: Partial<typeof selfHealBreaker.$inferInsert>;
  reason: string;
  now: Date;
  guard?: (row: BreakerRow) => boolean;
  logger?: BreakerLogger;
  capture?: BreakerCapture;
}): Promise<BreakerTransition | null> {
  const transition = await withSelfHealTx(db, async (tx) => {
    const [row] = await tx
      .select()
      .from(selfHealBreaker)
      .where(scopeWhere(organizationId, scopeKind, scopeKey))
      .limit(1);
    if (!row || row.state !== from) return null;
    if (guard && !guard(row)) return null;
    const next = await casUpdate(tx, row, patch, now);
    return next ? toTransition(row, next, reason) : null;
  });
  if (transition) {
    emitBreakerTransition({
      organizationId,
      scopeKind,
      scopeKey,
      transition,
      logger,
      capture,
    });
  }
  return transition;
}

/** open → half_open with exactly one probe, once open_until has passed. */
export async function moveExpiredToHalfOpen({
  db,
  organizationId,
  scopeKind,
  scopeKey,
  now = new Date(),
  logger,
  capture,
}: {
  db: DB;
  organizationId: string;
  scopeKind: BreakerScopeKind;
  scopeKey: string;
  now?: Date;
  logger?: BreakerLogger;
  capture?: BreakerCapture;
}): Promise<BreakerTransition | null> {
  return transitionFrom({
    db,
    organizationId,
    scopeKind,
    scopeKey,
    from: "open",
    patch: {
      state: "half_open",
      halfOpenProbesLeft: 1,
      probeInFlightUntil: null,
    },
    reason: "cooldown_elapsed",
    now,
    guard: (row) => row.openUntil !== null && row.openUntil <= now,
    logger,
    capture,
  });
}

/** The probe succeeded: half_open → closed; trip_count is kept (escalation memory). */
export async function closeBreakerAfterProbe({
  db,
  organizationId,
  scopeKind,
  scopeKey,
  now = new Date(),
  logger,
  capture,
}: {
  db: DB;
  organizationId: string;
  scopeKind: BreakerScopeKind;
  scopeKey: string;
  now?: Date;
  logger?: BreakerLogger;
  capture?: BreakerCapture;
}): Promise<BreakerTransition | null> {
  return transitionFrom({
    db,
    organizationId,
    scopeKind,
    scopeKey,
    from: "half_open",
    patch: {
      state: "closed",
      openUntil: null,
      halfOpenProbesLeft: 0,
      probeInFlightUntil: null,
    },
    reason: "probe_succeeded",
    now,
    logger,
    capture,
  });
}

/**
 * The probe run was refunded (infra) or never counted: give the single probe
 * back so the next claim can take it. Not a state transition.
 */
export async function releaseHalfOpenProbe({
  db,
  organizationId,
  scopeKind,
  scopeKey,
  now = new Date(),
}: {
  db: DB;
  organizationId: string;
  scopeKind: BreakerScopeKind;
  scopeKey: string;
  now?: Date;
}): Promise<boolean> {
  const rows = await db
    .update(selfHealBreaker)
    .set({
      halfOpenProbesLeft: 1,
      probeInFlightUntil: null,
      version: sql`${selfHealBreaker.version} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        scopeWhere(organizationId, scopeKind, scopeKey),
        eq(selfHealBreaker.state, "half_open"),
      ),
    )
    .returning({ id: selfHealBreaker.id });
  return rows.length === 1;
}

/**
 * Stamp the attempt that holds the half-open probe into the trip evidence
 * (merged, the trip counts are kept). Runs in the claim transaction.
 */
export async function recordProbeAttempt({
  tx,
  organizationId,
  scopeKind,
  scopeKey,
  attemptId,
}: {
  tx: SelfHealTx;
  organizationId: string;
  scopeKind: BreakerScopeKind;
  scopeKey: string;
  attemptId: string;
}): Promise<void> {
  await tx
    .update(selfHealBreaker)
    .set({
      lastTripEvidence: sql`coalesce(${selfHealBreaker.lastTripEvidence}, '{}'::jsonb) || jsonb_build_object('probeAttemptId', ${attemptId}::text)`,
      version: sql`${selfHealBreaker.version} + 1`,
    })
    .where(scopeWhere(organizationId, scopeKind, scopeKey));
}

/** The attempt holding the half-open probe, from the trip evidence. */
export function probeAttemptIdOf(row: BreakerRow): string | null {
  const evidence = row.lastTripEvidence;
  if (evidence === null || typeof evidence !== "object") return null;
  const id = (evidence as Record<string, unknown>).probeAttemptId;
  return typeof id === "string" ? id : null;
}
