import { describe, it, expect, beforeEach } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "@terragon/shared/db";
import * as schema from "@terragon/shared/db/schema";
import { nanoid } from "nanoid";
import {
  createTestUser,
  createTestAutomation,
} from "@terragon/shared/model/test-helpers";
import { createOrganization } from "@terragon/shared/model/organizations";
import { upsertOrganizationReviewSetting } from "@terragon/shared/model/organization-review-settings";
import type { ThreadTrustContext } from "@terragon/shared/db/types";
import { resolvePermissionModeForDispatch } from "./resolve-permission-mode";

/**
 * The dispatch snapshot seam for the permission-mode floor (ADR-005 §2/§3,
 * #82) — modeled on resolve-approve-floor.test.ts's real test-DB pattern.
 */

const db = createDb(env.DATABASE_URL!);

function trust(fields: {
  isFork: boolean;
  authorAssociation: string;
}): ThreadTrustContext {
  return {
    source: "github-pr",
    capturedAt: new Date().toISOString(),
    ...fields,
  };
}

async function makeOrg(): Promise<string> {
  const org = await createOrganization({
    db,
    name: "acme",
    slug: `acme-${nanoid(8).toLowerCase()}`,
  });
  return org.id;
}

/** Insert a repo-tier trustedAuthorThreshold row directly — no public writer
 * exists for this column yet (ADR-005 §4 reserves it; only the org-tier
 * writer, upsertOrganizationReviewSetting, ships today), so the composition
 * path is exercised at the storage layer. */
async function setRepoTrustedAuthorThreshold({
  organizationId,
  repoFullName,
  trustedAuthorThreshold,
}: {
  organizationId: string;
  repoFullName: string;
  trustedAuthorThreshold: string;
}) {
  await db
    .insert(schema.repoReviewSettings)
    .values({ organizationId, repoFullName, trustedAuthorThreshold })
    .onConflictDoUpdate({
      target: [
        schema.repoReviewSettings.organizationId,
        schema.repoReviewSettings.repoFullName,
      ],
      set: { trustedAuthorThreshold },
    });
}

describe("resolvePermissionModeForDispatch (dispatch snapshot)", () => {
  let userId: string;
  let orgId: string;

  beforeEach(async () => {
    userId = (await createTestUser({ db })).user.id;
    orgId = await makeOrg();
  });

  it("org-less thread + PR automation, unconfigured -> review (default)", async () => {
    const automation = await createTestAutomation({
      db,
      userId,
      values: {
        triggerType: "pull_request",
        triggerConfig: {
          on: { open: true },
          filter: { includeAllAuthors: true },
        },
      },
    });
    const mode = await resolvePermissionModeForDispatch({
      db,
      organizationId: null,
      automation,
      thread: {
        trustContext: trust({ isFork: false, authorAssociation: "MEMBER" }),
      },
    });
    expect(mode).toBe("review");
  });

  it("org+repo compose T_eff: repo raises the bar above the org floor", async () => {
    await upsertOrganizationReviewSetting({
      db,
      organizationId: orgId,
      patch: { trustedAuthorThreshold: "MEMBER" },
    });
    await setRepoTrustedAuthorThreshold({
      organizationId: orgId,
      repoFullName: "acme/widgets",
      trustedAuthorThreshold: "OWNER",
    });
    const automation = await createTestAutomation({
      db,
      userId,
      values: {
        organizationId: orgId,
        repoFullName: "acme/widgets",
        triggerType: "pull_request",
        triggerConfig: {
          on: { open: true },
          filter: { includeAllAuthors: true },
          permissionMode: "allowAll",
        },
      },
    });
    // MEMBER author is trusted under the org floor alone, but the repo raised
    // T_eff to OWNER — MEMBER now falls below the bar (repo can only RAISE,
    // never lower, ADR-005 §4).
    const mode = await resolvePermissionModeForDispatch({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
      automation,
      thread: {
        trustContext: trust({ isFork: false, authorAssociation: "MEMBER" }),
      },
    });
    expect(mode).toBe("review");
  });

  it("trusted-internal PR (author at T_eff) configured allowAll -> allowAll", async () => {
    await upsertOrganizationReviewSetting({
      db,
      organizationId: orgId,
      patch: { trustedAuthorThreshold: "MEMBER" },
    });
    const automation = await createTestAutomation({
      db,
      userId,
      values: {
        organizationId: orgId,
        repoFullName: "acme/widgets",
        triggerType: "pull_request",
        triggerConfig: {
          on: { open: true },
          filter: { includeAllAuthors: true },
          permissionMode: "allowAll",
        },
      },
    });
    const mode = await resolvePermissionModeForDispatch({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
      automation,
      thread: {
        trustContext: trust({ isFork: false, authorAssociation: "MEMBER" }),
      },
    });
    expect(mode).toBe("allowAll");
  });

  it("fork PR configured allowAll -> review regardless of T_eff", async () => {
    const automation = await createTestAutomation({
      db,
      userId,
      values: {
        organizationId: orgId,
        repoFullName: "acme/widgets",
        triggerType: "pull_request",
        triggerConfig: {
          on: { open: true },
          filter: { includeAllAuthors: true },
          permissionMode: "allowAll",
        },
      },
    });
    const mode = await resolvePermissionModeForDispatch({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
      automation,
      thread: {
        trustContext: trust({ isFork: true, authorAssociation: "OWNER" }),
      },
    });
    expect(mode).toBe("review");
  });

  it("trustContext NULL (missing snapshot) fails closed -> review", async () => {
    const automation = await createTestAutomation({
      db,
      userId,
      values: {
        organizationId: orgId,
        repoFullName: "acme/widgets",
        triggerType: "pull_request",
        triggerConfig: {
          on: { open: true },
          filter: { includeAllAuthors: true },
          permissionMode: "allowAll",
        },
      },
    });
    const mode = await resolvePermissionModeForDispatch({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
      automation,
      thread: { trustContext: null },
    });
    expect(mode).toBe("review");
  });

  it("non-PR trigger (schedule) configured plan -> plan", async () => {
    const automation = await createTestAutomation({
      db,
      userId,
      values: {
        organizationId: orgId,
        triggerType: "schedule",
        triggerConfig: {
          cron: "0 9 * * *",
          timezone: "UTC",
          permissionMode: "plan",
        },
      },
    });
    const mode = await resolvePermissionModeForDispatch({
      db,
      organizationId: orgId,
      automation,
      thread: { trustContext: null },
    });
    expect(mode).toBe("plan");
  });

  it("non-PR trigger (schedule) configured review -> review (emit-only opt-in)", async () => {
    const automation = await createTestAutomation({
      db,
      userId,
      values: {
        organizationId: orgId,
        triggerType: "schedule",
        triggerConfig: {
          cron: "0 9 * * *",
          timezone: "UTC",
          permissionMode: "review",
        },
      },
    });
    const mode = await resolvePermissionModeForDispatch({
      db,
      organizationId: orgId,
      automation,
      thread: { trustContext: null },
    });
    expect(mode).toBe("review");
  });

  it("unconfigured non-PR trigger -> allowAll (AC4 regression)", async () => {
    const automation = await createTestAutomation({
      db,
      userId,
      values: {
        organizationId: orgId,
        triggerType: "schedule",
        triggerConfig: { cron: "0 9 * * *", timezone: "UTC" },
      },
    });
    const mode = await resolvePermissionModeForDispatch({
      db,
      organizationId: orgId,
      automation,
      thread: { trustContext: null },
    });
    expect(mode).toBe("allowAll");
  });

  it("unconfigured non-PR trigger falls back to threadChat.permissionMode when set", async () => {
    const automation = await createTestAutomation({
      db,
      userId,
      values: {
        organizationId: orgId,
        triggerType: "schedule",
        triggerConfig: { cron: "0 9 * * *", timezone: "UTC" },
      },
    });
    const mode = await resolvePermissionModeForDispatch({
      db,
      organizationId: orgId,
      automation,
      thread: { trustContext: null },
      threadChatPermissionMode: "plan",
    });
    expect(mode).toBe("plan");
  });

  it("no automation (manual/non-automation thread) -> allowAll, or threadChat mode if set", async () => {
    const modeDefault = await resolvePermissionModeForDispatch({
      db,
      organizationId: null,
      automation: null,
      thread: { trustContext: null },
    });
    expect(modeDefault).toBe("allowAll");

    const modePlan = await resolvePermissionModeForDispatch({
      db,
      organizationId: null,
      automation: null,
      thread: { trustContext: null },
      threadChatPermissionMode: "plan",
    });
    expect(modePlan).toBe("plan");
  });
});
