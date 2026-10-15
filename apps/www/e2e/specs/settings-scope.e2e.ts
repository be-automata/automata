import { expect, switchOrganization, test, WORLD } from "../support/fixtures";

const { alpha, beta } = WORLD.orgs;

test.describe("settings scope", () => {
  test("nav groups Account and the active org, and follows a switch", async ({
    page,
    signIn,
  }) => {
    await signIn(WORLD.users.owner, alpha.id);
    await page.goto("/settings");

    const nav = page.getByRole("navigation", { name: "Settings" });
    /** The smallest nav group headed `name` that holds Integrations. */
    const orgGroup = (name: string) =>
      nav
        .locator("div")
        .filter({ has: page.getByText(name, { exact: true }) })
        .filter({ has: page.getByRole("link", { name: "Integrations" }) })
        .filter({ hasNot: page.getByRole("link", { name: "General" }) })
        .last();
    await expect(nav.getByText("Account", { exact: true })).toBeVisible();
    await expect(nav.getByText(alpha.name, { exact: true })).toBeVisible();
    // Org-scoped pages sit under the org's name, account pages under Account.
    await expect(orgGroup(alpha.name)).toBeVisible();
    await expect(
      orgGroup(alpha.name).getByRole("link", { name: "PR Review" }),
    ).toBeVisible();

    await switchOrganization(page, beta.name);
    await page.goto("/settings");
    await expect(orgGroup(beta.name)).toBeVisible();
    await expect(nav.getByText(alpha.name, { exact: true })).toHaveCount(0);
    await expect(nav.getByText("Account", { exact: true })).toBeVisible();
  });
});
