import { env } from "@terragon/env/apps-www";

// Ops alert for a knowledge reconcile intent that failed for good (D-15).
// The message carries the org id, repo, enum code and attempts only: no partner
// content, never the partner's workspace. The webhook URL is a credential, so
// it is validated here and never logged or returned.

export interface KnowledgeIntentFailedAlert {
  organizationId: string;
  repoFullName: string;
  code: string;
  attempts: number;
}

export type OpsAlertResult =
  | { sent: true }
  | {
      sent: false;
      reason:
        | "unconfigured"
        | "invalid_url"
        | "redirect"
        | "non_2xx"
        | "request_failed"
        | "timeout";
    };

interface OpsAlertDeps {
  url?: string;
  fetchImpl?: (url: string, init: RequestInit) => Promise<{ status: number }>;
}

const ALERT_TIMEOUT_MS = 3000;

export function formatKnowledgeIntentFailedAlert(
  alert: KnowledgeIntentFailedAlert,
): { text: string } {
  return {
    text: `knowledge reconcile intent failed: org ${alert.organizationId}, repo ${alert.repoFullName}, code ${alert.code}, attempts ${alert.attempts}`,
  };
}

function isAcceptableUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === ""
  );
}

export type KnowledgeMirrorPurgeFailureReason =
  | "routing_unresolved"
  | "trigger_failed";

export interface KnowledgeMirrorPurgeFailedAlert {
  organizationId: string;
  reason: KnowledgeMirrorPurgeFailureReason;
  count: number;
}

export function formatKnowledgeMirrorPurgeFailedAlert(
  alert: KnowledgeMirrorPurgeFailedAlert,
): { text: string } {
  return {
    text: `knowledge mirror purge dispatch failed: org ${alert.organizationId}, reason ${alert.reason}, count ${alert.count}`,
  };
}

/** Never throws; reports why nothing was sent instead. */
export async function postKnowledgeIntentFailedAlert(
  alert: KnowledgeIntentFailedAlert,
  deps: OpsAlertDeps = {},
): Promise<OpsAlertResult> {
  return postAlertText(formatKnowledgeIntentFailedAlert(alert), deps);
}

/** Never throws; reports why nothing was sent instead. */
export async function postKnowledgeMirrorPurgeFailedAlert(
  alert: KnowledgeMirrorPurgeFailedAlert,
  deps: OpsAlertDeps = {},
): Promise<OpsAlertResult> {
  return postAlertText(formatKnowledgeMirrorPurgeFailedAlert(alert), deps);
}

async function postAlertText(
  payload: { text: string },
  deps: OpsAlertDeps,
): Promise<OpsAlertResult> {
  const url = deps.url ?? env.OPS_ALERT_WEBHOOK_URL;
  if (url === "") return { sent: false, reason: "unconfigured" };
  if (!isAcceptableUrl(url)) return { sent: false, reason: "invalid_url" };
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "manual",
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      return { sent: false, reason: "redirect" };
    }
    if (response.status < 200 || response.status >= 300) {
      return { sent: false, reason: "non_2xx" };
    }
    return { sent: true };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return {
      sent: false,
      reason: name === "TimeoutError" ? "timeout" : "request_failed",
    };
  }
}

/**
 * Any other ops alert on the same channel (ADR-014 evidence upkeep). The
 * caller builds the text from ids, enums and dates only. Never throws.
 */
export async function postOpsAlert(
  payload: { text: string },
  deps: OpsAlertDeps = {},
): Promise<OpsAlertResult> {
  return postAlertText(payload, deps);
}
