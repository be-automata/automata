import { describe, expect, it } from "vitest";

import {
  displayRunTitle,
  explainNeedsYou,
  runStateFor,
  triggerKindFor,
} from "./run-state";

describe("runStateFor", () => {
  it("names running work and its boot step", () => {
    expect(runStateFor({ status: "working" })).toEqual({
      kind: "running",
      word: "working",
      reason: null,
    });
    expect(
      runStateFor({ status: "booting", bootingSubstatus: "cloning-repo" }),
    ).toEqual({ kind: "running", word: "booting", reason: "cloning repo" });
  });

  it("gives every queued variant a reason", () => {
    expect(runStateFor({ status: "queued-tasks-concurrency" })).toEqual({
      kind: "waiting",
      word: "queued",
      reason: "waiting for a free slot",
    });
    expect(runStateFor({ status: "queued-agent-rate-limit" }).reason).toBe(
      "agent rate limit",
    );
    expect(runStateFor({ status: "queued" }).reason).toBeNull();
  });

  it("treats errors, error messages and failure causes as needs-you", () => {
    expect(runStateFor({ status: "working-error" }).kind).toBe("needs-you");
    expect(runStateFor({ status: "complete", hasError: true }).kind).toBe(
      "needs-you",
    );
    expect(
      runStateFor({ status: "complete", terminalCause: "daemon-failed" }).kind,
    ).toBe("needs-you");
  });

  it("does not call a superseded or cancelled run done", () => {
    expect(
      runStateFor({ status: "complete", terminalCause: "superseded" }),
    ).toEqual({ kind: "unverified", word: "superseded", reason: null });
    expect(runStateFor({ status: "complete" }).kind).toBe("done");
  });
});

describe("explainNeedsYou", () => {
  it("routes credential failures to reconnecting the credential", () => {
    expect(
      explainNeedsYou({
        errorMessage: "invalid-claude-credentials",
        terminalCause: null,
      }).action,
    ).toBe("reconnect-credential");
  });

  it("falls back to the terminal cause, then to a generic error", () => {
    expect(
      explainNeedsYou({ errorMessage: null, terminalCause: "timeout" }).title,
    ).toBe("Timed out");
    expect(
      explainNeedsYou({ errorMessage: "some free text", terminalCause: null }),
    ).toEqual({
      title: "Agent error",
      reason: "The agent stopped with an error.",
      action: "open-task",
    });
  });
});

describe("triggerKindFor", () => {
  it("prefers the automation link over the source type", () => {
    expect(triggerKindFor({ sourceType: "www", automationId: "a1" })).toBe(
      "automation",
    );
    expect(
      triggerKindFor({ sourceType: "slack-mention", automationId: null }),
    ).toBe("slack");
    expect(triggerKindFor({ sourceType: null, automationId: null })).toBe(
      "web",
    );
  });
});

describe("displayRunTitle", () => {
  it("strips a leading markdown heading marker", () => {
    expect(displayRunTitle("# Post-merge ticket audit")).toBe(
      "Post-merge ticket audit",
    );
    expect(displayRunTitle("  ")).toBe("Untitled task");
    expect(displayRunTitle("Fix #123 flake")).toBe("Fix #123 flake");
  });
});
