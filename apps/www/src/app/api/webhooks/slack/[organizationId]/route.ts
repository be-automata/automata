import { NextRequest } from "next/server";

import { db } from "@/lib/db";
import { resolveSlackAppConfig } from "@/server-lib/slack-config";

import { handleSlackRequest } from "../handle-request";

/**
 * Requests from an organization's own Slack app, verified with the
 * SLACK_SIGNING_SECRET on that org's environment. An org without its own app
 * has no secret here, so every request is rejected.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ organizationId: string }> },
) {
  const { organizationId } = await params;
  const config = await resolveSlackAppConfig({ db, organizationId });
  return await handleSlackRequest({
    req,
    signingSecret:
      config.source === "organization" ? config.signingSecret : null,
    route: { kind: "organization", organizationId },
  });
}
