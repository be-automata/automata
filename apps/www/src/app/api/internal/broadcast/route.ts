import {
  getUserIdOrNull,
  getUserIdOrNullFromDaemonToken,
} from "@/lib/auth-server";
import { withDaemonAuthUnavailable } from "@/lib/daemon-auth-unavailable";
import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { parseBroadcastChannel } from "@terragon/types/broadcast";
import { assertNever } from "@terragon/shared/utils";
import { getThreadMinimal } from "@terragon/shared/model/threads";

// Validate that the current user is allowed to listen to the given broadcast channel.
export const GET = withDaemonAuthUnavailable(async function GET(
  request: Request,
) {
  const { searchParams } = new URL(request.url);
  const channel = searchParams.get("channel") ?? "";
  const parsedChannel = parseBroadcastChannel(channel);
  if (!parsedChannel) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const userId =
    (await getUserIdOrNullFromDaemonToken(request)) ??
    (await getUserIdOrNull());
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  switch (parsedChannel.type) {
    case "user": {
      if (parsedChannel.id !== userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      return NextResponse.json({ message: "ok" });
    }
    case "sandbox": {
      if (parsedChannel.userId !== userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      const thread = await getThreadMinimal({
        db,
        userId,
        threadId: parsedChannel.threadId,
      });
      if (!thread) {
        return NextResponse.json(
          { error: "Thread not found" },
          { status: 404 },
        );
      }
      if (thread.codesandboxId !== parsedChannel.sandboxId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      return NextResponse.json({ message: "ok" });
    }
    default: {
      assertNever(parsedChannel);
    }
  }
});
