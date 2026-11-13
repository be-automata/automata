import { describe, expect, it } from "vitest";

import { checkRefFence, parseReceivePackCommands } from "./receive-pack-refs";

const OLD = "1".repeat(40);
const NEW = "a".repeat(40);
const REF = "refs/heads/feat/x";

const encoder = new TextEncoder();

/** One pkt-line: 4 hex digits counting themselves, then the payload. */
function pkt(payload: string): Uint8Array {
  const body = encoder.encode(payload);
  const len = (body.length + 4).toString(16).padStart(4, "0");
  return encoder.encode(len + payload);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const FLUSH = encoder.encode("0000");

describe("parseReceivePackCommands (Uint8Array input)", () => {
  it("parses a single update carrying capabilities", () => {
    const buf = concat(
      pkt(`${OLD} ${NEW} ${REF}\0report-status side-band-64k\n`),
      FLUSH,
    );
    expect(parseReceivePackCommands(buf)).toEqual({
      ok: true,
      commands: [{ oldSha: OLD, newSha: NEW, ref: REF }],
      consumed: buf.length,
    });
  });

  it("a bare flush is ok with zero commands and consumed 4", () => {
    expect(parseReceivePackCommands(FLUSH)).toEqual({
      ok: true,
      commands: [],
      consumed: 4,
    });
  });

  it("reports consumed 4 when bytes follow the flush, so callers see the PACK start", () => {
    const buf = concat(FLUSH, encoder.encode("PACK"));
    expect(parseReceivePackCommands(buf)).toEqual({
      ok: true,
      commands: [],
      consumed: 4,
    });
  });

  it("a truncated length is incomplete, a non-hex one is malformed", () => {
    expect(parseReceivePackCommands(encoder.encode("00"))).toEqual({
      ok: false,
      reason: "incomplete",
    });
    expect(parseReceivePackCommands(encoder.encode("zzzz"))).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("checkRefFence", () => {
  const command = (ref: string) => ({ oldSha: OLD, newSha: NEW, ref });

  it("accepts the exact ref and refuses another", () => {
    expect(checkRefFence([command(REF)], { exactRef: REF })).toEqual({
      ok: true,
      pushedSha: NEW,
    });
    expect(
      checkRefFence([command("refs/heads/main")], { exactRef: REF }),
    ).toEqual({ ok: false, reason: "ref_not_allowed", ref: "refs/heads/main" });
  });
});
