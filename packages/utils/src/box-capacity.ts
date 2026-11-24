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

/**
 * The disk floor (WORKER_DISK_FLOOR): the worker refused the run before it
 * cloned because the box's workdir disk was below its floor. Same contract as
 * the memory prefix above: the worker's `DiskFloorError` message starts with
 * it, and www recognises the run as "box at capacity" by it.
 */
export const DISK_FLOOR_PREFIX = "box_disk_low:";

const ADMISSION_EXHAUSTED_PATTERN = new RegExp(
  `${ADMISSION_EXHAUSTED_PREFIX} \\d+ deferral\\(s\\)`,
);

const DISK_FLOOR_PATTERN = new RegExp(`${DISK_FLOOR_PREFIX} the execution box`);

/**
 * True when an error text says the box could not take the run: memory
 * admission exhausted, or the disk floor. Matched as a substring, not
 * anchored: Hatchet wraps it (`run: {"message":"…"}`). Narrow on purpose:
 * the memory prefix must be followed by `<n> deferral(s)`, the shape only
 * `AdmissionBudgetExhaustedError` writes, and the disk one by ` the execution box`.
 */
export function isAdmissionExhaustedText(
  text: string | null | undefined,
): boolean {
  if (!text) return false;
  return (
    ADMISSION_EXHAUSTED_PATTERN.test(text) || DISK_FLOOR_PATTERN.test(text)
  );
}
