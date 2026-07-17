import { NextResponse } from "next/server";
import {
  getUserIdOrNull,
  getUserIdOrNullFromDaemonToken,
} from "@/lib/auth-server";
import { getThread } from "@terragon/shared/model/threads";
import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import {
  getDecryptedEnvironmentVariables,
  getOrCreateEnvironment,
} from "@terragon/shared/model/environments";
import { getGitHubTokenForBackground } from "@/lib/github";
import { getEnv } from "@terragon/sandbox/env";
import { getAndVerifyCredentials } from "@/agent/credentials";
import { isSandboxTerminalSupported } from "@/lib/sandbox-terminal";
import { getPrimaryThreadChat } from "@terragon/shared/utils/thread-utils";

export async function POST(request: Request) {
  const userId =
    (await getUserIdOrNullFromDaemonToken(request)) ??
    (await getUserIdOrNull());
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { threadId, sandboxId } = await request.json();
  const thread = await getThread({ db, threadId, userId });
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
  const environment = await getOrCreateEnvironment({
    db,
    userId,
    repoFullName: thread.githubRepoFullName,
  });
  const [environmentVariables, githubAccessToken, agentCredentials] =
    await Promise.all([
      getDecryptedEnvironmentVariables({
        db,
        userId,
        environmentId: environment.id,
        encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
      }),
      // Background-capable: App installation token fallback for identity-less owners.
      getGitHubTokenForBackground({
        userId,
        repoFullName: thread.githubRepoFullName,
      }),
      (async () => {
        const threadChat = getPrimaryThreadChat(thread);
        if (!threadChat.agent) {
          return null;
        }
        try {
          return await getAndVerifyCredentials({
            agent: threadChat.agent,
            model: null,
            userId,
            organizationId: thread.organizationId,
          });
        } catch (error) {
          // Ignore errors if credentials are not found so that the user can still
          // user the terminal.
          console.error(error);
          return null;
        }
      })(),
    ]);

  return NextResponse.json({
    message: "ok",
    environmentVariables: getEnv({
      userEnv: environmentVariables,
      githubAccessToken,
      agentCredentials,
    }),
  });
}
