import { describe, expect, it, vi } from "vitest";

import {
  assertSlotAccountsExist,
  warnIfSlotsExceedMemory,
} from "./box-slots-boot";

describe("assertSlotAccountsExist (#205 boot)", () => {
  it("runs `id -u` once per slot account and resolves when every one exists", async () => {
    const exec = vi.fn(async () => "999\n");
    await assertSlotAccountsExist(["automata-agent", "automata-agent-1"], exec);
    expect(exec.mock.calls).toEqual([
      ["/usr/bin/id", ["-u", "automata-agent"]],
      ["/usr/bin/id", ["-u", "automata-agent-1"]],
    ]);
  });

  it("names the missing account and the provisioning doc when `id -u` fails", async () => {
    const exec = vi.fn(async (_f: string, args: string[]) => {
      if (args[1] === "automata-agent-2") throw new Error("no such user");
      return "999\n";
    });
    await expect(
      assertSlotAccountsExist(
        ["automata-agent", "automata-agent-1", "automata-agent-2"],
        exec,
      ),
    ).rejects.toThrow(
      /slot account "automata-agent-2" does not exist.*AGENT-UID-PROVISIONING\.md.*WORKER_BOX_SLOTS/s,
    );
  });

  it("no accounts (agent-uid mode off) ⇒ no exec at all", async () => {
    const exec = vi.fn(async () => "");
    await assertSlotAccountsExist([], exec);
    expect(exec).not.toHaveBeenCalled();
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
