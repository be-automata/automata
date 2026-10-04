/**
 * The pinned self-heal decision log (LOG-01, OBS-01). One line and one product
 * analytics event per decision, both carrying exactly the same seven ids and
 * enums. Nothing free-form ever reaches either: no issue title, plan text,
 * subject or path, so a publicSafe=false rule cannot leak through the log.
 * Operators and the acceptance script grep this format; change it only with a
 * version bump of `v=`.
 */

export type SelfHealDecision =
  | "create"
  | "update"
  | "close"
  | "reopen"
  | "skip"
  | "suppress"
  | "needs_human"
  | "comment"
  | "candidate"
  | "sighting"
  | "check"
  | "absence"
  | "claim"
  | "dispatch"
  | "pr_open"
  | "gate"
  | "guard"
  | "breaker";

/** Decisions that would have written to GitHub; logged as would_* in dry-run. */
export type SelfHealWouldDecision =
  | "would_create"
  | "would_update"
  | "would_close"
  | "would_reopen"
  | "would_needs_human"
  | "would_comment";

export type SelfHealLogMode = "off" | "dry-run" | "on";

export interface SelfHealDecisionFields {
  organizationId: string;
  repoFullName: string;
  runId: string;
  fingerprint: string;
  decision: SelfHealDecision | SelfHealWouldDecision;
  reason: string;
  mode: SelfHealLogMode;
}

export interface SelfHealDecisionLogDeps {
  log: (line: string) => void;
  capture: (event: string, properties: Record<string, string>) => void;
}

export const SELF_HEAL_DECISION_EVENT = "self_heal_decision";

const REASON_RE = /^[a-z0-9_:-]+$/;
/** Ids and slugs: no whitespace or control characters can split the line. */
const TOKEN_RE = /^[^\s\u0000-\u001f\u007f]+$/;

function assertToken(name: string, value: string): void {
  if (!TOKEN_RE.test(value)) {
    throw new Error(`self-heal decision log: ${name} is not a single token`);
  }
}

export function formatSelfHealDecisionLine(
  fields: SelfHealDecisionFields,
): string {
  if (!REASON_RE.test(fields.reason)) {
    throw new Error("self-heal decision log: reason must match [a-z0-9_:-]+");
  }
  assertToken("organizationId", fields.organizationId);
  assertToken("repoFullName", fields.repoFullName);
  assertToken("runId", fields.runId);
  assertToken("fingerprint", fields.fingerprint);
  assertToken("decision", fields.decision);
  assertToken("mode", fields.mode);
  return `[self-heal] v=1 org=${fields.organizationId} repo=${fields.repoFullName} run=${fields.runId} fp=${fields.fingerprint.slice(0, 8)} decision=${fields.decision} reason=${fields.reason} mode=${fields.mode}`;
}

/** Emits the line and the event; the event repeats exactly the seven fields. */
export function logSelfHealDecision(
  deps: SelfHealDecisionLogDeps,
  fields: SelfHealDecisionFields,
): void {
  const line = formatSelfHealDecisionLine(fields);
  deps.log(line);
  deps.capture(SELF_HEAL_DECISION_EVENT, {
    organizationId: fields.organizationId,
    repoFullName: fields.repoFullName,
    runId: fields.runId,
    fingerprint: fields.fingerprint,
    decision: fields.decision,
    reason: fields.reason,
    mode: fields.mode,
  });
}
