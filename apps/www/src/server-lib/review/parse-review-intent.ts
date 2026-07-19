import { z } from "zod";
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
 * A malformed / absent intent is NOT a silent drop — the caller degrades to a
 * marked COMMENT review + loud WorkFailed (see the executor wrapper). This module
 * only decides "is there a valid intent, and what is it".
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

export type ParseReviewIntentResult =
  | { ok: true; intent: EmittedReviewIntent }
  | { ok: false; reason: string };

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

/** Parse + validate the emitted review intent from the agent's terminal text. */
export function parseReviewIntent(text: string): ParseReviewIntentResult {
  const payload = extractJsonPayload(text);
  if (!payload) {
    return { ok: false, reason: "no JSON intent block found in agent output" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch (err) {
    return {
      ok: false,
      reason: `intent JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed = emittedReviewIntentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
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
