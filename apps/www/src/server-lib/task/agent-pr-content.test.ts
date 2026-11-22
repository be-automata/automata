import { describe, expect, it } from "vitest";
import type { DBMessage } from "@terragon/shared/db/db-message";

import { parseAgentPrContent } from "./agent-pr-content";

const BLOCK =
  '```json pull-request\n{"title": "feat(acme): add logging", "body": "## Summary\\n- logs"}\n```';

function agent(text: string, parent: string | null = null): DBMessage {
  return {
    type: "agent",
    parent_tool_use_id: parent,
    parts: [{ type: "text", text }],
  };
}

function user(text: string): DBMessage {
  return {
    type: "user",
    model: null,
    parts: [{ type: "text", text }],
  };
}

describe("parseAgentPrContent", () => {
  it("reads the block of the final lead message", () => {
    expect(parseAgentPrContent([user("go"), agent(`Done.\n${BLOCK}`)])).toEqual(
      { title: "feat(acme): add logging", body: "## Summary\n- logs" },
    );
  });

  it("returns null when an earlier message has a block but the final one has none", () => {
    expect(
      parseAgentPrContent([
        user("go"),
        agent(`Draft.\n${BLOCK}`),
        agent("Pushed the fix."),
      ]),
    ).toBeNull();
  });

  it("ignores a block left by an earlier run", () => {
    expect(
      parseAgentPrContent([
        user("run 1"),
        agent(BLOCK),
        user("run 2"),
        agent("Pushed without a block."),
      ]),
    ).toBeNull();
  });

  it("returns null when the run wrote no agent message at all", () => {
    expect(
      parseAgentPrContent([user("run 1"), agent(BLOCK), user("run 2")]),
    ).toBeNull();
  });

  it("never counts a sub-agent message as the final one", () => {
    expect(
      parseAgentPrContent([user("go"), agent(BLOCK), agent("noise", "tool-1")]),
    ).not.toBeNull();
  });
});
