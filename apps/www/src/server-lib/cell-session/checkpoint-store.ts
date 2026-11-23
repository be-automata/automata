import type { R2ConditionalPut } from "@terragon/r2";
import type { DB } from "@terragon/shared/db";
import {
  advanceCellSessionHead,
  getCellSessionHead,
  type AdvanceCellSessionHeadResult,
  type CellSessionHead,
  type CellSessionHeadMove,
} from "@terragon/shared/model/cell-session-checkpoint";
import {
  CELL_SESSION_CHUNK_MAX_BYTES,
  CELL_SESSION_MAX_CHUNKS,
  CELL_SESSION_NATIVE_MAX_BYTES,
  CELL_SESSION_SCHEMA,
  cellSessionKeys,
  computeManifestId,
  isSha256Hex,
  sha256Hex,
  canonicalJson,
  type BlobRef,
  type CellSessionManifest,
} from "@terragon/types/cell-session-checkpoint";

/** The slice of R2Client the store uses. */
export interface CheckpointObjects {
  putObjectIfAbsent(
    key: string,
    body: Buffer | Uint8Array | string,
    contentType?: string,
  ): Promise<R2ConditionalPut>;
  getObjectOrNull(key: string): Promise<Buffer | null>;
}

/** The pointer row operations, bound to a database. */
export interface CheckpointHead {
  get(args: {
    threadId: string;
    threadChatId: string;
  }): Promise<CellSessionHead | null>;
  advance(args: {
    threadId: string;
    threadChatId: string;
    expectedVersion: number;
    move: CellSessionHeadMove;
  }): Promise<AdvanceCellSessionHeadResult>;
}

export interface CheckpointStoreDeps {
  objects: CheckpointObjects;
  head: CheckpointHead;
}

/** Binds phase 2's pointer model to a database. */
export function bindCheckpointHead(db: DB): CheckpointHead {
  return {
    get: (args) => getCellSessionHead({ db, ...args }),
    advance: (args) => advanceCellSessionHead({ db, ...args }),
  };
}

/** The manifest is malformed, over a cap, or does not extend the head. The caller sent bad input. */
export class CheckpointManifestError extends Error {
  constructor(
    readonly code: "bad_manifest" | "not_append_only" | "too_large",
    message: string,
  ) {
    super(message);
    this.name = "CheckpointManifestError";
  }
}

/** A stored object does not match its address: tampering or corruption. */
export class CheckpointIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointIntegrityError";
  }
}

export type CommitCheckpointResult =
  | { status: "committed"; version: number }
  /** The head moved: the old head stands. Not a store failure. */
  | { status: "head_moved" };

export type ReadHeadResult =
  | { found: false; reason: "none" | "other_session" }
  | { found: true; manifest: CellSessionManifest; version: number };

function sumBytes(chunks: BlobRef[]): number {
  return chunks.reduce((total, chunk) => total + chunk.bytes, 0);
}

function validChunks(chunks: unknown): chunks is BlobRef[] {
  return (
    Array.isArray(chunks) &&
    chunks.length <= CELL_SESSION_MAX_CHUNKS &&
    chunks.every(
      (chunk) =>
        chunk !== null &&
        typeof chunk === "object" &&
        isSha256Hex((chunk as BlobRef).sha256) &&
        Number.isInteger((chunk as BlobRef).bytes) &&
        (chunk as BlobRef).bytes >= 0 &&
        (chunk as BlobRef).bytes <= CELL_SESSION_CHUNK_MAX_BYTES,
    )
  );
}

/** Throws CheckpointManifestError unless the manifest is well formed for this thread chat. */
export function assertValidManifest(
  manifest: CellSessionManifest,
  scope: { threadId: string; threadChatId: string },
): void {
  const bad = (message: string) =>
    new CheckpointManifestError("bad_manifest", message);
  if (manifest.schema !== CELL_SESSION_SCHEMA) throw bad("schema");
  if (
    manifest.threadId !== scope.threadId ||
    manifest.threadChatId !== scope.threadChatId
  ) {
    throw bad("thread ids");
  }
  if (!validChunks(manifest.native?.chunks)) throw bad("native chunks");
  if (!validChunks(manifest.events?.chunks)) throw bad("events chunks");
  if (sumBytes(manifest.native.chunks) !== manifest.native.bytes) {
    throw bad("native bytes");
  }
  if (manifest.native.bytes > CELL_SESSION_NATIVE_MAX_BYTES) {
    throw new CheckpointManifestError("too_large", "native over cap");
  }
  if (!isSha256Hex(manifest.native.sha256)) throw bad("native sha256");
  if (!Number.isInteger(manifest.turn) || manifest.turn < 0) throw bad("turn");
  const { id, ...rest } = manifest;
  if (id !== computeManifestId(rest)) throw bad("id");
}

function extendsList(previous: BlobRef[], next: BlobRef[]): boolean {
  return (
    next.length >= previous.length &&
    previous.every(
      (chunk, index) =>
        next[index]?.sha256 === chunk.sha256 &&
        next[index]?.bytes === chunk.bytes,
    )
  );
}

export function createCheckpointStore({ objects, head }: CheckpointStoreDeps) {
  async function readVerifiedManifest(
    threadId: string,
    id: string,
  ): Promise<CellSessionManifest> {
    const raw = await objects.getObjectOrNull(
      cellSessionKeys(threadId).manifest(id),
    );
    if (!raw) {
      throw new CheckpointIntegrityError(`manifest ${id} is missing`);
    }
    let parsed: CellSessionManifest;
    try {
      parsed = JSON.parse(raw.toString("utf8")) as CellSessionManifest;
    } catch {
      throw new CheckpointIntegrityError(`manifest ${id} is not JSON`);
    }
    const { id: storedId, ...rest } = parsed;
    if (storedId !== id || computeManifestId(rest) !== id) {
      throw new CheckpointIntegrityError(
        `manifest ${id} does not match its id`,
      );
    }
    return parsed;
  }

  /** Create-only write of one content-addressed blob. A 412 means identical bytes already exist. */
  async function putBlob({
    threadId,
    sha256,
    bytes,
  }: {
    threadId: string;
    sha256: string;
    bytes: Uint8Array;
  }): Promise<{ created: boolean }> {
    if (bytes.byteLength > CELL_SESSION_CHUNK_MAX_BYTES) {
      throw new CheckpointManifestError("too_large", "blob over cap");
    }
    if (!isSha256Hex(sha256) || sha256Hex(bytes) !== sha256) {
      throw new CheckpointManifestError("bad_manifest", "hash_mismatch");
    }
    const result = await objects.putObjectIfAbsent(
      cellSessionKeys(threadId).blob(sha256),
      bytes,
      "application/octet-stream",
    );
    return { created: result.status === 201 };
  }

  /** The blob at its address, or null when absent. Throws when the bytes do not hash to the address. */
  async function readBlob({
    threadId,
    sha256,
  }: {
    threadId: string;
    sha256: string;
  }): Promise<Buffer | null> {
    if (!isSha256Hex(sha256)) return null;
    const bytes = await objects.getObjectOrNull(
      cellSessionKeys(threadId).blob(sha256),
    );
    if (!bytes) return null;
    if (sha256Hex(bytes) !== sha256) {
      throw new CheckpointIntegrityError(
        `blob ${sha256} does not match its address`,
      );
    }
    return bytes;
  }

  /**
   * Write order: the caller has put the new chunks and the events blob first. Then
   * (1) create-only manifest, (2) CAS the head. A lost CAS returns head_moved and
   * leaves the old head; storage failures throw.
   */
  async function commit({
    threadId,
    threadChatId,
    manifest,
    expectedVersion,
    organizationId,
  }: {
    threadId: string;
    threadChatId: string;
    manifest: CellSessionManifest;
    expectedVersion: number;
    organizationId?: string | null;
  }): Promise<CommitCheckpointResult> {
    assertValidManifest(manifest, { threadId, threadChatId });

    const current = await head.get({ threadId, threadChatId });
    if ((current?.version ?? 0) !== expectedVersion) {
      return { status: "head_moved" };
    }
    if (current && current.sessionId === manifest.sessionId) {
      const previous = await readVerifiedManifest(
        threadId,
        current.headManifestId,
      );
      if (
        !extendsList(previous.native.chunks, manifest.native.chunks) ||
        !extendsList(previous.events.chunks, manifest.events.chunks)
      ) {
        throw new CheckpointManifestError(
          "not_append_only",
          "chunk list does not extend the head's list",
        );
      }
    }

    await objects.putObjectIfAbsent(
      cellSessionKeys(threadId).manifest(manifest.id),
      canonicalJson(manifest),
      "application/json",
    );

    const moved = await head.advance({
      threadId,
      threadChatId,
      expectedVersion,
      move: {
        sessionId: manifest.sessionId,
        headManifestId: manifest.id,
        headTurn: manifest.turn,
        nativeBytes: manifest.native.bytes,
        callIndexSha256: null,
        lastRunExternalId: manifest.runExternalId,
        organizationId,
      },
    });
    return moved.moved
      ? { status: "committed", version: moved.version }
      : { status: "head_moved" };
  }

  async function readHead({
    threadId,
    threadChatId,
    sessionId,
  }: {
    threadId: string;
    threadChatId: string;
    sessionId: string;
  }): Promise<ReadHeadResult> {
    const row = await head.get({ threadId, threadChatId });
    if (!row) return { found: false, reason: "none" };
    if (row.sessionId !== sessionId) {
      return { found: false, reason: "other_session" };
    }
    const manifest = await readVerifiedManifest(threadId, row.headManifestId);
    return { found: true, manifest, version: row.version };
  }

  return { putBlob, readBlob, commit, readHead };
}

export type CheckpointStore = ReturnType<typeof createCheckpointStore>;
