import { describe, it, expect } from "vitest";
import { NonRetryableError } from "@hatchet-dev/typescript-sdk";
import {
  classifyAgentExit,
  classifyNextMessageError,
  nonRetryablePreflight,
  ResourceLimitError,
  resourceLimitFailure,
} from "./retry-classification";
import { NextMessageHttpError } from "./www-client";

describe("classifyNextMessageError (#6)", () => {
  it("maps a 403 next-message error to NonRetryableError", () => {
    const out = classifyNextMessageError(
      new NextMessageHttpError(
        403,
        "next-message failed: HTTP 403 (Forbidden)",
      ),
    );
    expect(out).toBeInstanceOf(NonRetryableError);
    expect((out as Error).message).toMatch(/403/);
  });

  it("maps a 404 (PR gone) to NonRetryableError", () => {
    const out = classifyNextMessageError(new NextMessageHttpError(404, "gone"));
    expect(out).toBeInstanceOf(NonRetryableError);
  });

  it("leaves a 503 as a plain (retryable) error", () => {
    const original = new NextMessageHttpError(
      503,
      "next-message failed: HTTP 503",
    );
    const out = classifyNextMessageError(original);
    expect(out).toBe(original);
    expect(out).not.toBeInstanceOf(NonRetryableError);
  });

  it("leaves a non-HTTP error (e.g. network/abort) untouched", () => {
    const original = new Error("ECONNRESET");
    expect(classifyNextMessageError(original)).toBe(original);
  });
});

describe("nonRetryablePreflight (#6)", () => {
  it("wraps a preflight failure as NonRetryableError", () => {
    const out = nonRetryablePreflight(new Error("gh not authenticated"));
    expect(out).toBeInstanceOf(NonRetryableError);
    expect(out.message).toMatch(/gh auth precondition failed/);
    expect(out.message).toMatch(/gh not authenticated/);
  });
});

/**
 * #204 AC 3: an OOM inside the run's cgroup is a `resource-limit` terminal, not
 * an opaque crash — and, just as importantly, nothing ELSE is.
 */
describe("classifyAgentExit (#204)", () => {
  const base = {
    memoryMaxBytes: 1_400_000_000,
    fallback: new Error("original cause"),
  };

  it("reports resource-limit when the kernel says it OOM-killed the cgroup", () => {
    const out = classifyAgentExit({
      ...base,
      exitCode: 137,
      signal: null,
      oomKills: 1,
    });
    expect(out).toBeInstanceOf(NonRetryableError);
    expect((out as Error).message).toMatch(/exceeded its memory ceiling/);
    expect((out as Error).message).toContain("1400000000");
  });

  it("does NOT blame memory for a SIGKILL the kernel did not attribute to OOM", () => {
    // The important one. Our own teardown kill and a supersede both exit 137,
    // so classifying on the code alone would tell a user their CANCELLED run
    // blew its memory budget — a confidently wrong cause, worse than a generic
    // failure. The kernel counter is the only positive signal.
    for (const shape of [
      { exitCode: 137, signal: null },
      { exitCode: null, signal: "SIGKILL" as NodeJS.Signals },
    ]) {
      expect(classifyAgentExit({ ...base, ...shape, oomKills: 0 })).toBe(
        base.fallback,
      );
    }
  });

  it("leaves every non-SIGKILL exit untouched, cause intact", () => {
    for (const shape of [
      { exitCode: 1, signal: null },
      { exitCode: 97, signal: null },
      { exitCode: 96, signal: null },
      { exitCode: null, signal: "SIGTERM" as NodeJS.Signals },
    ]) {
      expect(classifyAgentExit({ ...base, ...shape, oomKills: 3 })).toBe(
        base.fallback,
      );
    }
  });

  it("names the ceiling and the kill count, so the report is actionable", () => {
    const e = new ResourceLimitError(1_073_741_824, 2);
    expect(e.name).toBe("ResourceLimitError");
    expect(e.message).toContain("memory.max=1G");
    expect(e.message).toContain("2 process(es)");
  });

  it("reads like the operator-facing banner it becomes on the thread", () => {
    // onFailure posts this message as the thread's error text, so it is
    // written for the person reading the UI: what happened, how many
    // processes, and the limit in the unit the box was configured with.
    const e = new ResourceLimitError(1500 * 1024 ** 2, 16);
    expect(e.message).toMatch(
      /^Out of memory: 16 process\(es\) killed by the per-run memory limit \(memory\.max=1500M\)/,
    );
  });
});

describe("resourceLimitFailure", () => {
  it("is terminal — a run that blew its ceiling is not retried into it again", () => {
    const out = resourceLimitFailure(1500 * 1024 ** 2, 3);
    expect(out).toBeInstanceOf(NonRetryableError);
    expect(out.message).toMatch(/Out of memory: 3 process\(es\)/);
  });
});
