import { describe, expect, it, vi } from "vitest";

import {
  assertSlotAccountsExist,
  retiredSlotAccounts,
  warnIfSlotsExceedMemory,
} from "./box-slots-boot";

describe("assertSlotAccountsExist (#205 boot)", () => {
  it("resolves every slot account (in parallel) and returns when each one exists", async () => {
    const resolveUid = vi.fn(async () => 999);
    await assertSlotAccountsExist(
      ["automata-agent", "automata-agent-1"],
      resolveUid,
    );
    expect(resolveUid.mock.calls).toEqual([
      ["automata-agent"],
      ["automata-agent-1"],
    ]);
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
    await assertSlotAccountsExist([], resolveUid);
    expect(resolveUid).not.toHaveBeenCalled();
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
    expect(got).toEqual(["automata-agent-2", "automata-agent-3"]);
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
