import { createHash } from "node:crypto";

export const CELL_SESSION_SCHEMA = "automata.cell-session-checkpoint/v1";

export interface BlobRef {
  sha256: string;
  bytes: number;
}

export interface CellSessionManifest {
  schema: typeof CELL_SESSION_SCHEMA;
  /** sha256 hex of canonicalJson(manifest without id). */
  id: string;
  threadId: string;
  threadChatId: string;
  /** Claude session id (UUID). */
  sessionId: string;
  /** Previous head, or the restored head. */
  parent: string | null;
  /** Completed turns in the whole transcript. */
  turn: number;
  runExternalId: string;
  createdAt: string;
  harness: { name: "claude-code"; nativeFormat: "claude-jsonl" };
  /** The ~/.claude/projects/<dir> the probe found, e.g. "-workspace". */
  projectDir: string;
  /** `git rev-parse HEAD` at capture; null on failure. */
  git: { commit: string } | null;
  /** The transcript as appended chunks; sha256 is of the concatenation. */
  native: { sha256: string; bytes: number; chunks: BlobRef[] };
  /** Normalized NDJSON events. */
  events: { count: number; chunks: BlobRef[] };
  /** The redaction applied before upload: the rule set's digest and the hit count, never values. */
  redaction: { rulesDigest: string; hits: number };
}

export const CELL_SESSION_CHUNK_MAX_BYTES = 4 * 1024 * 1024;
export const CELL_SESSION_NATIVE_MAX_BYTES = 12 * 1024 * 1024;
/**
 * The most chunks one manifest may list. The chain is append-only (a rewrite
 * would let a racing or compromised writer replace history), and a pull with
 * no new bytes writes nothing, so a session grows by about one chunk per
 * turn. 1024 covers a 60-minute run with room to spare; a manifest at the cap
 * is about 100 KB, and restore fetches chunks with bounded concurrency.
 */
export const CELL_SESSION_MAX_CHUNKS = 1024;

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

/** JSON with sorted object keys and no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
    }
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The manifest id: sha256 of the canonical JSON of the manifest without its id. */
export function computeManifestId(manifest: Omit<CellSessionManifest, "id">) {
  return sha256Hex(canonicalJson(manifest));
}

export function cellSessionKeys(threadId: string): {
  blob(sha: string): string;
  manifest(id: string): string;
} {
  return {
    blob: (sha) => `cell-sessions/${threadId}/blobs/sha256/${sha}`,
    manifest: (id) => `cell-sessions/${threadId}/manifests/${id}.json`,
  };
}
