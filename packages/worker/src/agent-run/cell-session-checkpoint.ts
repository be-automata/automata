import {
  CELL_SESSION_CHUNK_MAX_BYTES,
  CELL_SESSION_MAX_CHUNKS,
  CELL_SESSION_NATIVE_MAX_BYTES,
  CELL_SESSION_SCHEMA,
  computeManifestId,
  sha256Hex,
  type BlobRef,
  type CellSessionManifest,
} from "@terragon/types/cell-session-checkpoint";

import type { SessionRedactor } from "./cell-session-redact";
import type { CheckpointResult, CheckpointHead } from "./cell-www-client";

/**
 * The checkpoint writer core (#743 phase 5). Pure: it turns the previous
 * manifest plus the transcript bytes appended since the last pull into one new
 * set of chunks and the next manifest. The chain is append-only (A-12): a pull
 * with no new bytes writes nothing, and nothing already stored is rewritten.
 * Uploading, the head CAS and the pull cadence belong to the caller.
 */

export interface SessionEvent {
  seq: number;
  id: string;
  parentId: string | null;
  role: "user" | "assistant" | "tool";
  kind: "message" | "tool_call" | "tool_result";
  text: string;
  toolName?: string;
  toolCallId?: string;
  /** The assistant API response this event belongs to, for turn counting. */
  messageId: string | null;
  ts: string | null;
}

/** What the caller carries between pulls so a turn split across pulls counts once. */
export interface TurnState {
  turn: number;
  /** Assistant message ids seen but not yet complete. */
  pending: string[];
  /** tool_use id -> the message that issued it, until its tool_result arrives. */
  open: Record<string, string>;
}

export interface CheckpointContext {
  threadId: string;
  threadChatId: string;
  sessionId: string;
  runExternalId: string;
  projectDir: string;
  git: { commit: string } | null;
}

export interface PrepareCheckpointInput {
  previous: CellSessionManifest | null;
  /** The redacted transcript the previous manifest describes; verified against it. */
  previousNative?: Uint8Array;
  /** Raw transcript bytes since the last pull. */
  newBytes: Uint8Array;
  turnState?: TurnState;
  context: CheckpointContext;
  redactor: SessionRedactor;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface CheckpointBlob {
  sha256: string;
  bytes: number;
  body: Uint8Array;
  role: "native" | "events";
}

export type SkipReason =
  | "redactor error"
  | "prefix mismatch"
  | "over cap"
  | "chunk cap";

export type PrepareCheckpointResult =
  | { kind: "nothing" }
  | { kind: "skipped"; reason: SkipReason }
  | {
      kind: "write";
      manifest: CellSessionManifest;
      /** Only the new chunks; earlier ones are already stored. */
      blobs: CheckpointBlob[];
      /** The full redacted transcript after this pull: the caller's next `previousNative`. */
      native: Uint8Array;
      /** Raw bytes consumed (up to the last newline): advance the file offset by this. */
      consumedRawBytes: number;
      turnState: TurnState;
      /** True when this pull completed at least one more turn. */
      turnAdvanced: boolean;
    };

const NEWLINE = 0x0a;
const EMPTY_TURN_STATE: TurnState = { turn: 0, pending: [], open: {} };
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Group whole lines into chunks of at most `max` bytes. Null when one line exceeds it. */
function splitChunks(lines: string[], max: number): Uint8Array[] | null {
  const chunks: Uint8Array[] = [];
  let current: string[] = [];
  let size = 0;
  const flush = () => {
    if (current.length > 0) chunks.push(encoder.encode(current.join("")));
    current = [];
    size = 0;
  };
  for (const line of lines) {
    const bytes = encoder.encode(line).length;
    if (bytes > max) return null;
    if (size + bytes > max) flush();
    current.push(line);
    size += bytes;
  }
  flush();
  return chunks;
}

function contentParts(content: unknown): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

/** Claude Code JSONL (already redacted) -> events and the next turn state. */
function normalize(
  redactedLines: string[],
  firstSeq: number,
  state: TurnState,
): { events: SessionEvent[]; turnState: TurnState } {
  const events: SessionEvent[] = [];
  const open = { ...state.open };
  const touched = new Set<string>();

  for (const raw of redactedLines) {
    const line: unknown = JSON.parse(raw);
    if (!isRecord(line)) continue;
    const type = line.type;
    const message = line.message;
    // Unknown line types (summary, system, ...) are skipped, never guessed.
    if ((type !== "user" && type !== "assistant") || !isRecord(message)) {
      continue;
    }
    const messageId =
      type === "assistant" && typeof message.id === "string"
        ? message.id
        : null;
    if (messageId) touched.add(messageId);
    const base = {
      id:
        typeof line.uuid === "string"
          ? line.uuid
          : `line-${firstSeq + events.length}`,
      parentId: typeof line.parentUuid === "string" ? line.parentUuid : null,
      messageId,
      ts: typeof line.timestamp === "string" ? line.timestamp : null,
    };
    for (const part of contentParts(message.content)) {
      if (!isRecord(part)) continue;
      const seq = firstSeq + events.length;
      if (part.type === "text" && typeof part.text === "string") {
        events.push({
          seq,
          ...base,
          role: type,
          kind: "message",
          text: part.text,
        });
      } else if (part.type === "tool_use") {
        const toolCallId = typeof part.id === "string" ? part.id : "";
        if (messageId && toolCallId) open[toolCallId] = messageId;
        events.push({
          seq,
          ...base,
          role: "assistant",
          kind: "tool_call",
          text: JSON.stringify(part.input ?? {}),
          toolName: typeof part.name === "string" ? part.name : "",
          toolCallId,
        });
      } else if (part.type === "tool_result") {
        const toolCallId =
          typeof part.tool_use_id === "string" ? part.tool_use_id : "";
        delete open[toolCallId];
        events.push({
          seq,
          ...base,
          role: "tool",
          kind: "tool_result",
          text:
            typeof part.content === "string"
              ? part.content
              : JSON.stringify(part.content ?? ""),
          toolCallId,
        });
      }
    }
  }

  // A turn is one assistant response whose every tool_use has its tool_result.
  const issuing = new Set(Object.values(open));
  let turn = state.turn;
  const pending: string[] = [];
  for (const id of new Set([...state.pending, ...touched])) {
    if (issuing.has(id)) pending.push(id);
    else turn += 1;
  }
  return { events, turnState: { turn, pending, open } };
}

function ref(chunk: Uint8Array): BlobRef {
  return { sha256: sha256Hex(chunk), bytes: chunk.length };
}

export function prepareCheckpoint(
  input: PrepareCheckpointInput,
): PrepareCheckpointResult {
  const { previous, newBytes, context, redactor } = input;
  const log = input.log ?? (() => {});
  const skip = (reason: SkipReason): PrepareCheckpointResult => {
    log(`cell: checkpoint skipped (${reason})`);
    return { kind: "skipped", reason };
  };

  // Cut at the last newline: a torn line is never stored.
  const cut = newBytes.lastIndexOf(NEWLINE) + 1;
  if (cut === 0) return { kind: "nothing" };
  const text = decoder.decode(newBytes.subarray(0, cut));
  const rawLines = text.split("\n").filter((l) => l.trim() !== "");
  if (rawLines.length === 0) return { kind: "nothing" };

  const previousNative = input.previousNative ?? new Uint8Array(0);
  if (
    previous &&
    (previousNative.length !== previous.native.bytes ||
      sha256Hex(previousNative) !== previous.native.sha256)
  ) {
    return skip("prefix mismatch");
  }

  // Fail closed: one throw drops the whole pull. Log the class only.
  let redactedLines: string[];
  let hits = 0;
  let normalized: ReturnType<typeof normalize>;
  try {
    redactedLines = rawLines.map((line) => {
      const r = redactor.redactLine(line);
      hits += r.hits;
      return `${r.text}\n`;
    });
    normalized = normalize(
      redactedLines,
      previous?.events.count ?? 0,
      input.turnState ?? { ...EMPTY_TURN_STATE, turn: previous?.turn ?? 0 },
    );
  } catch (error) {
    const name = error instanceof Error ? error.constructor.name : "unknown";
    log(`cell: checkpoint redactor error (${name})`);
    return skip("redactor error");
  }

  const nativeChunks = splitChunks(redactedLines, CELL_SESSION_CHUNK_MAX_BYTES);
  const eventLines = normalized.events.map((e) => `${JSON.stringify(e)}\n`);
  const eventChunks = splitChunks(eventLines, CELL_SESSION_CHUNK_MAX_BYTES);
  if (!nativeChunks || !eventChunks) return skip("over cap");

  const native = concat(previousNative, concatAll(nativeChunks));
  if (native.length > CELL_SESSION_NATIVE_MAX_BYTES) return skip("over cap");

  const priorNativeChunks = previous?.native.chunks ?? [];
  const priorEventChunks = previous?.events.chunks ?? [];
  if (
    priorNativeChunks.length + nativeChunks.length > CELL_SESSION_MAX_CHUNKS ||
    priorEventChunks.length + eventChunks.length > CELL_SESSION_MAX_CHUNKS
  ) {
    return skip("chunk cap");
  }

  const body: Omit<CellSessionManifest, "id"> = {
    schema: CELL_SESSION_SCHEMA,
    threadId: context.threadId,
    threadChatId: context.threadChatId,
    sessionId: context.sessionId,
    parent: previous?.id ?? null,
    turn: normalized.turnState.turn,
    runExternalId: context.runExternalId,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    harness: { name: "claude-code", nativeFormat: "claude-jsonl" },
    projectDir: context.projectDir,
    git: context.git,
    native: {
      sha256: sha256Hex(native),
      bytes: native.length,
      chunks: [...priorNativeChunks, ...nativeChunks.map(ref)],
    },
    events: {
      count: (previous?.events.count ?? 0) + normalized.events.length,
      chunks: [...priorEventChunks, ...eventChunks.map(ref)],
    },
    redaction: {
      rulesDigest: redactor.digest,
      hits: (previous?.redaction.hits ?? 0) + hits,
    },
  };

  return {
    kind: "write",
    manifest: { ...body, id: computeManifestId(body) },
    blobs: [
      ...nativeChunks.map((c) => ({
        ...ref(c),
        body: c,
        role: "native" as const,
      })),
      ...eventChunks.map((c) => ({
        ...ref(c),
        body: c,
        role: "events" as const,
      })),
    ],
    native,
    consumedRawBytes: cut,
    turnState: normalized.turnState,
    turnAdvanced: normalized.turnState.turn > (previous?.turn ?? 0),
  };
}

function concatAll(chunks: Uint8Array[]): Uint8Array {
  return chunks.reduce((acc, c) => concat(acc, c), new Uint8Array(0));
}

// ---- restore into a new cell (#743 phase 8) -----------------------------------

/** A restore fetches this many chunks at a time (A-12). */
export const CELL_RESTORE_FETCH_CONCURRENCY = 8;

/** Why a restore started fresh. Enum only: never a value from the transcript. */
export type RestoreFailure =
  | "no-head"
  | "other-session"
  | "head-error"
  | "bad-manifest"
  | "over-cap"
  | "fetch-error"
  | "hash-mismatch";

export type RestoreResult =
  | {
      kind: "restored";
      manifest: CellSessionManifest;
      version: number;
      /** The whole redacted transcript, hash-verified. */
      native: Uint8Array;
    }
  | { kind: "fresh"; reason: RestoreFailure };

export interface RestoreInput {
  sessionId: string;
  readHead: (
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<CheckpointResult<{ head: CheckpointHead }>>;
  readBlob: (
    sha256: string,
    signal: AbortSignal,
  ) => Promise<CheckpointResult<{ bytes: Uint8Array }>>;
  signal: AbortSignal;
  concurrency?: number;
}

/**
 * Reads the head, fetches every native chunk (8 at a time) and verifies each
 * against its address, then the whole transcript against the manifest. A
 * missing or bad chunk fails the hash check (A-13) and the run starts fresh.
 * Never throws and never returns a byte that failed a check.
 */
export async function fetchSessionCheckpoint(
  input: RestoreInput,
): Promise<RestoreResult> {
  const fresh = (reason: RestoreFailure): RestoreResult => ({
    kind: "fresh",
    reason,
  });
  let head: CheckpointHead;
  try {
    const out = await input.readHead(input.sessionId, input.signal);
    if (!out.ok) return fresh("head-error");
    head = out.head;
  } catch {
    return fresh("head-error");
  }
  if (!head.found) {
    return fresh(head.reason === "other_session" ? "other-session" : "no-head");
  }
  const { manifest, version } = head;
  const { id, ...rest } = manifest;
  if (
    manifest.schema !== CELL_SESSION_SCHEMA ||
    id !== computeManifestId(rest) ||
    manifest.sessionId !== input.sessionId
  ) {
    return fresh("bad-manifest");
  }
  const chunks = manifest.native.chunks;
  const total = chunks.reduce((n, c) => n + c.bytes, 0);
  if (
    chunks.length > CELL_SESSION_MAX_CHUNKS ||
    manifest.native.bytes > CELL_SESSION_NATIVE_MAX_BYTES ||
    total !== manifest.native.bytes
  ) {
    return fresh(
      total > CELL_SESSION_NATIVE_MAX_BYTES ? "over-cap" : "bad-manifest",
    );
  }

  const bodies: Uint8Array[] = new Array<Uint8Array>(chunks.length);
  const state: { failure: RestoreFailure | null } = { failure: null };
  let next = 0;
  const worker = async (): Promise<void> => {
    while (state.failure === null) {
      const index = next++;
      const chunk = chunks[index];
      if (chunk === undefined) return;
      let out: CheckpointResult<{ bytes: Uint8Array }>;
      try {
        out = await input.readBlob(chunk.sha256, input.signal);
      } catch {
        state.failure ??= "fetch-error";
        return;
      }
      if (!out.ok) {
        state.failure ??= "fetch-error";
        return;
      }
      if (
        out.bytes.length !== chunk.bytes ||
        sha256Hex(out.bytes) !== chunk.sha256
      ) {
        state.failure ??= "hash-mismatch";
        return;
      }
      bodies[index] = out.bytes;
    }
  };
  const width = Math.max(
    1,
    input.concurrency ?? CELL_RESTORE_FETCH_CONCURRENCY,
  );
  await Promise.all(
    Array.from({ length: Math.min(width, chunks.length) }, worker),
  );
  if (state.failure !== null) return fresh(state.failure);

  const native = concatAll(bodies);
  if (
    native.length !== manifest.native.bytes ||
    sha256Hex(native) !== manifest.native.sha256
  ) {
    return fresh("hash-mismatch");
  }
  return { kind: "restored", manifest, version, native };
}
