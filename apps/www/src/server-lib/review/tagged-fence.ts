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
