import { createValueRedactor } from "@terragon/utils/redact";
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
  const scrub = createValueRedactor(exact);

  function redactString(text: string): RedactedLine {
    let hits = 0;
    let out = scrub(text);
    hits += countMarks(out) - countMarks(text);
    for (const [name, re] of PATTERN_RULES) {
      out = out.replace(re, () => {
        hits += 1;
        return `[REDACTED:${name}]`;
      });
    }
    return { text: out, hits };
  }

  function walk(
    value: unknown,
    depth: number,
  ): { value: unknown; hits: number } {
    if (depth > MAX_DEPTH) {
      throw new SessionRedactionError("line nests too deeply");
    }
    if (typeof value === "string") {
      const r = redactString(value);
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
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        if (SYSTEM_PROMPT_KEYS.has(key)) {
          out[key] = SYSTEM_PROMPT_MARK;
          hits += 1;
        } else if (ACCOUNT_KEYS.has(key) && typeof item === "string") {
          out[key] = ACCOUNT_MARK;
          hits += 1;
        } else {
          const r = walk(item, depth + 1);
          hits += r.hits;
          out[key] = r.value;
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
