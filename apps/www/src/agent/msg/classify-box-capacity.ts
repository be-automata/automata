import { isAdmissionExhaustedText } from "@terragon/utils/box-capacity";

/**
 * #561: a run the execution box never admitted. The worker refused it for
 * lack of memory headroom on every allowed deferral and failed it with
 * `AdmissionBudgetExhaustedError`; the message reaches www as text only
 * (onFailure's custom-error), recognised by the shared prefix in
 * `@terragon/utils/box-capacity`. The agent never ran, so every lane says
 * the box was busy instead of "no usable result".
 */

/** The `errorMessage` a thread chat carries when the box refused the run. */
export const BOX_AT_CAPACITY_ERROR = "box-at-capacity";

/**
 * True when a finished thread chat ended because the box was at capacity.
 * Reads the stored classification first, then the raw error text, so a
 * chat written before the classification existed is recognised too.
 */
export function boxAtCapacityOfChat(
  chat:
    | { errorMessage?: string | null; errorMessageInfo?: string | null }
    | null
    | undefined,
): boolean {
  if (!chat) return false;
  if (chat.errorMessage === BOX_AT_CAPACITY_ERROR) return true;
  return (
    chat.errorMessage === "agent-generic-error" &&
    isAdmissionExhaustedText(chat.errorMessageInfo)
  );
}

/**
 * One sentence for every lane's public notice. Never the raw error: it holds
 * box memory figures that mean nothing to a PR author.
 */
export const BOX_AT_CAPACITY_SENTENCE =
  "The execution box was at capacity (no memory headroom for another run), so the agent never started; nothing about this change caused it.";
