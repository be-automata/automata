import { env } from "@terragon/env/apps-www";
import { NextRequest } from "next/server";

import { handleSlackRequest } from "./handle-request";
import { PLATFORM_SLACK_ROUTE } from "./route-fence";

/** Requests from the platform Slack app (the worker's SLACK_* secrets). */
export async function POST(req: NextRequest) {
  return await handleSlackRequest({
    req,
    signingSecret: env.SLACK_SIGNING_SECRET || null,
    route: PLATFORM_SLACK_ROUTE,
  });
}
