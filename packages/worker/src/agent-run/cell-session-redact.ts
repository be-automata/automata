import { redactSecrets } from "@terragon/utils/redact";
import { sha256Hex } from "@terragon/types/cell-session-checkpoint";

/**
 * Redaction for a Claude Code session transcript before it leaves the cell
 * (#743, spike 048 rule 4, OQ-2). It works per field from the parsed JSONL
 * line, never as one regex over the raw line, so the redacted file still
 * parses line by line and `--resume` reads it. Any failure throws: the caller
 * fails closed and writes nothing for that pull.
 */

export interface SessionRedactorInput {
  /** Exact values to blank: the owner's repo env values and the test-DB password. */
  values: Iterable<string>;
  /** The operator's email, as the harness recorded it. */
  operatorEmail?: string;
  /** Home paths of the operator (the image user's own `/home/agent` is not one by default). */
  homePaths?: readonly string[];
  /** Account and org UUIDs. */
  identityIds?: readonly string[];
  /** System-prompt texts, blanked wherever they are echoed. */
  systemPrompts?: readonly string[];
}

export interface RedactedLine {
  text: string;
  hits: number;
}

export interface SessionRedactor {
  /** sha256 of the rule names and sources; changes only when a rule is added. */
  digest: string;
  /** Redact one JSONL line. Throws on anything that is not a JSON value. */
  redactLine(line: string): RedactedLine;
}

export class SessionRedactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionRedactionError";
  }
}

const SYSTEM_PROMPT_KEYS = new Set([
  "systemPrompt",
  "system_prompt",
  "system",
  "appendSystemPrompt",
  "append_system_prompt",
  "customSystemPrompt",
]);
const ACCOUNT_KEYS = new Set(["accountUuid", "organizationUuid"]);
const MAX_DEPTH = 64;

/**
 * Exact-value blanking bar: a value of this length or more is blanked as a
 * substring (the bar cell-run.ts applies to log lines, as a literal there).
 * A shorter value (down to SHORT_VALUE_MIN) is blanked only as a whole token,
 * with a non-`[A-Za-z0-9_]` neighbour on both sides, so `POSTGRES_USER=user`
 * does not rewrite `userType`. Trade-off, on purpose: a short secret inside a
 * longer token is not blanked. A value under 8 characters is a weak secret,
 * and the pattern rules (keys, tokens, emails) still apply to it.
 */
const EXACT_VALUE_MIN_LENGTH = 8;
const SHORT_VALUE_MIN = 4;

/**
 * Transcript schema fields whose string values are never exact-value blanked,
 * at any depth: `normalize` and `--resume` read them. The pattern rules still
 * run on them. Object KEYS are never exact-blanked for these names either.
 */
const STRUCTURAL_KEYS = new Set([
  "type",
  "subtype",
  "role",
  "uuid",
  "parentUuid",
  "leafUuid",
  "sessionId",
  "id",
  "tool_use_id",
  "timestamp",
  "version",
  "cwd",
  "gitBranch",
  "isSidechain",
  "userType",
  "requestId",
  "model",
  "stop_reason",
]);

const SYSTEM_PROMPT_MARK = "[REDACTED:system-prompt]";
const ACCOUNT_MARK = "[REDACTED:account-id]";

const PATTERN_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["aws-access-key-id", /\bAKIA[0-9A-Z]{16}\b/g],
  [
    "private-key",
    /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,8192}?-----END [A-Z ]{0,40}PRIVATE KEY-----/g,
  ],
  // Bounded runs: an unbounded local part is quadratic on a long token-like
  // string with no "@", and a transcript holds megabytes of those.
  [
    "email",
    /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}/g,
  ],
  // The image user's own home is fixed by the image: not an identity.
  [
    "home-path",
    /\/(?:Users|home)\/(?!agent(?![A-Za-z0-9._-]))[A-Za-z0-9._-]+/g,
  ],
];

const RULES_DIGEST = sha256Hex(
  [
    ...PATTERN_RULES.map(([name, re]) => `${name}:${re.source}`),
    `system-prompt-keys:${[...SYSTEM_PROMPT_KEYS].join(",")}`,
    `account-keys:${[...ACCOUNT_KEYS].join(",")}`,
    "object-keys:redacted-like-values;collision-suffix:#n",
    "span-union:original-string;merge-touching;first-pattern-marker-wins;structural-values:long",
    `structural-keys:${[...STRUCTURAL_KEYS].join(",")}`,
    `exact-values:min=${EXACT_VALUE_MIN_LENGTH};whole-token-from=${SHORT_VALUE_MIN}`,
  ].join("\n"),
);

function countMarks(text: string): number {
  return text.split("<redacted>").length - 1;
}

export function createSessionRedactor(
  input: SessionRedactorInput,
): SessionRedactor {
  const exact = [
    ...input.values,
    ...(input.operatorEmail ? [input.operatorEmail] : []),
    ...(input.homePaths ?? []),
    ...(input.identityIds ?? []),
    ...(input.systemPrompts ?? []),
  ];
  const longBlanks = [
    ...new Set(
      exact
        .filter((v) => v.length >= EXACT_VALUE_MIN_LENGTH)
        .flatMap((v) => [v, JSON.stringify(v).slice(1, -1)]),
    ),
  ].sort((a, b) => b.length - a.length);
  const longRe =
    longBlanks.length > 0
      ? new RegExp(
          longBlanks
            .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("|"),
          "g",
        )
      : null;
  const shortValues = [
    ...new Set(
      exact.filter(
        (v) => v.length >= SHORT_VALUE_MIN && v.length < EXACT_VALUE_MIN_LENGTH,
      ),
    ),
  ];
  const shortBlanks = [
    ...new Set(shortValues.flatMap((v) => [v, JSON.stringify(v).slice(1, -1)])),
  ].sort((a, b) => b.length - a.length);
  const shortRe =
    shortBlanks.length > 0
      ? new RegExp(
          `(?<![A-Za-z0-9_])(?:${shortBlanks
            .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("|")})(?![A-Za-z0-9_])`,
          "g",
        )
      : null;

  /**
   * Span union on the ORIGINAL string: every pattern match and every exact
   * match is collected, overlapping or touching spans are merged, and a merged
   * span becomes the first pattern marker it contains, else `<redacted>`. No
   * rule can break another's match, so no fragment of either survives.
   */
  function redactString(
    text: string,
    exactValues: "all" | "long" | "none" = "all",
  ): RedactedLine {
    const spans: Array<[number, number, string | null]> = [];
    for (const [name, re] of PATTERN_RULES) {
      for (const m of text.matchAll(re)) {
        spans.push([m.index, m.index + m[0].length, `[REDACTED:${name}]`]);
      }
    }
    if (exactValues !== "none") {
      if (longRe) {
        for (const m of text.matchAll(longRe)) {
          spans.push([m.index, m.index + m[0].length, null]);
        }
      }
      if (exactValues === "all" && shortRe) {
        for (const m of text.matchAll(shortRe)) {
          spans.push([m.index, m.index + m[0].length, null]);
        }
      }
    }
    spans.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
    let out = "";
    let pos = 0;
    let hits = 0;
    for (let i = 0; i < spans.length; ) {
      let [start, end, marker] = spans[i] as [number, number, string | null];
      i += 1;
      while (
        i < spans.length &&
        (spans[i] as [number, number, string | null])[0] <= end
      ) {
        const [, e, mk] = spans[i] as [number, number, string | null];
        end = Math.max(end, e);
        marker ??= mk;
        i += 1;
      }
      out += text.slice(pos, start) + (marker ?? "<redacted>");
      pos = end;
      hits += 1;
    }
    out += text.slice(pos);
    // Shared secret patterns (tokens, bearer) run last on what remains.
    const final = redactSecrets(out);
    hits += countMarks(final) - countMarks(out);
    return { text: final, hits };
  }

  function walk(
    value: unknown,
    depth: number,
    structural = false,
  ): { value: unknown; hits: number } {
    if (depth > MAX_DEPTH) {
      throw new SessionRedactionError("line nests too deeply");
    }
    if (typeof value === "string") {
      const r = redactString(value, structural ? "long" : "all");
      return { value: r.text, hits: r.hits };
    }
    if (Array.isArray(value)) {
      let hits = 0;
      const items = value.map((item) => {
        const r = walk(item, depth + 1);
        hits += r.hits;
        return r.value;
      });
      return { value: items, hits };
    }
    if (value !== null && typeof value === "object") {
      let hits = 0;
      // No prototype: a parsed "__proto__" key is an own property, not a
      // prototype assignment that JSON.stringify then drops.
      const out: Record<string, unknown> = Object.create(null);
      for (const [key, item] of Object.entries(value)) {
        // Keys are transcript text too: pattern-redacted, and exact-blanked
        // only for long values and never for schema names, so a short env value
        // never renames a schema key. Two keys that redact to the same
        // string both survive (second gets "#n").
        const rk = redactString(
          key,
          STRUCTURAL_KEYS.has(key) ? "none" : "long",
        );
        hits += rk.hits;
        let outKey = rk.text;
        for (let n = 2; Object.hasOwn(out, outKey); n += 1) {
          outKey = `${rk.text}#${n}`;
        }
        if (SYSTEM_PROMPT_KEYS.has(key)) {
          out[outKey] = SYSTEM_PROMPT_MARK;
          hits += 1;
        } else if (ACCOUNT_KEYS.has(key) && typeof item === "string") {
          out[outKey] = ACCOUNT_MARK;
          hits += 1;
        } else {
          const r = walk(item, depth + 1, STRUCTURAL_KEYS.has(key));
          hits += r.hits;
          out[outKey] = r.value;
        }
      }
      return { value: out, hits };
    }
    return { value, hits: 0 };
  }

  return {
    digest: RULES_DIGEST,
    redactLine(line) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new SessionRedactionError("transcript line is not valid JSON");
      }
      const r = walk(parsed, 0);
      return { text: JSON.stringify(r.value), hits: r.hits };
    },
  };
}
