import { NextRequest, NextResponse } from "next/server";
import { getUserOrNull } from "@/lib/auth-server";
import {
  getDecryptedEnvironmentVariables,
  getEnvironment,
} from "@terragon/shared/model/environments";
import { db } from "@/lib/db";
import { getUserSettings } from "@terragon/shared/model/user";
import { getFeatureFlagsForUser } from "@terragon/shared/model/feature-flags";
import { env } from "@terragon/env/apps-www";
import { getOrCreateSandbox, getSandboxProvider } from "@/agent/sandbox";
import { CreateSandboxOptions } from "@terragon/sandbox/types";
import { runSetupScript } from "@terragon/sandbox";
import { nonLocalhostPublicAppUrl } from "@/lib/server-utils";
import { resolveCredentialBrokerForCreate } from "@/server-lib/credential-broker/resolve-credential-broker";
import {
  getDefaultBranchForRepo,
  getGitHubTokenForBackground,
} from "@/lib/github";
import { SandboxOutput } from "@/hooks/use-setup-script";
import * as z from "zod/v4";
import { getSandboxSizeForUser } from "@/lib/subscription-tiers";

const bodySchema = z.object({
  environmentId: z.string(),
  setupScript: z.string(),
});

export async function POST(request: NextRequest) {
  const user = await getUserOrNull();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const bodyJSON = await request.json();
  const bodyResult = bodySchema.safeParse(bodyJSON);
  if (!bodyResult.success) {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }
  const { environmentId, setupScript } = bodyResult.data;
  const userId = user.id;

  const environment = await getEnvironment({ db, environmentId, userId });
  if (!environment) {
    return NextResponse.json(
      { error: "Environment not found" },
      { status: 404 },
    );
  }

  // Create a TransformStream for SSE
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  const sendEvent = async (event: any) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    await writer.write(encoder.encode(data));
  };

  const sendOutput = async (type: SandboxOutput["type"], content: string) => {
    const output: SandboxOutput = {
      type,
      content,
      timestamp: new Date().toISOString(),
    };
    await sendEvent({ type: "output", output });
  };

  const sendStatus = async (status: string) => {
    await sendEvent({ type: "status", status });
  };

  const sendData = async (data: any) => {
    await sendEvent({ type: "data", data });
  };

  const sendComplete = async (data?: any) => {
    await sendEvent({ type: "complete", data });
    await writer.close();
  };

  const sendError = async (error: string) => {
    await sendEvent({ type: "error", error });
    await writer.close();
  };

  // Run the sandbox session in the background
  (async () => {
    try {
      await sendStatus("preparing");
      const [
        userSettings,
        githubAccessToken,
        preferredSandboxSize,
        featureFlags,
        defaultBranch,
      ] = await Promise.all([
        getUserSettings({ db, userId }),
        // Background-capable: App installation token fallback for identity-less owners.
        getGitHubTokenForBackground({
          userId,
          repoFullName: environment.repoFullName,
        }),
        getSandboxSizeForUser(userId),
        getFeatureFlagsForUser({ db, userId }),
        getDefaultBranchForRepo({
          userId,
          repoFullName: environment.repoFullName,
        }),
      ]);
      if (!githubAccessToken) {
        await sendError("GitHub access token not found");
        return;
      }
      const sandboxProvider = await getSandboxProvider({
        userSetting: userSettings?.sandboxProvider,
        sandboxSize: preferredSandboxSize,
        userId,
      });
      // #114: this is a CREATE path — carry the broker shape so a brokered
      // Docker sandbox never receives the raw installation token (Docker + flag
      // on only; null otherwise = today's behavior).
      const brokerCreate = resolveCredentialBrokerForCreate({
        sandboxProvider,
        githubRepoFullName: environment.repoFullName,
        githubAccessToken,
        // Server-resolved per-user flag map (#114). Per-org scoping is not
        // supported by the flag system, so this is the user-scoped fallback;
        // env stays force-on.
        featureFlags,
      });
      // Create sandbox options
      const sandboxOptions: CreateSandboxOptions = {
        threadName: `Sandbox Session - ${environment.repoFullName}`,
        userName: user.name,
        userEmail: user.email,
        githubAccessToken,
        githubRepoFullName: environment.repoFullName,
        repoBaseBranchName: defaultBranch,
        userId,
        sandboxProvider,
        sandboxSize: preferredSandboxSize,
        agent: null,
        createNewBranch: false,
        environmentVariables: [],
        agentCredentials: null,
        autoUpdateDaemon: false,
        skipSetupScript: true,
        publicUrl: nonLocalhostPublicAppUrl(),
        egressPolicy: undefined,
        credentialBroker: brokerCreate?.shape ?? undefined,
        credentialBrokerMode: brokerCreate?.mode ?? undefined,
        featureFlags: featureFlags,
        generateBranchName: async () => null,
        onStatusUpdate: async () => {},
      };

      await sendOutput(
        "system",
        `Creating sandbox for ${environment.repoFullName}...\n`,
      );

      // Create a new sandbox
      const sandbox = await getOrCreateSandbox(null, sandboxOptions);

      await sendData({ sandboxId: sandbox.sandboxId });
      await sendOutput("system", `Sandbox created: ${sandbox.sandboxId}\n`);
      await sendOutput("system", `Setting up environment...\n`);

      try {
        // Wait for initial setup to complete
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await sendStatus("running");
        // Get environment variables
        const environmentVariables = await getDecryptedEnvironmentVariables({
          db,
          userId,
          environmentId,
          encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
        });
        const setupScriptPath = `/tmp/sandbox-session-${Date.now()}.sh`;
        try {
          await runSetupScript({
            session: sandbox,
            options: {
              environmentVariables,
              githubAccessToken,
              setupScript,
              setupScriptPath,
              // #114: brokered so the setup script env carries only the bearer.
              credentialBroker: brokerCreate?.shape ?? undefined,
              // We already stream the output, so we don't need to include it in the error message
              excludeOutputInError: true,
              // No agent credentials for setup script
              agentCredentials: null,
              onUpdate: sendOutput,
            },
          });
        } catch (error: any) {
          const errorMessage = error.message || "Script execution failed";
          await sendOutput("stdout", "\n\n");
          await sendOutput("stderr", errorMessage);
        }
        await sendOutput("system", "\n" + "=".repeat(50) + "\n");
        await sendOutput("system", `Script execution completed.\n`);
        // Clean up the script file
        try {
          await sandbox.runCommand(`rm -f ${setupScriptPath}`);
        } catch (error) {
          console.warn("Failed to clean up script file:", error);
        }
        // Shutdown the sandbox
        await sendOutput("system", `Shutting down sandbox...\n`);
        try {
          await sandbox.shutdown();
          await sendOutput("system", `Sandbox shutdown complete.\n`);
        } catch (error) {
          console.error("Error shutting down sandbox:", error);
          await sendOutput("system", `Warning: Sandbox shutdown failed.\n`);
        }
        await sendComplete({ sandboxId: sandbox.sandboxId });
      } catch (error) {
        // Make sure to shutdown sandbox on error
        try {
          await sandbox.shutdown();
        } catch (e) {
          // Ignore shutdown errors
        }
        throw error;
      }
    } catch (error) {
      console.error("Error in sandbox session stream:", error);
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Failed to run sandbox session";
      await sendError(errorMessage);
    }
  })();

  return new NextResponse(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
