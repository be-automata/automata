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
        try {
          const logs = await withSandboxResource({
            label: "getSandboxDaemonLogs",
            sandboxId,
            callback: async () => {
              const sandboxOrNull = await getSandboxOrNull({
                sandboxProvider,
                sandboxId,
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
