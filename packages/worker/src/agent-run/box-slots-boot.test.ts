import { describe, expect, it, vi } from "vitest";

import {
  assertFenceCoversSlotUids,
  assertSlotAccountsExist,
  assertSlotSudoGrants,
  retiredSlotAccounts,
  warnIfSlotsExceedMemory,
} from "./box-slots-boot";

describe("assertSlotAccountsExist (#205 boot)", () => {
  it("resolves every slot account (in parallel) and returns their uids in slot order", async () => {
    const resolveUid = vi.fn(async (u: string) =>
      u === "automata-agent" ? 999 : 2001,
    );
    const uids = await assertSlotAccountsExist(
      ["automata-agent", "automata-agent-1"],
      resolveUid,
      1000,
    );
    expect(uids).toEqual([999, 2001]);
    expect(resolveUid.mock.calls).toEqual([
      ["automata-agent"],
      ["automata-agent-1"],
    ]);
  });

  it("refuses two slot logins that alias one uid, a slot account at uid 0, and one at the worker's own uid (ADR-007 I4)", async () => {
    await expect(
      assertSlotAccountsExist(
        ["automata-agent", "automata-agent-1"],
        async () => 999,
        1000,
      ),
    ).rejects.toThrow(/share uid 999.*one uid per slot/);
    await expect(
      assertSlotAccountsExist(["automata-agent"], async () => 0, 1000),
    ).rejects.toThrow(/uid 0/);
    await expect(
      assertSlotAccountsExist(["automata-agent"], async () => 1000, 1000),
    ).rejects.toThrow(/worker's own uid 1000/);
  });

  it("names every missing account (with the resolver's reason) and the provisioning doc", async () => {
    const resolveUid = vi.fn(async (user: string) => {
      if (user === "automata-agent-2") throw new Error("no such user");
      return 999;
    });
    await expect(
      assertSlotAccountsExist(
        ["automata-agent", "automata-agent-1", "automata-agent-2"],
        resolveUid,
      ),
    ).rejects.toThrow(
      /slot account\(s\) "automata-agent-2" \(no such user\) do not exist.*AGENT-UID-PROVISIONING\.md.*WORKER_BOX_SLOTS/s,
    );
  });

  it("no accounts (agent-uid mode off) ⇒ nothing is resolved", async () => {
    const resolveUid = vi.fn(async () => 0);
    expect(await assertSlotAccountsExist([], resolveUid, 1000)).toEqual([]);
    expect(resolveUid).not.toHaveBeenCalled();
  });
});

describe("assertSlotSudoGrants (#205 boot)", () => {
  it("probes every slot account in parallel and resolves when sudo permits each", async () => {
    const probe = vi.fn(async () => {});
    await assertSlotSudoGrants(["automata-agent", "automata-agent-1"], probe);
    expect(probe.mock.calls).toEqual([
      ["automata-agent"],
      ["automata-agent-1"],
    ]);
  });

  it("names every refused account and the provisioning doc", async () => {
    const probe = vi.fn(async (user: string) => {
      if (user !== "automata-agent") {
        throw new Error("sudo: a password is required");
      }
    });
    await expect(
      assertSlotSudoGrants(
        ["automata-agent", "automata-agent-1", "automata-agent-2"],
        probe,
      ),
    ).rejects.toThrow(
      /slot account\(s\) "automata-agent-1" \(sudo: a password is required\), "automata-agent-2".*Runas.*AGENT-UID-PROVISIONING\.md.*WORKER_BOX_SLOTS/s,
    );
  });

  it("no accounts ⇒ no probe", async () => {
    const probe = vi.fn(async () => {});
    await assertSlotSudoGrants([], probe);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("assertFenceCoversSlotUids (#205 boot, Linux N > 1)", () => {
  it("passes when every slot uid is in the preflight's marker (any separator)", () => {
    expect(() =>
      assertFenceCoversSlotUids({
        uids: [999, 2001],
        platform: "linux",
        readMarker: () => "999, 2001\n",
      }),
    ).not.toThrow();
    expect(() =>
      assertFenceCoversSlotUids({
        uids: [999],
        platform: "linux",
        readMarker: () => "2001 999",
      }),
    ).not.toThrow();
  });

  it("refuses when the marker is missing (fence never loaded this boot), naming the unit and the file", () => {
    expect(() =>
      assertFenceCoversSlotUids({
        uids: [999, 2001],
        platform: "linux",
        markerPath: "/run/automata/egress-fence.uids",
        readMarker: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toThrow(
      /coverage unproven.*\/run\/automata\/egress-fence\.uids.*ENOENT.*automata-egress/,
    );
  });

  it("refuses when a slot uid is not fenced, naming it and the fenced set", () => {
    expect(() =>
      assertFenceCoversSlotUids({
        uids: [999, 2001],
        platform: "linux",
        readMarker: () => "999",
      }),
    ).toThrow(/does not cover slot uid\(s\) 2001 \(fenced: 999\)/);
  });

  it("is a no-op off Linux (PF fences the pilot) and with no slot accounts", () => {
    const readMarker = vi.fn(() => "");
    assertFenceCoversSlotUids({ uids: [999], platform: "darwin", readMarker });
    assertFenceCoversSlotUids({ uids: [], platform: "linux", readMarker });
    expect(readMarker).not.toHaveBeenCalled();
  });
});

describe("retiredSlotAccounts (#205 boot)", () => {
  it("returns the slot accounts at or above N that resolve on the box, probing all candidates in parallel", async () => {
    const existing = new Set(["automata-agent-2", "automata-agent-3"]);
    const resolveUid = vi.fn(async (user: string) => {
      if (!existing.has(user)) throw new Error("no such user");
      return 2000;
    });
    const got = await retiredSlotAccounts("automata-agent", 2, resolveUid);
    expect(got).toEqual([
      { slot: 2, account: "automata-agent-2" },
      { slot: 3, account: "automata-agent-3" },
    ]);
    // Nothing below N is a candidate; every name up to the slot cap is probed.
    const probed = resolveUid.mock.calls.map((c) => c[0]);
    expect(probed[0]).toBe("automata-agent-2");
    expect(probed).toHaveLength(14);
    expect(probed).not.toContain("automata-agent-1");
  });

  it("[] when agent-uid mode is off, and never throws when nothing resolves", async () => {
    const resolveUid = vi.fn(async () => {
      throw new Error("no such user");
    });
    expect(await retiredSlotAccounts("", 1, resolveUid)).toEqual([]);
    expect(resolveUid).not.toHaveBeenCalled();
    expect(await retiredSlotAccounts("automata-agent", 1, resolveUid)).toEqual(
      [],
    );
  });
});

describe("warnIfSlotsExceedMemory (#205 boot)", () => {
  const meminfo = "MemTotal:        7937228 kB\nMemFree:          100 kB\n";

  it("is silent at N = 1 and when the ceiling is off", () => {
    const log = vi.fn();
    warnIfSlotsExceedMemory(
      { boxSlots: 1, memoryMaxBytes: 5000 * 1024 ** 2 },
      () => meminfo,
      log,
    );
    warnIfSlotsExceedMemory(
      { boxSlots: 3, memoryMaxBytes: 0 },
      () => meminfo,
      log,
    );
    expect(log).not.toHaveBeenCalled();
  });

  it("warns, naming both knobs and MemTotal, when N × ceiling exceeds the box RAM", () => {
    const log = vi.fn();
    warnIfSlotsExceedMemory(
      { boxSlots: 2, memoryMaxBytes: 5000 * 1024 ** 2 },
      () => meminfo,
      log,
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatch(
      /WORKER_BOX_SLOTS=2 × WORKER_RUN_MEMORY_MAX=5242880000 = 10485760000 bytes exceeds MemTotal 8127721472/,
    );
  });

  it("is silent when N × ceiling fits, and when /proc/meminfo is unreadable", () => {
    const log = vi.fn();
    warnIfSlotsExceedMemory(
      { boxSlots: 2, memoryMaxBytes: 1500 * 1024 ** 2 },
      () => meminfo,
      log,
    );
    warnIfSlotsExceedMemory(
      { boxSlots: 2, memoryMaxBytes: 5000 * 1024 ** 2 },
      () => {
        throw new Error("ENOENT");
      },
      log,
    );
    expect(log).not.toHaveBeenCalled();
  });
});
