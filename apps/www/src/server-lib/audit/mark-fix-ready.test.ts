import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import {
  getFindingByIssue,
  insertFinding,
  updateFinding,
} from "@terragon/shared/model/audit-findings";
import { createTestOrg } from "@terragon/shared/model/test-helpers";

import { clearFindingFixReady, markFindingFixReady } from "./mark-fix-ready";

const REPO = "Acme/Widgets";
const BOT = "automata-app[bot]";

describe("markFindingFixReady", () => {
  let orgId: string;
  let otherOrgId: string;

  async function seed({
    organizationId,
    issueNumber,
    fingerprint,
    status = "open",
    checkKind = "script",
  }: {
    organizationId: string;
    issueNumber: number;
    fingerprint: string;
    status?: "candidate" | "open" | "resolved" | "needs_human" | "suppressed";
    checkKind?: "script" | "rubric";
  }) {
    const row = await insertFinding({
      db,
      organizationId,
      finding: {
        repoFullName: REPO,
        fingerprint,
        audit: "security-audit",
        ruleId: "supply.lockfile-missing",
        severity: "high",
        checkKind,
        title: "t",
      },
    });
    await updateFinding({
      db,
      organizationId,
      id: row.id,
      patch: { issueNumber, status },
    });
  }

  beforeEach(async () => {
    orgId = await createTestOrg({ db });
    otherOrgId = await createTestOrg({ db });
    await seed({
      organizationId: orgId,
      issueNumber: 11,
      fingerprint: "a".repeat(16),
    });
    await seed({
      organizationId: orgId,
      issueNumber: 12,
      fingerprint: "b".repeat(16),
      checkKind: "rubric",
    });
    await seed({
      organizationId: orgId,
      issueNumber: 13,
      fingerprint: "c".repeat(16),
      status: "needs_human",
    });
    await seed({
      organizationId: orgId,
      issueNumber: 14,
      fingerprint: "d".repeat(16),
      status: "resolved",
    });
    await seed({
      organizationId: otherOrgId,
      issueNumber: 15,
      fingerprint: "e".repeat(16),
    });
  });

  function mark(
    issueNumber: number,
    opts: { organizationId?: string; author?: string; now?: Date } = {},
  ) {
    return markFindingFixReady({
      db,
      organizationId: opts.organizationId ?? orgId,
      repoFullName: REPO,
      issueNumber,
      issueAuthorLogin: opts.author ?? BOT,
      botLogin: BOT,
      now: opts.now ?? new Date("2026-10-04T10:00:00Z"),
    });
  }

  it("marks a bot-filed open script finding once, then reports already_ready", async () => {
    const first = await mark(11);
    expect(first.outcome).toBe("marked");
    expect(first.fingerprint).toBe("a".repeat(16));
    const row = await getFindingByIssue({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      issueNumber: 11,
    });
    expect(row?.autoFixLabeled).toBe(true);
    expect(row?.fixReadyAt?.toISOString()).toBe("2026-10-04T10:00:00.000Z");

    const second = await mark(11, { now: new Date("2026-10-05T10:00:00Z") });
    expect(second.outcome).toBe("already_ready");
    const again = await getFindingByIssue({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      issueNumber: 11,
    });
    expect(again?.fixReadyAt?.toISOString()).toBe("2026-10-04T10:00:00.000Z");
  });

  it("matches the bot author and the repo case-insensitively", async () => {
    const result = await markFindingFixReady({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
      issueNumber: 11,
      issueAuthorLogin: "Automata-App[bot]",
      botLogin: BOT,
      now: new Date("2026-10-04T10:00:00Z"),
    });
    expect(result.outcome).toBe("marked");
  });

  it("ignores an unknown issue number", async () => {
    expect((await mark(999)).outcome).toBe("not_a_ledger_issue");
  });

  it("ignores a human-filed issue and leaves the row untouched", async () => {
    expect((await mark(11, { author: "mallory" })).outcome).toBe(
      "author_not_bot",
    );
    expect((await mark(11, { author: "" })).outcome).toBe("author_not_bot");
    const row = await getFindingByIssue({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      issueNumber: 11,
    });
    expect(row?.autoFixLabeled).toBe(false);
    expect(row?.fixReadyAt).toBeNull();
  });

  it("ignores a rubric finding", async () => {
    expect((await mark(12)).outcome).toBe("not_script_rule");
  });

  it("ignores needs_human and resolved findings", async () => {
    expect((await mark(13)).outcome).toBe("status_not_open");
    expect((await mark(14)).outcome).toBe("status_not_open");
  });

  it("never crosses organizations", async () => {
    expect((await mark(15)).outcome).toBe("not_a_ledger_issue");
    const row = await getFindingByIssue({
      db,
      organizationId: otherOrgId,
      repoFullName: REPO,
      issueNumber: 15,
    });
    expect(row?.fixReadyAt).toBeNull();
  });

  it("R7: clearFindingFixReady withdraws readiness (issue closed / trigger label removed), org-fenced", async () => {
    await mark(11);
    const clear = (issueNumber: number, organizationId = orgId) =>
      clearFindingFixReady({
        db,
        organizationId,
        repoFullName: "acme/widgets",
        issueNumber,
      });
    expect(await clear(11)).toEqual({
      outcome: "cleared",
      fingerprint: "a".repeat(16),
    });
    const row = await getFindingByIssue({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      issueNumber: 11,
    });
    expect(row?.autoFixLabeled).toBe(false);
    expect(row?.fixReadyAt).toBeNull();
    expect((await clear(11)).outcome).toBe("not_ready");
    expect((await clear(999)).outcome).toBe("not_a_ledger_issue");
    // Another org's issue number is not reachable from this org.
    expect((await clear(15)).outcome).toBe("not_a_ledger_issue");
    // Re-labelling marks it again.
    expect((await mark(11)).outcome).toBe("marked");
  });
});
