import { beforeEach, describe, expect, it, vi } from "vitest";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { createOrganization } from "@terragon/shared/model/organizations";
import {
  getCellDecisionsForThread,
  insertProfileEvidence,
  upsertExecutionProfile,
} from "@terragon/shared/model/execution-profiles";
import type { User } from "@terragon/shared";
import { installTestPlaneKey } from "./__fixtures__/plane-key";
import { CELL_POLICY_WASM_GLOBAL } from "@terragon/shared/cell-policy/cell-policy-global";
import { resetCellPolicyForTests } from "@/server-lib/compute/resolve-cell-decision";
import { dispatchAgentRun } from "./dispatch";

/**
 * ADR-014 step 5, slice 1: the allow_cell resolver runs at the dispatch seam
 * in SHADOW mode. Whatever it decides, and even when it fails, the run is
 * triggered exactly as before and one cell_decision row records the outcome.
 */

installTestPlaneKey("plane-cell-shadow");

const okTrigger = () =>
  vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ run: { metadata: { id: "run-cell" } } }), {
      status: 200,
    }),
  );

describe("dispatchAgentRun: allow_cell shadow", () => {
  let user: User;
  let threadId: string;
  let threadChatId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    user = (await createTestUser({ db })).user;
    const org = await createOrganization({
      db,
      name: "Org",
      slug: `org-${nanoid(8).toLowerCase()}`,
    });
    const t = await createTestThread({
      db,
      userId: user.id,
      overrides: { organizationId: org.id },
    });
    threadId = t.threadId;
    threadChatId = t.threadChatId;
  });

  const dispatch = () =>
    dispatchAgentRun({
      userId: user.id,
      threadId,
      threadChatId,
      repoFullName: "be-automata/automata",
      branch: "main",
    });

  it("a denial is recorded and the run is still triggered", async () => {
    // The box in observe mode with fresh evidence: the policy denies it as
    // open egress (no egress policy on this repo).
    const profile = await upsertExecutionProfile({
      db,
      id: "automata-box/observe",
      provider: "automata-box",
      tier: "customer_box",
      configuration: { egress_mode: "observe" },
    });
    for (const capability of [
      "metadata_blocked",
      "peer_isolated",
      "teardown_verified",
      "secret_brokering",
    ]) {
      await insertProfileEvidence({
        db,
        evidence: {
          profileId: profile.id,
          capability,
          measuredAt: new Date(Date.now() - 86_400_000),
          source: "conformance",
          result: { value: true },
        },
      });
    }
    const fetchMock = okTrigger();
    vi.stubGlobal("fetch", fetchMock);

    await dispatch();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const rows = await getCellDecisionsForThread({ db, threadId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      threadChatId,
      profileId: "automata-box/observe",
      allowed: false,
      seam: "dispatch",
      mode: "shadow",
    });
    expect(rows[0]!.reasons).toContain("egress_open");
    const input = rows[0]!.input as {
      cell: { lane: string; secrets: string[]; repo_visibility: string };
    };
    expect(input.cell.lane).toBe("task");
    // GitHub is not reachable in tests: visibility fails closed to private.
    expect(input.cell.repo_visibility).toBe("private");
    expect(input.cell.secrets).toEqual(
      expect.arrayContaining(["daemonToken", "installationToken"]),
    );
    // Names only: the sealed values never reach the decision record.
    expect(JSON.stringify(rows[0]!.input)).not.toMatch(/ghs_|daemon_/);
  });

  it("a resolver failure is recorded as resolver_error and the run is still triggered", async () => {
    // The Workers path with a broken module: an empty WASM module registered
    // where worker-entry.ts registers the policy. Loading it fails inside the
    // resolver (no OPA exports), after the catalog read.
    const globals = globalThis as Record<symbol, unknown>;
    globals[CELL_POLICY_WASM_GLOBAL] = new WebAssembly.Module(
      new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    );
    resetCellPolicyForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = okTrigger();
    vi.stubGlobal("fetch", fetchMock);

    await expect(dispatch()).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const rows = await getCellDecisionsForThread({ db, threadId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      allowed: false,
      reasons: ["resolver_error"],
      mode: "shadow",
    });
    expect(warn).toHaveBeenCalledWith(
      "[cell] resolver error (shadow: dispatch proceeds)",
      expect.anything(),
    );
    delete globals[CELL_POLICY_WASM_GLOBAL];
    resetCellPolicyForTests();
    warn.mockRestore();
  });
});
