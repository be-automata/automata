import type { DB } from "@terragon/shared/db";
import type {
  SlackAccount,
  SlackInstallation,
} from "@terragon/shared/db/types";
import { getMembership } from "@terragon/shared/model/organizations";
import { getSlackAccountForSlackUserId } from "@terragon/shared/model/slack";

import {
  getSlackInstallationForRoute,
  type SlackRequestRoute,
} from "./route-fence";

export type BlockActionUnverifiedReason =
  | "org_route_payload_forgeable"
  | "missing_identity"
  | "no_installation_for_route"
  | "slack_account_not_linked"
  | "not_org_member";

export type BlockActionAttribution =
  | {
      verdict: "verified";
      teamId: string;
      slackUserId: string;
      userId: string;
      organizationId: string | null;
    }
  | {
      verdict: "unverified";
      reason: BlockActionUnverifiedReason;
      teamId: string | null;
      slackUserId: string | null;
    };

export interface BlockActionAttributionDeps {
  getInstallationForRoute: (args: {
    db: DB;
    teamId: string;
    route: SlackRequestRoute;
  }) => Promise<SlackInstallation | null>;
  getSlackAccount: (args: {
    db: DB;
    teamId: string;
    slackUserId: string;
  }) => Promise<SlackAccount | null>;
  getMembership: (args: {
    db: DB;
    organizationId: string;
    userId: string;
  }) => Promise<unknown>;
}

const DEFAULT_DEPS: BlockActionAttributionDeps = {
  getInstallationForRoute: getSlackInstallationForRoute,
  getSlackAccount: getSlackAccountForSlackUserId,
  getMembership,
};

interface BlockActionIdentity {
  slackUserId: string | null;
  teamId: string | null;
  actionId: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Reads only the identity fields; never the action value or message text. */
function readIdentity(payload: unknown): BlockActionIdentity {
  const root = asRecord(payload);
  const user = asRecord(root?.user);
  const team = asRecord(root?.team);
  const actions = Array.isArray(root?.actions) ? root.actions : [];
  return {
    slackUserId: asNonEmptyString(user?.id),
    teamId: asNonEmptyString(team?.id) ?? asNonEmptyString(user?.team_id),
    actionId: asNonEmptyString(asRecord(actions[0])?.action_id),
  };
}

/**
 * Whether a block_actions click came from a verified Slack identity. Pure over
 * injected lookups: no logging, no Slack API call.
 */
export async function attributeSlackBlockAction({
  db,
  payload,
  route,
  deps = DEFAULT_DEPS,
}: {
  db: DB;
  payload: unknown;
  route: SlackRequestRoute;
  deps?: BlockActionAttributionDeps;
}): Promise<BlockActionAttribution> {
  const { slackUserId, teamId } = readIdentity(payload);
  const unverified = (
    reason: BlockActionUnverifiedReason,
  ): BlockActionAttribution => ({
    verdict: "unverified",
    reason,
    teamId,
    slackUserId,
  });

  // route-fence.ts: on the org route the org admins can forge every payload
  // claim, and a click has no Slack-held record to confirm against.
  if (route.kind === "organization") {
    return unverified("org_route_payload_forgeable");
  }
  if (!slackUserId || !teamId) {
    return unverified("missing_identity");
  }
  const installation = await deps.getInstallationForRoute({
    db,
    teamId,
    route,
  });
  if (!installation) {
    return unverified("no_installation_for_route");
  }
  // A linked slack_account exists only after jwtVerify of Slack's OpenID
  // id_token at link time.
  const account = await deps.getSlackAccount({ db, teamId, slackUserId });
  if (!account) {
    return unverified("slack_account_not_linked");
  }
  if (installation.organizationId) {
    const membership = await deps.getMembership({
      db,
      organizationId: installation.organizationId,
      userId: account.userId,
    });
    if (!membership) {
      return unverified("not_org_member");
    }
  }
  return {
    verdict: "verified",
    teamId,
    slackUserId,
    userId: account.userId,
    organizationId: installation.organizationId ?? null,
  };
}

export const BLOCK_ACTION_ATTRIBUTION_LOG_PREFIX =
  "[slack webhook] block_action attribution ";

/** Emits ONE allow-listed log line: prefix + JSON of ids and verdict only. */
export async function logBlockActionAttribution({
  db,
  payload,
  route,
  deps,
}: {
  db: DB;
  payload: unknown;
  route: SlackRequestRoute;
  deps?: BlockActionAttributionDeps;
}): Promise<void> {
  const attribution = await attributeSlackBlockAction({
    db,
    payload,
    route,
    deps,
  });
  const { actionId } = readIdentity(payload);
  const fields = {
    actionId,
    route: route.kind,
    routeOrganizationId:
      route.kind === "organization" ? route.organizationId : null,
    teamId: attribution.teamId,
    slackUserId: attribution.slackUserId,
    verdict: attribution.verdict,
    reason: attribution.verdict === "unverified" ? attribution.reason : null,
    ...(attribution.verdict === "verified"
      ? { userId: attribution.userId }
      : {}),
  };
  console.log(
    `${BLOCK_ACTION_ATTRIBUTION_LOG_PREFIX}${JSON.stringify(fields)}`,
  );
}
