import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import { env } from "@terragon/env/pkg-shared";
import { createDb } from "@terragon/shared/db";
import { repoReviewSettings } from "@terragon/shared/db/schema";
import { createOrganization } from "@terragon/shared/model/organizations";
import {
  ORG_DEFAULT_REPO_SENTINEL,
  upsertRepoReviewSetting,
} from "@terragon/shared/model/repo-review-settings";

import { resolveReviewPromptMode } from "./resolve-review-prompt-mode";

/**
 * Render-time review mode (phase 6): the prompt picks its review-mode sections
 * from the SAME Phase 4 resolver dispatch uses, and an invalid stored value
 * degrades only the PROMPT to classic (dispatch still refuses loudly).
 */

const db = createDb(env.DATABASE_URL!);
const REPO = "acme/widgets";

const TRUSTED = {
  source: "github-pr" as const,
  isFork: false,
  isCrossRepo: false,
  authorAssociation: "MEMBER",
  capturedAt: "2026-10-04T00:00:00.000Z",
};

describe("resolveReviewPromptMode", () => {
  let orgId: string;

  beforeEach(async () => {
    const org = await createOrganization({
      db,
      name: "acme",
      slug: `acme-${nanoid(8).toLowerCase()}`,
    });
    orgId = org.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const resolve = (trustContext: typeof TRUSTED | null = TRUSTED) =>
    resolveReviewPromptMode({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      trustContext,
    });

  it("no rows → classic", async () => {
    expect(await resolve()).toEqual({ mode: "classic", runTests: false });
  });

  it("repo row orchestrated → orchestrated without tests", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: { reviewMode: "orchestrated" },
    });
    expect(await resolve()).toEqual({ mode: "orchestrated", runTests: false });
  });

  it("'*' org default orchestrated with the repo inheriting → orchestrated", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: ORG_DEFAULT_REPO_SENTINEL,
      patch: { reviewMode: "orchestrated" },
    });
    expect(await resolve()).toEqual({ mode: "orchestrated", runTests: false });
  });

  it("orchestrated + runTests + same-repo trusted → runTests true; fork → false", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: { reviewMode: "orchestrated", reviewRunTests: true },
    });
    expect(await resolve()).toEqual({ mode: "orchestrated", runTests: true });
    expect(await resolve({ ...TRUSTED, isFork: true })).toEqual({
      mode: "orchestrated",
      runTests: false,
    });
  });

  it("an invalid stored value → classic, one fixed-string error log", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: { reviewMode: "classic" },
    });
    await db
      .update(repoReviewSettings)
      .set({ reviewMode: "turbo" })
      .where(
        and(
          eq(repoReviewSettings.organizationId, orgId),
          eq(repoReviewSettings.repoFullName, REPO),
        ),
      );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await resolve()).toEqual({ mode: "classic", runTests: false });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    // Exact arguments: no argument carries the resolver's message or "turbo".
    expect(errorSpy).toHaveBeenCalledWith(
      orgId,
      REPO,
      "invalid review-agent setting; rendering classic prompt",
    );
  });
});
