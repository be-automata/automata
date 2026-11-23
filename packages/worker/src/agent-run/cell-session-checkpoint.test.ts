import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { computeManifestId } from "@terragon/types/cell-session-checkpoint";
import {
  CELL_SESSION_CHUNK_MAX_BYTES,
  CELL_SESSION_NATIVE_MAX_BYTES,
  CELL_SESSION_SCHEMA,
  sha256Hex,
  type CellSessionManifest,
} from "@terragon/types/cell-session-checkpoint";

import type { CheckpointHead } from "./cell-www-client";
import {
  CELL_RESTORE_FETCH_CONCURRENCY,
  fetchSessionCheckpoint,
  prepareCheckpoint,
  type CheckpointContext,
  type RestoreInput,
  type PrepareCheckpointInput,
  type PrepareCheckpointResult,
} from "./cell-session-checkpoint";
import {
  createSessionRedactor,
  type SessionRedactor,
} from "./cell-session-redact";

const FIXTURE = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "__fixtures__/cell-session.jsonl",
  ),
  "utf8",
);
const LINES = FIXTURE.split("\n")
  .filter(Boolean)
  .map((l) => `${l}\n`);
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

const CANARIES = [
  "CANARY-EMAIL@example.invalid",
  "/home/agent",
  "00000000-0000-4000-8000-0000000000a1",
  "00000000-0000-4000-8000-0000000000b2",
  "sk-ant-api03-CANARYCANARYCANARYCANARY00",
  "CANARY-SYSTEM-PROMPT",
  "CANARY-REPO-ENV-VALUE-123",
  "CANARY-DB-PASSWORD-456",
];

const CONTEXT: CheckpointContext = {
  threadId: "thread-1",
  threadChatId: "chat-1",
  sessionId: "11111111-1111-4111-8111-111111111111",
  runExternalId: "run-1",
  projectDir: "-workspace",
  git: { commit: "abc123" },
};
const NOW = () => new Date("2026-01-02T03:04:05.000Z");

const redactor = createSessionRedactor({
  values: ["CANARY-REPO-ENV-VALUE-123", "CANARY-DB-PASSWORD-456"],
  operatorEmail: "CANARY-EMAIL@example.invalid",
  homePaths: ["/home/agent"],
  identityIds: [
    "00000000-0000-4000-8000-0000000000a1",
    "00000000-0000-4000-8000-0000000000b2",
  ],
  systemPrompts: ["CANARY-SYSTEM-PROMPT: synthetic instructions"],
});

function run(over: Partial<PrepareCheckpointInput>): PrepareCheckpointResult {
  return prepareCheckpoint({
    previous: null,
    newBytes: bytes(FIXTURE),
    context: CONTEXT,
    redactor,
    now: NOW,
    ...over,
  });
}

function written(result: PrepareCheckpointResult) {
  if (result.kind !== "write")
    throw new Error(`expected write: ${result.kind}`);
  return result;
}

describe("prepareCheckpoint", () => {
  it("AC-5: no canary survives in the chunk, the events or the manifest", () => {
    const w = written(run({}));
    const everything = [
      ...w.blobs.map((b) => text(b.body)),
      JSON.stringify(w.manifest),
      text(w.native),
    ].join("\n");
    for (const canary of CANARIES) expect(everything).not.toContain(canary);
    // The redacted transcript still parses line by line.
    const native = text(w.native).split("\n").filter(Boolean);
    expect(native).toHaveLength(LINES.length);
    for (const l of native) expect(() => JSON.parse(l)).not.toThrow();
    // Events parse too.
    for (const b of w.blobs.filter((x) => x.role === "events")) {
      for (const l of text(b.body).split("\n").filter(Boolean)) {
        expect(() => JSON.parse(l)).not.toThrow();
      }
    }
    expect(w.manifest.redaction.hits).toBeGreaterThan(6);
  });

  it("builds a manifest whose id is its sha256 and whose chunks match the blobs", () => {
    const w = written(run({}));
    const { id, ...rest } = w.manifest;
    expect(id).toBe(computeManifestId(rest));
    expect(w.manifest.parent).toBeNull();
    expect(w.manifest.projectDir).toBe("-workspace");
    expect(w.manifest.createdAt).toBe("2026-01-02T03:04:05.000Z");
    expect(w.manifest.native.chunks).toEqual(
      w.blobs
        .filter((b) => b.role === "native")
        .map((b) => ({ sha256: b.sha256, bytes: b.bytes })),
    );
    expect(w.manifest.native.bytes).toBe(w.native.length);
    expect(w.consumedRawBytes).toBe(bytes(FIXTURE).length);
  });

  it("normalizes events and counts two completed turns", () => {
    const w = written(run({}));
    expect(w.manifest.turn).toBe(2);
    expect(w.turnAdvanced).toBe(true);
    const events = text(w.blobs.find((b) => b.role === "events")!.body)
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.map((e) => e.kind)).toEqual([
      "message",
      "message",
      "tool_call",
      "tool_result",
      "message",
    ]);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(w.manifest.events.count).toBe(5);
  });

  it("returns nothing for an empty pull and for a torn line", () => {
    expect(run({ newBytes: new Uint8Array(0) })).toEqual({ kind: "nothing" });
    expect(run({ newBytes: bytes('{"type":"user"') })).toEqual({
      kind: "nothing",
    });
    expect(run({ newBytes: bytes("\n  \n") })).toEqual({ kind: "nothing" });
  });

  it("cuts a torn tail and reports only the consumed bytes", () => {
    const whole = LINES.slice(0, 2).join("");
    const w = written(run({ newBytes: bytes(`${whole}{"type":"us`) }));
    expect(w.consumedRawBytes).toBe(bytes(whole).length);
    expect(text(w.native).split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("chains: the new manifest extends the previous chunk list and parents it", () => {
    const first = written(run({ newBytes: bytes(LINES.slice(0, 4).join("")) }));
    // msg_01's tool_use has no result yet: not a completed turn.
    expect(first.manifest.turn).toBe(0);
    expect(first.turnAdvanced).toBe(false);
    const second = written(
      run({
        previous: first.manifest,
        previousNative: first.native,
        turnState: first.turnState,
        newBytes: bytes(LINES.slice(4).join("")),
        context: { ...CONTEXT, runExternalId: "run-2" },
      }),
    );
    expect(second.manifest.parent).toBe(first.manifest.id);
    expect(
      second.manifest.native.chunks.slice(
        0,
        first.manifest.native.chunks.length,
      ),
    ).toEqual(first.manifest.native.chunks);
    expect(second.manifest.native.chunks.length).toBeGreaterThan(
      first.manifest.native.chunks.length,
    );
    expect(second.manifest.events.chunks.length).toBeGreaterThan(
      first.manifest.events.chunks.length,
    );
    expect(second.manifest.turn).toBe(2);
    expect(second.turnAdvanced).toBe(true);
    expect(second.manifest.events.count).toBe(5);
    expect(second.manifest.events.chunks[0]).toEqual(
      first.manifest.events.chunks[0],
    );
    expect(second.manifest.redaction.hits).toBeGreaterThan(
      first.manifest.redaction.hits,
    );
    // The chain's concatenation equals a single-pull transcript.
    expect(text(second.native)).toBe(text(written(run({})).native));
    expect(second.manifest.native.sha256).toBe(
      written(run({})).manifest.native.sha256,
    );
  });

  it("the incremental digest path yields the same manifest id and native sha256", () => {
    const first = written(run({ newBytes: bytes(LINES.slice(0, 4).join("")) }));
    const rest = {
      previous: first.manifest,
      previousNative: first.native,
      turnState: first.turnState,
      newBytes: bytes(LINES.slice(4).join("")),
    };
    const classic = written(run(rest));
    const incremental = written(
      run({ ...rest, previousNativeSha256: first.nativeSha256 }),
    );
    expect(incremental.manifest.id).toBe(classic.manifest.id);
    expect(incremental.manifest.native.sha256).toBe(
      classic.manifest.native.sha256,
    );
    expect(incremental.nativeSha256).toBe(classic.nativeSha256);
    expect(run({ ...rest, previousNativeSha256: "0".repeat(64) })).toEqual({
      kind: "skipped",
      reason: "prefix mismatch",
    });
  });

  it("a pull with only a summary line adds a native chunk but no events chunk", () => {
    const first = written(run({ newBytes: bytes(LINES.slice(0, 6).join("")) }));
    const second = written(
      run({
        previous: first.manifest,
        previousNative: first.native,
        turnState: first.turnState,
        newBytes: bytes(LINES[6] as string),
      }),
    );
    expect(second.blobs.map((b) => b.role)).toEqual(["native"]);
    expect(second.manifest.events.chunks).toEqual(first.manifest.events.chunks);
    expect(second.turnAdvanced).toBe(false);
  });

  it("derives turn state from the previous manifest when none is carried", () => {
    const first = written(run({ newBytes: bytes(LINES.slice(0, 6).join("")) }));
    const second = written(
      run({
        previous: first.manifest,
        previousNative: first.native,
        newBytes: bytes(LINES[6] as string),
      }),
    );
    expect(second.manifest.turn).toBe(first.manifest.turn);
  });

  // card: protects=#743 R1-5: Claude Code writes one line per content block with the same message.id; a message touched again by a later pull counts once; fails_when=the second pull raises the turn count again; no_claim=the file offset (cell-run.test.ts)
  it("counts a message once when its blocks arrive across pulls", () => {
    const block = (uuid: string, text: string) =>
      `${JSON.stringify({
        type: "assistant",
        uuid,
        message: { id: "msg_same", content: [{ type: "text", text }] },
      })}\n`;
    const first = written(run({ newBytes: bytes(block("a", "one")) }));
    expect(first.manifest.turn).toBe(1);
    const second = written(
      run({
        previous: first.manifest,
        previousNative: first.native,
        turnState: first.turnState,
        newBytes: bytes(block("b", "two")),
      }),
    );
    expect(second.manifest.turn).toBe(1);
    expect(second.turnAdvanced).toBe(false);
    const third = written(
      run({
        previous: second.manifest,
        previousNative: second.native,
        turnState: second.turnState,
        newBytes: bytes(
          `${JSON.stringify({
            type: "assistant",
            uuid: "c",
            message: { id: "msg_next", content: [{ type: "text", text: "x" }] },
          })}\n`,
        ),
      }),
    );
    expect(third.manifest.turn).toBe(2);
  });

  // card: protects=#743 R1-1/4: a new chain (no previous manifest) is parented to the head that was current when it began; fails_when=parent is null or ignored; no_claim=the head read (cell-run.test.ts)
  it("parents a new chain to the given head", () => {
    const w = written(run({ parent: "head-manifest-id" }));
    expect(w.manifest.parent).toBe("head-manifest-id");
    expect(written(run({})).manifest.parent).toBeNull();
  });

  it("fails closed on a redactor throw: nothing is written, the class is logged, not the message", () => {
    const log = vi.fn();
    const broken: SessionRedactor = {
      digest: "x",
      redactLine: () => {
        throw new RangeError(
          "CANARY-EMAIL@example.invalid leaked in a message",
        );
      },
    };
    const result = run({ redactor: broken, log });
    expect(result).toEqual({ kind: "skipped", reason: "redactor error" });
    const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("RangeError");
    expect(logged).toContain("cell: checkpoint skipped (redactor error)");
    expect(logged).not.toContain("CANARY");
  });

  it("fails closed on a non-Error throw and on an unparseable line", () => {
    const log = vi.fn();
    const weird: SessionRedactor = {
      digest: "x",
      redactLine: () => {
        throw "boom";
      },
    };
    expect(run({ redactor: weird, log }).kind).toBe("skipped");
    expect(String(log.mock.calls[0]?.[0])).toContain("unknown");
    expect(run({ newBytes: bytes('{"type":"user",\n') })).toEqual({
      kind: "skipped",
      reason: "redactor error",
    });
  });

  it("refuses a previous transcript that does not match the manifest", () => {
    const first = written(run({ newBytes: bytes(LINES.slice(0, 2).join("")) }));
    const log = vi.fn();
    const base = {
      previous: first.manifest,
      newBytes: bytes(LINES[2] as string),
      log,
    };
    expect(run({ ...base, previousNative: bytes("tampered") })).toEqual({
      kind: "skipped",
      reason: "prefix mismatch",
    });
    const sameLength = new Uint8Array(first.native.length);
    expect(run({ ...base, previousNative: sameLength }).kind).toBe("skipped");
    expect(run({ ...base }).kind).toBe("skipped");
    expect(log).toHaveBeenCalledWith(
      "cell: checkpoint skipped (prefix mismatch)",
    );
  });

  it("splits a large pull into chunks under the chunk cap", () => {
    const filler = "x".repeat(1024 * 1024);
    const big = Array.from(
      { length: 5 },
      (_, i) =>
        `${JSON.stringify({ type: "summary", summary: `${i}${filler}` })}\n`,
    ).join("");
    const w = written(run({ newBytes: bytes(big) }));
    const nativeBlobs = w.blobs.filter((b) => b.role === "native");
    expect(nativeBlobs.length).toBeGreaterThan(1);
    for (const b of nativeBlobs) {
      expect(b.bytes).toBeLessThanOrEqual(CELL_SESSION_CHUNK_MAX_BYTES);
    }
  });

  it("skips a single line over the chunk cap and a transcript over the native cap", () => {
    const huge = `${JSON.stringify({ type: "summary", summary: "x".repeat(CELL_SESSION_CHUNK_MAX_BYTES) })}\n`;
    expect(run({ newBytes: bytes(huge) })).toEqual({
      kind: "skipped",
      reason: "over cap",
    });
    const chunkLine = `${JSON.stringify({ type: "summary", summary: "x".repeat(CELL_SESSION_CHUNK_MAX_BYTES - 100) })}\n`;
    const pull = chunkLine.repeat(
      Math.floor(CELL_SESSION_NATIVE_MAX_BYTES / chunkLine.length) + 1,
    );
    expect(run({ newBytes: bytes(pull) })).toEqual({
      kind: "skipped",
      reason: "over cap",
    });
    // It redacts ~16 MiB of real lines (the caps are 4 and 12 MiB): 6.7 s on a
    // loaded CI runner, past vitest's 5 s default.
  }, 60_000);

  it("skips when the chunk list would pass the cap", () => {
    const first = written(run({ newBytes: bytes(LINES.slice(0, 2).join("")) }));
    const tail = first.manifest.native.chunks[0]!;
    const full = {
      ...first.manifest,
      native: {
        ...first.manifest.native,
        chunks: Array.from({ length: 1024 }, () => tail),
      },
    };
    expect(
      run({
        previous: full,
        previousNative: first.native,
        newBytes: bytes(LINES[2] as string),
      }),
    ).toEqual({ kind: "skipped", reason: "chunk cap" });
    const fullEvents = {
      ...first.manifest,
      events: {
        ...first.manifest.events,
        chunks: Array.from({ length: 1024 }, () => tail),
      },
    };
    expect(
      run({
        previous: fullEvents,
        previousNative: first.native,
        newBytes: bytes(LINES[2] as string),
      }),
    ).toEqual({ kind: "skipped", reason: "chunk cap" });
  });

  it("normalizes odd shapes without guessing: string content, missing ids, non-records", () => {
    const odd = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "hi" },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          id: 5,
          content: [
            7,
            { type: "tool_use" },
            { type: "tool_result", content: [1] },
          ],
        },
      }),
      JSON.stringify([1, 2]),
      JSON.stringify({ type: "user", message: { content: 3 } }),
    ]
      .map((l) => `${l}\n`)
      .join("");
    const w = written(run({ newBytes: bytes(odd) }));
    const events = text(w.blobs.find((b) => b.role === "events")!.body)
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.map((e) => e.kind)).toEqual([
      "message",
      "tool_call",
      "tool_result",
    ]);
    expect(events[0]?.id).toBe("line-0");
    expect(events[1]?.toolName).toBe("");
    expect(events[2]?.text).toBe("[1]");
    expect(w.manifest.turn).toBe(0);
  });
});

describe("fetchSessionCheckpoint (#743 phase 8)", () => {
  const SID = CONTEXT.sessionId;
  const parts = Array.from({ length: 20 }, (_, i) => bytes(`line ${i}\n`));
  const whole = parts.reduce((a, b) => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  }, new Uint8Array(0));

  function manifestFor(over: Partial<CellSessionManifest> = {}) {
    const body: Omit<CellSessionManifest, "id"> = {
      schema: CELL_SESSION_SCHEMA,
      threadId: "thread-1",
      threadChatId: "chat-1",
      sessionId: SID,
      parent: null,
      turn: 3,
      runExternalId: "run-1",
      createdAt: "2026-01-02T03:04:05.000Z",
      harness: { name: "claude-code", nativeFormat: "claude-jsonl" },
      projectDir: "-workspace",
      git: null,
      native: {
        sha256: sha256Hex(whole),
        bytes: whole.length,
        chunks: parts.map((p) => ({ sha256: sha256Hex(p), bytes: p.length })),
      },
      events: { count: 0, chunks: [] },
      redaction: { rulesDigest: "d", hits: 0 },
      ...over,
    };
    return { ...body, id: computeManifestId(body) } as CellSessionManifest;
  }

  function harness(
    opts: {
      head?: CheckpointHead;
      blob?: (sha: string) => Uint8Array | "fail";
    } = {},
  ) {
    const manifest = manifestFor();
    const store = new Map(parts.map((p) => [sha256Hex(p), p]));
    let inFlight = 0;
    let peak = 0;
    const input: RestoreInput = {
      sessionId: SID,
      signal: new AbortController().signal,
      readHead: async () => ({
        ok: true as const,
        head: opts.head ?? { found: true as const, manifest, version: 5 },
      }),
      readBlob: async (sha: string) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setImmediate(r));
        inFlight -= 1;
        const got = opts.blob ? opts.blob(sha) : store.get(sha);
        if (got === "fail" || got === undefined) {
          return { ok: false as const, code: "not_found", status: 404 };
        }
        return { ok: true as const, bytes: got };
      },
    };
    return { input, manifest, peak: () => peak };
  }

  it("returns the exact bytes and the head version, fetching at most 8 chunks at once", async () => {
    const h = harness();
    const out = await fetchSessionCheckpoint(h.input);
    expect(out.kind).toBe("restored");
    if (out.kind !== "restored") return;
    expect(text(out.native)).toBe(text(whole));
    expect(out.version).toBe(5);
    expect(out.manifest.id).toBe(h.manifest.id);
    expect(h.peak()).toBe(CELL_RESTORE_FETCH_CONCURRENCY);
  });

  it("fails on a chunk that does not match its address", async () => {
    const h = harness({ blob: () => bytes("tampered\n") });
    expect(await fetchSessionCheckpoint(h.input)).toEqual({
      kind: "fresh",
      reason: "hash-mismatch",
    });
  });

  it("fails on a missing chunk (A-13) and on a thrown fetch", async () => {
    const h = harness({ blob: () => "fail" });
    expect(await fetchSessionCheckpoint(h.input)).toEqual({
      kind: "fresh",
      reason: "fetch-error",
    });
    const t = harness();
    t.input.readBlob = async () => {
      throw new Error("boom");
    };
    expect(await fetchSessionCheckpoint(t.input)).toEqual({
      kind: "fresh",
      reason: "fetch-error",
    });
  });

  it("starts fresh with no head, another session, or a head error", async () => {
    for (const [head, reason] of [
      [{ found: false, reason: "none" }, "no-head"],
      [{ found: false, reason: "other_session" }, "other-session"],
    ] as const) {
      const h = harness({ head });
      expect(await fetchSessionCheckpoint(h.input)).toEqual({
        kind: "fresh",
        reason,
      });
    }
    const h = harness();
    h.input.readHead = async () => ({
      ok: false as const,
      code: "transport",
      status: 0,
    });
    expect(await fetchSessionCheckpoint(h.input)).toEqual({
      kind: "fresh",
      reason: "head-error",
    });
    h.input.readHead = async () => {
      throw new Error("x");
    };
    expect(await fetchSessionCheckpoint(h.input)).toEqual({
      kind: "fresh",
      reason: "head-error",
    });
  });

  it("refuses a manifest with a bad id, another session, wrong sizes or over the cap", async () => {
    const good = manifestFor();
    const cases: CellSessionManifest[] = [
      { ...good, id: "0".repeat(64) },
      manifestFor({ sessionId: "22222222-2222-4222-8222-222222222222" }),
      manifestFor({ native: { ...good.native, bytes: good.native.bytes + 1 } }),
      manifestFor({
        native: {
          sha256: good.native.sha256,
          bytes: CELL_SESSION_NATIVE_MAX_BYTES + 1,
          chunks: [
            {
              sha256: "a".repeat(64),
              bytes: CELL_SESSION_NATIVE_MAX_BYTES + 1,
            },
          ],
        },
      }),
    ];
    const reasons = [];
    for (const manifest of cases) {
      const h = harness({ head: { found: true, manifest, version: 1 } });
      const out = await fetchSessionCheckpoint(h.input);
      reasons.push(out.kind === "fresh" ? out.reason : "restored");
    }
    expect(reasons).toEqual([
      "bad-manifest",
      "bad-manifest",
      "bad-manifest",
      "over-cap",
    ]);
  });

  it("fails when the whole transcript hash disagrees with the manifest", async () => {
    const good = manifestFor();
    const manifest = manifestFor({
      native: { ...good.native, sha256: "f".repeat(64) },
    });
    const h = harness({ head: { found: true, manifest, version: 1 } });
    expect(await fetchSessionCheckpoint(h.input)).toEqual({
      kind: "fresh",
      reason: "hash-mismatch",
    });
  });
});

describe("prepareCheckpoint with a short repo env value (#743 roborev)", () => {
  it("keeps the transcript structure: the turn counts and the user line stays a user line", () => {
    const shortRedactor = createSessionRedactor({ values: ["user"] });
    const sid = CONTEXT.sessionId;
    const lines = [
      {
        type: "user",
        uuid: "u-1",
        parentUuid: null,
        sessionId: sid,
        userType: "external",
        message: { role: "user", content: "run the tests" },
      },
      {
        type: "assistant",
        uuid: "a-1",
        parentUuid: "u-1",
        sessionId: sid,
        message: {
          id: "msg_s1",
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_s1", name: "Bash", input: {} },
          ],
        },
      },
      {
        type: "user",
        uuid: "u-2",
        parentUuid: "a-1",
        sessionId: sid,
        userType: "external",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_s1", content: "ok" },
          ],
        },
      },
    ]
      .map((l) => `${JSON.stringify(l)}\n`)
      .join("");

    const w = written(run({ newBytes: bytes(lines), redactor: shortRedactor }));

    expect(w.manifest.turn).toBe(1);
    expect(w.turnAdvanced).toBe(true);
    const stored = text(w.native)
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(stored).toHaveLength(3);
    expect(stored[0]?.type).toBe("user");
    expect(stored[2]?.type).toBe("user");
    expect(stored[2]?.userType).toBe("external");
  });
});
