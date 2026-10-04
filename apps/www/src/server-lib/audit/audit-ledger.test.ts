import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { auditEffects, auditRuns } from "@terragon/shared/db/schema";
import {
  createAuditRunAtDispatch,
  getAuditRunByThread,
  listFindingsForRepo,
} from "@terragon/shared/model/audit-findings";
import {
  createTestOrg,
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import { createDbAuditLedger } from "./audit-ledger";

const REPO = "Acme/Widgets";
const FP = "aaaaaaaaaaaaaaaa";

describe("createDbAuditLedger", () => {
  let orgId: string;
  let runId: string;

  beforeEach(async () => {
    const userId = (await createTestUser({ db })).user.id;
    orgId = await createTestOrg({ db });
    const { threadId } = await createTestThread({ db, userId });
    await createAuditRunAtDispatch({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      threadId,
      audit: "security-audit",
    });
    const run = await getAuditRunByThread({
      db,
      organizationId: orgId,
      threadId,
    });
    runId = run!.id; // created one line above
  });

  function ledger() {
    return createDbAuditLedger({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      runId,
    });
  }

  const insert = {
    repoFullName: REPO,
    fingerprint: FP,
    audit: "security-audit",
    ruleId: "supply.lockfile-missing",
    severity: "high",
    checkKind: "script" as const,
    title: "t",
    recentSightings: [true, true],
  };

  it("persists the finding, the effect and the decisions together", async () => {
    const l = ledger();
    const { effectsEnqueued } = await l.persist({
      inserts: [insert],
      patches: [],
      effects: [
        {
          fingerprint: FP,
          action: "create_issue",
          payload: { title: "t", body: "b", labels: [] },
        },
      ],
      runDecisions: [
        { fingerprint: FP, action: "create", reason: "consensus" },
      ],
    });
    expect(effectsEnqueued).toBe(1);
    const rows = await l.list();
    expect(rows).toHaveLength(1);
    const effects = await db
      .select()
      .from(auditEffects)
      .where(eq(auditEffects.runId, runId));
    expect(effects).toHaveLength(1);
    expect(effects[0]?.findingId).toBe(rows[0]?.id);
    const [run] = await db
      .select()
      .from(auditRuns)
      .where(eq(auditRuns.id, runId));
    expect(run?.decisions).toEqual([
      { fingerprint: FP, action: "create", reason: "consensus" },
    ]);
    expect([...(await l.pendingCreateFingerprints())]).toEqual([FP]);
  });

  it("rolls back every write when one statement fails", async () => {
    const l = ledger();
    await expect(
      l.persist({
        inserts: [insert],
        patches: [],
        effects: [
          {
            fingerprint: FP,
            action: "create_issue",
            // runId is fixed by the ledger; a bad finding id violates the FK.
            findingId: "no-such-finding",
            payload: {},
          },
        ],
        runDecisions: [],
      }),
    ).rejects.toThrow();
    expect(
      await listFindingsForRepo({
        db,
        organizationId: orgId,
        repoFullName: REPO,
      }),
    ).toHaveLength(0);
    expect(
      await db.select().from(auditEffects).where(eq(auditEffects.runId, runId)),
    ).toHaveLength(0);
  });

  it("markIssueCreated stamps the issue, status and the auto-fix flags", async () => {
    const l = ledger();
    await l.persist({
      inserts: [insert],
      patches: [],
      effects: [
        {
          fingerprint: FP,
          action: "create_issue",
          payload: {
            title: "t",
            body: "b",
            labels: [],
            status: "open",
            autoFix: true,
            planHash: "h1",
          },
        },
      ],
      runDecisions: [],
    });
    const [effect] = await db
      .select()
      .from(auditEffects)
      .where(eq(auditEffects.runId, runId));
    const now = new Date("2026-10-04T12:00:00Z");
    await l.markIssueCreated(effect!, 77, now); // one effect was just inserted
    const [row] = await l.list();
    expect(row).toMatchObject({
      issueNumber: 77,
      status: "open",
      autoFixLabeled: true,
      planHash: "h1",
    });
    expect(row?.fixReadyAt?.getTime()).toBe(now.getTime());
    expect(await l.issueNumberFor(effect!)).toBe(77);
    expect(await l.countOpenIssues()).toBe(1);
  });
});
