import type { z } from "zod";

/**
 * Tagged-fence helper shared by the review lane (`json review-intent`) and the
 * audit lane. A tagged block opens with a WHOLE fence line at a line start:
 * three backticks, `json`, spaces/tabs, the tag, optional trailing
 * spaces/tabs, optional CR, LF. Mid-line mentions in prose are not openers.
 * The LAST opener decides, and it must be closed by a line that is exactly
 * three backticks.
 */

const TAG_RE = /^[a-z][a-z0-9-]{0,40}$/;
/** A closing fence: a line that is exactly three backticks. */
const TAGGED_CLOSE_RE = /(?:^|\r?\n)```(?=[ \t]*(?:\r?\n|$))/;

export type TaggedExtraction =
  | { ok: true; payload: string }
  | { ok: false; reason: string }
  | null;

export interface TaggedFence {
  /** The tag after `json` on the opener line (also the payload's `kind`). */
  info: string;
  openerRe: RegExp;
  hasOpener(text: string): boolean;
  /** null = no tagged opener; ok:false = opener present but never closed. */
  extractLast(text: string): TaggedExtraction;
}

export function buildTaggedFence(info: string): TaggedFence {
  if (!TAG_RE.test(info)) {
    throw new Error(`invalid tagged fence info: ${JSON.stringify(info)}`);
  }
  const openerRe = new RegExp(
    `(?:^|\\n)\`\`\`json[ \\t]+${info}[ \\t]*\\r?\\n`,
  );

  function findLastOpenerEnd(text: string): number {
    const scan = new RegExp(openerRe.source, "g");
    let end = -1;
    let match: RegExpExecArray | null;
    while ((match = scan.exec(text)) !== null) {
      end = match.index + match[0].length;
      // Let the opener's trailing LF serve as the next opener's leading LF.
      scan.lastIndex = end - 1;
    }
    return end;
  }

  return {
    info,
    openerRe,
    hasOpener: (text) => openerRe.test(text),
    extractLast(text) {
      const bodyStart = findLastOpenerEnd(text);
      if (bodyStart < 0) return null;
      const rest = text.slice(bodyStart);
      const close = TAGGED_CLOSE_RE.exec(rest);
      if (!close) {
        return {
          ok: false,
          reason: `tagged ${info} block is incomplete (no closing fence)`,
        };
      }
      return { ok: true, payload: rest.slice(0, close.index).trim() };
    },
  };
}

/** Untagged ```json fences, the fallback when the agent dropped the tag. */
const PLAIN_JSON_FENCE = /```json[ \t]*\r?\n([\s\S]*?)\r?\n```/g;

export type ParseTaggedJsonResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

/**
 * An emit-only lane's terminal block (the mention and companion lanes): the
 * LAST tagged `json <info>` block decides; without one, the last plain
 * ```json block naming `"<info>"` (an agent that forgot the tag still gets
 * its block read). The payload is then JSON-parsed and schema-validated;
 * every failure is a reason, never a throw.
 */
export function parseTaggedJsonBlock<T>(
  text: string,
  fence: TaggedFence,
  schema: z.ZodType<T>,
): ParseTaggedJsonResult<T> {
  const kind = fence.info;
  let payload: string | null = null;
  const tagged = fence.extractLast(text);
  if (tagged !== null) {
    if (!tagged.ok) return { ok: false, reason: tagged.reason };
    payload = tagged.payload;
  } else {
    for (const match of text.matchAll(PLAIN_JSON_FENCE)) {
      const candidate = match[1]?.trim() ?? "";
      if (candidate.includes(`"${kind}"`)) payload = candidate;
    }
  }
  if (payload === null) {
    return { ok: false, reason: `no ${kind} block in agent output` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch (error) {
    return {
      ok: false,
      reason: `${kind} JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `${kind} schema validation failed: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    };
  }
  return { ok: true, value: parsed.data };
}
