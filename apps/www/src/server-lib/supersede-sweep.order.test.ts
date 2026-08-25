import { describe, it, vi, beforeEach, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestOrg,
  createTestRemoteRun,
} from "@terragon/shared/model/test-helpers";
import { markThreadTerminal } from "@terragon/shared/model/threads";
import { hatchetRun as hatchetRunTable } from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { runSupersedeSweep } from "./supersede-sweep";

// Fault injection on the thread write: the run row must NOT be retired when
// the thread terminal failed, or it silently leaves the sweep's candidate
// set while the thread never terminates ("exactly-once by construction"
// relies on this ordering — the two writes are not one transaction).
vi.mock("@terragon/shared/model/threads", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    markThreadTerminal: vi.fn(
      actual.markThreadTerminal as (...a: unknown[]) => Promise<boolean>,
    ),
  };
});

describe("supersede sweep — terminal write ordering under a thread-write failure", () => {
  const T = 10 * 60 * 1000;
  let userId: string;
  let orgId: string;

  beforeEach(async () => {
    vi.mocked(markThreadTerminal).mockReset();
    const actual = (await vi.importActual(
      "@terragon/shared/model/threads",
    )) as { markThreadTerminal: typeof markThreadTerminal };
    vi.mocked(markThreadTerminal).mockImplementation(actual.markThreadTerminal);
    userId = (await createTestUser({ db })).user.id;
    orgId = await createTestOrg({ db });
  });

  it("thread write throws → run row stays in_flight (retried next tick); once it succeeds → retired", async () => {
    const run = await createTestRemoteRun({
      db,
      userId,
      organizationId: orgId,
      prNumber: 41,
      externalId: "r-order",
      ageMs: T + 60_000,
      repoFullName: "be-automata/automata",
    });
    const rowStatus = async () =>
      (
        await db
          .select({ status: hatchetRunTable.status })
          .from(hatchetRunTable)
          .where(eq(hatchetRunTable.id, run.runId))
      )[0]!.status;

    vi.mocked(markThreadTerminal).mockRejectedValueOnce(new Error("db blip"));
    const first = await runSupersedeSweep({
      cancelledAfterMs: T,
      orphanAfterMs: 15 * 60 * 1000,
      readStatus: async () => "FAILED",
    });
    expect(first.terminals).toEqual([]);
    expect(first.errors).toEqual([
      { externalId: "r-order", message: "db blip" },
    ]);
    expect(await rowStatus()).toBe("in_flight"); // NOT retired
    expect(markThreadTerminal).toHaveBeenCalledTimes(1);

    const second = await runSupersedeSweep({
      cancelledAfterMs: T,
      orphanAfterMs: 15 * 60 * 1000,
      readStatus: async () => "FAILED",
    });
    expect(second.terminals).toEqual([
      { threadId: run.threadId, cause: "daemon-failed" },
    ]);
    expect(await rowStatus()).toBe("terminal");
  });
});
