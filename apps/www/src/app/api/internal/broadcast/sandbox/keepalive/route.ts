import { NextResponse } from "next/server";
import {
  getUserIdOrNull,
  getUserIdOrNullFromDaemonToken,
} from "@/lib/auth-server";
import { withDaemonAuthUnavailable } from "@/lib/daemon-auth-unavailable";
import { getThreadMinimal } from "@terragon/shared/model/threads";
import { setTerminalActive } from "@/agent/sandbox-resource";
import { db } from "@/lib/db";
import { isSandboxTerminalSupported } from "@/lib/sandbox-terminal";

export const POST = withDaemonAuthUnavailable(async function POST(
  request: Request,
) {
  const userId =
    (await getUserIdOrNullFromDaemonToken(request)) ??
    (await getUserIdOrNull());
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { threadId, sandboxId } = await request.json();
  const thread = await getThreadMinimal({ db, threadId, userId });
  if (!thread) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isSandboxTerminalSupported(thread.sandboxProvider)) {
    return NextResponse.json(
      { error: "Sandbox terminal not supported for this sandbox provider" },
      { status: 400 },
    );
  }
  if (thread.codesandboxId !== sandboxId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await setTerminalActive({ sandboxId, expires: 60 * 5 }); // 5 minutes
  return NextResponse.json({ message: "ok" });
});
