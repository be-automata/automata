import { E2E_SLACK_CLIENT_ID } from "../e2e-env";
import { expect, test, WORLD } from "../support/fixtures";

const { alpha, beta } = WORLD.orgs;

/** True for the POST a Next.js server action makes from the page. */
function isServerAction(request: {
  method(): string;
  headers(): Record<string, string>;
}) {
  return request.method() === "POST" && "next-action" in request.headers();
}

test.describe("Slack install-target dialog", () => {
  test("names Beta and sends Beta as the expected org", async ({
    page,
    signIn,
    slackNavigations,
  }) => {
    await signIn(WORLD.users.owner, beta.id);
    await page.goto("/settings/integrations");

    const install = page.getByRole("button", {
      name: `Install into ${beta.name}`,
    });
    await expect(install).toBeEnabled();
    await install.click();

    const dialog = page.getByRole("dialog", {
      name: `Install Slack into ${beta.name}`,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(WORLD.slack.teamName);

    const actionRequest = page.waitForRequest(
      (request) =>
        isServerAction(request) &&
        (request.postData() ?? "").includes("expectedOrganizationId"),
    );
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "Continue to Slack" }).click();
    const body = (await actionRequest).postData() ?? "";
    expect(body).toContain(`"expectedOrganizationId":"${beta.id}"`);
    expect(body).toContain(`"teamId":"${WORLD.slack.teamId}"`);

    // The page then sends the browser to Slack's authorize URL (aborted).
    await expect.poll(() => slackNavigations.length).toBeGreaterThan(0);
    const authorize = new URL(slackNavigations[0]!);
    expect(authorize.pathname).toBe("/oauth/v2/authorize");
    expect(authorize.searchParams.get("client_id")).toBe(E2E_SLACK_CLIENT_ID);
    expect(authorize.searchParams.get("team")).toBe(WORLD.slack.teamId);
  });

  test("refuses when another tab switched org after the page loaded", async ({
    page,
    context,
    signIn,
    slackNavigations,
  }) => {
    await signIn(WORLD.users.owner, beta.id);
    await page.goto("/settings/integrations");
    await page
      .getByRole("button", { name: `Install into ${beta.name}` })
      .click();
    const dialog = page.getByRole("dialog", {
      name: `Install Slack into ${beta.name}`,
    });
    await expect(dialog).toBeVisible();

    // A second tab of the same session moves it to Alpha.
    const otherTab = await context.newPage();
    await otherTab.goto(`/o/${alpha.slug}`);
    await expect(otherTab).toHaveURL(/\/dashboard$/);
    await otherTab.close();

    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "Continue to Slack" }).click();
    await expect(
      page.getByText(
        "Your active organization changed in another tab. Reload the page and try again.",
      ),
    ).toBeVisible();
    expect(slackNavigations).toEqual([]);
  });
});
