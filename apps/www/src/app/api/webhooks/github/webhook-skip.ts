/**
 * WI-8 — webhook endpoints must fast-ack business rejections, not 5xx.
 *
 * GitHub marks a 5xx delivery failed, retries it, and disables the webhook after
 * repeated failures. A business rejection (app not installed on the repo, no
 * mapped user, unconfigured/unmapped installation) is NOT a transient failure —
 * retrying never helps. So those paths throw a `WebhookSkip`, which the webhook
 * route catches and turns into a 2xx with a structured skip log. Genuine
 * unexpected errors (bugs, DB down) still propagate to a 500 so GitHub's retry
 * remains the durability net until the ingress outbox lands (Hatchet phase).
 */
export type WebhookSkipCategory =
  | "app_access_unavailable" // couldn't get an installation client (not installed / bad creds)
  | "no_mapped_users" // no platform user mapped to this GitHub actor/repo
  | "unmapped_installation" // installation id has no org binding
  | "unconfigured_repo" // no default repo / settings for this workspace
  | "shadow_mode"; // installation is in shadow mode — ingest only, no side effects

export class WebhookSkip extends Error {
  readonly isWebhookSkip = true;
  constructor(
    readonly category: WebhookSkipCategory,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WebhookSkip";
  }
}

/** The WebhookSkip in `error`, unwrapping @octokit/webhooks' aggregate wrapper. */
export function findWebhookSkip(error: unknown): WebhookSkip | null {
  if (error instanceof WebhookSkip) return error;
  if (typeof error === "object" && error !== null) {
    if ((error as { isWebhookSkip?: boolean }).isWebhookSkip === true) {
      return error as WebhookSkip;
    }
    // @octokit/webhooks rejects `receive` with an aggregate whose `.errors`
    // (or `.event.errors`) holds the original handler error(s).
    const nested =
      (error as { errors?: unknown[] }).errors ??
      (error as { errors?: unknown[]; cause?: unknown }).cause;
    if (Array.isArray(nested)) {
      for (const e of nested) {
        const found = findWebhookSkip(e);
        if (found) return found;
      }
    } else if (nested) {
      return findWebhookSkip(nested);
    }
  }
  return null;
}

export function isWebhookSkip(error: unknown): error is WebhookSkip {
  return findWebhookSkip(error) !== null;
}

/**
 * Run an installation-client acquisition (or any GitHub-App access step) and
 * convert an auth/not-installed failure into a business skip rather than a 500.
 */
export async function requireAppAccess<T>(
  fn: () => Promise<T>,
  detail: Record<string, unknown>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new WebhookSkip(
      "app_access_unavailable",
      `GitHub App access unavailable: ${error instanceof Error ? error.message : String(error)}`,
      detail,
    );
  }
}
