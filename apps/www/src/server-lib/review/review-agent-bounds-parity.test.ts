import { describe, expect, it } from "vitest";

import {
  REVIEW_AGENT_COMMAND_TIMEOUT_MS_MAX,
  REVIEW_AGENT_COMMAND_TIMEOUT_MS_MIN,
  REVIEW_AGENT_MAX_TURNS_MAX,
  REVIEW_AGENT_MAX_TURNS_MIN,
} from "@terragon/daemon/shared";
import {
  REVIEW_COMMAND_TIMEOUT_S_MAX,
  REVIEW_COMMAND_TIMEOUT_S_MIN,
  REVIEW_MAX_TURNS_MAX,
  REVIEW_MAX_TURNS_MIN,
} from "@terragon/shared/model/review-agent-settings";

/**
 * The Phase 4 admin ranges (what a repo may store) must equal the daemon's
 * reviewAgent wire bounds (what the worker gate and the daemon schema accept).
 * A drift either rejects settings the admin UI allowed — the run silently
 * degrades to classic — or lets the wire carry values the UI forbids.
 */
describe("review-agent bounds parity: admin settings ⇔ daemon wire", () => {
  it("command timeout: seconds × 1000 === wire milliseconds", () => {
    expect(REVIEW_COMMAND_TIMEOUT_S_MIN * 1000).toBe(
      REVIEW_AGENT_COMMAND_TIMEOUT_MS_MIN,
    );
    expect(REVIEW_COMMAND_TIMEOUT_S_MAX * 1000).toBe(
      REVIEW_AGENT_COMMAND_TIMEOUT_MS_MAX,
    );
  });

  it("max turns are identical", () => {
    expect(REVIEW_MAX_TURNS_MIN).toBe(REVIEW_AGENT_MAX_TURNS_MIN);
    expect(REVIEW_MAX_TURNS_MAX).toBe(REVIEW_AGENT_MAX_TURNS_MAX);
  });
});
