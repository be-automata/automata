import { hatchet } from "../hatchet-client";

export type HelloInput = {
  name: string;
};

export type HelloOutput = {
  message: string;
  ranAt: string;
};

/**
 * Trivial round-trip proof workflow for the execution-plane substrate (ADR-002
 * rollout step 0). It only echoes its input — its purpose is to prove that a task
 * triggered from the control-plane side is delivered to a registered worker, runs,
 * and its result is readable back.
 *
 * scheduleTimeout is set EXPLICITLY to 30m rather than inheriting Hatchet's 5m
 * default: on a customer-supplied box the schedule-timeout window is the grace
 * period for THEIR infrastructure being down (reboot/network drop). At the 5m
 * default a brief customer outage silently deletes queued work (ADR-002 §Worker
 * availability). The real agent-run workflow must make the same choice deliberately.
 */
export const hello = hatchet.task({
  name: "hello",
  scheduleTimeout: "30m",
  fn: async (input: HelloInput): Promise<HelloOutput> => {
    return {
      message: `hello ${input.name}`,
      ranAt: new Date().toISOString(),
    };
  },
});
