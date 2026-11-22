import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDaemonTokenContext } from "@/lib/auth-server";
import { withDaemonAuthUnavailable } from "@/lib/daemon-auth-unavailable";
import { db } from "@/lib/db";
import { r2Private } from "@/server-lib/r2";
import {
  bindCheckpointHead,
  CheckpointIntegrityError,
  CheckpointManifestError,
  createCheckpointStore,
} from "@/server-lib/cell-session/checkpoint-store";
import { isOpenCellAttempt } from "@terragon/shared/model/cell-authority";
import {
  checkThreadGeneration,
  getThreadMinimal,
} from "@terragon/shared/model/threads";
import { cellStepKey } from "@terragon/types/cell";
import {
  CELL_SESSION_CHUNK_MAX_BYTES,
  type CellSessionManifest,
} from "@terragon/types/cell-session-checkpoint";

/**
 * POST /api/daemon/cell-checkpoint (#743, contract C5): the worker's write path
 * for a cell run's session checkpoint. Actions: put-blob, commit, read-head,
 * read-blob. Authenticated by the run token.
 *
 *  - F3: the size is checked BEFORE any JSON parse. A `content-length` above the
 *    cap, or a body that streams past it, is 413 `body_too_large`.
 *    `parseDaemonRequest` is not used: it calls `request.json()` uncapped.
 *  - F5: only a cell run's own step may write. A token with a null binding is 403
 *    `binding_required`; a thread with no open cell attempt (a box run's token,
 *    a done, revoked or older attempt, another thread's step) is 403
 *    `no_open_cell_step`. Nothing is written.
 *  - A lost head CAS is 409 `head_moved`, a typed answer apart from a store
 *    failure (5xx).
 *  - Never logs a body, a token or blob bytes: the action, the thread id, the
 *    version and sizes only.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** A 4 MiB chunk inflated by base64 (4/3), plus the envelope. */
const CELL_CHECKPOINT_MAX_BODY_BYTES = 6 * 1024 * 1024;

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/);
const base = {
  threadId: z.string().min(1),
  threadChatId: z.string().min(1),
  attempt: z.number().int().positive(),
};
const runExternalId = z.string().min(1).max(256);

const bodySchema = z.discriminatedUnion("action", [
  z
    .object({
      ...base,
      action: z.literal("put-blob"),
      runExternalId,
      sha256: SHA256,
      base64: z.string(),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("commit"),
      runExternalId,
      manifest: z.record(z.string(), z.unknown()),
      expectedVersion: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("read-head"),
      runExternalId,
      sessionId: z.string().min(1).max(64),
    })
    .strict(),
  z
    .object({ ...base, action: z.literal("read-blob"), sha256: SHA256 })
    .strict(),
]);

function reply(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** Reads at most `maxBytes`; null when the body is longer. Never parses. */
async function readCapped(
  request: Request,
  maxBytes: number,
): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const POST = withDaemonAuthUnavailable(async function POST(
  request: NextRequest,
): Promise<NextResponse> {
  // F3, step 1: the declared length, before anything is read.
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > CELL_CHECKPOINT_MAX_BODY_BYTES) {
      return reply({ error: "body_too_large" }, 413);
    }
  }

  const ctx = await getDaemonTokenContext(request);
  if (!ctx) return reply({ error: "Unauthorized" }, 401);
  if (ctx.tokenType !== "daemon") return reply({ error: "Forbidden" }, 403);
  // F5: the legacy pass-through (a null binding) never writes a checkpoint.
  if (ctx.threadId === null || ctx.threadChatId === null) {
    return reply({ error: "binding_required" }, 403);
  }

  // F3, step 2: the capped read, because the header can be absent or a lie.
  const raw = await readCapped(request, CELL_CHECKPOINT_MAX_BODY_BYTES);
  if (raw === null) return reply({ error: "body_too_large" }, 413);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return reply({ error: "invalid_body" }, 400);
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return reply({ error: "invalid_body" }, 400);
  const body = parsed.data;
  const { threadId, threadChatId, attempt } = body;

  if (ctx.threadId !== threadId || ctx.threadChatId !== threadChatId) {
    return reply({ error: "Forbidden" }, 403);
  }
  const thread = await getThreadMinimal({ db, userId: ctx.userId, threadId });
  if (!thread) return reply({ error: "Forbidden" }, 403);
  if ((thread.organizationId ?? null) !== (ctx.organizationId ?? null)) {
    return reply({ error: "Forbidden" }, 403);
  }

  // F5: the cell's own live step only.
  const open =
    ctx.apiKeyId !== null &&
    (await isOpenCellAttempt({
      db,
      stepKey: cellStepKey(ctx.apiKeyId),
      threadId,
      attempt,
    }));
  if (!open) {
    console.log("[daemon cell-checkpoint] refused", {
      action: body.action,
      threadId,
      outcome: "no_open_cell_step",
    });
    return reply({ error: "no_open_cell_step" }, 403);
  }

  if (body.action !== "read-blob") {
    const generation = await checkThreadGeneration({
      db,
      threadId,
      runExternalId: body.runExternalId,
    });
    if (!generation.ok) {
      if (generation.reason === "not-found") {
        return reply({ error: "Thread not found" }, 404);
      }
      return reply({ error: "superseded" }, 409);
    }
  }

  const head = bindCheckpointHead(db);
  const store = createCheckpointStore({ objects: r2Private, head });

  try {
    switch (body.action) {
      case "put-blob": {
        const bytes = Buffer.from(body.base64, "base64");
        if (bytes.byteLength > CELL_SESSION_CHUNK_MAX_BYTES) {
          return reply({ error: "too_large" }, 413);
        }
        const { created } = await store.putBlob({
          threadId,
          sha256: body.sha256,
          bytes,
        });
        console.log("[daemon cell-checkpoint] put-blob", {
          threadId,
          bytes: bytes.byteLength,
          created,
        });
        return reply({ created });
      }
      case "commit": {
        const result = await store.commit({
          threadId,
          threadChatId,
          manifest: body.manifest as unknown as CellSessionManifest,
          expectedVersion: body.expectedVersion,
          organizationId: thread.organizationId,
        });
        if (result.status === "head_moved") {
          const current = await head.get({ threadId, threadChatId });
          console.log("[daemon cell-checkpoint] commit: head_moved", {
            threadId,
            version: current?.version ?? 0,
          });
          return reply(
            { error: "head_moved", version: current?.version ?? 0 },
            409,
          );
        }
        console.log("[daemon cell-checkpoint] commit", {
          threadId,
          version: result.version,
        });
        return reply({ version: result.version });
      }
      case "read-head": {
        const result = await store.readHead({
          threadId,
          threadChatId,
          sessionId: body.sessionId,
        });
        return reply(result);
      }
      case "read-blob": {
        const bytes = await store.readBlob({ threadId, sha256: body.sha256 });
        if (!bytes) return reply({ error: "not_found" }, 404);
        return reply({ base64: bytes.toString("base64") });
      }
    }
  } catch (e: unknown) {
    if (e instanceof CheckpointManifestError) {
      if (e.code === "too_large") return reply({ error: "too_large" }, 413);
      if (e.code === "not_append_only") {
        return reply({ error: "not_append_only" }, 409);
      }
      const code =
        e.message === "hash_mismatch" ? "hash_mismatch" : "bad_manifest";
      return reply({ error: code }, 400);
    }
    console.log("[daemon cell-checkpoint] store failure", {
      action: body.action,
      threadId,
      error: e instanceof Error ? e.name : "unknown",
    });
    if (e instanceof CheckpointIntegrityError) {
      return reply({ error: "integrity" }, 500);
    }
    return reply({ error: "storage_unavailable" }, 503);
  }
});
