import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DB } from "@terragon/shared/db";

const h = vi.hoisted(() => ({
  order: [] as string[],
  revokeAttempt: vi.fn(),
  envState: { url: "", key: "", image: "" },
}));

vi.mock("@terragon/shared/model/cell-authority", () => ({
  revokeAttempt: h.revokeAttempt,
}));
vi.mock("@terragon/env/apps-www", () => ({
  env: {
    get OPENSANDBOX_URL() {
      return h.envState.url;
    },
    get OPENSANDBOX_API_KEY() {
      return h.envState.key;
    },
    get OPENSANDBOX_GUEST_IMAGE() {
      return h.envState.image;
    },
  },
}));

import { opensandboxConfigured } from "./cell-gate";
import { cellProvider, runCellReconciler, teardownCell } from "./cell-control";

const db = {} as DB;

beforeEach(() => {
  h.order.length = 0;
  h.envState.url = "";
  h.envState.key = "";
  h.revokeAttempt.mockReset();
  h.revokeAttempt.mockImplementation(async (a: { stepKey: string }) => {
    h.order.push(`revoke:${a.stepKey}`);
    return true;
  });
});

describe("opensandboxConfigured / cellProvider", () => {
  it("is off unless URL and key are both set", () => {
    expect(opensandboxConfigured()).toBe(false);
    expect(cellProvider()).toBeNull();
    h.envState.url = "http://127.0.0.1:8090";
    expect(opensandboxConfigured()).toBe(false);
    h.envState.key = "k";
    expect(opensandboxConfigured()).toBe(true);
    expect(cellProvider()).not.toBeNull();
  });
});

describe("teardownCell", () => {
  const provider = {
    teardown: vi.fn(async (id: string) => {
      h.order.push(`teardown:${id}`);
    }),
  };
  beforeEach(() => provider.teardown.mockClear());

  it("revokes the attempt before the provider teardown", async () => {
    await teardownCell({
      db,
      provider,
      cellId: "c1",
      stepKey: "cell:k",
      attempt: 2,
    });
    expect(h.order).toEqual(["revoke:cell:k", "teardown:c1"]);
    expect(h.revokeAttempt).toHaveBeenCalledWith({
      db,
      stepKey: "cell:k",
      attempt: 2,
    });
  });

  it("still tears down when revokeAttempt throws, then rethrows", async () => {
    h.revokeAttempt.mockRejectedValue(new Error("db down"));
    await expect(
      teardownCell({
        db,
        provider,
        cellId: "c1",
        stepKey: "cell:k",
        attempt: 1,
      }),
    ).rejects.toThrow("db down");
    expect(provider.teardown).toHaveBeenCalledWith("c1");
  });
});

describe("runCellReconciler", () => {
  it("reaps an expired cell, revoking through revokeAttempt first", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const provider = {
      listByTags: vi.fn(async () => [
        {
          cellId: "x",
          tags: {
            automata: "cell",
            stepKey: "cell:x",
            attempt: "3",
            expiresAt: "10",
            worker: "w",
            epoch: "1",
          },
        },
      ]),
      teardown: vi.fn(async (id: string) => {
        h.order.push(`teardown:${id}`);
      }),
    };
    const r = await runCellReconciler({ db, provider, now: () => 100 });
    expect(h.order).toEqual(["revoke:cell:x", "teardown:x"]);
    expect(h.revokeAttempt).toHaveBeenCalledWith({
      db,
      stepKey: "cell:x",
      attempt: 3,
    });
    expect(r).toMatchObject({ expired: 1, reaped: 1, failed: 0 });
  });
});
