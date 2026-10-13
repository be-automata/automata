import { env } from "@terragon/env/apps-www";
import type { DB } from "@terragon/shared/db";

import { SLACK_APP_ENV_KEYS } from "@/lib/env-key-hints";
import {
  type EnvironmentVariable,
  getControlPlaneOrganizationEnvironmentVariables,
} from "@/server-lib/env-audience";

/**
 * Which Slack app a request, an install or an account connection belongs to.
 *
 * An organization brings its own Slack app by setting the SLACK_* keys on its
 * organization environment; an org that sets none of them uses the platform
 * app (the worker's SLACK_* secrets). Repository and personal Global layers
 * are never read: a Slack app answers for a whole workspace, before any repo
 * is known, and the Global layer has no org fence.
 *
 * Every value here is control plane only (CONTROL_PLANE_ONLY_ENV_KEYS).
 */

export const SLACK_CONFIG_KEYS = SLACK_APP_ENV_KEYS;

export type SlackConfigKey = (typeof SLACK_CONFIG_KEYS)[number];

export type SlackConfigSource = "organization" | "platform";

export interface SlackAppConfig {
  source: SlackConfigSource;
  /** The org that owns this app; null for the platform app. */
  organizationId: string | null;
  clientId: string | null;
  clientSecret: string | null;
  signingSecret: string | null;
}

/** Key names and presence only — safe to show any org member. */
export interface SlackAppConfigStatus {
  source: SlackConfigSource;
  keys: Record<SlackConfigKey, boolean>;
  /** All three keys are set: requests can be verified and OAuth can run. */
  ready: boolean;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Pure. The org owns its Slack app as soon as it sets ANY SLACK_* key; the
 * three values then come from the org alone, never mixed with the platform's
 * — a signing secret from one Slack app cannot verify another app's requests.
 */
export function pickSlackAppConfig({
  organizationId,
  organizationVariables,
  platform,
}: {
  organizationId: string | null;
  organizationVariables: readonly EnvironmentVariable[];
  platform: Record<SlackConfigKey, string | undefined>;
}): SlackAppConfig {
  const organizationValues = new Map(
    organizationVariables
      .filter((variable) =>
        (SLACK_CONFIG_KEYS as readonly string[]).includes(variable.key),
      )
      .map((variable) => [variable.key, nonEmpty(variable.value)]),
  );
  if (organizationId && organizationValues.size > 0) {
    return {
      source: "organization",
      organizationId,
      clientId: organizationValues.get("SLACK_CLIENT_ID") ?? null,
      clientSecret: organizationValues.get("SLACK_CLIENT_SECRET") ?? null,
      signingSecret: organizationValues.get("SLACK_SIGNING_SECRET") ?? null,
    };
  }
  return {
    source: "platform",
    organizationId: null,
    clientId: nonEmpty(platform.SLACK_CLIENT_ID),
    clientSecret: nonEmpty(platform.SLACK_CLIENT_SECRET),
    signingSecret: nonEmpty(platform.SLACK_SIGNING_SECRET),
  };
}

export function describeSlackAppConfig(
  config: SlackAppConfig,
): SlackAppConfigStatus {
  const keys = {
    SLACK_CLIENT_ID: config.clientId !== null,
    SLACK_CLIENT_SECRET: config.clientSecret !== null,
    SLACK_SIGNING_SECRET: config.signingSecret !== null,
  };
  return {
    source: config.source,
    keys,
    ready: Object.values(keys).every(Boolean),
  };
}

/**
 * The Slack app for `organizationId` (or the platform app when null). Reads
 * the org's raw values without a membership check: the caller must already
 * be entitled to act for the org — a verified Slack signature, an org member
 * in session, or OAuth state the control plane encrypted itself.
 */
export async function resolveSlackAppConfig({
  db,
  organizationId,
}: {
  db: DB;
  organizationId: string | null;
}): Promise<SlackAppConfig> {
  const organizationVariables = organizationId
    ? await getControlPlaneOrganizationEnvironmentVariables({
        db,
        organizationId,
      })
    : [];
  return pickSlackAppConfig({
    organizationId,
    organizationVariables,
    platform: {
      SLACK_CLIENT_ID: env.SLACK_CLIENT_ID,
      SLACK_CLIENT_SECRET: env.SLACK_CLIENT_SECRET,
      SLACK_SIGNING_SECRET: env.SLACK_SIGNING_SECRET,
    },
  });
}

/** The Slack app's Event Subscriptions and Interactivity request URL. */
export function slackRequestUrlPath(config: SlackAppConfig): string {
  return config.source === "organization" && config.organizationId
    ? `/api/webhooks/slack/${config.organizationId}`
    : "/api/webhooks/slack";
}
