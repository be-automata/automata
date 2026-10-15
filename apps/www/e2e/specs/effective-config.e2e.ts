import type { Locator } from "@playwright/test";

import { expect, test, WORLD } from "../support/fixtures";

const { beta } = WORLD.orgs;

/** The Source cell: the winning badge first, then the struck ones. */
function sourceCell(row: Locator): Locator {
  return row.getByRole("cell").nth(2);
}

test.describe("effective configuration", () => {
  test("shows the winning layer per key and never a value", async ({
    page,
    signIn,
    world,
  }) => {
    await signIn(WORLD.users.owner, beta.id);
    await page.goto(`/environments/${world.effectiveEnvironmentId}`);

    const heading = page.getByRole("heading", {
      name: "Effective configuration",
    });
    await expect(heading).toBeVisible();
    const table = page
      .locator("div", { has: heading })
      .last()
      .getByRole("table");
    const rowFor = (key: string) =>
      table.getByRole("row").filter({
        has: page.getByRole("cell", { name: key, exact: true }),
      });

    // Global + Organization + Repo: the repository value wins.
    const shared = rowFor("E2E_SHARED_KEY");
    await expect(shared).toHaveCount(1);
    await expect(sourceCell(shared)).toHaveText(/^RepoGlobalOrganization/);
    await expect(shared).toContainText(
      "Global, Organization overridden by Repo",
    );

    // Global + Organization: the organization wins.
    const orgAndGlobal = rowFor("E2E_ORG_AND_GLOBAL_KEY");
    await expect(sourceCell(orgAndGlobal)).toHaveText(/^OrganizationGlobal/);
    await expect(orgAndGlobal).toContainText(
      "Global overridden by Organization",
    );

    // Global only.
    const globalOnly = rowFor("E2E_GLOBAL_ONLY_KEY");
    await expect(sourceCell(globalOnly)).toHaveText("Global");

    // Every value cell is masked.
    const valueCells = table.getByRole("cell", { name: "Hidden value" });
    await expect(valueCells).toHaveCount(3);
    for (const text of await valueCells.allInnerTexts()) {
      expect(text.trim()).toBe("••••");
    }

    // No inherited (org/global) plaintext reaches the page at all; the
    // repository's own values only through the owner's editor, never here.
    const html = await page.content();
    for (const secret of [
      ...world.seededSecretValues.global,
      ...world.seededSecretValues.organization,
    ]) {
      expect(html).not.toContain(secret);
    }
    const tableText = await table.innerText();
    for (const secret of world.seededSecretValues.repository) {
      expect(tableText).not.toContain(secret);
    }
  });
});
