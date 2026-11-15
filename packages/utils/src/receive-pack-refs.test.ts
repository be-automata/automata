import { describe, expect, it } from "vitest";

import {
  checkRefFence,
  isBranchRef,
  parseReceivePackCommands,
} from "./receive-pack-refs";

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

describe("parseReceivePackCommands (plain Uint8Array input)", () => {
  it("parses one update with capabilities and reports where the PACK starts", () => {
    const oldSha = "1".repeat(40);
    const newSha = "a".repeat(40);
    const ref = "refs/heads/feat/x";
    const commandSection = concat(
      pkt(`${oldSha} ${newSha} ${ref}\0report-status side-band-64k\n`),
      encoder.encode("0000"),
    );
    const buf = concat(commandSection, encoder.encode("PACK"));
    expect(parseReceivePackCommands(buf)).toEqual({
      ok: true,
      commands: [{ oldSha, newSha, ref }],
      consumed: commandSection.length,
    });
  });
});

describe("isBranchRef", () => {
  it.each([
    "refs/heads/automata/task-1a2b3c4d",
    "refs/heads/automata/fix-abc.1",
    "refs/heads/feat/x",
    "refs/heads/main",
    "refs/heads/HEAD2",
    "refs/heads/feat/caf\u00e9-\u{1f680}",
  ])("accepts %s", (ref) => {
    expect(isBranchRef(ref)).toBe(true);
  });

  it.each([
    "feat/x",
    "refs/tags/v1",
    "refs/heads/",
    "refs/heads/a..b",
    "refs/heads/a.lock",
    "refs/heads/a.lock/b",
    "refs/heads/.hidden",
    "refs/heads/a/.b",
    "refs/heads/a\u0007b",
    "refs/heads/a b",
    "refs/heads/a~1",
    "refs/heads/a^",
    "refs/heads/a:b",
    "refs/heads/a?",
    "refs/heads/a*",
    "refs/heads/a[0]",
    "refs/heads/a\\b",
    "refs/heads/a@{1}",
    "refs/heads/@",
    "refs/heads//a",
    "refs/heads/a//b",
    "refs/heads/a/",
    "refs/heads/a.",
    "refs/heads/-x",
    "refs/heads/HEAD",
    "refs/heads/a\u007f",
    "refs/heads/a\ufffd",
    "refs/heads/a\ud800",
  ])("refuses %j", (ref) => {
    expect(isBranchRef(ref)).toBe(false);
  });
});

describe("checkRefFence with no fence", () => {
  const command = {
    oldSha: "1".repeat(40),
    newSha: "a".repeat(40),
    ref: "refs/heads/x",
  };

  it("refuses a non-empty command list with no_ref_fence", () => {
    expect(checkRefFence([command], null)).toEqual({
      ok: false,
      reason: "no_ref_fence",
    });
  });

  it("keeps no_commands for an empty list", () => {
    expect(checkRefFence([], null)).toEqual({
      ok: false,
      reason: "no_commands",
    });
  });
});
