import path from "node:path";

import { request } from "@playwright/test";

import { E2E_BASE_URL } from "./e2e-env";
import { AUTH_DIR, WORLD } from "./support/world";

/**
 * The server is up by now (webServer). Abort the whole run unless each seeded
 * cookie is accepted as its user: a signing or cookie-name mismatch would
 * otherwise show up as every spec failing on the login page.
 */
export default async function globalSetup(): Promise<void> {
  for (const [file, user] of [
    ["owner.json", WORLD.users.owner],
    ["outsider.json", WORLD.users.outsider],
  ] as const) {
    const context = await request.newContext({
      baseURL: E2E_BASE_URL,
      storageState: path.join(AUTH_DIR, file),
    });
    try {
      const response = await context.get("/api/auth/get-session");
      const body = (await response.json().catch(() => null)) as {
        user?: { id?: string };
      } | null;
      if (!response.ok() || body?.user?.id !== user.id) {
        throw new Error(
          `Seeded session for ${user.id} was not accepted: HTTP ${response.status()}, user ${body?.user?.id ?? "none"}`,
        );
      }
    } finally {
      await context.dispose();
    }
  }
}
