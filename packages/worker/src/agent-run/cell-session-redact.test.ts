import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createSessionRedactor,
  SessionRedactionError,
} from "./cell-session-redact";

const FIXTURE = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "__fixtures__/cell-session.jsonl",
  ),
  "utf8",
);

export const CANARIES = [
  "CANARY-EMAIL@example.invalid",
  "/home/agent",
  "00000000-0000-4000-8000-0000000000a1",
  "00000000-0000-4000-8000-0000000000b2",
  "sk-ant-api03-CANARYCANARYCANARYCANARY00",
  "CANARY-SYSTEM-PROMPT",
  "CANARY-REPO-ENV-VALUE-123",
  "CANARY-DB-PASSWORD-456",
];

// A user line is a counted turn only while it still has type "user" and text.
function normalizeTurnsOf(line: string): number {
  const p = JSON.parse(line) as {
    type?: string;
    message?: { content?: unknown };
  };
  return p.type === "user" && typeof p.message?.content === "string" ? 1 : 0;
}

function redactor() {
  return createSessionRedactor({
    values: ["CANARY-REPO-ENV-VALUE-123", "CANARY-DB-PASSWORD-456"],
    operatorEmail: "CANARY-EMAIL@example.invalid",
    homePaths: ["/home/agent"],
    identityIds: [
      "00000000-0000-4000-8000-0000000000a1",
      "00000000-0000-4000-8000-0000000000b2",
    ],
    systemPrompts: ["CANARY-SYSTEM-PROMPT: synthetic instructions"],
  });
}

describe("session redactor", () => {
  // card: protects=#743 the redactor stays linear on hostile lines (a BEGIN with no END repeated, a long word-boundary run) while a real-sized key is still scrubbed; fails_when=a lazy unbounded body or an unbounded scheme is reintroduced; no_claim=keys over 8 KB
  it("stays linear on hostile lines, and still scrubs a real-sized private key", () => {
    const r = redactor();
    const hostile = [
      "-----BEGIN PRIVATE KEY-----".repeat(30_000),
      "a-".repeat(500_000) + "@",
    ];
    for (const text of hostile) {
      const started = Date.now();
      r.redactLine(JSON.stringify({ a: text }));
      expect(Date.now() - started).toBeLessThan(1000);
    }
    const key = `-----BEGIN RSA PRIVATE KEY-----\n${"A".repeat(3200)}\n-----END RSA PRIVATE KEY-----`;
    const out = r.redactLine(JSON.stringify({ a: key })).text;
    expect(out).not.toContain("A".repeat(64));
  });

  it("the fixture really carries every canary", () => {
    for (const canary of CANARIES) expect(FIXTURE).toContain(canary);
  });

  it("leaves no canary and keeps every line parseable", () => {
    const r = redactor();
    const lines = FIXTURE.split("\n").filter(Boolean);
    const out = lines.map((l) => r.redactLine(l));
    const joined = out.map((o) => o.text).join("\n");
    for (const canary of CANARIES) expect(joined).not.toContain(canary);
    for (const o of out) expect(() => JSON.parse(o.text)).not.toThrow();
    expect(out.reduce((n, o) => n + o.hits, 0)).toBeGreaterThan(6);
  });

  it("keeps the line shape: ids, cwd and the parent chain survive", () => {
    const r = redactor();
    const first = JSON.parse(
      r.redactLine(FIXTURE.split("\n")[0] as string).text,
    ) as Record<string, unknown>;
    expect(first.systemPrompt).toBe("[REDACTED:system-prompt]");
    expect(first.uuid).toBe("00000000-0000-4000-8000-000000000001");
    expect(first.cwd).toBe("/workspace");
    expect((first.account as Record<string, unknown>).accountUuid).toBe(
      "[REDACTED:account-id]",
    );
  });

  it("redacts an operator home path but not the image user's own home", () => {
    const r = createSessionRedactor({ values: [] });
    const line = JSON.stringify({
      a: "/Users/jane/x /home/bob/y /home/agent/z /home/agent2/w",
    });
    const text = (JSON.parse(r.redactLine(line).text) as { a: string }).a;
    expect(text).toBe(
      "[REDACTED:home-path]/x [REDACTED:home-path]/y /home/agent/z [REDACTED:home-path]/w",
    );
  });

  it("redacts AWS ids and PEM blocks that span newlines inside a field", () => {
    const r = createSessionRedactor({ values: [] });
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----";
    const out = r.redactLine(
      JSON.stringify({ k: ["AKIAABCDEFGHIJKLMNOP", pem, 7, null, true] }),
    );
    const k = (JSON.parse(out.text) as { k: unknown[] }).k;
    expect(k).toEqual([
      "[REDACTED:aws-access-key-id]",
      "[REDACTED:private-key]",
      7,
      null,
      true,
    ]);
  });

  it("counts the exact-value and pattern passes", () => {
    const r = createSessionRedactor({ values: ["hunter2hunter2"] });
    const out = r.redactLine(
      JSON.stringify({ a: "pw hunter2hunter2 and ghp_abcdefgh12345678" }),
    );
    expect(out.hits).toBe(2);
  });

  it("an account key that is not a string is walked, not blanked", () => {
    const r = createSessionRedactor({ values: [] });
    const out = r.redactLine(JSON.stringify({ accountUuid: { n: 1 } }));
    expect(JSON.parse(out.text)).toEqual({ accountUuid: { n: 1 } });
  });

  it("redacts object keys and keeps colliding keys distinct", () => {
    const line = JSON.stringify({
      "CANARY-EMAIL@example.invalid": 1,
      "sk-ant-api03-CANARYCANARYCANARYCANARY00": { x: 2 },
      "CANARY-DB-PASSWORD-456": 3,
    });
    const out = redactor().redactLine(line);
    for (const c of CANARIES) expect(out.text).not.toContain(c);
    const parsed = JSON.parse(out.text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toHaveLength(3);
    expect(Object.values(parsed)).toEqual([1, { x: 2 }, 3]);
    expect(out.hits).toBeGreaterThanOrEqual(3);
  });

  it("throws on a line that is not JSON", () => {
    expect(() => redactor().redactLine("{not json")).toThrow(
      SessionRedactionError,
    );
  });

  it("throws on a pathologically deep line", () => {
    const deep = `${"[".repeat(100)}${"]".repeat(100)}`;
    expect(() => redactor().redactLine(deep)).toThrow(/nests too deeply/);
  });

  // card: protects=#743 finding 2: a short repo env value (`user`, `test`) never rewrites schema keys or structural values, so normalize still counts the turn; fails_when=exact-value blanking reaches keys or structural fields again; no_claim=a short secret inside a longer token is blanked
  it("short env values leave the transcript schema alone", () => {
    const r = createSessionRedactor({ values: ["user", "test"] });
    const line = JSON.stringify({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000002",
      userType: "external",
      role: "user",
      message: { role: "user", content: "run pnpm test as user, userType ok" },
    });
    const out = r.redactLine(line);
    const parsed = JSON.parse(out.text) as Record<string, unknown>;
    expect(parsed.type).toBe("user");
    expect(Object.keys(parsed)).toEqual([
      "type",
      "uuid",
      "userType",
      "role",
      "message",
    ]);
    expect(parsed.role).toBe("user");
    expect(parsed.message).toEqual({
      role: "user",
      content: "run pnpm <redacted> as <redacted>, userType ok",
    });
    expect(normalizeTurnsOf(out.text)).toBe(1);
  });

  it("blanks a 12-character env value inside content", () => {
    const r = createSessionRedactor({ values: ["abcdefghijkl"] });
    const out = r.redactLine(JSON.stringify({ a: "x abcdefghijkl-y" })).text;
    expect(JSON.parse(out)).toEqual({ a: "x <redacted>-y" });
  });

  // card: protects=#743 round 3 finding 2: a long env secret echoed under a structural key (`id`) is blanked; fails_when=structural strings skip exact-value blanking again; no_claim=short values under structural keys
  it("blanks a long env value under a structural key, keeps type", () => {
    const secret = "tok_live_abcdefgh12345678";
    const r = createSessionRedactor({ values: [secret, "user"] });
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "tool_use", id: secret, input: { id: secret, q: "x" } },
        ],
      },
    });
    const out = r.redactLine(line).text;
    expect(out).not.toContain(secret);
    expect(JSON.parse(out).type).toBe("user");
  });

  // card: protects=#743 round 3 finding 3: pattern and exact matches are unioned on the original string, so neither hides the other's span; fails_when=one rule runs before the other and leaves a fragment; no_claim=exact values under 4 characters
  it("leaves no fragment when a pattern and an exact span overlap", () => {
    const sec = createSessionRedactor({ values: ["pw-bob@x.com-zzz"] });
    const o1 = sec.redactLine(JSON.stringify({ a: "k pw-bob@x.com-zzz k" }));
    for (const f of ["pw-", "bob", "x.com", "zzz"]) {
      expect(o1.text).not.toContain(f);
    }
    const cases: Array<[string, string, string]> = [
      ["example", "alice@example.com", "alice"],
      ["example.com", "alice@example.com", "alice"],
      ["Users", "/Users/alice/x", "alice"],
    ];
    for (const [env, text, leak] of cases) {
      const out = createSessionRedactor({ values: [env] }).redactLine(
        JSON.stringify({ a: text }),
      ).text;
      expect(out).not.toContain(leak);
    }
  });

  it("an exact value cannot mangle a redaction marker", () => {
    const r = createSessionRedactor({
      values: ["REDACTED", "EMAIL", "email", "home-path"],
    });
    const out = JSON.parse(
      r.redactLine(JSON.stringify({ a: "bob@corp.io /home/bob" })).text,
    ) as { a: string };
    expect(out.a).toBe("[REDACTED:email] [REDACTED:home-path]");
  });

  it("round-trips a parsed __proto__ key", () => {
    const out = createSessionRedactor({ values: [] }).redactLine(
      '{"a":{"__proto__":{"x":1}}}',
    ).text;
    expect(out).toBe('{"a":{"__proto__":{"x":1}}}');
  });

  // Re-pinned deliberately for #743 round 3: rules ADDED (span union of pattern and exact matches, long-mode structural values), none removed.
  it("pins the rules digest: rules may be added, never removed", () => {
    expect(redactor().digest).toBe(
      "9f98cc3fb5771f97d95d6ab03a3b0e5bd6ec8bec79c78233d0039b2f70d95165",
    );
  });
});
