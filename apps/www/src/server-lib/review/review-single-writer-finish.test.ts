import { describe, it, expect } from "vitest";
import { extractTerminalAgentText } from "./review-single-writer-finish";
import type { DBMessage } from "@terragon/shared/db/db-message";

const userMsg: DBMessage = {
  type: "user",
  model: null,
  parts: [{ type: "text", text: "review this PR" }],
};
const agent = (text: string): DBMessage => ({
  type: "agent",
  parent_tool_use_id: null,
  parts: [{ type: "text", text }],
});

describe("extractTerminalAgentText", () => {
  it("returns the LAST agent message's text (ignoring earlier ones + non-agent)", () => {
    const msgs: DBMessage[] = [
      userMsg,
      agent("first pass"),
      { type: "tool_call" } as unknown as DBMessage,
      agent("```json\n{\"verdict\":\"approve\"}\n```"),
    ];
    expect(extractTerminalAgentText(msgs)).toContain('"verdict":"approve"');
    expect(extractTerminalAgentText(msgs)).not.toContain("first pass");
  });

  it("concatenates multiple text parts of the last agent message", () => {
    const multi: DBMessage = {
      type: "agent",
      parent_tool_use_id: null,
      parts: [
        { type: "text", text: "line one" },
        { type: "thinking", text: "ignored" } as unknown as {
          type: "text";
          text: string;
        },
        { type: "text", text: "line two" },
      ],
    };
    // The thinking part is filtered (type !== "text"); only text parts join.
    expect(extractTerminalAgentText([multi])).toBe("line one\nline two");
  });

  it("returns empty string when there is no agent message", () => {
    expect(extractTerminalAgentText([userMsg])).toBe("");
  });

  it("returns empty string for null messages", () => {
    expect(extractTerminalAgentText(null)).toBe("");
  });
});
