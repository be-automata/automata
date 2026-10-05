import type { NextRequest } from "next/server";
import { env } from "@terragon/env/apps-www";
import { runScheduledCron } from "@/server-lib/cron";

/**
 * The Workers cron entry point for the every-10-minutes trigger: scheduled() in
 * worker-entry.ts fetches this route in-process, so the Cloudflare request context
 * exists. It MUST go through runScheduledCron, which composes the per-user queue drain, then
 * the self-heal tick (fix dispatcher, CI gate, lifecycle sweeps).
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
  console.log("Queued tasks cron task triggered");
  await runScheduledCron("*/10 * * * *");
  console.log("Queued tasks cron task completed");
  return Response.json({ success: true });
}
