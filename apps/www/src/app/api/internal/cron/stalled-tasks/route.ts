import type { NextRequest } from "next/server";
import { env } from "@terragon/env/apps-www";
import { runScheduledCron } from "@/server-lib/cron";

/**
 * The Workers cron entry point for the hourly trigger: scheduled() in
 * worker-entry.ts fetches this route in-process, so the Cloudflare request context
 * exists. It MUST go through runScheduledCron, which composes stalled-task recovery, then the
 * hourly self-heal backstops (audit sweep, outbox drain, retention).
 * Calling the base runner alone silently skips the self-heal stage in production.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (
    process.env.NODE_ENV === "production" &&
    authHeader !== `Bearer ${env.CRON_SECRET}`
  ) {
    return new Response("Unauthorized", { status: 401 });
  }
  console.log("Stalled tasks cron task triggered");
  await runScheduledCron("0 * * * *");
  console.log("Stalled tasks cron task completed");
  return Response.json({ success: true });
}
