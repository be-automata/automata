import { expect, test, WORLD } from "../support/fixtures";

const { beta } = WORLD.orgs;
const { alphaRepo, betaRepo } = WORLD.github;

/**
 * Guards #344: the stored repo (Alpha's) must never show, or be the cue,
 * while Beta's repo list is still loading.
 */
test.describe("runs-in cue", () => {
  test("names nothing while Beta's repos load, then Beta and its repo", async ({
    page,
    signIn,
    setGithubDelay,
  }) => {
    // A user whose GitHub listing cache no earlier spec has warmed.
    await signIn(WORLD.users.cueWatcher, beta.id);
    setGithubDelay(3000);
    await page.goto("/dashboard");

    const cue = page.getByText(/^Runs in/);
    // Inside the delay window: the prompt box is up, the repo list is not.
    await expect(page.getByRole("button", { name: /Acting in/ })).toBeVisible();
    await page.waitForTimeout(1000);
    await expect(cue).toHaveCount(0);
    await expect(page.getByText(alphaRepo)).toHaveCount(0);

    // After the list arrives the cue names Beta and Beta's repo.
    const label = `Runs in ${beta.name} · ${betaRepo}`;
    await expect(page.getByTitle(label)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTitle(label)).toContainText(beta.name);
    await expect(page.getByTitle(label)).toContainText(betaRepo);
    await expect(page.getByText(alphaRepo)).toHaveCount(0);
  });
});
