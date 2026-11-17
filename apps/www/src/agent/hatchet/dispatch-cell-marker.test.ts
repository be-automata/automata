import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import type { User } from "@terragon/shared";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import {
  createTestOrg,
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import { installTestPlaneKey } from "./__fixtures__/plane-key";
import {
  createBootingPRThread,
  createReviewAutomation,
  routedHatchetFetch,
  triggerBody,
} from "./__fixtures__/review-thread";
import { dispatchAgentRun } from "./dispatch";

vi.mock("@terragon/shared/model/feature-flags", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@terragon/shared/model/feature-flags")
  >()),
  getFeatureFlagForUser: vi.fn(),
}));

/**
 * #634 S4: dispatch marks a plain org task run with `cell: "opensandbox"` when
 * OpenSandbox is configured and the flag is on for the user. The marker is a
 * reference: the sealed secrets are the same shape with it on or off.
 */

const plane = installTestPlaneKey("plane-cell-marker");

function setCellsEnv(on: boolean): void {
  const e = env as { OPENSANDBOX_URL: string; OPENSANDBOX_API_KEY: string };
  e.OPENSANDBOX_URL = on ? "http://127.0.0.1:18090" : "";
  e.OPENSANDBOX_API_KEY = on ? "test-key" : "";
}

describe("dispatchAgentRun: cell marker", () => {
  let user: User;
  let orgId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    setCellsEnv(true);
    vi.mocked(getFeatureFlagForUser).mockResolvedValue(true);
    user = (await createTestUser({ db })).user;
    orgId = await createTestOrg({ db });
  });

  async function dispatchPlain(overrides: { organizationId?: string } = {}) {
    const t = await createTestThread({
      db,
      userId: user.id,
      overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
    });
    const { mock } = routedHatchetFetch("cell-marker-run");
    vi.stubGlobal("fetch", mock);
    try {
      await dispatchAgentRun({
        userId: user.id,
        threadId: t.threadId,
        threadChatId: t.threadChatId,
        repoFullName: "be-automata/automata",
        branch: "main",
      });
      return triggerBody(mock).input;
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("flag off: no cell field", async () => {
    vi.mocked(getFeatureFlagForUser).mockResolvedValue(false);
    const input = await dispatchPlain({ organizationId: orgId });
    expect(input).not.toHaveProperty("cell");
  });

  it("env unset: no cell field and the flag is not even read", async () => {
    setCellsEnv(false);
    const input = await dispatchPlain({ organizationId: orgId });
    expect(input).not.toHaveProperty("cell");
    expect(getFeatureFlagForUser).not.toHaveBeenCalled();
  });

  it("flag on and env set: cell is opensandbox, secrets keep the same shape", async () => {
    const on = await dispatchPlain({ organizationId: orgId });
    expect(on.cell).toBe("opensandbox");
    const secretsOn = await plane.unseal(on);

    vi.mocked(getFeatureFlagForUser).mockResolvedValue(false);
    const off = await dispatchPlain({ organizationId: orgId });
    const secretsOff = await plane.unseal(off);

    // Same plaintext, value for value, except the per-dispatch daemon token.
    expect({ ...secretsOn, daemonToken: "" }).toEqual({
      ...secretsOff,
      daemonToken: "",
    });
    expect(secretsOn.daemonToken).not.toBe("");
    // Reference only: the marker carries nothing secret.
    expect(JSON.stringify(on)).not.toContain(secretsOn.daemonToken);
  });

  it("a flag lookup failure is logged and the run is dispatched without the marker", async () => {
    vi.mocked(getFeatureFlagForUser).mockRejectedValue(new Error("db down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const input = await dispatchPlain({ organizationId: orgId });
    expect(input).not.toHaveProperty("cell");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("db down");
    warn.mockRestore();
  });

  it("a thread without an organization never gets the marker", async () => {
    const input = await dispatchPlain();
    expect(input).not.toHaveProperty("cell");
  });

  it("a review run never gets the marker", async () => {
    const t = await createBootingPRThread({
      userId: user.id,
      orgId,
      automationId: await createReviewAutomation({ userId: user.id, orgId }),
      prNumber: 4343,
    });
    const { mock } = routedHatchetFetch("cell-marker-review");
    vi.stubGlobal("fetch", mock);
    try {
      await dispatchAgentRun({
        userId: user.id,
        threadId: t.threadId,
        threadChatId: t.threadChatId,
        repoFullName: "be-automata/automata",
        branch: "feature-marker",
      });
      expect(triggerBody(mock).input).not.toHaveProperty("cell");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
