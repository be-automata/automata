import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NonRetryableError } from "@hatchet-dev/typescript-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RUN_TERMINAL_TTL_MS,
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
    expect(log).toHaveBeenLastCalledWith(
      expect.stringMatching(
        /already finished on this box .*redelivered attempt refused, not re-executed/,
      ),
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
