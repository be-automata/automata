import { describe, expect, it } from "vitest";

import { allThreadErrors } from "@/agent/error";
import { TERMINAL_CAUSES } from "@terragon/shared/model/terminal-cause";

import {
  classifyFixTerminal,
  INFRA_TERMINAL_CAUSES,
  TERMINAL_CAUSE_RULES,
  THREAD_ERROR_RULES,
} from "./fix-outcome-classify";

const base = { terminalCause: null, hasCheckReport: false, killed: false };

describe("classifyFixTerminal (RES-10)", () => {
  it("maps every TerminalCause member (exhaustive)", () => {
    expect(Object.keys(TERMINAL_CAUSE_RULES).sort()).toEqual(
      [...TERMINAL_CAUSES].sort(),
    );
    for (const cause of TERMINAL_CAUSES) {
      const got = classifyFixTerminal({ ...base, terminalCause: cause });
      expect(got.class, cause).toBe(TERMINAL_CAUSE_RULES[cause].class);
    }
  });

  it("maps every thread error type (exhaustive)", () => {
    expect(Object.keys(THREAD_ERROR_RULES).sort()).toEqual(
      Object.keys(allThreadErrors).sort(),
    );
  });

  it.each([
    ["timeout", "timeout", true],
    ["daemon-failed", "daemon_failed", true],
    ["plane-offline", "plane_offline", true],
    ["superseded", "abandoned", false],
    ["publish-failed", "publish_failed", false],
  ])("cause %s is refunded infra (%s)", (cause, reason, signal) => {
    expect(classifyFixTerminal({ ...base, terminalCause: cause })).toEqual({
      class: "infra",
      reason,
      outcome: "refunded",
      execPlaneSignal: signal,
    });
  });

  it.each([
    ["sandbox-creation-failed", "sandbox_lost"],
    ["sandbox-not-found", "sandbox_lost"],
    ["agent-not-responding", "agent_not_responding"],
    ["request-timeout", "request_timeout"],
  ])(
    "box / worker death error %s is refunded with an exec_plane signal",
    (errorMessage, reason) => {
      expect(
        classifyFixTerminal({ ...base, status: "error", errorMessage }),
      ).toEqual({
        class: "infra",
        reason,
        outcome: "refunded",
        execPlaneSignal: true,
      });
    },
  );

  it("a Drain / kill-switch cancel is refunded as killed and is not plane evidence (KILL-01)", () => {
    const killed = {
      class: "infra",
      reason: "killed",
      outcome: "killed",
      execPlaneSignal: false,
    };
    expect(
      classifyFixTerminal({ ...base, terminalCause: "user-cancelled" }),
    ).toEqual(killed);
    expect(classifyFixTerminal({ ...base, killed: true })).toEqual(killed);
    expect(
      classifyFixTerminal({
        ...base,
        killed: true,
        errorMessage: "invalid-claude-credentials",
      }),
    ).toEqual(killed);
    expect(classifyFixTerminal({ ...base, status: "stopped" })).toEqual(killed);
  });

  it.each([
    ["invalid-claude-credentials"],
    ["invalid-codex-credentials"],
    ["missing-amp-credentials"],
    ["chatgpt-sub-required"],
    ["Claude AI usage limit reached|1752350400"],
    ["Weekly limit reached · resets 6pm (UTC)"],
    ["You've hit your usage limit. Try again in 3 days."],
    ["API Error: 401 Unauthorized"],
    ["Invalid API key · Please run /login"],
  ])(
    "credential 401 / quota %s is COUNTED and never an exec_plane signal",
    (errorMessage) => {
      expect(
        classifyFixTerminal({
          ...base,
          status: "error",
          errorMessage,
          // Even under an infra-looking typed cause the credential wins.
          terminalCause: "daemon-failed",
        }),
      ).toEqual({
        class: "counted",
        reason: "credential",
        outcome: "run_failed",
        execPlaneSignal: false,
      });
    },
  );

  it("a completed run without a check report is infra check_missing", () => {
    expect(classifyFixTerminal({ ...base, status: "complete" })).toEqual({
      class: "infra",
      reason: "check_missing",
      outcome: "refunded",
      execPlaneSignal: true,
    });
  });

  it("a reported run is never refunded here (the gate owns it)", () => {
    expect(
      classifyFixTerminal({
        ...base,
        hasCheckReport: true,
        terminalCause: "daemon-failed",
      }).class,
    ).toBe("counted");
  });

  it.each([
    ["agent-generic-error", "agent_error"],
    ["prompt-too-long", "prompt_too_long"],
    ["setup-script-failed", "setup_script_failed"],
    ["git-checkpoint-push-failed", "agent_error"],
    ["the agent gave up", "agent_error"],
  ])("agent-side error %s is counted", (errorMessage, reason) => {
    expect(
      classifyFixTerminal({ ...base, status: "error", errorMessage }),
    ).toMatchObject({ class: "counted", reason, execPlaneSignal: false });
  });

  it("an unknown ending with no cause, error or status is counted", () => {
    expect(classifyFixTerminal({ ...base, status: "error" }).class).toBe(
      "counted",
    );
  });

  it("INFRA_TERMINAL_CAUSES is every refunded cause plus check_missing and killed", () => {
    expect([...INFRA_TERMINAL_CAUSES].sort()).toEqual(
      [...TERMINAL_CAUSES, "check_missing", "killed"].sort(),
    );
  });
});
