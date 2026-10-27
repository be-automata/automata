/**
 * OPS-04 single write chokepoint for the knowledge store.
 *
 * Stored partner data is limited to statements, hashes, URIs, value tokens and
 * snippets of at most 4 lines. Every knowledge write path calls these
 * validators before touching the database. Errors carry the field path and a
 * fixed rule description only, never the value: values can be partner text.
 *
 * Pure module: no database and no package imports.
 */

/** Locked by OPS-04. */
export const MAX_SNIPPET_LINES = 4;
/**
 * Confirmed by the owner 2026-10-26: one claim is one fact. Raise only: stored
 * proposals are re-validated on read, so a lower cap makes older rows throw.
 * The engine routes an over-cap rewrite to human review (@terragon/knowledge
 * MAX_STATEMENT_CHARS, kept equal by a test).
 */
export const MAX_STATEMENT_CHARS = 1_000;
/** Confirmed by the owner 2026-10-26. Raise only, as above. */
export const MAX_SNIPPET_LINE_CHARS = 200;
export const MAX_URI_CHARS = 512;
export const MAX_VALUE_TOKEN_CHARS = 64;
export const MAX_LIST_ITEMS = 32;
export const PIN_HASH_RE = /^(x:)?[0-9a-f]{16}$/;
export const FINGERPRINT_RE = /^[0-9a-f]{16}$/;
export const GIT_SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

const URI_RE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/;
const CLAIM_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const OP_KIND_RE = /^[a-z_]{1,32}$/;
const VALUE_TOKEN_RE = /^\S{1,64}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[^\s~^:?*[\\]{1,255}$/;
const ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const LOG_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
const LOG_TOKEN_RE = /^[a-z0-9_:.-]{1,64}$/i;
const MAX_LOG_KEYS = 16;

export class MinimizationError extends Error {
  readonly path: string;

  constructor(path: string, rule: string) {
    super(`${path}: ${rule}`);
    this.name = "MinimizationError";
    this.path = path;
  }
}

export interface StoredSourceValues {
  uri: string;
  values: string[];
}

/** Mirrors DraftOp in @terragon/knowledge (op typed as a string). */
export interface StoredProposal {
  id: string;
  claimId: string;
  op: string;
  auto: boolean;
  before: string;
  after?: string;
  why: string;
  evidence: string[];
  newEvidence?: string[];
  newEvidenceHash?: string[];
  score?: number;
  sourceValues?: StoredSourceValues[];
  evidenceFingerprint?: string;
  locatedEvidence?: string[];
  proposalFingerprint?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new MinimizationError(path, "must be an object");
  return value;
}

function assertPattern(
  value: unknown,
  path: string,
  pattern: RegExp,
  rule: string,
): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new MinimizationError(path, rule);
  }
  return value;
}

function assertKnownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new MinimizationError(`${prefix}.${key}`, "unknown key");
    }
  }
}

function assertRequired(
  record: Record<string, unknown>,
  required: readonly string[],
  prefix: string,
): void {
  for (const key of required) {
    if (record[key] === undefined) {
      throw new MinimizationError(`${prefix}.${key}`, "required key missing");
    }
  }
}

function assertList(
  value: unknown,
  path: string,
  item: (entry: unknown, entryPath: string) => string,
): string[] {
  if (!Array.isArray(value)) {
    throw new MinimizationError(path, "must be an array");
  }
  if (value.length > MAX_LIST_ITEMS) {
    throw new MinimizationError(path, `more than ${MAX_LIST_ITEMS} items`);
  }
  return value.map((entry, index) => item(entry, `${path}[${index}]`));
}

function assertLines(text: string, path: string): void {
  const lines = text.split("\n");
  if (lines.length > MAX_SNIPPET_LINES) {
    throw new MinimizationError(path, `more than ${MAX_SNIPPET_LINES} lines`);
  }
  for (const line of lines) {
    if (line.length > MAX_SNIPPET_LINE_CHARS) {
      throw new MinimizationError(
        path,
        `line exceeds ${MAX_SNIPPET_LINE_CHARS} characters`,
      );
    }
  }
}

export function assertStatement(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MinimizationError(path, "must be a non-empty string");
  }
  if (value.length > MAX_STATEMENT_CHARS) {
    throw new MinimizationError(
      path,
      `exceeds ${MAX_STATEMENT_CHARS} characters`,
    );
  }
  if (value.split("\n").length > MAX_SNIPPET_LINES) {
    throw new MinimizationError(path, `more than ${MAX_SNIPPET_LINES} lines`);
  }
  return value;
}

export function assertSnippet(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new MinimizationError(path, "must be a string");
  }
  assertLines(value, path);
  return value;
}

export function assertUri(value: unknown, path: string): string {
  if (typeof value === "string" && value.length > MAX_URI_CHARS) {
    throw new MinimizationError(path, `exceeds ${MAX_URI_CHARS} characters`);
  }
  return assertPattern(value, path, URI_RE, "must be a URI");
}

function assertFlag(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new MinimizationError(path, "must be a boolean");
  }
  return value;
}

function assertSourceValues(
  value: unknown,
  path: string,
): StoredSourceValues[] {
  if (!Array.isArray(value)) {
    throw new MinimizationError(path, "must be an array");
  }
  if (value.length > MAX_LIST_ITEMS) {
    throw new MinimizationError(path, `more than ${MAX_LIST_ITEMS} items`);
  }
  return value.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const record = assertRecord(entry, entryPath);
    assertKnownKeys(record, ["uri", "values"], entryPath);
    assertRequired(record, ["uri", "values"], entryPath);
    return {
      uri: assertUri(record["uri"], `${entryPath}.uri`),
      values: assertList(record["values"], `${entryPath}.values`, (v, p) =>
        assertPattern(v, p, VALUE_TOKEN_RE, "must be a short value token"),
      ),
    };
  });
}

const PROPOSAL_KEYS = [
  "id",
  "claimId",
  "op",
  "auto",
  "before",
  "after",
  "why",
  "evidence",
  "newEvidence",
  "newEvidenceHash",
  "score",
  "sourceValues",
  "evidenceFingerprint",
  "locatedEvidence",
  "proposalFingerprint",
] as const;
const PROPOSAL_REQUIRED = [
  "id",
  "claimId",
  "op",
  "auto",
  "before",
  "why",
  "evidence",
] as const;

export function assertStoredProposal(value: unknown): StoredProposal {
  const record = assertRecord(value, "proposal");
  assertKnownKeys(record, PROPOSAL_KEYS, "proposal");
  assertRequired(record, PROPOSAL_REQUIRED, "proposal");

  const id = record["id"];
  if (
    typeof id !== "string" ||
    id.length > MAX_URI_CHARS ||
    !/^\S+$/.test(id)
  ) {
    throw new MinimizationError("proposal.id", "must be an id");
  }

  const proposal: StoredProposal = {
    id,
    claimId: assertPattern(
      record["claimId"],
      "proposal.claimId",
      CLAIM_ID_RE,
      "must be an id token",
    ),
    op: assertPattern(
      record["op"],
      "proposal.op",
      OP_KIND_RE,
      "must be an op kind",
    ),
    auto: assertFlag(record["auto"], "proposal.auto"),
    before: assertStatement(record["before"], "proposal.before"),
    why: assertSnippet(record["why"], "proposal.why"),
    evidence: assertList(record["evidence"], "proposal.evidence", assertUri),
  };
  if (record["after"] !== undefined) {
    proposal.after = assertStatement(record["after"], "proposal.after");
  }
  if (record["newEvidence"] !== undefined) {
    proposal.newEvidence = assertList(
      record["newEvidence"],
      "proposal.newEvidence",
      assertUri,
    );
  }
  if (record["newEvidenceHash"] !== undefined) {
    proposal.newEvidenceHash = assertList(
      record["newEvidenceHash"],
      "proposal.newEvidenceHash",
      (v, p) => assertPattern(v, p, PIN_HASH_RE, "must be a hash"),
    );
  }
  if (record["score"] !== undefined) {
    const score = record["score"];
    if (
      typeof score !== "number" ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 1
    ) {
      throw new MinimizationError("proposal.score", "must be a number 0..1");
    }
    proposal.score = score;
  }
  if (record["sourceValues"] !== undefined) {
    proposal.sourceValues = assertSourceValues(
      record["sourceValues"],
      "proposal.sourceValues",
    );
  }
  if (record["evidenceFingerprint"] !== undefined) {
    proposal.evidenceFingerprint = assertPattern(
      record["evidenceFingerprint"],
      "proposal.evidenceFingerprint",
      FINGERPRINT_RE,
      "must be a fingerprint",
    );
  }
  if (record["locatedEvidence"] !== undefined) {
    proposal.locatedEvidence = assertList(
      record["locatedEvidence"],
      "proposal.locatedEvidence",
      assertUri,
    );
  }
  if (record["proposalFingerprint"] !== undefined) {
    proposal.proposalFingerprint = assertPattern(
      record["proposalFingerprint"],
      "proposal.proposalFingerprint",
      FINGERPRINT_RE,
      "must be a fingerprint",
    );
  }
  return proposal;
}

export interface PinFields {
  uri: string;
  hash: string;
  observedRev: string;
}

export function assertPinFields(value: unknown): PinFields {
  const record = assertRecord(value, "pin");
  assertKnownKeys(record, ["uri", "hash", "observedRev"], "pin");
  assertRequired(record, ["uri", "hash", "observedRev"], "pin");
  return {
    uri: assertUri(record["uri"], "pin.uri"),
    hash: assertPattern(
      record["hash"],
      "pin.hash",
      PIN_HASH_RE,
      "must be a hash",
    ),
    observedRev: assertPattern(
      record["observedRev"],
      "pin.observedRev",
      GIT_SHA_RE,
      "must be a git sha",
    ),
  };
}

export interface IntentFields {
  repoFullName: string;
  defaultBranch: string;
  targetSha: string;
  lastErrorCode?: string;
}

export function assertIntentFields(value: unknown): IntentFields {
  const record = assertRecord(value, "intent");
  assertKnownKeys(
    record,
    ["repoFullName", "defaultBranch", "targetSha", "lastErrorCode"],
    "intent",
  );
  assertRequired(
    record,
    ["repoFullName", "defaultBranch", "targetSha"],
    "intent",
  );
  const fields: IntentFields = {
    repoFullName: assertPattern(
      record["repoFullName"],
      "intent.repoFullName",
      REPO_RE,
      "must be owner/name",
    ),
    defaultBranch: assertPattern(
      record["defaultBranch"],
      "intent.defaultBranch",
      BRANCH_RE,
      "must be a branch name",
    ),
    targetSha: assertPattern(
      record["targetSha"],
      "intent.targetSha",
      GIT_SHA_RE,
      "must be a git sha",
    ),
  };
  if (record["lastErrorCode"] !== undefined) {
    fields.lastErrorCode = assertPattern(
      record["lastErrorCode"],
      "intent.lastErrorCode",
      ERROR_CODE_RE,
      "must be an error code",
    );
  }
  return fields;
}

export function assertAdminLogTarget(
  value: unknown,
): Record<string, string | number | boolean | null> {
  const record = assertRecord(value, "target");
  const keys = Object.keys(record);
  if (keys.length > MAX_LOG_KEYS) {
    throw new MinimizationError("target", `more than ${MAX_LOG_KEYS} keys`);
  }
  const out: Record<string, string | number | boolean | null> = {};
  for (const key of keys) {
    if (!LOG_KEY_RE.test(key)) {
      throw new MinimizationError(`target.${key}`, "invalid key");
    }
    const entry = record[key];
    const path = `target.${key}`;
    if (entry === null || typeof entry === "boolean") {
      out[key] = entry;
    } else if (typeof entry === "number") {
      if (!Number.isSafeInteger(entry)) {
        throw new MinimizationError(path, "must be an integer");
      }
      out[key] = entry;
    } else {
      out[key] = assertPattern(
        entry,
        path,
        LOG_TOKEN_RE,
        "must be an enum token",
      );
    }
  }
  return out;
}
