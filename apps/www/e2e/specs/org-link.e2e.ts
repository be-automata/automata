import type { APIRequestContext } from "@playwright/test";

import { E2E_BASE_URL } from "../e2e-env";
import { expect, orgSwitcherTrigger, test, WORLD } from "../support/fixtures";

const { alpha, beta, gamma } = WORLD.orgs;

/**
 * The same probes deploy/smoke.ts runs against production (C8): each must
 * stay on this origin through every hop and end in a 404.
 */
const OPEN_REDIRECT_PROBES = [
  "%2F%2Fevil.com",
  "%2F%2F%2Fevil.com",
  "https:%2F%2Fevil.com",
  "%5C%5Cevil.com",
  "..%2F..%2Fevil",
  "o%2Facme",
  "o/acme/x",
  "%0d%0aLocation:%20https://evil.com",
];

const MAX_HOPS = 5;

/** Follows redirects by hand so every Location is checked, not just the last. */
async function followSameOrigin(
  request: APIRequestContext,
  path: string,
): Promise<{ status: number; hops: string[] }> {
  const hops: string[] = [];
  let url = new URL(path, E2E_BASE_URL).toString();
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const response = await request.get(url, { maxRedirects: 0 });
    const status = response.status();
    if (status < 300 || status >= 400) {
      return { status, hops };
    }
    const location = response.headers()["location"];
    if (!location) {
      throw new Error(`${status} from ${url} without a Location`);
    }
    const next = new URL(location, url);
    hops.push(next.toString());
    expect(next.origin, `hop ${hop + 1} of ${path}`).toBe(E2E_BASE_URL);
    url = next.toString();
  }
  throw new Error(`${path}: more than ${MAX_HOPS} redirects`);
}

test.describe("org links /o/<slug>/<path>", () => {
  test("a member lands on the path with that org active", async ({
    page,
    signIn,
  }) => {
    const session = await signIn(WORLD.users.owner, alpha.id);
    await page.goto(`/o/${beta.slug}/settings`);
    await expect(page).toHaveURL(`${E2E_BASE_URL}/settings`);
    await expect(orgSwitcherTrigger(page)).toHaveAccessibleName(
      `Acting in ${beta.name}. Switch organization`,
    );
    expect(await session.activeOrganizationId()).toBe(beta.id);
  });

  test("a non-member gets a 404 and keeps their org", async ({
    page,
    signIn,
  }) => {
    const session = await signIn(WORLD.users.outsider, gamma.id);
    const response = await page.request.get(`/o/${alpha.slug}`, {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(404);
    expect(await session.activeOrganizationId()).toBe(gamma.id);
  });

  test("an unknown slug is a 404", async ({ page, signIn }) => {
    await signIn(WORLD.users.owner, alpha.id);
    const response = await page.request.get("/o/e2e-no-such-org/settings", {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(404);
  });

  test("signed out goes to login with the link as returnUrl", async ({
    playwright,
  }) => {
    const anonymous = await playwright.request.newContext({
      baseURL: E2E_BASE_URL,
    });
    try {
      for (const path of [
        `/o/${alpha.slug}/settings?tab=1`,
        `/o/${alpha.slug}`,
      ]) {
        const response = await anonymous.get(path, { maxRedirects: 0 });
        expect(response.status(), path).toBe(307);
        const location = new URL(
          response.headers()["location"] ?? "",
          E2E_BASE_URL,
        );
        expect(location.origin).toBe(E2E_BASE_URL);
        expect(location.pathname).toBe("/login");
        expect(location.searchParams.get("returnUrl")).toBe(path);
        expect(response.headers()["location"]).toContain(
          `returnUrl=${encodeURIComponent(path)}`,
        );
      }
    } finally {
      await anonymous.dispose();
    }
  });

  for (const probe of OPEN_REDIRECT_PROBES) {
    test(`open-redirect probe ${probe} stays same-origin and 404s`, async ({
      page,
      signIn,
    }) => {
      const session = await signIn(WORLD.users.owner, alpha.id);
      const { status } = await followSameOrigin(
        page.request,
        `/o/${beta.slug}/${probe}`,
      );
      expect(status).toBe(404);
      // A rejected target never touches the session.
      expect(await session.activeOrganizationId()).toBe(alpha.id);
    });
  }
});
