import type { NextRequest } from "next/server";
import { env } from "@terragon/env/apps-www";
import { runStalledTasksCron } from "@/server-lib/cron";

/**
 * Vercel-cron mirror (does not fire on Workers — see server-lib/cron.ts). The real
 * trigger on Workers is scheduled() → runScheduledCron("0 * * * *"). This GET route
 * stays for external hits / manual pokes; both share the IN-PROCESS runner.
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
  await runStalledTasksCron();
  console.log("Stalled tasks cron task completed");
  return Response.json({ success: true });
}
