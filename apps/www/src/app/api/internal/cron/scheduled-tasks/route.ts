import type { NextRequest } from "next/server";
import { env } from "@terragon/env/apps-www";
import { runScheduledTasksCron } from "@/server-lib/cron";

/**
 * External cron entrypoint (Vercel schedule / manual hit). The real work lives in
 * runScheduledTasksCron so the Workers scheduled() handler dispatches the identical
 * in-process path (no internalPOST self-fetch, which 404s on Workers).
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (
    process.env.NODE_ENV === "production" &&
    authHeader !== `Bearer ${env.CRON_SECRET}`
  ) {
    return new Response("Unauthorized", { status: 401 });
  }
  console.log("Scheduled tasks cron task triggered");
  try {
    await runScheduledTasksCron();
    return Response.json({ success: true });
  } catch (error) {
    console.error("Error in scheduled tasks cron task:", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
