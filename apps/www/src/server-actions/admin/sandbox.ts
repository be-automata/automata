"use server";

import { adminOnly } from "@/lib/auth-server";
import { User } from "@terragon/shared";
import { withSandboxResource } from "@/agent/sandbox-resource";
import { getSandboxOrNull } from "@terragon/sandbox";
import { getDaemonLogs } from "@terragon/sandbox/daemon";
import { waitUntil } from "@/lib/wait-until";
import { maybeHibernateSandboxInternal } from "@/agent/sandbox";
import Sandbox from "@e2b/code-interpreter";
import type { SandboxProvider } from "@terragon/types/sandbox";
import type { ISandboxSession } from "@terragon/sandbox/types";
import { db } from "@/lib/db";
import { getThreadBrokerContextBySandboxId } from "@terragon/shared/model/threads";
import { getGitHubTokenForBackground } from "@/lib/github";
import { resolveBrokerRefreshForConnect } from "@/server-lib/credential-broker/resolve-credential-broker";

export const getSandboxDaemonLogs = adminOnly(
  async function getSandboxDaemonLogs(
    adminUser: User,
    {
      sandboxProvider,
      sandboxId,
    }: { sandboxProvider: SandboxProvider; sandboxId: string },
  ) {
    console.log("getSandboxDaemonLogs", sandboxProvider, sandboxId);
    const logsOrTimeout = await Promise.race([
      new Promise<"timeout">((resolve) => {
        setTimeout(() => {
          resolve("timeout");
        }, 10000);
      }),
      (async () => {
        // Don't use withThreadSandboxSession here because we don't want to have any errors show up
        // in the user's thread model.
        let sandbox: ISandboxSession | undefined;
        // #114 §7a: this admin view's getSandboxOrNull connect auto-resumes the
        // guest, so for a brokered E2B sandbox rotate its vault secret (throttled)
        // BEFORE connect. We have only a sandboxId here, so look up the owning
        // thread's NON-secret broker context and mint the fresh installation
        // token as the sandbox OWNER (not the admin). undefined for
        // Docker/non-brokered — today's behavior.
        const brokerContext =
          await getThreadBrokerContextBySandboxId({ db, sandboxId });
        const refresh = brokerContext
          ? resolveBrokerRefreshForConnect({
              sandboxProvider: brokerContext.sandboxProvider,
              persistedBrokerMode: brokerContext.credentialBrokerMode,
              mintToken: () =>
                getGitHubTokenForBackground({
                  userId: brokerContext.userId,
                  repoFullName: brokerContext.githubRepoFullName,
                }),
              // Stable id for the Daytona org-Secret name (#114); ignored by E2B.
              threadId: brokerContext.threadId,
            })
          : undefined;
        try {
          const logs = await withSandboxResource({
            label: "getSandboxDaemonLogs",
            sandboxId,
            callback: async () => {
              const sandboxOrNull = await getSandboxOrNull({
                sandboxProvider,
                sandboxId,
                refresh,
              });
              if (!sandboxOrNull) {
                return ["Sandbox not found"];
              }
              sandbox = sandboxOrNull;
              return await getDaemonLogs({
                session: sandbox,
                parseJson: false,
              });
            },
          });
          return logs ?? [];
        } finally {
          if (sandbox) {
            waitUntil(
              maybeHibernateSandboxInternal({
                sandboxId: sandbox.sandboxId,
                sandboxProvider: sandbox.sandboxProvider,
              }),
            );
          }
        }
      })(),
    ]);
    if (logsOrTimeout === "timeout") {
      return ["Timeout waiting for logs"];
    }
    return logsOrTimeout;
  },
);

export const getActiveSandboxCount = adminOnly(
  async function getActiveSandboxCount() {
    console.log("getActiveSandboxCount");
    try {
      // Fetch all sandboxes from E2B
      const paginator = await Sandbox.list();
      let count = 0;

      // Get first page of results (should be enough for 100 sandboxes)
      if (paginator && typeof paginator.nextItems === "function") {
        const items = await paginator.nextItems();
        count += items.length;

        // Collect remaining pages if any
        while (paginator.hasNext) {
          const moreItems = await paginator.nextItems();
          count += moreItems.length;
        }
      }

      return count;
    } catch (error) {
      console.error("Error fetching sandbox count:", error);
      throw new Error("Failed to fetch sandbox count from E2B");
    }
  },
);
