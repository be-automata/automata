import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import {
  getFeatureFlagForUser,
  setUserFeatureFlagOverride,
} from "@terragon/shared/model/feature-flags";
import {
  getOrganizationCellsEnabled,
  setOrganizationCellsEnabled,
} from "@terragon/shared/model/organizations";
import {
  createTestOrg,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import { cellAgentSupported, cellsEnabledForRun } from "./cell-gate";

// Pass-through spies: the real reads run, and a test can assert one was skipped.
vi.mock("@terragon/shared/model/feature-flags", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@terragon/shared/model/feature-flags")
    >();
  return {
    ...actual,
    getFeatureFlagForUser: vi.fn(actual.getFeatureFlagForUser),
  };
});
vi.mock("@terragon/shared/model/organizations", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@terragon/shared/model/organizations")
    >();
  return {
    ...actual,
    getOrganizationCellsEnabled: vi.fn(actual.getOrganizationCellsEnabled),
  };
});

/**
 * #708: the cells gate is configured AND org enabled AND user flag, read from
 * the real database (the org row and the per-user flag override).
 */

function setCellsEnv(on: boolean): void {
  const e = env as { OPENSANDBOX_URL: string; OPENSANDBOX_API_KEY: string };
  e.OPENSANDBOX_URL = on ? "http://127.0.0.1:18090" : "";
  e.OPENSANDBOX_API_KEY = on ? "test-key" : "";
}

async function setUserFlag(userId: string, value: boolean): Promise<void> {
  await setUserFeatureFlagOverride({
    db,
    userId,
    name: "opensandboxCells",
    value,
  });
}

describe("cellsEnabledForRun", () => {
  let userId: string;
  let orgId: string;

  beforeEach(async () => {
    userId = (await createTestUser({ db })).user.id;
    orgId = await createTestOrg({ db });
  });

  afterEach(() => {
    setCellsEnv(false);
  });

  const table: Array<{
    configured: boolean;
    user: boolean;
    org: boolean;
    expected: boolean;
  }> = [];
  for (const configured of [true, false]) {
    for (const user of [true, false]) {
      for (const org of [true, false]) {
        table.push({
          configured,
          user,
          org,
          expected: configured && user && org,
        });
      }
    }
  }

  it.each(table)(
    "configured=$configured user=$user org=$org -> $expected",
    async ({ configured, user, org, expected }) => {
      setCellsEnv(configured);
      await setUserFlag(userId, user);
      await setOrganizationCellsEnabled({
        db,
        organizationId: orgId,
        enabled: org,
      });
      expect(
        await cellsEnabledForRun({ db, userId, organizationId: orgId }),
      ).toBe(expected);
    },
  );

  it.each([null, undefined, ""])(
    "an org-less run (%j) is never eligible",
    async (organizationId) => {
      setCellsEnv(true);
      await setUserFlag(userId, true);
      expect(await cellsEnabledForRun({ db, userId, organizationId })).toBe(
        false,
      );
    },
  );

  it("an unconfigured deployment reads neither the org nor the flag", async () => {
    setCellsEnv(false);
    vi.mocked(getFeatureFlagForUser).mockClear();
    vi.mocked(getOrganizationCellsEnabled).mockClear();
    expect(
      await cellsEnabledForRun({ db, userId, organizationId: orgId }),
    ).toBe(false);
    expect(getOrganizationCellsEnabled).not.toHaveBeenCalled();
    expect(getFeatureFlagForUser).not.toHaveBeenCalled();
  });

  it("an org that is off skips the flag read", async () => {
    setCellsEnv(true);
    vi.mocked(getFeatureFlagForUser).mockClear();
    expect(
      await cellsEnabledForRun({ db, userId, organizationId: orgId }),
    ).toBe(false);
    expect(getOrganizationCellsEnabled).toHaveBeenCalled();
    expect(getFeatureFlagForUser).not.toHaveBeenCalled();
  });

  it("a missing org row is off", async () => {
    setCellsEnv(true);
    await setUserFlag(userId, true);
    expect(
      await cellsEnabledForRun({
        db,
        userId,
        organizationId: "no-such-org",
      }),
    ).toBe(false);
  });

  it("org A on and org B off, same user: only A is eligible", async () => {
    setCellsEnv(true);
    await setUserFlag(userId, true);
    const orgB = await createTestOrg({ db, name: "Org B" });
    await setOrganizationCellsEnabled({
      db,
      organizationId: orgId,
      enabled: true,
    });
    expect(
      await cellsEnabledForRun({ db, userId, organizationId: orgId }),
    ).toBe(true);
    expect(await cellsEnabledForRun({ db, userId, organizationId: orgB })).toBe(
      false,
    );
  });
});

describe("cellAgentSupported (#718)", () => {
  it("is true only for claudeCode", () => {
    expect(cellAgentSupported("claudeCode")).toBe(true);
    for (const agent of [
      "codex",
      "gemini",
      "amp",
      "opencode",
      "",
      "ClaudeCode",
    ]) {
      expect(cellAgentSupported(agent)).toBe(false);
    }
  });

  it("fails closed on null and undefined", () => {
    expect(cellAgentSupported(null)).toBe(false);
    expect(cellAgentSupported(undefined)).toBe(false);
  });
});
