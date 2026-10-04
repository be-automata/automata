import { beforeEach, describe, expect, it, vi } from "vitest";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { auditRuns } from "@terragon/shared/db/schema";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { createOrganization } from "@terragon/shared/model/organizations";
import { insertFinding } from "@terragon/shared/model/audit-findings";
import { upsertFeatureFlag } from "@terragon/shared/model/feature-flags";
import type { DB } from "@terragon/shared/db";
import { upsertRepoReviewSetting } from "@terragon/shared/model/repo-review-settings";

import {
  hashSelfHealToken,
  mintSelfHealToken,
  planSelfHealAuditRun,
} from "./plan-self-heal-run";

const REPO = "acme/widgets";
const STAMP = {
  type: "automation-skill" as const,
  skillName: "audit-findings",
  contentSha: "sha",
  source: "db",
};

describe("planSelfHealAuditRun", () => {
  let orgId: string;
  let threadId: string;

  const plan = (sourceMetadata: unknown = STAMP) =>
    planSelfHealAuditRun({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      threadId,
      sourceMetadata: sourceMetadata as never,
    });

  const finding = (fingerprint: string, over: Record<string, unknown> = {}) =>
    insertFinding({
      db,
      organizationId: orgId,
      finding: {
        repoFullName: REPO,
        fingerprint,
        audit: "security-audit",
        ruleId: "supply.lockfile-missing",
        severity: "high",
        checkKind: "script",
        title: `finding ${fingerprint}`,
        subject: "pnpm-lock.yaml",
        status: "open",
        ...over,
      },
    });

  const runRows = () =>
    db.select().from(auditRuns).where(eq(auditRuns.threadId, threadId));

  beforeEach(async () => {
    vi.restoreAllMocks();
    await upsertFeatureFlag({
      db,
      name: "selfHealLoop",
      updates: { defaultValue: false, globalOverride: true },
    });
    const user = (await createTestUser({ db })).user;
    orgId = (
      await createOrganization({
        db,
        name: "Org",
        slug: `org-${nanoid(8).toLowerCase()}`,
      })
    ).id;
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: { selfHealMode: "dry-run" },
    });
    threadId = (await createTestThread({ db, userId: user.id })).threadId;
  });

  it("returns {} for an unstamped thread", async () => {
    expect(await plan(null)).toEqual({});
    expect(await plan({ ...STAMP, skillName: "other" })).toEqual({});
    expect(await runRows()).toHaveLength(0);
  });

  it("returns {} and creates no run when the effective mode is off", async () => {
    await upsertFeatureFlag({
      db,
      name: "selfHealLoop",
      updates: { defaultValue: false, globalOverride: false },
    });
    expect(await plan()).toEqual({});
    expect(await runRows()).toHaveLength(0);
  });

  it("lists script findings with their rule check kind and stores only the token hash", async () => {
    await finding("aaaaaaaaaaaaaaa1");
    await finding("aaaaaaaaaaaaaaa2", {
      ruleId: "files.gitignore-missing-pattern",
      subject: ".gitignore",
      findingKey: ".env",
    });
    await finding("aaaaaaaaaaaaaaa3", { checkKind: "rubric" });
    await finding("aaaaaaaaaaaaaaa4", { status: "suppressed" });
    await finding("aaaaaaaaaaaaaaa5", { status: "candidate" });

    const { selfHeal } = await plan();
    expect(selfHeal?.kind).toBe("audit");
    expect(selfHeal?.checkToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(selfHeal?.checks.map((c) => c.fingerprint).sort()).toEqual([
      "aaaaaaaaaaaaaaa1",
      "aaaaaaaaaaaaaaa2",
      "aaaaaaaaaaaaaaa5",
    ]);
    expect(
      selfHeal?.checks.find((c) => c.fingerprint === "aaaaaaaaaaaaaaa2"),
    ).toEqual({
      fingerprint: "aaaaaaaaaaaaaaa2",
      check: "gitignore-has-pattern",
      subject: ".gitignore",
      key: ".env",
    });

    const rows = await runRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("dispatched");
    expect(rows[0]?.requestedChecks).toEqual(selfHeal?.checks);
    expect(rows[0]?.checkTokenHash).toBe(
      hashSelfHealToken(selfHeal?.checkToken ?? ""),
    );
    expect(JSON.stringify(rows[0])).not.toContain(selfHeal?.checkToken ?? "?");
    const ttl = (rows[0]?.checkTokenExpiresAt?.getTime() ?? 0) - Date.now();
    expect(ttl).toBeGreaterThan(44 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(45 * 60 * 1000);
  });

  it("caps the checks at 50, highest severity first", async () => {
    for (let i = 0; i < 60; i++) {
      await finding(i.toString(16).padStart(16, "0"), {
        severity: i < 5 ? "low" : "high",
      });
    }
    const { selfHeal } = await plan();
    expect(selfHeal?.checks).toHaveLength(50);
    const lowFps = new Set(
      Array.from({ length: 5 }, (_, i) => i.toString(16).padStart(16, "0")),
    );
    expect(selfHeal?.checks.some((c) => lowFps.has(c.fingerprint))).toBe(false);
  });

  it("never throws: a database failure yields {} and one warn line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await planSelfHealAuditRun({
      db: {} as DB,
      organizationId: orgId,
      repoFullName: REPO,
      threadId,
      sourceMetadata: STAMP,
    });
    expect(result).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(
      "[hatchet] self-heal: audit planning failed",
    );
    expect(await runRows()).toHaveLength(0);
  });

  it("mints distinct 43-char tokens whose hash is sha256 hex", () => {
    const a = mintSelfHealToken();
    expect(a).toHaveLength(43);
    expect(a).not.toBe(mintSelfHealToken());
    expect(hashSelfHealToken(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});
