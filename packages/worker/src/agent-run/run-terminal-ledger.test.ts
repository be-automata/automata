import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NonRetryableError } from "@hatchet-dev/typescript-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RUN_TERMINAL_TTL_MS,
  runTerminalRootBootLines,
  RunAlreadyTerminalError,
  guardRunTerminal,
  readRunTerminal,
  recordRunTerminal,
} from "./run-terminal-ledger";

/**
 * #386: a failure that ends the SDK's graceful drain was redelivered (same
 * workflow run id) to the next worker process, which ran the agent again.
 * The ledger records the run id's terminal on the box; a redelivered attempt
 * of an id that already ended is refused, never re-executed.
 */

const RUN_ID = "0b2e6a52-4f0f-4b8e-9d1c-7a5d3e2f1c0b";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "run-terminal-ledger-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("recordRunTerminal / readRunTerminal", () => {
  it("round-trips a recorded terminal for a run id", () => {
    recordRunTerminal(root, RUN_ID, { outcome: "failed", detail: "boom" });
    expect(readRunTerminal(root, RUN_ID)).toMatchObject({
      outcome: "failed",
      detail: "boom",
    });
  });

  it("returns null for a run id with no terminal", () => {
    expect(readRunTerminal(root, RUN_ID)).toBeNull();
  });

  it("ignores a run id that is not a safe file name (no path traversal)", () => {
    recordRunTerminal(root, "../escape", { outcome: "failed" });
    expect(fs.existsSync(path.join(root, "..", "escape.json"))).toBe(false);
    expect(readRunTerminal(root, "../escape")).toBeNull();
  });

  it("treats an unreadable entry as absent (fails open: a stray file never blocks a run)", () => {
    recordRunTerminal(root, RUN_ID, { outcome: "failed" });
    const dir = path.join(root, "run-terminals");
    fs.writeFileSync(path.join(dir, `${RUN_ID}.json`), "{not json");
    expect(readRunTerminal(root, RUN_ID)).toBeNull();
  });

  it("prunes entries older than the TTL when recording", () => {
    const old = "11111111-1111-1111-1111-111111111111";
    recordRunTerminal(root, old, { outcome: "returned" }, 0);
    recordRunTerminal(
      root,
      RUN_ID,
      { outcome: "returned" },
      RUN_TERMINAL_TTL_MS + 1,
    );
    expect(readRunTerminal(root, old)).toBeNull();
    expect(readRunTerminal(root, RUN_ID)).not.toBeNull();
  });

  it("prunes a .tmp left by a crash mid-write once it is older than the TTL", () => {
    recordRunTerminal(root, RUN_ID, { outcome: "returned" }, 0);
    const dir = path.join(root, "run-terminals");
    const stale = path.join(dir, `${RUN_ID}.4242.tmp`);
    const fresh = path.join(dir, `${RUN_ID}.4343.tmp`);
    fs.writeFileSync(stale, "{");
    fs.writeFileSync(fresh, "{");
    const now = Date.now();
    fs.utimesSync(stale, new Date(0), new Date(0));
    recordRunTerminal(root, RUN_ID, { outcome: "returned" }, now);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});

describe("guardRunTerminal", () => {
  const log = vi.fn();

  it("records a failed terminal when the run throws, and rethrows the same error", async () => {
    const err = new Error("admission budget exhausted");
    await expect(
      guardRunTerminal({ root, runId: RUN_ID, log }, async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(readRunTerminal(root, RUN_ID)?.outcome).toBe("failed");
  });

  it("refuses a redelivered attempt of a run id that already FAILED — the run fn never executes again", async () => {
    await guardRunTerminal({ root, runId: RUN_ID, log }, async () => {
      throw new Error("first attempt failed");
    }).catch(() => undefined);

    const rerun = vi.fn(async () => "ran again");
    const second = guardRunTerminal({ root, runId: RUN_ID, log }, rerun);
    await expect(second).rejects.toBeInstanceOf(RunAlreadyTerminalError);
    await expect(second).rejects.toBeInstanceOf(NonRetryableError);
    expect(rerun).not.toHaveBeenCalled();
  });

  it("a redelivered attempt of a run id that already RETURNED gets the caller's no-op output (engine records COMPLETED), without re-executing", async () => {
    await guardRunTerminal({ root, runId: RUN_ID, log }, async () => "done");
    const rerun = vi.fn(async () => "ran again");
    const noop = vi.fn((prior: { outcome: string }) => `noop:${prior.outcome}`);
    await expect(
      guardRunTerminal(
        { root, runId: RUN_ID, log, onAlreadyReturned: noop },
        rerun,
      ),
    ).resolves.toBe("noop:returned");
    expect(rerun).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(
        /already finished on this box .*redelivered attempt completed as a no-op, not re-executed/,
      ),
    );
  });

  it("logs one structured run.redelivery_refused line per caught redelivery, naming the action", async () => {
    const lines: string[] = [];
    const capture = (msg: string) => lines.push(msg);
    const parse = (prefix: string) => {
      const line = lines.find((l) => l.startsWith(prefix));
      expect(line, lines.join("\n")).toBeTruthy();
      return JSON.parse(line!.slice(prefix.length)) as Record<string, unknown>;
    };
    const event = "run.redelivery_refused ";

    await guardRunTerminal({ root, runId: RUN_ID, log }, async () => "done");
    await guardRunTerminal(
      { root, runId: RUN_ID, log: capture, onAlreadyReturned: () => "noop" },
      async () => "ran again",
    );
    expect(parse(event)).toMatchObject({
      runId: RUN_ID,
      prior: "returned",
      action: "noop",
    });
    expect(lines.filter((l) => l.startsWith(event))).toHaveLength(1);

    lines.length = 0;
    const failed = "22222222-2222-2222-2222-222222222222";
    await guardRunTerminal({ root, runId: failed, log }, async () => {
      throw new Error("boom");
    }).catch(() => undefined);
    await guardRunTerminal(
      { root, runId: failed, log: capture, onAlreadyReturned: () => "noop" },
      async () => "ran again",
    ).catch(() => undefined);
    const refused = parse(event);
    expect(refused).toMatchObject({
      runId: failed,
      prior: "failed",
      action: "refused",
    });
    expect(typeof refused.gapMs).toBe("number");
    expect(lines).toContainEqual(
      expect.stringMatching(/redelivered attempt refused, not re-executed/),
    );
  });

  it("a redelivered attempt of a run id that already FAILED still throws, even with a no-op output on offer", async () => {
    await guardRunTerminal({ root, runId: RUN_ID, log }, async () => {
      throw new Error("boom");
    }).catch(() => undefined);
    const noop = vi.fn(() => "noop");
    await expect(
      guardRunTerminal(
        { root, runId: RUN_ID, log, onAlreadyReturned: noop },
        async () => "ran again",
      ),
    ).rejects.toBeInstanceOf(RunAlreadyTerminalError);
    expect(noop).not.toHaveBeenCalled();
  });

  it("refuses a redelivered attempt of a run id that already RETURNED, also without re-executing", async () => {
    await guardRunTerminal({ root, runId: RUN_ID, log }, async () => "done");
    const rerun = vi.fn(async () => "ran again");
    await expect(
      guardRunTerminal({ root, runId: RUN_ID, log }, rerun),
    ).rejects.toBeInstanceOf(RunAlreadyTerminalError);
    expect(rerun).not.toHaveBeenCalled();
  });

  it("does NOT refuse a worker-loss redelivery of a run that never reached a terminal (#152: re-execution after a crash stays)", async () => {
    const run = vi.fn(async () => "ran");
    await expect(
      guardRunTerminal({ root, runId: RUN_ID, log }, run),
    ).resolves.toBe("ran");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs unguarded (and records nothing) without a workflow run id", async () => {
    const run = vi.fn(async () => "ran");
    await guardRunTerminal({ root, runId: "", log }, run);
    await guardRunTerminal({ root, runId: "", log }, run);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("runTerminalRootBootLines", () => {
  it("names the root, and warns only for a Linux root under /tmp (wiped at boot)", () => {
    expect(
      runTerminalRootBootLines("/usr/local/automata/state", "linux"),
    ).toEqual({
      line: "run-terminal ledger root=/usr/local/automata/state",
      warning: null,
    });
    expect(
      runTerminalRootBootLines("/tmp/automata-agent-run", "linux").warning,
    ).toMatch(/under \/tmp, which is wiped at boot/);
    expect(
      runTerminalRootBootLines("/tmp/automata-agent-run", "darwin").warning,
    ).toBeNull();
    expect(runTerminalRootBootLines("/tmpfs/x", "linux").warning).toBeNull();
  });
});
