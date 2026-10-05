import { describe, expect, it } from "vitest";

import {
  checkRefFence,
  parseReceivePackCommands,
  RECEIVE_PACK_ZERO_SHA,
  type ReceivePackCommand,
} from "./receive-pack-refs";

const OLD = "1".repeat(40);
const NEW = "a".repeat(40);
const NEW2 = "b".repeat(40);
const BRANCH = "refs/heads/automata/fix-12-deadbeef-a1";

/** One pkt-line: 4 hex digits of total length (prefix included), then the payload. */
function pkt(payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  return Buffer.concat([
    Buffer.from((body.length + 4).toString(16).padStart(4, "0"), "ascii"),
    body,
  ]);
}

const FLUSH = Buffer.from("0000", "ascii");
const PACK = Buffer.from("PACK\u0000\u0000\u0000\u0002binary-pack-bytes");

/**
 * The command section exactly as `git send-pack` writes it over smart HTTP:
 * the first command carries the capability list after a NUL, later ones do
 * not, none ends in LF, and a flush-pkt separates it from the PACK.
 */
function gitPushBody(
  commands: Array<[string, string, string]>,
  opts: { shallow?: string[] } = {},
): Buffer {
  const lines = (opts.shallow ?? []).map((sha) => pkt(`shallow ${sha}`));
  commands.forEach(([oldSha, newSha, ref], i) => {
    lines.push(
      pkt(
        i === 0
          ? `${oldSha} ${newSha} ${ref}\u0000 report-status side-band-64k quiet object-format=sha1 agent=git/2.53.0`
          : `${oldSha} ${newSha} ${ref}`,
      ),
    );
  });
  return Buffer.concat([...lines, FLUSH, PACK]);
}

describe("parseReceivePackCommands", () => {
  it("parses a real git push command list (one update, caps after NUL)", () => {
    const body = gitPushBody([[OLD, NEW, BRANCH]]);
    const parsed = parseReceivePackCommands(body);
    expect(parsed).toEqual({
      ok: true,
      commands: [{ oldSha: OLD, newSha: NEW, ref: BRANCH }],
      consumed: body.length - PACK.length,
    });
    // `consumed` points exactly at the first PACK byte.
    if (parsed.ok) {
      expect(body.subarray(parsed.consumed).equals(PACK)).toBe(true);
    }
  });

  it("parses two updates (the second has no caps)", () => {
    const parsed = parseReceivePackCommands(
      gitPushBody([
        [OLD, NEW, BRANCH],
        [OLD, NEW2, "refs/heads/main"],
      ]),
    );
    expect(parsed.ok && parsed.commands).toEqual([
      { oldSha: OLD, newSha: NEW, ref: BRANCH },
      { oldSha: OLD, newSha: NEW2, ref: "refs/heads/main" },
    ]);
  });

  it("accepts a trailing LF on a command line", () => {
    const body = Buffer.concat([pkt(`${OLD} ${NEW} ${BRANCH}\n`), FLUSH]);
    const parsed = parseReceivePackCommands(body);
    expect(parsed.ok && parsed.commands).toEqual([
      { oldSha: OLD, newSha: NEW, ref: BRANCH },
    ]);
  });

  it("skips the shallow lines a push from a shallow clone sends first", () => {
    const parsed = parseReceivePackCommands(
      gitPushBody([[OLD, NEW, BRANCH]], { shallow: ["c".repeat(40)] }),
    );
    expect(parsed.ok && parsed.commands).toEqual([
      { oldSha: OLD, newSha: NEW, ref: BRANCH },
    ]);
  });

  it("parses sha256 object names (64 hex)", () => {
    const old256 = "1".repeat(64);
    const new256 = "f".repeat(64);
    const parsed = parseReceivePackCommands(
      Buffer.concat([pkt(`${old256} ${new256} ${BRANCH}`), FLUSH]),
    );
    expect(parsed.ok && parsed.commands).toEqual([
      { oldSha: old256, newSha: new256, ref: BRANCH },
    ]);
  });

  it("an empty command list (bare flush) parses to zero commands", () => {
    expect(parseReceivePackCommands(FLUSH)).toEqual({
      ok: true,
      commands: [],
      consumed: 4,
    });
  });

  it("a truncated length prefix → ok:false (incomplete)", () => {
    expect(parseReceivePackCommands(Buffer.from("00", "ascii"))).toEqual({
      ok: false,
      reason: "incomplete",
    });
  });

  it("a pkt-line whose payload has not fully arrived → incomplete", () => {
    const line = pkt(`${OLD} ${NEW} ${BRANCH}`);
    expect(parseReceivePackCommands(line.subarray(0, 20))).toEqual({
      ok: false,
      reason: "incomplete",
    });
    // Complete line but no flush yet: still incomplete, never "ok".
    expect(parseReceivePackCommands(line)).toEqual({
      ok: false,
      reason: "incomplete",
    });
  });

  it("malformed command lists are rejected", () => {
    const cases: Buffer[] = [
      Buffer.from("zzzz", "ascii"), // non-hex length
      Buffer.from("0003", "ascii"), // impossible length (1..3)
      Buffer.from("0001", "ascii"), // delim-pkt is not v0 receive-pack
      Buffer.concat([pkt(`${OLD} ${NEW}`), FLUSH]), // no ref
      Buffer.concat([pkt(`${OLD.slice(1)} ${NEW} ${BRANCH}`), FLUSH]), // short sha
      Buffer.concat([pkt(`${OLD} ${"g".repeat(40)} ${BRANCH}`), FLUSH]), // non-hex
      Buffer.concat([pkt(`${OLD} ${"a".repeat(64)} ${BRANCH}`), FLUSH]), // mixed widths
      Buffer.concat([pkt(`${OLD} ${NEW} refs/heads/a b`), FLUSH]), // space in ref
      Buffer.concat([pkt(`${OLD} ${NEW} `), FLUSH]), // empty ref
      Buffer.concat([pkt("push-cert\u0000 report-status"), FLUSH]), // signed push
      Buffer.concat([
        pkt(`${OLD} ${NEW} ${BRANCH}`),
        pkt(`shallow ${"c".repeat(40)}`), // shallow after a command
        FLUSH,
      ]),
      Buffer.concat([
        pkt(`${OLD} ${NEW} ${BRANCH}`),
        pkt(`${OLD} ${NEW} ${BRANCH}\u0000 caps-again`), // NUL on a later line
        FLUSH,
      ]),
    ];
    for (const body of cases) {
      expect(parseReceivePackCommands(body), body.toString("latin1")).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });
});

describe("checkRefFence", () => {
  const fence = { exactRef: BRANCH };
  const cmd = (ref: string, newSha = NEW): ReceivePackCommand => ({
    oldSha: OLD,
    newSha,
    ref,
  });

  it("the exact attempt branch passes and reports the pushed sha", () => {
    expect(checkRefFence([cmd(BRANCH)], fence)).toEqual({
      ok: true,
      pushedSha: NEW,
    });
  });

  it("a branch create (old sha all zeros) is allowed", () => {
    expect(
      checkRefFence(
        [{ oldSha: RECEIVE_PACK_ZERO_SHA, newSha: NEW, ref: BRANCH }],
        fence,
      ),
    ).toEqual({ ok: true, pushedSha: NEW });
  });

  it("refs/heads/main → ref_not_allowed", () => {
    expect(checkRefFence([cmd("refs/heads/main")], fence)).toEqual({
      ok: false,
      reason: "ref_not_allowed",
      ref: "refs/heads/main",
    });
  });

  it("another fix branch → ref_not_allowed", () => {
    expect(
      checkRefFence([cmd("refs/heads/automata/fix-other")], fence),
    ).toMatchObject({ ok: false, reason: "ref_not_allowed" });
  });

  it("near-misses of the exact ref are refused", () => {
    for (const ref of [
      "refs/tags/v1",
      `${BRANCH}x`,
      `${BRANCH}/nested`,
      BRANCH.toUpperCase(),
      "automata/fix-12-deadbeef-a1",
      "refs/heads/automata/fix-12-deadbeef-a2",
    ]) {
      expect(checkRefFence([cmd(ref)], fence), ref).toMatchObject({
        ok: false,
        reason: "ref_not_allowed",
      });
    }
  });

  it("new sha all zeros (sha1 or sha256) → delete_not_allowed", () => {
    for (const zero of [RECEIVE_PACK_ZERO_SHA, "0".repeat(64)]) {
      expect(checkRefFence([cmd(BRANCH, zero)], fence)).toEqual({
        ok: false,
        reason: "delete_not_allowed",
        ref: BRANCH,
      });
    }
  });

  it("one good + one bad update → the whole push is rejected", () => {
    expect(
      checkRefFence([cmd(BRANCH), cmd("refs/heads/main", NEW2)], fence),
    ).toMatchObject({ ok: false, reason: "ref_not_allowed" });
    expect(
      checkRefFence([cmd("refs/heads/main", NEW2), cmd(BRANCH)], fence),
    ).toMatchObject({ ok: false, reason: "ref_not_allowed" });
  });

  it("two updates of the exact branch: the last new sha is the pushed one", () => {
    expect(checkRefFence([cmd(BRANCH), cmd(BRANCH, NEW2)], fence)).toEqual({
      ok: true,
      pushedSha: NEW2,
    });
  });

  it("an empty list → no_commands", () => {
    expect(checkRefFence([], fence)).toEqual({
      ok: false,
      reason: "no_commands",
    });
  });
});
