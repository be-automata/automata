import { writeFileSync } from "node:fs";

import {
  test as base,
  expect,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { Pool } from "pg";

import {
  createSessionCookie,
  readActiveOrganizationId,
  storageStateFor,
} from "./session";
import { readWorldState, WORLD, type WorldState } from "./world";

type SeededUser = (typeof WORLD.users)[keyof typeof WORLD.users];

interface SignedInSession {
  sessionId: string;
  /** session.active_organization_id as the database holds it now. */
  activeOrganizationId: () => Promise<string | null>;
}

interface E2EFixtures {
  /**
   * Gives `context` a session of its own for `user`, acting in
   * `activeOrganizationId`. Specs that move the active org never share a
   * session row with another spec.
   */
  signIn: (
    user: SeededUser,
    activeOrganizationId: string | null,
    target?: BrowserContext,
  ) => Promise<SignedInSession>;
  /** Delay every api.github.com fixture response by `ms` (0 to clear). */
  setGithubDelay: (ms: number) => void;
  /** URLs the browser tried to open on slack.com (all aborted). */
  slackNavigations: string[];
}

interface E2EWorkerFixtures {
  world: WorldState;
  pool: Pool;
}

export const test = base.extend<E2EFixtures, E2EWorkerFixtures>({
  world: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use(readWorldState());
    },
    { scope: "worker" },
  ],
  pool: [
    async ({ world }, use) => {
      const pool = new Pool({ connectionString: world.databaseUrl });
      await use(pool);
      await pool.end();
    },
    { scope: "worker" },
  ],
  slackNavigations: [
    async ({ context }, use) => {
      const urls: string[] = [];
      // The browser must never reach Slack: the server's guard covers the
      // app, this covers the redirect the page itself performs.
      await context.route(/^https:\/\/([a-z0-9-]+\.)*slack\.com\//, (route) => {
        urls.push(route.request().url());
        return route.abort("blockedbyclient");
      });
      await use(urls);
    },
    { auto: true },
  ],
  signIn: async ({ context, pool }, use) => {
    await use(async (user, activeOrganizationId, target = context) => {
      const session = await createSessionCookie(pool, {
        userId: user.id,
        activeOrganizationId,
      });
      await target.addCookies(storageStateFor(session).cookies);
      return {
        sessionId: session.sessionId,
        activeOrganizationId: () =>
          readActiveOrganizationId(pool, session.sessionId),
      };
    });
  },
  setGithubDelay: async ({ world }, use) => {
    const set = (ms: number) =>
      writeFileSync(world.controlFile, JSON.stringify({ githubDelayMs: ms }));
    await use(set);
    set(0);
  },
});

export { expect, WORLD };

/** The sidebar's org switcher trigger, whatever org it names. */
export function orgSwitcherTrigger(page: Page) {
  return page.getByRole("button", {
    name: /(Acting in .+\. Switch organization|Choose an organization)/,
  });
}

/** Opens the switcher and picks `orgName`; waits for the switch toast. */
export async function switchOrganization(page: Page, orgName: string) {
  await orgSwitcherTrigger(page).click();
  await page.getByRole("option", { name: orgName, exact: false }).click();
  await expect(page.getByText(`Switched to ${orgName}`)).toBeVisible();
}
