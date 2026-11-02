/**
 * The worker <-> www contract of the merge-driven reconcile (Phase 13).
 *
 * Defined once, here, because the worker never imports `@terragon/shared` and www cannot import
 * `claims.ts` (node:fs). This module has no runtime import, so both planes can bundle it.
 *
 * Unknown-key policy (PD-22): every `parse*` guard BUILDS a fresh object from the declared fields only,
 * so an unknown key is ignored and never reaches the caller. The worker deploys before www, so a newer
 * www response must not break an older worker. Requests are the opposite: www validates bodies with
 * strict zod schemas and refuses unknown keys.
 *
 * Nothing here carries a secret except `installationToken`, which exists only in the context response.
 * Error codes are a closed enum and responses hold ids, enums and integers (OPS-04).
 */
import type { EvidencePin } from "./claims";
import type { RejectedOp } from "./rejections";

export const RECONCILE_TOKEN_HEADER = "x-knowledge-reconcile-token";
export const RECONCILE_PATHS = {
  context: "/api/internal/knowledge/reconcile/context",
  publish: "/api/internal/knowledge/reconcile/publish",
  fail: "/api/internal/knowledge/reconcile/fail",
} as const;
export const KNOWLEDGE_RECONCILE_WORKFLOW = "knowledge-reconcile";
export const KNOWLEDGE_MIRROR_PURGE_WORKFLOW = "knowledge-mirror-purge";
export const MAX_PUBLISH_OPS = 2000;
export const MAX_PUBLISH_BODY_BYTES = 2 * 1024 * 1024;

export const RECONCILE_WORKER_ERROR_CODES = [
  "repo_access_lost",
  "non_descendant_unrecoverable",
  "disk_low",
  "mirror_over_cap",
  "mirror_corrupt",
  "fetch_failed",
  "snapshot_failed",
  "engine_failed",
  "control_plane_rejected",
  "worker_error",
] as const;
export const RECONCILE_ALL_ERROR_CODES = [
  ...RECONCILE_WORKER_ERROR_CODES,
  "lease_expired",
  "dispatch_failed",
  "max_attempts",
] as const;
export type ReconcileWorkerErrorCode =
  (typeof RECONCILE_WORKER_ERROR_CODES)[number];
export type ReconcileErrorCode = (typeof RECONCILE_ALL_ERROR_CODES)[number];

/** Hatchet input of a reconcile run: references only, no secret. */
export interface KnowledgeReconcileInput {
  intentId: string;
  organizationId: string;
  repoFullName: string;
  targetSha: string;
}
/** Hatchet input of a mirror purge. */
export interface KnowledgeMirrorPurgeInput {
  organizationId: string;
}

export interface ReconcileContextRequest {
  intentId: string;
}
export interface WireClaim {
  id: string;
  statement: string;
  version: number;
  evidence: EvidencePin[];
}
/** No pageVersion: the worker computes it per PD-14 (pageVersionOf). */
export interface WireSidecar {
  page: string;
  claims: WireClaim[];
}
export interface ReconcileContextReady {
  status: "ready";
  intent: {
    id: string;
    organizationId: string;
    repoFullName: string;
    defaultBranch: string;
    targetSha: string;
  };
  cursor: { lastSha: string | null };
  installationToken: string;
  sidecars: WireSidecar[];
  rejected: RejectedOp[];
  purgedOrganizationIds: string[];
  /**
   * Claims of the repo left out because their page fails repoRelativePath or they hold a pin the worker
   * cannot check (PD-21). An integer only.
   */
  excludedClaims: number;
}
/** "no_access": www could not mint a read-only token, or the installation is bound to another org. */
export interface ReconcileContextNotReady {
  status: "gated" | "done" | "not_found" | "no_access";
  purgedOrganizationIds: string[];
}
export type ReconcileContextResponse =
  | ReconcileContextReady
  | ReconcileContextNotReady;

export interface ReconcilePublishOp {
  id: string;
  claimId: string;
  kind: string;
  baseVersion: number;
  proposal: unknown;
}
export interface ReconcilePublishRequest {
  intentId: string;
  fromSha: string | null;
  toSha: string;
  mode: "range" | "full";
  ops: ReconcilePublishOp[];
}
export const PUBLISH_RESULTS = [
  "published",
  "already_published",
  "gated",
  "cursor_moved",
  "not_processing",
  "stale_claim",
] as const;
export type PublishResult = (typeof PUBLISH_RESULTS)[number];
export interface ReconcilePublishResponse {
  /** stale_claim (PD-23): an op's baseVersion no longer equals the claim's version; nothing written. */
  result: PublishResult;
  opsInserted: number;
}
export interface ReconcileFailRequest {
  intentId: string;
  code: ReconcileWorkerErrorCode;
}
export interface ReconcileFailResponse {
  state: "pending" | "failed";
  attempts: number;
  code: ReconcileErrorCode;
}

const SHA40 = /^[0-9a-f]{40}$/;
const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const OP_KINDS: readonly string[] = [
  "repin",
  "update",
  "reverify",
  "add",
  "conflict",
  "retract",
  "review",
];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNonEmpty = (v: unknown): v is string => isStr(v) && v.length > 0;
const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;
const isSha = (v: unknown): v is string => isStr(v) && SHA40.test(v);

function strings(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const x of v) {
    if (!isStr(x)) return null;
    out.push(x);
  }
  return out;
}

function parseClaim(v: unknown): WireClaim | null {
  if (!isObj(v)) return null;
  const { id, statement, version, evidence } = v;
  if (!isNonEmpty(id) || !isStr(statement) || !isCount(version)) return null;
  if (!Array.isArray(evidence)) return null;
  const pins: EvidencePin[] = [];
  for (const e of evidence) {
    if (!isObj(e) || !isStr(e.uri) || !isStr(e.hash)) return null;
    pins.push({ uri: e.uri, hash: e.hash });
  }
  return { id, statement, version, evidence: pins };
}

function parseSidecar(v: unknown): WireSidecar | null {
  if (!isObj(v) || !isNonEmpty(v.page) || !Array.isArray(v.claims)) return null;
  const claims: WireClaim[] = [];
  for (const c of v.claims) {
    const claim = parseClaim(c);
    if (!claim) return null;
    claims.push(claim);
  }
  return { page: v.page, claims };
}

function parseRejected(v: unknown): RejectedOp | null {
  if (!isObj(v)) return null;
  const { opId, claimId, op, evidenceFingerprint, locatedEvidence } = v;
  if (!isNonEmpty(opId) || !isNonEmpty(claimId)) return null;
  if (!isStr(op) || !OP_KINDS.includes(op)) return null;
  if (!isStr(evidenceFingerprint)) return null;
  const out: RejectedOp = {
    opId,
    claimId,
    op: op as RejectedOp["op"],
    evidenceFingerprint,
  };
  if (locatedEvidence !== undefined) {
    const located = strings(locatedEvidence);
    if (!located) return null;
    out.locatedEvidence = located;
  }
  return out;
}

function mapAll<T>(v: unknown, f: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const x of v) {
    const r = f(x);
    if (r === null) return null;
    out.push(r);
  }
  return out;
}

export function parseReconcileContextResponse(
  raw: unknown,
): ReconcileContextResponse | null {
  if (!isObj(raw)) return null;
  const purged = strings(raw.purgedOrganizationIds);
  if (!purged) return null;
  const { status } = raw;
  if (
    status === "gated" ||
    status === "done" ||
    status === "not_found" ||
    status === "no_access"
  ) {
    return { status, purgedOrganizationIds: purged };
  }
  if (status !== "ready") return null;
  const { intent, cursor } = raw;
  if (!isObj(intent) || !isObj(cursor)) return null;
  if (
    !isNonEmpty(intent.id) ||
    !isNonEmpty(intent.organizationId) ||
    !isStr(intent.repoFullName) ||
    !SLUG.test(intent.repoFullName) ||
    !isNonEmpty(intent.defaultBranch) ||
    !isSha(intent.targetSha)
  ) {
    return null;
  }
  const lastSha = cursor.lastSha;
  if (lastSha !== null && !isSha(lastSha)) return null;
  if (!isNonEmpty(raw.installationToken)) return null;
  if (!isCount(raw.excludedClaims)) return null;
  const sidecars = mapAll(raw.sidecars, parseSidecar);
  const rejected = mapAll(raw.rejected, parseRejected);
  if (!sidecars || !rejected) return null;
  return {
    status: "ready",
    intent: {
      id: intent.id,
      organizationId: intent.organizationId,
      repoFullName: intent.repoFullName,
      defaultBranch: intent.defaultBranch,
      targetSha: intent.targetSha,
    },
    cursor: { lastSha },
    installationToken: raw.installationToken,
    sidecars,
    rejected,
    purgedOrganizationIds: purged,
    excludedClaims: raw.excludedClaims,
  };
}

export function parsePublishResponse(
  raw: unknown,
): ReconcilePublishResponse | null {
  if (!isObj(raw)) return null;
  const { result, opsInserted } = raw;
  if (
    !isStr(result) ||
    !(PUBLISH_RESULTS as readonly string[]).includes(result)
  )
    return null;
  if (!isCount(opsInserted)) return null;
  return { result: result as PublishResult, opsInserted };
}

export function parseFailResponse(raw: unknown): ReconcileFailResponse | null {
  if (!isObj(raw)) return null;
  const { state, attempts, code } = raw;
  if (state !== "pending" && state !== "failed") return null;
  if (!isCount(attempts)) return null;
  if (
    !isStr(code) ||
    !(RECONCILE_ALL_ERROR_CODES as readonly string[]).includes(code)
  )
    return null;
  return { state, attempts, code: code as ReconcileErrorCode };
}

/**
 * The single path check of the reconcile pipeline (PD-21). 13-05 uses it to admit a claim into the
 * context, 13-07 re-checks every page and repo:// pin target with it before any git or fs call, and
 * snapshotPaths still asserts containment as defense in depth. Accepts normalized POSIX repo-relative
 * paths only; returns the normalized path or null.
 */
export function repoRelativePath(input: string): string | null {
  const path = input.startsWith("./") ? input.slice(2) : input;
  if (path.length === 0) return null;
  if (new TextEncoder().encode(path).length > 1024) return null;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return null;
  if (path.includes("\\") || path.includes("://")) return null;
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return null;
  }
  for (const seg of path.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return null;
    if (seg.toLowerCase() === ".git") return null;
  }
  return path;
}

/**
 * The fs-free twin of claims.ts parseUri for the repo scheme: the repo-relative file a `repo://` pin
 * names, or null for any other scheme, a malformed URI or an unacceptable path. www and shared use it
 * because claims.ts imports node:fs; a parity test pins it to parseUri.
 */
export function repoPinTarget(uri: string): string | null {
  const m = /^(repo|ticket|doc):\/\/([^#]+)#(.+)$/.exec(uri);
  if (!m || m[1] !== "repo" || !m[2]) return null;
  return repoRelativePath(m[2]);
}
