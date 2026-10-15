import { expect, test, WORLD } from "../support/fixtures";

const { alpha, beta } = WORLD.orgs;
const { betaRepo } = WORLD.github;

/**
 * Guards #340: the same user may hold one environment per org for the same
 * repository. The seed already gave Beta's repo an environment in Alpha.
 */
test.describe("environment in a second org", () => {
  test("creating Beta's environment for a repo Alpha already has succeeds", async ({
    page,
    signIn,
    pool,
  }) => {
    await signIn(WORLD.users.owner, beta.id);
    await page.goto("/environments");

    await page.getByRole("button", { name: "Create Environment" }).click();
    const dialog = page.getByRole("dialog", { name: "Create Environment" });
    await expect(dialog).toBeVisible();

    const repoButton = dialog.getByRole("button", { name: betaRepo });
    await expect(repoButton).toBeEnabled();
    await repoButton.click();
    await dialog.getByRole("button", { name: "Create Environment" }).click();

    await expect(
      page.getByText(`Environment created for ${betaRepo}`),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/environments\/[^/]+$/);
    const environmentId = new URL(page.url()).pathname.split("/").pop();

    const { rows } = await pool.query<{
      id: string;
      organization_id: string | null;
    }>(
      `SELECT id, organization_id FROM environment
        WHERE user_id = $1 AND repo_full_name = $2
        ORDER BY organization_id`,
      [WORLD.users.owner.id, betaRepo],
    );
    expect(rows.map((row) => row.organization_id).sort()).toEqual(
      [alpha.id, beta.id].sort(),
    );
    expect(rows.find((row) => row.organization_id === beta.id)?.id).toBe(
      environmentId,
    );
  });
});
