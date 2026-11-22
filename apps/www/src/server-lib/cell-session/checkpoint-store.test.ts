import { describe, expect, it, vi } from "vitest";
import {
  CELL_SESSION_SCHEMA,
  cellSessionKeys,
  computeManifestId,
  sha256Hex,
  type BlobRef,
  type CellSessionManifest,
} from "@terragon/types/cell-session-checkpoint";
import {
  CheckpointIntegrityError,
  CheckpointManifestError,
  createCheckpointStore,
  type CheckpointHead,
} from "./checkpoint-store";

const THREAD = "thread-1";
const CHAT = "chat-1";
const SESSION = "11111111-1111-4111-8111-111111111111";

function blob(text: string): { ref: BlobRef; bytes: Buffer } {
  const bytes = Buffer.from(text);
  return { ref: { sha256: sha256Hex(bytes), bytes: bytes.length }, bytes };
}

function makeManifest(
  nativeChunks: BlobRef[],
  eventChunks: BlobRef[],
  over: Partial<CellSessionManifest> = {},
): CellSessionManifest {
  const rest: Omit<CellSessionManifest, "id"> = {
    schema: CELL_SESSION_SCHEMA,
    threadId: THREAD,
    threadChatId: CHAT,
    sessionId: SESSION,
    parent: null,
    turn: nativeChunks.length,
    runExternalId: "run-1",
    createdAt: "2026-11-22T00:00:00.000Z",
    harness: { name: "claude-code", nativeFormat: "claude-jsonl" },
    projectDir: "-workspace",
    git: null,
    native: {
      sha256: sha256Hex(nativeChunks.map((c) => c.sha256).join("")),
      bytes: nativeChunks.reduce((n, c) => n + c.bytes, 0),
      chunks: nativeChunks,
    },
    events: { count: eventChunks.length, chunks: eventChunks },
    redaction: { rulesDigest: "d", hits: 0 },
    ...over,
  };
  return { ...rest, id: computeManifestId(rest) };
}

function setup() {
  const log: string[] = [];
  const objects = new Map<string, Buffer>();
  const r2 = {
    putObjectIfAbsent: vi.fn(
      async (key: string, body: Buffer | Uint8Array | string) => {
        log.push(`put ${key}`);
        if (objects.has(key)) return { status: 412 as const };
        objects.set(key, Buffer.from(body));
        return { status: 201 as const };
      },
    ),
    getObjectOrNull: vi.fn(async (key: string) => objects.get(key) ?? null),
  };
  let row: Awaited<ReturnType<CheckpointHead["get"]>> = null;
  const head: CheckpointHead = {
    get: vi.fn(async () => row),
    advance: vi.fn(async ({ expectedVersion, move }) => {
      log.push("cas");
      if ((row?.version ?? 0) !== expectedVersion)
        return { moved: false as const };
      row = {
        id: "row",
        threadId: THREAD,
        threadChatId: CHAT,
        organizationId: null,
        sessionId: move.sessionId,
        headManifestId: move.headManifestId,
        headTurn: move.headTurn,
        nativeBytes: move.nativeBytes,
        callIndexSha256: null,
        version: expectedVersion + 1,
        lastRunExternalId: move.lastRunExternalId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return { moved: true as const, version: row.version };
    }),
  };
  return {
    log,
    objects,
    r2,
    head,
    store: createCheckpointStore({ objects: r2, head }),
  };
}

async function putAll(
  store: ReturnType<typeof setup>["store"],
  parts: { ref: BlobRef; bytes: Buffer }[],
) {
  for (const part of parts) {
    await store.putBlob({
      threadId: THREAD,
      sha256: part.ref.sha256,
      bytes: part.bytes,
    });
  }
}

describe("checkpoint store", () => {
  it("writes chunks, then the manifest, then the head CAS, in that order", async () => {
    const { store, log } = setup();
    const n1 = blob("native-1");
    const e1 = blob("events-1");
    await putAll(store, [n1, e1]);
    const manifest = makeManifest([n1.ref], [e1.ref]);

    const result = await store.commit({
      threadId: THREAD,
      threadChatId: CHAT,
      manifest,
      expectedVersion: 0,
    });

    expect(result).toEqual({ status: "committed", version: 1 });
    const keys = cellSessionKeys(THREAD);
    expect(log).toEqual([
      `put ${keys.blob(n1.ref.sha256)}`,
      `put ${keys.blob(e1.ref.sha256)}`,
      `put ${keys.manifest(manifest.id)}`,
      "cas",
    ]);
  });

  it("a lost CAS race leaves the old head and returns head_moved, not a throw", async () => {
    const { store, head, objects } = setup();
    const n1 = blob("native-1");
    const e1 = blob("events-1");
    await putAll(store, [n1, e1]);
    const first = makeManifest([n1.ref], [e1.ref]);
    await store.commit({
      threadId: THREAD,
      threadChatId: CHAT,
      manifest: first,
      expectedVersion: 0,
    });

    const n2 = blob("native-2");
    await putAll(store, [n2]);
    const second = makeManifest([n1.ref, n2.ref], [e1.ref], {
      parent: first.id,
    });
    // another writer wins between our read and our CAS
    vi.mocked(head.advance).mockResolvedValueOnce({ moved: false });
    const result = await store.commit({
      threadId: THREAD,
      threadChatId: CHAT,
      manifest: second,
      expectedVersion: 1,
    });

    expect(result).toEqual({ status: "head_moved" });
    const read = await store.readHead({
      threadId: THREAD,
      threadChatId: CHAT,
      sessionId: SESSION,
    });
    expect(read).toMatchObject({ found: true, version: 1 });
    expect(read.found && read.manifest.id).toBe(first.id);
    // a store failure is a different thing: it throws
    vi.mocked(head.advance).mockRejectedValueOnce(new Error("db down"));
    await expect(
      store.commit({
        threadId: THREAD,
        threadChatId: CHAT,
        manifest: second,
        expectedVersion: 1,
      }),
    ).rejects.toThrow("db down");
    expect(objects.size).toBeGreaterThan(0);
  });

  it("a stale expectedVersion returns head_moved without writing the manifest", async () => {
    const { store, r2 } = setup();
    const n1 = blob("n");
    const e1 = blob("e");
    await putAll(store, [n1, e1]);
    const first = makeManifest([n1.ref], [e1.ref]);
    await store.commit({
      threadId: THREAD,
      threadChatId: CHAT,
      manifest: first,
      expectedVersion: 0,
    });
    r2.putObjectIfAbsent.mockClear();
    const result = await store.commit({
      threadId: THREAD,
      threadChatId: CHAT,
      manifest: first,
      expectedVersion: 0,
    });
    expect(result).toEqual({ status: "head_moved" });
    expect(r2.putObjectIfAbsent).not.toHaveBeenCalled();
  });

  it("a repeated chunk is a 412 and counts as fine", async () => {
    const { store } = setup();
    const n1 = blob("same");
    const a = await store.putBlob({
      threadId: THREAD,
      sha256: n1.ref.sha256,
      bytes: n1.bytes,
    });
    const b = await store.putBlob({
      threadId: THREAD,
      sha256: n1.ref.sha256,
      bytes: n1.bytes,
    });
    expect(a).toEqual({ created: true });
    expect(b).toEqual({ created: false });
  });

  it("refuses a blob whose bytes do not hash to the address", async () => {
    const { store, r2 } = setup();
    await expect(
      store.putBlob({
        threadId: THREAD,
        sha256: sha256Hex("x"),
        bytes: Buffer.from("y"),
      }),
    ).rejects.toBeInstanceOf(CheckpointManifestError);
    expect(r2.putObjectIfAbsent).not.toHaveBeenCalled();
  });

  it("detects a tampered blob on read", async () => {
    const { store, objects } = setup();
    const n1 = blob("genuine");
    await putAll(store, [n1]);
    expect(
      (
        await store.readBlob({ threadId: THREAD, sha256: n1.ref.sha256 })
      )?.toString(),
    ).toBe("genuine");
    objects.set(
      cellSessionKeys(THREAD).blob(n1.ref.sha256),
      Buffer.from("forged"),
    );
    await expect(
      store.readBlob({ threadId: THREAD, sha256: n1.ref.sha256 }),
    ).rejects.toBeInstanceOf(CheckpointIntegrityError);
    expect(
      await store.readBlob({ threadId: THREAD, sha256: sha256Hex("absent") }),
    ).toBeNull();
  });

  it("detects a tampered manifest on read", async () => {
    const { store, objects } = setup();
    const n1 = blob("n");
    const e1 = blob("e");
    await putAll(store, [n1, e1]);
    const manifest = makeManifest([n1.ref], [e1.ref]);
    await store.commit({
      threadId: THREAD,
      threadChatId: CHAT,
      manifest,
      expectedVersion: 0,
    });
    const key = cellSessionKeys(THREAD).manifest(manifest.id);
    objects.set(key, Buffer.from(JSON.stringify({ ...manifest, turn: 99 })));
    await expect(
      store.readHead({
        threadId: THREAD,
        threadChatId: CHAT,
        sessionId: SESSION,
      }),
    ).rejects.toBeInstanceOf(CheckpointIntegrityError);
  });

  it("refuses a manifest whose chunk list does not extend the head's list", async () => {
    const { store, head } = setup();
    const n1 = blob("n1");
    const n2 = blob("n2");
    const e1 = blob("e1");
    await putAll(store, [n1, n2, e1]);
    const first = makeManifest([n1.ref], [e1.ref]);
    await store.commit({
      threadId: THREAD,
      threadChatId: CHAT,
      manifest: first,
      expectedVersion: 0,
    });

    // replaces the first chunk instead of appending after it
    const rewrite = makeManifest([n2.ref], [e1.ref], { parent: first.id });
    await expect(
      store.commit({
        threadId: THREAD,
        threadChatId: CHAT,
        manifest: rewrite,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "not_append_only" });
    // drops a chunk
    const shorter = makeManifest([], [e1.ref], { parent: first.id });
    await expect(
      store.commit({
        threadId: THREAD,
        threadChatId: CHAT,
        manifest: shorter,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "not_append_only" });
    expect(head.advance).toHaveBeenCalledTimes(1);

    // a true extension is accepted
    const ok = makeManifest([n1.ref, n2.ref], [e1.ref], { parent: first.id });
    expect(
      await store.commit({
        threadId: THREAD,
        threadChatId: CHAT,
        manifest: ok,
        expectedVersion: 1,
      }),
    ).toEqual({ status: "committed", version: 2 });
  });

  it("refuses a malformed manifest before any write", async () => {
    const { store, r2 } = setup();
    const n1 = blob("n");
    const manifest = makeManifest([n1.ref], []);
    await expect(
      store.commit({
        threadId: THREAD,
        threadChatId: CHAT,
        manifest: { ...manifest, turn: 7 },
        expectedVersion: 0,
      }),
    ).rejects.toMatchObject({ code: "bad_manifest" });
    await expect(
      store.commit({
        threadId: "other",
        threadChatId: CHAT,
        manifest,
        expectedVersion: 0,
      }),
    ).rejects.toMatchObject({ code: "bad_manifest" });
    expect(r2.putObjectIfAbsent).not.toHaveBeenCalled();
  });

  it("readHead reports none and other_session", async () => {
    const { store } = setup();
    expect(
      await store.readHead({
        threadId: THREAD,
        threadChatId: CHAT,
        sessionId: SESSION,
      }),
    ).toEqual({ found: false, reason: "none" });
    const n1 = blob("n");
    const e1 = blob("e");
    await putAll(store, [n1, e1]);
    await store.commit({
      threadId: THREAD,
      threadChatId: CHAT,
      manifest: makeManifest([n1.ref], [e1.ref]),
      expectedVersion: 0,
    });
    expect(
      await store.readHead({
        threadId: THREAD,
        threadChatId: CHAT,
        sessionId: "other",
      }),
    ).toEqual({ found: false, reason: "other_session" });
  });
});
