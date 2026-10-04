import type { DB } from "@terragon/shared/db";
import type {
  AuditEffectRow,
  AuditFindingInsert,
  AuditFindingRow,
} from "@terragon/shared/model/audit-findings";
import type { EffectInput } from "@terragon/shared/model/self-heal-outbox";
import { OUTBOX_BACKOFF_MS } from "@terragon/shared/model/self-heal-outbox";

import type { IssueWriter } from "../issue-writer";
import type { SelfHealCallResult } from "../with-self-heal-call";

/**
 * In-memory stand-ins for the GitHub issue writer and the Postgres-backed
 * ledger, outbox and breaker events, for the applier and orchestrator tests
 * (08-10, 08-12). They mimic the real uniqueness rules, not the SQL.
 */

export const FAKE_DB = {} as DB;
export const FAKE_ORG = "org-fake";

// ---------------------------------------------------------------- issue writer

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  labels: Set<string>;
  state: "open" | "closed";
  stateReason: string | null;
  createdAt: Date;
  fingerprint: string | null;
}

export interface FakeComment {
  issueNumber: number;
  marker: string;
  body: string;
}

export type FakeWriterCall =
  | { op: "readIssueStates" }
  | { op: "findByMarkerSince"; fingerprint: string }
  | { op: "ensureLabels"; names: string[] }
  | { op: "createIssue"; title: string }
  | { op: "updateIssue"; number: number }
  | { op: "setIssueState"; number: number; state: "open" | "closed" }
  | { op: "upsertComment"; number: number; marker: string }
  | { op: "isPrivateRepo" };

export interface FakeIssueWriter extends IssueWriter {
  calls: FakeWriterCall[];
  issues: Map<number, FakeIssue>;
  comments: FakeComment[];
  /** Number of issues.create calls that committed on the fake GitHub. */
  createCount(): number;
  /** The next createIssue commits, then reports this failure (ambiguous). */
  failNextCreateAfterCommit(outcome: "timeout" | "server_error"): void;
  /** The next call of `op` returns this failure without committing. */
  failNext(
    op: FakeWriterCall["op"],
    outcome: Extract<SelfHealCallResult<never>, { ok: false }>["outcome"],
  ): void;
  /** Force the read paths to report unknown. */
  setListingUnknown(unknown: boolean): void;
  setPrivate(value: boolean | null): void;
  /** Place an issue directly (e.g. one a human or an earlier isolate made). */
  seedIssue(issue: Partial<FakeIssue> & { number: number }): void;
}

const FINDING_MARKER_FP_RE = /^<!-- automata-finding:v1 fp=([\w-]+) -->/;

export function createFakeIssueWriter(
  options: { now?: () => Date; firstIssueNumber?: number } = {},
): FakeIssueWriter {
  const now = options.now ?? (() => new Date());
  let nextNumber = options.firstIssueNumber ?? 1;
  let creates = 0;
  let listingUnknown = false;
  let isPrivate: boolean | null = false;
  let ambiguousCreate: "timeout" | "server_error" | null = null;
  const programmed = new Map<
    string,
    Extract<SelfHealCallResult<never>, { ok: false }>["outcome"]
  >();
  const issues = new Map<number, FakeIssue>();
  const comments: FakeComment[] = [];
  const calls: FakeWriterCall[] = [];

  function ok<T>(data: T): SelfHealCallResult<T> {
    return { ok: true, data, status: 200 };
  }

  function takeFailure<T>(op: string): SelfHealCallResult<T> | null {
    const outcome = programmed.get(op);
    if (!outcome) return null;
    programmed.delete(op);
    return { ok: false, outcome };
  }

  const writer: FakeIssueWriter = {
    calls,
    issues,
    comments,
    createCount: () => creates,
    failNextCreateAfterCommit: (outcome) => {
      ambiguousCreate = outcome;
    },
    failNext: (op, outcome) => {
      programmed.set(op, outcome);
    },
    setListingUnknown: (unknown) => {
      listingUnknown = unknown;
    },
    setPrivate: (value) => {
      isPrivate = value;
    },
    seedIssue: (issue) => {
      issues.set(issue.number, {
        title: "",
        body: "",
        labels: new Set(),
        state: "open",
        stateReason: null,
        createdAt: now(),
        fingerprint: null,
        ...issue,
      });
      nextNumber = Math.max(nextNumber, issue.number + 1);
    },

    async readIssueStates(ledgerIssueNumbers) {
      calls.push({ op: "readIssueStates" });
      if (listingUnknown) return null;
      const map = new Map<
        number,
        {
          state: "open" | "closed";
          stateReason: string | null;
          labels: string[];
        }
      >();
      for (const [number, issue] of issues) {
        if (issue.fingerprint === null) continue;
        if (issue.state === "open" || ledgerIssueNumbers.includes(number)) {
          map.set(number, {
            state: issue.state,
            stateReason: issue.stateReason,
            labels: [...issue.labels],
          });
        }
      }
      return map;
    },

    async findByMarkerSince(fingerprint, since) {
      calls.push({ op: "findByMarkerSince", fingerprint });
      if (listingUnknown || programmed.delete("findByMarkerSince")) {
        return "unknown";
      }
      for (const issue of issues.values()) {
        if (
          issue.fingerprint === fingerprint &&
          issue.state === "open" &&
          issue.createdAt.getTime() >= since.getTime()
        ) {
          return issue.number;
        }
      }
      return null;
    },

    async ensureLabels(names) {
      calls.push({ op: "ensureLabels", names });
      return takeFailure("ensureLabels") ?? ok(undefined);
    },

    async createIssue(i) {
      calls.push({ op: "createIssue", title: i.title });
      const failure = takeFailure<number>("createIssue");
      if (failure) return failure;
      const number = nextNumber++;
      creates += 1;
      issues.set(number, {
        number,
        title: i.title,
        body: i.body,
        labels: new Set(i.labels),
        state: "open",
        stateReason: null,
        createdAt: now(),
        fingerprint: FINDING_MARKER_FP_RE.exec(i.body)?.[1] ?? null,
      });
      if (ambiguousCreate) {
        const outcome = ambiguousCreate;
        ambiguousCreate = null;
        return { ok: false, outcome };
      }
      return ok(number);
    },

    async updateIssue(i) {
      calls.push({ op: "updateIssue", number: i.number });
      const failure = takeFailure<void>("updateIssue");
      if (failure) return failure;
      const issue = issues.get(i.number);
      if (!issue) return { ok: false, outcome: "not_found", status: 404 };
      if (i.title !== undefined) issue.title = i.title;
      if (i.body !== undefined) issue.body = i.body;
      for (const l of i.labelsAdd ?? []) issue.labels.add(l);
      for (const l of i.labelsRemove ?? []) issue.labels.delete(l);
      return ok(undefined);
    },

    async setIssueState(i) {
      calls.push({ op: "setIssueState", number: i.number, state: i.state });
      const failure = takeFailure<void>("setIssueState");
      if (failure) return failure;
      const issue = issues.get(i.number);
      if (!issue) return { ok: false, outcome: "not_found", status: 404 };
      issue.state = i.state;
      issue.stateReason = i.state === "closed" ? (i.stateReason ?? null) : null;
      return ok(undefined);
    },

    async upsertComment(i) {
      calls.push({ op: "upsertComment", number: i.number, marker: i.marker });
      const failure = takeFailure<"created" | "updated">("upsertComment");
      if (failure) return failure;
      if (!issues.has(i.number)) {
        return { ok: false, outcome: "not_found", status: 404 };
      }
      const existing = comments.find(
        (c) => c.issueNumber === i.number && c.marker === i.marker,
      );
      if (existing) {
        existing.body = i.body;
        return ok("updated");
      }
      comments.push({ issueNumber: i.number, marker: i.marker, body: i.body });
      creates += 1;
      return ok("created");
    },

    async isPrivateRepo() {
      calls.push({ op: "isPrivateRepo" });
      return isPrivate;
    },
  };
  return writer;
}

// ----------------------------------------------------------------------- ledger

function ledgerKey(org: string, repo: string, fingerprint: string): string {
  return `${org}|${repo.toLowerCase()}|${fingerprint}`;
}

/** The finding half of the 08-02 audit-findings model, unique per (org, repo, fingerprint). */
export function createInMemoryAuditLedger() {
  const rows = new Map<string, AuditFindingRow>();
  let seq = 0;

  return {
    rows,
    async insertFinding({
      organizationId,
      finding,
    }: {
      db?: DB;
      organizationId: string;
      finding: Omit<AuditFindingInsert, "organizationId" | "id"> & {
        repoFullName: string;
      };
    }): Promise<AuditFindingRow> {
      const key = ledgerKey(
        organizationId,
        finding.repoFullName,
        finding.fingerprint,
      );
      const existing = rows.get(key);
      if (existing) return existing;
      seq += 1;
      const now = new Date();
      const row = {
        id: `finding-${seq}`,
        organizationId,
        section: null,
        subject: null,
        findingKey: null,
        planMd: null,
        acceptanceMd: null,
        planFiles: null,
        planHash: null,
        issueNumber: null,
        status: "candidate",
        recentSightings: false,
        consecutiveCheckPasses: 0,
        lastCheckOutcome: null,
        absentCount: 0,
        attempts: 0,
        lastAttemptAt: null,
        activeThreadId: null,
        activeAttemptId: null,
        prNumber: null,
        autoFixLabeled: false,
        fixReadyAt: null,
        lastSeenRunId: null,
        lastReopenedAt: null,
        lastDecision: null,
        lastDecisionReason: null,
        createdAt: now,
        updatedAt: now,
        ...finding,
        repoFullName: finding.repoFullName.toLowerCase(),
      } as unknown as AuditFindingRow; // fixture: defaults cover every column the tests read
      rows.set(key, row);
      return row;
    },
    async updateFinding({
      organizationId,
      id,
      patch,
    }: {
      db?: DB;
      organizationId: string;
      id: string;
      patch: Partial<AuditFindingInsert>;
    }): Promise<AuditFindingRow | null> {
      for (const [key, row] of rows) {
        if (row.id === id && row.organizationId === organizationId) {
          const next = { ...row, ...patch, updatedAt: new Date() };
          rows.set(key, next as AuditFindingRow);
          return next as AuditFindingRow;
        }
      }
      return null;
    },
    async getFindingByIssue({
      organizationId,
      repoFullName,
      issueNumber,
    }: {
      db?: DB;
      organizationId: string;
      repoFullName: string;
      issueNumber: number;
    }): Promise<AuditFindingRow | null> {
      for (const row of rows.values()) {
        if (
          row.organizationId === organizationId &&
          row.repoFullName === repoFullName.toLowerCase() &&
          row.issueNumber === issueNumber
        ) {
          return row;
        }
      }
      return null;
    },
    async listFindingsForRepo({
      organizationId,
      repoFullName,
      statuses,
    }: {
      db?: DB;
      organizationId: string;
      repoFullName: string;
      statuses?: AuditFindingRow["status"][];
    }): Promise<AuditFindingRow[]> {
      return [...rows.values()].filter(
        (r) =>
          r.organizationId === organizationId &&
          r.repoFullName === repoFullName.toLowerCase() &&
          (!statuses || statuses.length === 0 || statuses.includes(r.status)),
      );
    },
  };
}

// ----------------------------------------------------------------------- outbox

export type InMemoryOutbox = ReturnType<typeof createInMemoryOutbox>;

/** The 08-03 outbox model, unique per (run, fingerprint, action). */
export function createInMemoryOutbox(clock: () => Date = () => new Date()) {
  const rows = new Map<string, AuditEffectRow>();
  let seq = 0;

  function find(organizationId: string, id: string): AuditEffectRow | null {
    const row = rows.get(id);
    return row && row.organizationId === organizationId ? row : null;
  }

  return {
    rows,
    async enqueueEffects({
      organizationId,
      repoFullName,
      runId,
      effects,
      now = clock(),
    }: {
      db?: DB;
      organizationId: string;
      repoFullName: string;
      runId: string;
      effects: EffectInput[];
      now?: Date;
    }): Promise<number> {
      let inserted = 0;
      for (const e of effects) {
        const duplicate = [...rows.values()].some(
          (r) =>
            r.runId === runId &&
            r.fingerprint === e.fingerprint &&
            r.action === e.action,
        );
        if (duplicate) continue;
        seq += 1;
        rows.set(`effect-${seq}`, {
          id: `effect-${seq}`,
          organizationId,
          repoFullName: repoFullName.toLowerCase(),
          runId,
          findingId: e.findingId ?? null,
          fingerprint: e.fingerprint,
          action: e.action,
          payload: e.payload ?? null,
          status: "pending",
          attempts: 0,
          nextAttemptAt: now,
          leaseUntil: null,
          pendingSince: now,
          lastError: null,
          appliedAt: null,
          createdAt: now,
          updatedAt: now,
        });
        inserted += 1;
      }
      return inserted;
    },
    async claimDueEffectsForRun({
      organizationId,
      runId,
      now = clock(),
      leaseMs = 60_000,
      limit = 20,
    }: {
      db?: DB;
      organizationId: string;
      runId: string;
      now?: Date;
      leaseMs?: number;
      limit?: number;
    }): Promise<AuditEffectRow[]> {
      const due = [...rows.values()]
        .filter(
          (r) =>
            r.organizationId === organizationId &&
            r.runId === runId &&
            r.status === "pending" &&
            (r.nextAttemptAt?.getTime() ?? 0) <= now.getTime() &&
            (!r.leaseUntil || r.leaseUntil.getTime() < now.getTime()),
        )
        .slice(0, limit);
      for (const r of due) r.leaseUntil = new Date(now.getTime() + leaseMs);
      return due.map((r) => ({ ...r }));
    },
    /** Cross-run drain used by the cron drainer (the real one is UNFENCED). */
    async claimDueEffects({
      now = clock(),
      leaseMs = 60_000,
      limit = 20,
    }: {
      db?: DB;
      now?: Date;
      leaseMs?: number;
      limit?: number;
    } = {}): Promise<AuditEffectRow[]> {
      const due = [...rows.values()]
        .filter(
          (r) =>
            r.status === "pending" &&
            (r.nextAttemptAt?.getTime() ?? 0) <= now.getTime() &&
            (!r.leaseUntil || r.leaseUntil.getTime() < now.getTime()),
        )
        .slice(0, limit);
      for (const r of due) r.leaseUntil = new Date(now.getTime() + leaseMs);
      return due.map((r) => ({ ...r }));
    },
    async markEffectApplied({
      organizationId,
      id,
      appliedAt = clock(),
    }: {
      db?: DB;
      organizationId: string;
      id: string;
      appliedAt?: Date;
    }): Promise<void> {
      const row = find(organizationId, id);
      if (!row) return;
      row.status = "applied";
      row.appliedAt = appliedAt;
      row.leaseUntil = null;
      row.lastError = null;
    },
    async markEffectFailed({
      organizationId,
      id,
      error,
    }: {
      db?: DB;
      organizationId: string;
      id: string;
      error: string;
    }): Promise<void> {
      const row = find(organizationId, id);
      if (!row) return;
      row.status = "failed";
      row.leaseUntil = null;
      row.lastError = error;
    },
    async markEffectRetry({
      organizationId,
      id,
      error,
      now = clock(),
      rand = Math.random,
    }: {
      db?: DB;
      organizationId: string;
      id: string;
      error: string;
      now?: Date;
      rand?: () => number;
    }): Promise<"pending" | "failed"> {
      const row = find(organizationId, id);
      if (!row) return "failed";
      row.attempts += 1;
      row.lastError = error;
      row.leaseUntil = null;
      const base = OUTBOX_BACKOFF_MS[row.attempts - 1];
      if (base === undefined) {
        row.status = "failed";
        return "failed";
      }
      row.nextAttemptAt = new Date(
        now.getTime() + Math.round(base * (1 + 0.3 * rand())),
      );
      return "pending";
    },
    async releaseEffectLease({
      organizationId,
      id,
      nextAttemptAt,
    }: {
      db?: DB;
      organizationId: string;
      id: string;
      nextAttemptAt?: Date;
    }): Promise<void> {
      const row = find(organizationId, id);
      if (!row || row.status !== "pending") return;
      row.leaseUntil = null;
      if (nextAttemptAt) row.nextAttemptAt = nextAttemptAt;
    },
  };
}

// ----------------------------------------------------------------------- breaker

/** Hourly create counting (RES-19) over an in-memory event list. */
export function createFakeBreakerStore(clock: () => Date = () => new Date()) {
  const events: Array<{
    organizationId: string;
    scopeKind: string;
    scopeKey: string;
    signal: string;
    createdAt: Date;
  }> = [];

  return {
    events,
    /** Simulate events recorded by another isolate. */
    seedEvents(
      count: number,
      e: {
        organizationId: string;
        scopeKind: string;
        scopeKey: string;
        signal: string;
        createdAt?: Date;
      },
    ): void {
      for (let n = 0; n < count; n++) {
        events.push({ ...e, createdAt: e.createdAt ?? clock() });
      }
    },
    async countRecentEvents({
      organizationId,
      scopeKind,
      scopeKey,
      signal,
      since,
    }: {
      db?: DB;
      organizationId: string;
      scopeKind: string;
      scopeKey: string;
      signal: string;
      since: Date;
    }): Promise<number> {
      return events.filter(
        (ev) =>
          ev.organizationId === organizationId &&
          ev.scopeKind === scopeKind &&
          ev.scopeKey === scopeKey &&
          ev.signal === signal &&
          ev.createdAt.getTime() >= since.getTime(),
      ).length;
    },
  };
}
