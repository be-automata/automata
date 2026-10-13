import { NextRequest } from "next/server";

import { db } from "@/lib/db";
import { resolveSlackAppConfig } from "@/server-lib/slack-config";

import { handleSlackRequest } from "./handle-request";
import { PLATFORM_SLACK_ROUTE } from "./route-fence";

/** Requests from the platform Slack app (the worker's SLACK_* secrets). */
export async function POST(req: NextRequest) {
  const config = await resolveSlackAppConfig({ db, organizationId: null });
  return await handleSlackRequest({
    req,
    signingSecret: config.signingSecret,
    route: PLATFORM_SLACK_ROUTE,
  });
}
