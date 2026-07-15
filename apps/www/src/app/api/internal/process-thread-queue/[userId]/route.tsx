import { db } from "@/lib/db";
import { waitUntil } from "@/lib/wait-until";
import { NextResponse } from "next/server";
import { validInternalRequestOrThrow } from "@/lib/auth-server";
import { isValidUserId } from "@terragon/shared/model/user";
import { maybeStartQueuedThreadChat } from "@/server-lib/process-queued-thread";

// Process the thread queue for the given user.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  await validInternalRequestOrThrow();
  const { userId } = await params;
  const isValidUser = await isValidUserId({ db, userId });
  if (!isValidUser) {
    throw new Error(`Invalid userId: ${userId}`);
  }
  waitUntil(maybeStartQueuedThreadChat({ userId }));
  return NextResponse.json({ message: "ok" });
}
