import { describe, expect, it, vi } from "vitest";

import {
  assertSlotAccountsExist,
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
