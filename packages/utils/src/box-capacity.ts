/**
 * #561: a run the execution box could not admit. The worker (headroom.ts)
 * defers a run while the box has no memory headroom; when every allowed
 * deferral is refused the run fails with `AdmissionBudgetExhaustedError`,
 * whose message starts with this prefix. That message reaches the control
 * plane only as text (onFailure's synthetic custom-error carries Hatchet's
 * error summary), so the worker builds the message FROM this constant and
 * www recognises it BY this constant: one string, two packages, no drift.
 *
 * The agent never ran: the cause is the box's load, not the change, the
 * credential or the agent.
 */
export const ADMISSION_EXHAUSTED_PREFIX =
  "The box had no memory headroom for this run after";

const ADMISSION_EXHAUSTED_PATTERN = new RegExp(
  `${ADMISSION_EXHAUSTED_PREFIX} \\d+ deferral\\(s\\)`,
);

/**
 * True when an error text carries the admission-exhausted message. Matched
 * as a substring, not anchored: Hatchet wraps it (`run: {"message":"…"}`).
 * Narrow on purpose: the prefix must be followed by `<n> deferral(s)`, the
 * shape only `AdmissionBudgetExhaustedError` writes.
 */
export function isAdmissionExhaustedText(
  text: string | null | undefined,
): boolean {
  if (!text) return false;
  return ADMISSION_EXHAUSTED_PATTERN.test(text);
}
