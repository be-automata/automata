import { z } from "zod";
import { buildTaggedFence } from "./tagged-fence";
import type {
  ReviewIntent,
  ReviewIntentComment,
} from "@terragon/review/state/review-intent-executor";

/**
 * Parse + validate the review intent an emit-only review skill produces as its
 * terminal output (ADR-036 single-writer channel, capture option (a)). The agent
 * has no gh-write outlet; it emits a fenced ```json block describing the verdict,
 * and the control-plane executor posts it exactly once.
 *
 * A malformed / absent intent is NOT a silent drop — the caller reports it as a
 * no-verdict notice + loud WorkFailed (see the executor wrapper, ADR-009). This
 * module only decides "is there a valid intent, and what is it".
 */

const findingSchema = z.object({
  severity: z.enum(["info", "warning", "error", "critical"]).optional(),
  path: z.string().min(1),
  line: z.number().int().nonnegative(),
  body: z.string().min(1),
  quote: z.string().optional(),
});

/** The wire shape the agent emits. Richer than the executor's ReviewIntent. */
export const emittedReviewIntentSchema = z.object({
  verdict: z.enum(["approve", "request_changes", "comment"]),
  /** The HEAD sha the agent reviewed — the stale-intent key (may differ from live HEAD). */
  commit: z.string().min(1),
  /** The verdict rationale / summary → the executor review body. */
  summary: z.string().min(1),
  /** Line-level findings → the executor's inline/folded comments. */
  findings: z.array(findingSchema).optional(),
  /** Informational: the resolved approve-severity floor (server already applied it). */
  severityFloor: z.string().optional(),
});

export type EmittedReviewIntent = z.infer<typeof emittedReviewIntentSchema>;

/**
 * The verdict value an agent emits when it could not review at all (no diff,
 * no git access, a truncated diff it will not guess from). It is a statement
 * that there is NO verdict, so it is deliberately not a member of the verdict
 * enum above and never reaches the executor (ADR-009).
 */
export const UNABLE_TO_REVIEW = "unable_to_review";

const unableToReviewIntentSchema = z.object({
  verdict: z.literal(UNABLE_TO_REVIEW),
  /** Why no review was possible, in the agent's words. */
  reason: z.string().min(1),
  /** Optional: an agent that cannot run git cannot name the commit. */
  commit: z.string().min(1).optional(),
});

export type ParseReviewIntentResult =
  | { ok: true; intent: EmittedReviewIntent }
  /** The control plane could not read a verdict out of the output. */
  | { ok: false; source: "parser"; reason: string }
  /** The agent said, in a well-formed intent, that it could not review. */
  | { ok: false; source: "agent"; reason: string; commit?: string };

/**
 * Extract the JSON payload from the agent's terminal text. Prefers the LAST
 * ```json fenced block (an earlier one may be an example in the skill echo);
 * falls back to the last balanced top-level `{…}` object. Returns null when no
 * candidate is present.
 */
function extractJsonPayload(text: string): string | null {
  const fenceRe = /```(?:json)?\s*\n([\s\S]*?)\n```/gi;
  let lastFence: string | null = null;
  for (const m of text.matchAll(fenceRe)) {
    if (m[1] && m[1].includes("{")) {
      lastFence = m[1].trim();
    }
  }
  if (lastFence) return lastFence;

  // Fallback: last balanced brace object.
  const start = text.lastIndexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return text.slice(start, end + 1);
  }
  return null;
}

/**
 * The fence info string the orchestrated github-ops render (phase 6) tells the
 * LEAD reviewer to put on its one final block: the opening fence line is three
 * backticks immediately followed by this string. Sub-agents are never given
 * it. Anti-drift-tested against SKILL.md (github-ops-review-mode.test.ts).
 */
export const REVIEW_INTENT_FENCE_INFO = "json review-intent";

const REVIEW_INTENT_FENCE = buildTaggedFence("review-intent");

/** Whether `text` contains a tagged `json review-intent` opener line. */
export function hasTaggedReviewIntentOpener(text: string): boolean {
  return REVIEW_INTENT_FENCE.hasOpener(text);
}

export interface ParseReviewIntentOptions {
  /**
   * Set ONLY for threads whose prompt was rendered orchestrated
   * (sourceMetadata.reviewPromptMode === "orchestrated"): the last tagged
   * block decides. Classic callers omit it and get today's behaviour
   * byte-for-byte.
   */
  preferTaggedIntent?: boolean;
}

type PayloadResult =
  | { payload: string | null }
  | { failure: ParseReviewIntentResult };

function extractTaggedPayload(text: string): PayloadResult | null {
  const extracted = REVIEW_INTENT_FENCE.extractLast(text);
  if (extracted === null) return null;
  if (!extracted.ok) {
    return {
      failure: {
        ok: false,
        source: "parser",
        reason: "tagged review-intent block is incomplete (no closing fence)",
      },
    };
  }
  return { payload: extracted.payload };
}

/**
 * Parse + validate the emitted review intent from the agent's terminal text.
 *
 * Two paths:
 * - Default (classic, and any caller without options): today's rule — the
 *   LAST ```json fence, else the last balanced brace object.
 * - `preferTaggedIntent` (orchestrated-prompt threads): the block after the
 *   LAST `json review-intent` opener decides, because a lead that echoes a
 *   sub-agent's fence after its own makes the sub-agent's fence the last one
 *   (Phase 2 Q7, q4sub). An unclosed or malformed tagged block is a parser
 *   failure — it never falls back to an untagged block, which may be a
 *   sub-agent's. With no opener in the text, today's rule applies.
 */
export function parseReviewIntent(
  text: string,
  options: ParseReviewIntentOptions = {},
): ParseReviewIntentResult {
  let payload: string | null;
  const tagged = options.preferTaggedIntent ? extractTaggedPayload(text) : null;
  if (tagged === null) {
    payload = extractJsonPayload(text);
  } else if ("failure" in tagged) {
    return tagged.failure;
  } else {
    payload = tagged.payload;
  }
  if (!payload) {
    return {
      ok: false,
      source: "parser",
      reason: "no JSON intent block found in agent output",
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch (err) {
    return {
      ok: false,
      source: "parser",
      reason: `intent JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Tried first and only on a well-formed block: a malformed `unable_to_review`
  // falls through to the verdict schema and is reported as a parse failure.
  const unable = unableToReviewIntentSchema.safeParse(raw);
  if (unable.success) {
    return {
      ok: false,
      source: "agent",
      reason: unable.data.reason,
      ...(unable.data.commit ? { commit: unable.data.commit } : {}),
    };
  }
  const parsed = emittedReviewIntentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      source: "parser",
      reason: `intent schema validation failed: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  }
  return { ok: true, intent: parsed.data };
}

/** Map the emitted (wire) intent to the executor's ReviewIntent. */
export function toExecutorIntent(emitted: EmittedReviewIntent): ReviewIntent {
  const comments: ReviewIntentComment[] | undefined = emitted.findings?.map(
    (f) => ({
      path: f.path,
      line: f.line,
      body: f.body,
      severity: f.severity,
      quote: f.quote,
    }),
  );
  return {
    verdict: emitted.verdict,
    body: emitted.summary,
    comments,
  };
}
