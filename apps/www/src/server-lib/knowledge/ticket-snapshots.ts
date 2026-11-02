import { createHash } from "node:crypto";

import {
  TICKET_SNAPSHOT_FIELDS,
  type TicketPin,
  type TicketSnapshotField,
  type TicketSourceCode,
  type UnavailableClaim,
  type WireTicket,
} from "@terragon/knowledge/reconcile-wire";
import { getOrganizationOwnerUserId } from "@terragon/shared/model/organizations";

import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { createTrackerClient } from "@/server-lib/tracker/tracker-client";
import {
  resolveTrackerConfig,
  type TrackerConfig,
} from "@/server-lib/tracker/tracker-config";
import type {
  TrackerClient,
  TrackerIssue,
} from "@/server-lib/tracker/tracker-types";

/**
 * PD-24: ticket:// evidence for the merge-driven reconcile. Each pinned issue is read through the
 * existing control-plane TrackerClient, reduced to the top-level fields the org's pins point into
 * (minimization, OPS-04), given a revision (sha256 of the canonical snapshot; TrackerIssue has no
 * updated_at) and shipped to the worker as content only.
 *
 * The tracker token stays in www: it is control-plane only (env-audience.ts CONTROL_PLANE_ONLY_ENV_KEYS)
 * and tracker config is resolved for the intent's own organization and repo, never the personal GLOBAL
 * environment. Redis holds at most KNOWLEDGE_TICKET_LIMITS.ttlS (15 minutes) of minimized content,
 * well inside the OPS-04 30-day deletion window; an offboarded org is gated before this runs (13-05).
 *
 * Degradation is per claim and closed-enum: a claim whose ticket source cannot be read is listed as
 * { claimId, code } and left out of the reconcile; nothing here throws or fails an intent. A 404 is
 * source_unavailable, not deletion (a token without access also answers 404), so a deleted ticket
 * never auto-retracts a claim in this phase. No key, pointer or content reaches a log line.
 */

export const KNOWLEDGE_TICKET_LIMITS = {
  ttlS: 900,
  maxFetches: 40,
  concurrency: 4,
  perFetchMs: 3000,
  stageMs: 6000,
  maxSnapshotBytes: 16 * 1024,
  maxTotalBytes: 512 * 1024,
} as const;

export interface TicketClaimInput {
  claimId: string;
  ticketPins: readonly TicketPin[];
}

export interface TicketSnapshotRequest {
  organizationId: string;
  repoFullName: string;
  intentId: string;
  claims: readonly TicketClaimInput[];
}

export interface TicketSnapshotResult {
  tickets: WireTicket[];
  unavailableClaims: UnavailableClaim[];
}

export interface TicketCache {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttlS: number): Promise<void>;
}

export interface TicketSnapshotDeps {
  /** The org's tracker config for this repo; null when none is configured. */
  resolveConfig(
    organizationId: string,
    repoFullName: string,
  ): Promise<TrackerConfig | null>;
  createClient(
    config: TrackerConfig,
    options: { timeoutMs: number },
  ): TrackerClient;
  cache: TicketCache;
  now(): number;
  /** Receives ids and integers only. */
  log(message: string, fields: Record<string, unknown>): void;
}

type CacheEntry =
  | { status: "ok"; fields: Record<string, unknown> }
  | { status: "too_large"; needs: string[] }
  | { status: "unavailable" };

type KeyOutcome =
  | { status: "ok"; fields: Record<string, unknown> }
  | { status: "too_large" }
  | { status: "unavailable" };

const FIELD_SET: ReadonlySet<string> = new Set(TICKET_SNAPSHOT_FIELDS);

const isSupportedField = (field: string): field is TicketSnapshotField =>
  FIELD_SET.has(field);

export function defaultTicketSnapshotDeps(): TicketSnapshotDeps {
  return {
    async resolveConfig(organizationId, repoFullName) {
      const userId = await getOrganizationOwnerUserId({ db, organizationId });
      if (userId === null) return null;
      return resolveTrackerConfig({
        db,
        userId,
        organizationId,
        repoFullName,
      });
    },
    createClient: (config, options) => createTrackerClient(config, options),
    cache: {
      get: (key) => redis.get(key),
      async set(key, value, ttlS) {
        await redis.set(key, value, { ex: ttlS });
      },
    },
    now: Date.now,
    log: (message, fields) => console.log(message, fields),
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value));

const sha256Hex = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

function normalizeIssue(issue: TrackerIssue): Record<string, unknown> {
  return {
    key: issue.key,
    summary: issue.summary,
    stage: issue.stage,
    resolved: issue.resolved,
    description: issue.description,
    links: issue.links,
    comments: issue.comments,
  };
}

function project(
  source: Record<string, unknown>,
  needed: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of needed) {
    if (Object.hasOwn(source, f)) out[f] = source[f];
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function readEntry(raw: unknown): CacheEntry | null {
  if (!isRecord(raw)) return null;
  if (raw.status === "unavailable") return { status: "unavailable" };
  if (raw.status === "ok" && isRecord(raw.fields)) {
    return { status: "ok", fields: raw.fields };
  }
  if (
    raw.status === "too_large" &&
    Array.isArray(raw.needs) &&
    raw.needs.every((n): n is string => typeof n === "string")
  ) {
    return { status: "too_large", needs: raw.needs };
  }
  return null;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

function trackerIdentity(config: TrackerConfig): string {
  return sha256Hex(`${config.kind}${config.baseUrl}`).slice(0, 16);
}

/** Resolves "timeout" after ms; the caller clears it through `cancel`. */
function timer(ms: number): { promise: Promise<"timeout">; cancel(): void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"timeout">((resolve) => {
    handle = setTimeout(() => resolve("timeout"), ms);
  });
  return { promise, cancel: () => clearTimeout(handle) };
}

export async function loadTicketSnapshots(
  request: TicketSnapshotRequest,
  deps: TicketSnapshotDeps = defaultTicketSnapshotDeps(),
): Promise<TicketSnapshotResult> {
  const limits = KNOWLEDGE_TICKET_LIMITS;
  const unavailable = new Map<string, TicketSourceCode>();
  const mark = (claimId: string, code: TicketSourceCode) => {
    // A permanent reason outranks a transient one.
    const rank = {
      pin_unsupported: 3,
      source_too_large: 2,
      source_unavailable: 1,
    };
    const prior = unavailable.get(claimId);
    if (prior === undefined || rank[code] > rank[prior]) {
      unavailable.set(claimId, code);
    }
  };

  const withPins = request.claims.filter((c) => c.ticketPins.length > 0);
  if (withPins.length === 0) return { tickets: [], unavailableClaims: [] };

  const finish = (
    tickets: WireTicket[],
    fetched: number,
    cacheHits: number,
  ): TicketSnapshotResult => {
    const counts: Record<TicketSourceCode, number> = {
      source_unavailable: 0,
      source_too_large: 0,
      pin_unsupported: 0,
    };
    for (const code of unavailable.values()) counts[code] += 1;
    deps.log("[knowledge-tickets] snapshots", {
      intentId: request.intentId,
      fetched,
      cacheHits,
      ...counts,
    });
    const unavailableClaims = [...unavailable.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([claimId, code]) => ({ claimId, code }));
    return { tickets, unavailableClaims };
  };

  const allUnavailable = (): TicketSnapshotResult => {
    for (const c of withPins) mark(c.claimId, "source_unavailable");
    return finish([], 0, 0);
  };

  let config: TrackerConfig | null;
  try {
    config = await deps.resolveConfig(
      request.organizationId,
      request.repoFullName,
    );
  } catch {
    return allUnavailable();
  }
  if (config === null) return allUnavailable();

  // Claims with an unsupported field are out; the rest decide which fields each issue needs.
  const needsByKey = new Map<string, Set<TicketSnapshotField>>();
  const claimKeys = new Map<string, Set<string>>();
  for (const claim of withPins) {
    if (claim.ticketPins.some((p) => !isSupportedField(p.field))) {
      mark(claim.claimId, "pin_unsupported");
      continue;
    }
    const keys = new Set<string>();
    for (const pin of claim.ticketPins) {
      if (!isSupportedField(pin.field)) continue;
      keys.add(pin.key);
      let set = needsByKey.get(pin.key);
      if (!set) {
        set = new Set();
        needsByKey.set(pin.key, set);
      }
      set.add(pin.field);
    }
    claimKeys.set(claim.claimId, keys);
  }

  const identity = trackerIdentity(config);
  const cacheKey = (key: string) =>
    `knowledge:ticket:v1:${request.organizationId}:${identity}:${key}`;
  const keys = [...needsByKey.keys()].sort();
  const neededOf = (key: string): string[] =>
    [...(needsByKey.get(key) ?? [])].sort();

  const outcomes = new Map<string, KeyOutcome>();
  const misses: string[] = [];
  let cacheHits = 0;
  for (const key of keys) {
    const needed = neededOf(key);
    let entry: CacheEntry | null = null;
    try {
      entry = readEntry(await deps.cache.get(cacheKey(key)));
    } catch {
      entry = null;
    }
    if (entry?.status === "unavailable") {
      outcomes.set(key, { status: "unavailable" });
      cacheHits += 1;
    } else if (
      entry?.status === "ok" &&
      needed.every((f) => Object.hasOwn(entry.fields, f))
    ) {
      outcomes.set(key, { status: "ok", fields: entry.fields });
      cacheHits += 1;
    } else if (entry?.status === "too_large" && sameSet(entry.needs, needed)) {
      outcomes.set(key, { status: "too_large" });
      cacheHits += 1;
    } else {
      misses.push(key);
    }
  }

  const toFetch = misses.slice(0, limits.maxFetches);
  for (const key of misses.slice(limits.maxFetches)) {
    outcomes.set(key, { status: "unavailable" });
  }

  const client = deps.createClient(config, { timeoutMs: limits.perFetchMs });
  const stage = timer(limits.stageMs);
  let next = 0;
  let fetched = 0;
  const storeEntry = async (key: string, entry: CacheEntry) => {
    try {
      await deps.cache.set(cacheKey(key), entry, limits.ttlS);
    } catch {
      // A cache write failure only costs a refetch.
    }
  };
  const runOne = async (key: string) => {
    fetched += 1;
    const needed = neededOf(key);
    const perFetch = timer(limits.perFetchMs);
    let issue: TrackerIssue | "timeout";
    try {
      issue = await Promise.race([
        client.getIssue(key),
        perFetch.promise,
        stage.promise,
      ]);
    } catch {
      issue = "timeout";
    } finally {
      perFetch.cancel();
    }
    if (issue === "timeout") {
      outcomes.set(key, { status: "unavailable" });
      await storeEntry(key, { status: "unavailable" });
      return;
    }
    const fields = project(normalizeIssue(issue), needed);
    if (byteLength(canonicalJson(fields)) > limits.maxSnapshotBytes) {
      outcomes.set(key, { status: "too_large" });
      await storeEntry(key, { status: "too_large", needs: needed });
      return;
    }
    outcomes.set(key, { status: "ok", fields });
    await storeEntry(key, { status: "ok", fields });
  };
  const worker = async () => {
    let expired = false;
    void stage.promise.then(() => {
      expired = true;
    });
    while (next < toFetch.length && !expired) {
      const key = toFetch[next++];
      if (key === undefined) return;
      await runOne(key);
    }
  };
  try {
    await Promise.all(
      Array.from(
        { length: Math.min(limits.concurrency, toFetch.length) },
        worker,
      ),
    );
  } finally {
    stage.cancel();
  }
  // Anything never started (stage budget gone) is unavailable and not cached.
  for (const key of toFetch) {
    if (!outcomes.has(key)) outcomes.set(key, { status: "unavailable" });
  }

  // Build snapshots in key order, enforcing the per-context byte cap.
  const tickets: WireTicket[] = [];
  const keyCode = new Map<string, TicketSourceCode>();
  let total = 0;
  for (const key of keys) {
    const outcome = outcomes.get(key) ?? { status: "unavailable" as const };
    if (outcome.status === "unavailable") {
      keyCode.set(key, "source_unavailable");
      continue;
    }
    if (outcome.status === "too_large") {
      keyCode.set(key, "source_too_large");
      continue;
    }
    const snapshot = project(outcome.fields, neededOf(key));
    const json = canonicalJson(snapshot);
    const size = byteLength(json);
    if (size > limits.maxSnapshotBytes || total + size > limits.maxTotalBytes) {
      keyCode.set(key, "source_too_large");
      continue;
    }
    total += size;
    tickets.push({ key, revision: sha256Hex(json), snapshot });
  }

  // All or nothing per claim.
  for (const [claimId, claimKeySet] of claimKeys) {
    for (const key of claimKeySet) {
      const code = keyCode.get(key);
      if (code !== undefined) mark(claimId, code);
    }
  }

  // Ship only the snapshots some admitted claim still needs.
  const usable = new Set<string>();
  for (const [claimId, claimKeySet] of claimKeys) {
    if (unavailable.has(claimId)) continue;
    for (const key of claimKeySet) usable.add(key);
  }
  return finish(
    tickets.filter((t) => usable.has(t.key)),
    fetched,
    cacheHits,
  );
}
