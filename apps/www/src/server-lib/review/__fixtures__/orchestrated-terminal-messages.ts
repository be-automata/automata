import type { ThreadSourceMetadata } from "@terragon/shared";
import type { DBMessage } from "@terragon/shared/db/db-message";

/**
 * Phase 6 fixtures shared by the terminal-text selector, finish-hook and sweep
 * tests: an orchestrated run whose lead emitted its tagged verdict, then a
 * background sub-agent finished (its message carries an untagged fence) and
 * resumed the lead, whose LAST message has no fence (Phase 2 Q2/Q7).
 */

export const FIXTURE_HEAD_SHA = "head-sha";

export const LEAD_SUMMARY = "The lead's consolidated verdict: one real bug.";

export const LEAD_TAGGED_TEXT =
  "Consolidated review of the sub-agent findings.\n" +
  "```json review-intent\n" +
  JSON.stringify({
    verdict: "request_changes",
    commit: FIXTURE_HEAD_SHA,
    summary: LEAD_SUMMARY,
    findings: [
      {
        severity: "error",
        path: "src/a.ts",
        line: 3,
        body: "Off-by-one.",
        quote: "  return age > 18;",
      },
    ],
  }) +
  "\n```";

export const SUB_AGENT_APPROVE_FENCE =
  "```json\n" +
  JSON.stringify({
    verdict: "approve",
    commit: FIXTURE_HEAD_SHA,
    summary: "Sub-agent thinks it is fine.",
  }) +
  "\n```";

export const LEAD_RESUMED_TEXT =
  "The background security agent finished; nothing to add.";

const leadMessage = (text: string): DBMessage => ({
  type: "agent",
  parent_tool_use_id: null,
  parts: [{ type: "text", text }],
});

const subAgentMessage = (text: string): DBMessage => ({
  type: "agent",
  parent_tool_use_id: "toolu_x",
  parts: [{ type: "text", text }],
});

/** Lead tagged verdict, a sub-agent's untagged fence, then the lead resumed. */
export const F1: DBMessage[] = [
  { type: "user", model: null, parts: [{ type: "text", text: "review" }] },
  leadMessage(LEAD_TAGGED_TEXT),
  subAgentMessage(`Security findings:\n${SUB_AGENT_APPROVE_FENCE}`),
  leadMessage(LEAD_RESUMED_TEXT),
];

/** Same messages, read for an UNSTAMPED (classic-prompt) thread. */
export const F2: DBMessage[] = F1;

/** A stamped thread whose lead wrote an untagged fence (pre-tag body). */
export const F3: DBMessage[] = [
  leadMessage(
    "Review.\n```json\n" +
      JSON.stringify({
        verdict: "approve",
        commit: FIXTURE_HEAD_SHA,
        summary: "untagged lead",
      }) +
      "\n```",
  ),
];

export const STAMPED_METADATA: ThreadSourceMetadata = {
  type: "automation-skill",
  skillName: "github-ops",
  contentSha: "sha",
  source: "db-version",
  reviewPromptMode: "orchestrated",
};

export const UNSTAMPED_METADATA: ThreadSourceMetadata = {
  type: "automation-skill",
  skillName: "github-ops",
  contentSha: "sha",
  source: "db-version",
};
