import { redactSecrets } from "@terragon/utils/redact";

/** An error's message with secrets redacted, safe for logs and stored reasons. */
export function errorText(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/** The installation key is unknown until the single token mint. */
export const PRE_MINT_INSTALLATION_KEY = "pending";

/** Below this, the next row could not finish its GitHub calls. */
export const MIN_ROW_BUDGET_MS = 5_000;
