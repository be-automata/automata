import { redactSecrets } from "@terragon/utils/redact";

import { waitUntil } from "@/lib/wait-until";

import { findWebhookSkip } from "./webhook-skip";

export interface DeferredWebhookWork {
  /** The delivery's `x-github-delivery` id: what an operator redelivers. */
  deliveryId: string | undefined;
  /** `event.action`, e.g. `issues.opened`. */
  eventName: string;
  /** What the work is, for the log line. */
  label: string;
  work: () => Promise<unknown>;
}

/**
 * An error's stack (or message) for a log line, with credential material
 * redacted: a failed git or HTTP call can echo a token or a connection string.
 */
export function errorText(error: unknown): string {
  return redactSecrets(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
}

/**
 * #447: run a delivery's slow work after the 2xx instead of before it.
 *
 * GitHub gives a delivery 10s to get a 2xx and never retries a failed one on
 * its own, so work awaited before the reply that outruns it is lost unless a
 * person redelivers it. Work handed here starts at once and runs in
 * `waitUntil`, which is best-effort: no record of the delivery, no retry. A
 * failure can no longer reach GitHub as a 5xx, so it is logged with the
 * delivery id an operator needs to redeliver it. A `WebhookSkip` (a business
 * rejection the route used to fast-ack) is logged as a skip, not an error.
 * Never throws.
 */
export function deferWebhookWork(deferred: DeferredWebhookWork): void {
  waitUntil(runDeferredWebhookWork(deferred));
}

async function runDeferredWebhookWork({
  deliveryId,
  eventName,
  label,
  work,
}: DeferredWebhookWork): Promise<void> {
  try {
    await work();
  } catch (error: unknown) {
    const skip = findWebhookSkip(error);
    if (skip) {
      console.log("[github webhook] deferred work skipped", {
        deliveryId: deliveryId ?? null,
        eventName,
        label,
        category: skip.category,
        reason: skip.message,
        ...skip.detail,
      });
      return;
    }
    console.error(
      "[github webhook] deferred work failed; redeliver this delivery to retry",
      {
        deliveryId: deliveryId ?? null,
        eventName,
        label,
        error: errorText(error),
      },
    );
  }
}
