import {
  expect,
  orgSwitcherTrigger,
  switchOrganization,
  test,
  WORLD,
} from "../support/fixtures";

const { personal, alpha, beta, gamma } = WORLD.orgs;

test.describe("org switcher", () => {
  test("lists the user's orgs only, personal first", async ({
    page,
    signIn,
  }) => {
    await signIn(WORLD.users.owner, alpha.id);
    await page.goto("/settings");

    const trigger = orgSwitcherTrigger(page);
    await expect(trigger).toHaveAccessibleName(
      `Acting in ${alpha.name}. Switch organization`,
    );
    await trigger.click();

    const options = page.getByRole("option");
    await expect(options.filter({ hasText: personal.name })).toHaveCount(1);
    await expect(options.filter({ hasText: alpha.name })).toHaveCount(1);
    await expect(options.filter({ hasText: beta.name })).toHaveCount(1);
    await expect(options.filter({ hasText: gamma.name })).toHaveCount(0);
    await expect(options.first()).toContainText(personal.name);
  });

  test("switching to Beta moves the session and survives a reload", async ({
    page,
    signIn,
  }) => {
    const session = await signIn(WORLD.users.owner, alpha.id);
    await page.goto("/settings");

    await switchOrganization(page, beta.name);
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect.poll(() => session.activeOrganizationId()).toBe(beta.id);

    await page.reload();
    await expect(orgSwitcherTrigger(page)).toHaveAccessibleName(
      `Acting in ${beta.name}. Switch organization`,
    );
    expect(await session.activeOrganizationId()).toBe(beta.id);
  });
});
