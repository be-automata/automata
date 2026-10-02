import { z } from "zod";

/**
 * Parse + validate the audit intent the emit-only post-merge skill produces as
 * its terminal output (ADR-008). The agent holds no GitHub-write outlet and no
 * tracker token; it emits one fenced ```json block and the control-plane
 * executor (execute-merge-audit.ts) does every write.
 *
 * The intent carries JUDGEMENT only — a verdict per acceptance criterion. It
 * never names a stage, a transition, or a comment target: those are decided
 * server-side from data the control plane fetched itself.
 */

export const MERGE_AUDIT_INTENT_KIND = "pr-merged-audit";

const VERDICTS = ["met", "partial", "not_met", "not_verifiable"] as const;
export type CriterionVerdict = (typeof VERDICTS)[number];

/**
 * Length limits TRUNCATE; they never reject. One over-long `evidence` string
 * or a 41st criterion must not turn a complete audit into "no usable result".
 */
const clipped = (max: number) =>
  z.string().transform((value) => value.slice(0, max));
const requiredClipped = (max: number) =>
  z
    .string()
    .min(1)
    .transform((value) => value.slice(0, max));

const MAX_CRITERIA = 40;
const MAX_DEVIATIONS = 20;
const MAX_INTENT_TICKETS = 10;

const criterionSchema = z.object({
  /** `AC-1`, `DoD-2`, `Scope-1` … as labelled in the ticket. */
  id: requiredClipped(40),
  text: requiredClipped(600),
  verdict: z.enum(VERDICTS),
  /** `path:line`, a test name, or one line on why it could not be verified. */
  evidence: clipped(600).optional(),
  /**
   * Verbatim quote showing the miss was consciously accepted (PR body or a
   * ticket comment). Present only on `partial` / `not_met` criteria.
   */
  acceptedBy: clipped(400).optional(),
  /** Follow-up ticket key or PR reference named alongside the acceptance. */
  followUp: clipped(200).optional(),
});

const deviationSchema = z.object({
  summary: requiredClipped(400),
  /** True when the PR body or a ticket comment explicitly calls it out. */
  acknowledged: z.boolean(),
  followUp: clipped(200).optional(),
});

const ticketSchema = z.object({
  key: requiredClipped(40),
  /**
   * `formal`   — a `## Acceptance Criteria` section was audited;
   * `fallback` — no formal AC, audited against summary/description/checkboxes;
   * `none`     — nothing auditable was found.
   */
  acSource: z.enum(["formal", "fallback", "none"]),
  criteria: z
    .array(criterionSchema)
    .transform((criteria) => criteria.slice(0, MAX_CRITERIA)),
  /** False when a multi-PR / multi-repo roadmap still has pending items. */
  taskComplete: z.boolean(),
  /** What is still outstanding when `taskComplete` is false. */
  remaining: clipped(400).optional(),
  deviations: z
    .array(deviationSchema)
    .transform((deviations) => deviations.slice(0, MAX_DEVIATIONS))
    .optional(),
});

export const mergeAuditIntentSchema = z.object({
  kind: z.literal(MERGE_AUDIT_INTENT_KIND),
  pr: z.number().int().positive(),
  tickets: z
    .array(ticketSchema)
    .transform((tickets) => tickets.slice(0, MAX_INTENT_TICKETS)),
});

export type MergeAuditIntent = z.infer<typeof mergeAuditIntentSchema>;
export type MergeAuditTicket = z.infer<typeof ticketSchema>;
export type MergeAuditCriterion = z.infer<typeof criterionSchema>;
export type MergeAuditDeviation = z.infer<typeof deviationSchema>;

export type ParseMergeAuditIntentResult =
  | { ok: true; intent: MergeAuditIntent }
  | { ok: false; reason: string };

/**
 * The LAST fenced block that mentions the intent kind. Earlier blocks may be
 * the skill's own example echoed back, or JSON the agent quoted from a diff —
 * only the final one is the verdict.
 *
 * Fences are paired by walking lines, not with one regex over the whole text:
 * a regex cannot tell an opening fence from a closing one, so a `bash` block
 * ahead of the intent makes it pair that block's CLOSING fence with the
 * intent's OPENING fence and never capture the JSON at all.
 */
function extractIntentPayload(text: string): string | null {
  let last: string | null = null;
  let open: { language: string; lines: string[] } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const fence = /^\s*```\s*([A-Za-z0-9_-]*)\s*$/.exec(line);
    if (open === null) {
      if (fence) open = { language: (fence[1] ?? "").toLowerCase(), lines: [] };
      continue;
    }
    if (fence && fence[1] === "") {
      const block = open.lines.join("\n");
      if (
        (open.language === "json" || open.language === "") &&
        block.includes(MERGE_AUDIT_INTENT_KIND)
      ) {
        last = block.trim();
      }
      open = null;
      continue;
    }
    open.lines.push(line);
  }
  return last;
}

export function parseMergeAuditIntent(
  text: string,
): ParseMergeAuditIntentResult {
  const payload = extractIntentPayload(text);
  if (!payload) {
    return { ok: false, reason: "no audit intent block found in agent output" };
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
  const parsed = mergeAuditIntentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `intent schema validation failed: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    };
  }
  return { ok: true, intent: parsed.data };
}
