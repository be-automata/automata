import type { DB } from "@terragon/shared/db";
import type { AuditEffectRow } from "@terragon/shared/model/audit-findings";
import type * as breakerModel from "@terragon/shared/model/self-heal-breaker";
import { GH_CREATE_SIGNAL } from "@terragon/shared/model/self-heal-breaker";
import type * as outboxModel from "@terragon/shared/model/self-heal-outbox";
import { redactSecrets } from "@terragon/utils/redact";

import type { IssueWriter } from "./issue-writer";
import type {
  SelfHealCallOutcome,
  SelfHealCallResult,
} from "./with-self-heal-call";

/**
 * Turns durable outbox rows into idempotent GitHub effects (OUTBOX-01) under a
 * deadline and a write budget. The finish hook (~30 s waitUntil) may stop at
 * any point; whatever is left stays pending and the cron drainer resumes it.
 * An effect that was attempted before is never re-created before the applier
 * has searched GitHub for its marker (RES-02): an ambiguous create (committed,
 * then timed out) is adopted, not duplicated.
 */

export const SELF_HEAL_WRITE_BUDGET = {
  perRunCreates: 10,
  perHourCreates: 20,
  minCreateSpacingMs: 3_000,
} as const;

/** Look-back margin on pending_since when searching for an ambiguous create. */
const RECONCILE_MARGIN_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;
/** Same floor withSelfHealCall enforces; below it no call can start. */
const MIN_DEADLINE_LEFT_MS = 1_000;

export type OutboxStoppedBy =
  | "deadline"
  | "write_budget"
  | "rate_limited"
  | "breaker_open"
  | "permission"
  | "primary_quota_reserve";

export interface OutboxApplySummary {
  applied: number;
  pending: number;
  failed: number;
  stoppedBy?: OutboxStoppedBy;
}

export interface ApplyOutboxDeps {
  db: DB;
  /** Numeric installation id as a string; scopes the hourly create count. */
  installationKey: string;
  outbox: Pick<
    typeof outboxModel,
    | "markEffectApplied"
    | "markEffectRetry"
    | "markEffectFailed"
    | "releaseEffectLease"
  >;
  breakers: Pick<typeof breakerModel, "countRecentEvents">;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  rand: () => number;
  log: (message: string, fields: Record<string, unknown>) => void;
  /** The 08-10 ledger adapter persists the new issue number on the finding. */
  onIssueCreated: (
    effect: AuditEffectRow,
    issueNumber: number,
  ) => Promise<void>;
  /** Resolves the issue an update/state/label/comment effect targets. */
  issueNumberFor?: (effect: AuditEffectRow) => Promise<number | null>;
}

type Action = AuditEffectRow["action"];

/** set_labels / set_issue_state / update_issue first, creates next, comments last. */
const ACTION_ORDER: Record<Action, number> = {
  set_labels: 0,
  set_issue_state: 0,
  update_issue: 0,
  create_issue: 1,
  upsert_comment: 2,
};

type Disposition =
  | { kind: "applied" }
  | { kind: "retry"; error: string }
  | { kind: "fail"; error: string }
  | { kind: "release" }
  | {
      kind: "stop";
      stoppedBy: OutboxStoppedBy;
      error?: string;
      retryAfterS?: number;
    };

function asRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

function failureDisposition(
  result: Extract<SelfHealCallResult<unknown>, { ok: false }>,
  describe: string,
): Disposition {
  const error = redactSecrets(
    `${describe}: ${result.outcome}${result.status ? ` (${result.status})` : ""}`,
  );
  const outcome: SelfHealCallOutcome = result.outcome;
  switch (outcome) {
    case "rate_limited":
      return {
        kind: "stop",
        stoppedBy: "rate_limited",
        error,
        ...(result.retryAfterS !== undefined
          ? { retryAfterS: result.retryAfterS }
          : {}),
      };
    case "breaker_open":
      return { kind: "stop", stoppedBy: "breaker_open", error };
    case "deadline":
      return { kind: "stop", stoppedBy: "deadline", error };
    case "primary_quota_reserve":
      return { kind: "stop", stoppedBy: "primary_quota_reserve", error };
    case "permission":
      return { kind: "stop", stoppedBy: "permission", error };
    case "not_found":
    case "unprocessable":
      // The target is gone or the payload is invalid: retrying cannot help.
      return { kind: "fail", error };
    case "server_error":
    case "timeout":
    case "other":
      return { kind: "retry", error };
  }
}

export async function applyOutboxEffects({
  effects,
  writer,
  deadlineAt,
  deps,
}: {
  effects: AuditEffectRow[];
  writer: IssueWriter;
  deadlineAt: Date;
  mode: "on";
  deps: ApplyOutboxDeps;
}): Promise<OutboxApplySummary> {
  const { outbox, breakers, now, sleep, log } = deps;
  const ordered = effects
    .map((effect, index) => ({ effect, index }))
    .sort(
      (a, b) =>
        ACTION_ORDER[a.effect.action] - ACTION_ORDER[b.effect.action] ||
        a.index - b.index,
    )
    .map((x) => x.effect);

  const summary: OutboxApplySummary = { applied: 0, pending: 0, failed: 0 };
  const createdNumbers = new Map<string, number>();
  const createsInBatch = new Set(
    ordered
      .filter((e) => e.action === "create_issue")
      .map((e) => e.fingerprint),
  );
  let createsThisRun = 0;
  let lastCreateAt: number | null = null;

  const fence = (effect: AuditEffectRow) => ({
    db: deps.db,
    organizationId: effect.organizationId,
    id: effect.id,
  });

  async function release(effect: AuditEffectRow, retryAfterS?: number) {
    await outbox.releaseEffectLease({
      ...fence(effect),
      ...(retryAfterS !== undefined
        ? { nextAttemptAt: new Date(now().getTime() + retryAfterS * 1000) }
        : {}),
    });
    summary.pending += 1;
  }

  async function resolveNumber(effect: AuditEffectRow): Promise<number | null> {
    const fromPayload = asRecord(effect.payload).issueNumber;
    if (typeof fromPayload === "number") return fromPayload;
    const created = createdNumbers.get(effect.fingerprint);
    if (created !== undefined) return created;
    return deps.issueNumberFor ? deps.issueNumberFor(effect) : null;
  }

  /** Records the issue number; a hook failure keeps the effect reconcilable. */
  async function adopt(
    effect: AuditEffectRow,
    issueNumber: number,
  ): Promise<Disposition> {
    createdNumbers.set(effect.fingerprint, issueNumber);
    try {
      await deps.onIssueCreated(effect, issueNumber);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: "retry",
        error: redactSecrets(`onIssueCreated failed: ${message}`),
      };
    }
    return { kind: "applied" };
  }

  async function budgetStop(): Promise<OutboxStoppedBy | null> {
    if (createsThisRun >= SELF_HEAL_WRITE_BUDGET.perRunCreates) {
      return "write_budget";
    }
    try {
      const lastHour = await breakers.countRecentEvents({
        db: deps.db,
        organizationId: ordered[0]?.organizationId ?? "",
        scopeKind: "github_write",
        scopeKey: deps.installationKey,
        signal: GH_CREATE_SIGNAL,
        since: new Date(now().getTime() - HOUR_MS),
      });
      if (lastHour >= SELF_HEAL_WRITE_BUDGET.perHourCreates) {
        return "write_budget";
      }
    } catch (error: unknown) {
      // Cannot prove the hourly budget: fail closed, leave the effect pending.
      log("[self-heal:outbox] create budget unreadable", {
        error: redactSecrets(
          error instanceof Error ? error.message : String(error),
        ),
      });
      return "write_budget";
    }
    return null;
  }

  /** Spacing before a content-creating write; null = proceed, else the stop. */
  async function spaceCreate(): Promise<OutboxStoppedBy | null> {
    const wait =
      lastCreateAt === null
        ? 0
        : Math.max(
            0,
            lastCreateAt +
              SELF_HEAL_WRITE_BUDGET.minCreateSpacingMs -
              now().getTime(),
          );
    if (
      deadlineAt.getTime() - (now().getTime() + wait) <
      MIN_DEADLINE_LEFT_MS
    ) {
      return "deadline";
    }
    if (wait > 0) await sleep(wait);
    return null;
  }

  async function runEffect(effect: AuditEffectRow): Promise<Disposition> {
    const payload = asRecord(effect.payload);
    const creating =
      effect.action === "create_issue" || effect.action === "upsert_comment";

    if (effect.action === "create_issue") {
      const title = asString(payload.title);
      const body = asString(payload.body);
      if (title === undefined || body === undefined) {
        return { kind: "fail", error: "invalid create_issue payload" };
      }
      if (effect.attempts > 0) {
        // Ambiguous earlier attempt: search before any second create (RES-02).
        const since = new Date(
          (effect.pendingSince ?? effect.createdAt).getTime() -
            RECONCILE_MARGIN_MS,
        );
        const found = await writer.findByMarkerSince(effect.fingerprint, since);
        if (found === "unknown") return { kind: "release" };
        if (found !== null) return adopt(effect, found);
      }
    }

    if (creating) {
      const stop = (await budgetStop()) ?? (await spaceCreate());
      if (stop) return { kind: "stop", stoppedBy: stop };
    }

    switch (effect.action) {
      case "create_issue": {
        const result = await writer.createIssue({
          title: asString(payload.title) ?? "",
          body: asString(payload.body) ?? "",
          labels: asStringArray(payload.labels),
        });
        lastCreateAt = now().getTime();
        if (!result.ok) return failureDisposition(result, "create_issue");
        createsThisRun += 1;
        return adopt(effect, result.data);
      }
      case "upsert_comment": {
        const marker = asString(payload.marker);
        const body = asString(payload.body);
        if (marker === undefined || body === undefined) {
          return { kind: "fail", error: "invalid upsert_comment payload" };
        }
        const number = await resolveNumber(effect);
        if (number === null) return unresolved(effect);
        const result = await writer.upsertComment({ number, marker, body });
        if (!result.ok) return failureDisposition(result, "upsert_comment");
        if (result.data === "created") {
          createsThisRun += 1;
          lastCreateAt = now().getTime();
        }
        return { kind: "applied" };
      }
      case "update_issue": {
        const number = await resolveNumber(effect);
        if (number === null) return unresolved(effect);
        const title = asString(payload.title);
        const body = asString(payload.body);
        const result = await writer.updateIssue({
          number,
          ...(title !== undefined ? { title } : {}),
          ...(body !== undefined ? { body } : {}),
        });
        return result.ok
          ? { kind: "applied" }
          : failureDisposition(result, "update_issue");
      }
      case "set_labels": {
        const number = await resolveNumber(effect);
        if (number === null) return unresolved(effect);
        const result = await writer.updateIssue({
          number,
          labelsAdd: asStringArray(payload.add),
          labelsRemove: asStringArray(payload.remove),
        });
        return result.ok
          ? { kind: "applied" }
          : failureDisposition(result, "set_labels");
      }
      case "set_issue_state": {
        const state = payload.state;
        if (state !== "open" && state !== "closed") {
          return { kind: "fail", error: "invalid set_issue_state payload" };
        }
        const reason = payload.stateReason;
        const number = await resolveNumber(effect);
        if (number === null) return unresolved(effect);
        const result = await writer.setIssueState({
          number,
          state,
          ...(reason === "completed" || reason === "not_planned"
            ? { stateReason: reason }
            : {}),
        });
        return result.ok
          ? { kind: "applied" }
          : failureDisposition(result, "set_issue_state");
      }
    }
  }

  function unresolved(effect: AuditEffectRow): Disposition {
    // Waiting on a create in this same batch is not a failed attempt.
    if (createsInBatch.has(effect.fingerprint)) return { kind: "release" };
    return { kind: "retry", error: "issue number unknown" };
  }

  for (let i = 0; i < ordered.length; i++) {
    const effect = ordered[i];
    if (!effect) continue;
    if (deadlineAt.getTime() - now().getTime() < MIN_DEADLINE_LEFT_MS) {
      summary.stoppedBy = "deadline";
      await releaseFrom(i);
      break;
    }
    const disposition = await runEffect(effect);
    switch (disposition.kind) {
      case "applied":
        await outbox.markEffectApplied(fence(effect));
        summary.applied += 1;
        break;
      case "release":
        await release(effect);
        break;
      case "fail":
        await outbox.markEffectFailed({
          ...fence(effect),
          error: disposition.error,
        });
        summary.failed += 1;
        break;
      case "retry": {
        const status = await outbox.markEffectRetry({
          ...fence(effect),
          error: disposition.error,
          now: now(),
          rand: deps.rand,
        });
        if (status === "failed") summary.failed += 1;
        else summary.pending += 1;
        break;
      }
      case "stop":
        summary.stoppedBy = disposition.stoppedBy;
        if (disposition.stoppedBy === "permission") {
          await outbox.markEffectFailed({
            ...fence(effect),
            error: disposition.error ?? "permission",
          });
          summary.failed += 1;
        } else {
          await release(effect, disposition.retryAfterS);
        }
        log("[self-heal:outbox] stopped", {
          stoppedBy: disposition.stoppedBy,
          action: effect.action,
        });
        await releaseFrom(i + 1);
        return summary;
    }
  }
  return summary;

  /** Leave the unreached effects pending with their leases released. */
  async function releaseFrom(start: number): Promise<void> {
    for (const rest of ordered.slice(start)) await release(rest);
  }
}
