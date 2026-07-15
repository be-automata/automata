import type { NextRequest } from "next/server";
import {
  getUserIdsWithThreadsReadyToProcess,
  getUserIdsWithThreadsStuckInQueue,
} from "@terragon/shared/model/threads";
import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import { internalPOST } from "@/server-lib/internal-request";
import { getSandboxCreationRemaining } from "@/lib/rate-limit";
import { getPostHogServer } from "@/lib/posthog-server";

async function sleep(ms: number = 1000) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processOtherRateLimitedQueues() {
  console.log("Processing other rate-limited queues");
  const userIds = await getUserIdsWithThreadsReadyToProcess({ db });
  console.log(`Found ${userIds.length} users with other rate-limited threads`);

  // Log cron job queue processing metrics
  if (userIds.length > 0) {
    getPostHogServer().capture({
      distinctId: "system",
      event: "cron_queue_processing",
      properties: {
        usersWithRateLimitedThreads: userIds.length,
        queueType: "other_rate_limit",
      },
    });
  }
  // Batch the requests
  for (let i = 0; i < userIds.length; i += 10) {
    const batch = userIds.slice(i, i + 10);
    await Promise.allSettled(
      batch.map(async (userId) => {
        // Check if the user is has tokens remaining before we kick off the request to
        // process the thread queue so we don't end up making a bunch of useless requests.
        const rateLimitResult = await getSandboxCreationRemaining(userId);
        if (rateLimitResult.remaining === 0) {
          // TODO: If possible, we should update the attemptQueueAt for the threads to the new reset time.
          return;
        }
        // We have this make a separate request to process the thread queue
        // to keep each request's logs and errors separate and so each of them
        // get their own function time limit.
        await internalPOST(`process-thread-queue/${userId}`);
      }),
    );
    await sleep();
  }
}

async function processConcurrencyLimitedQueues() {
  console.log("Processing concurrency-limited queues");
  const userIds = await getUserIdsWithThreadsStuckInQueue({ db });
  console.log(`Found ${userIds.length} users with stuck threads`);
  if (userIds.length > 0) {
    console.log(userIds);
    // Log metrics for stuck users
    getPostHogServer().capture({
      distinctId: "system",
      event: "cron_queue_stuck_users",
      properties: {
        stuckUserCount: userIds.length,
        queueType: "tasks_concurrency",
      },
    });
  }
  // Batch the requests
  for (let i = 0; i < userIds.length; i += 10) {
    const batch = userIds.slice(i, i + 10);
    await Promise.allSettled(
      batch.map(async (userId) => {
        await internalPOST(`process-thread-queue/${userId}`);
      }),
    );
    await sleep();
  }
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (
    process.env.NODE_ENV === "production" &&
    authHeader !== `Bearer ${env.CRON_SECRET}`
  ) {
    return new Response("Unauthorized", {
      status: 401,
    });
  }
  console.log("Queued tasks cron task triggered");
  await processOtherRateLimitedQueues();
  await processConcurrencyLimitedQueues();
  console.log("Queued tasks cron task completed");
  return Response.json({ success: true });
}
