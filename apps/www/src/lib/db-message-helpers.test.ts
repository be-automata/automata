import { describe, it, expect, vi } from "vitest";
import type {
  DBMessage,
  DBUserMessage,
  DBSystemMessage,
} from "@terragon/shared";
import {
  getPendingToolCallErrorMessages,
  getUserMessageToSend,
  convertToPrompt,
  richTextToPlainText,
} from "./db-message-helpers";

describe("getPendingToolCallErrorMessages", () => {
  it("should add error results for single pending tool with user interruption", () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Read a file" }],
        permissionMode: "allowAll",
      },
      {
        type: "tool-call",
        id: "tool-1",
        name: "Read",
        parameters: { file_path: "/test.txt" },
        parent_tool_use_id: null,
      },
    ];

    const result = getPendingToolCallErrorMessages({
      messages,
      interruptionReason: "user",
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "tool-result",
      id: "tool-1",
      is_error: true,
      parent_tool_use_id: null,
      result: "Tool execution interrupted by user",
    });
  });

  it("should add error results for single pending tool with error interruption", () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Read a file" }],
      },
      {
        type: "tool-call",
        id: "tool-1",
        name: "Read",
        parameters: { file_path: "/test.txt" },
        parent_tool_use_id: null,
      },
    ];

    const result = getPendingToolCallErrorMessages({
      messages,
      interruptionReason: "error",
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "tool-result",
      id: "tool-1",
      is_error: true,
      parent_tool_use_id: null,
      result: "Tool execution interrupted by error",
    });
  });

  it("should add error results for multiple pending tools", () => {
    const messages: DBMessage[] = [
      {
        type: "tool-call",
        id: "tool-1",
        name: "Read",
        parameters: { file_path: "/test1.txt" },
        parent_tool_use_id: null,
      },
      {
        type: "tool-call",
        id: "tool-2",
        name: "Write",
        parameters: { file_path: "/test2.txt", content: "new content" },
        parent_tool_use_id: null,
      },
    ];

    const result = getPendingToolCallErrorMessages({
      messages,
      interruptionReason: "user",
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      type: "tool-result",
      id: "tool-1",
      is_error: true,
      parent_tool_use_id: null,
      result: "Tool execution interrupted by user",
    });
    expect(result[1]).toEqual({
      type: "tool-result",
      id: "tool-2",
      is_error: true,
      parent_tool_use_id: null,
      result: "Tool execution interrupted by user",
    });
  });

  it("should not add error results for tools that have results", () => {
    const messages: DBMessage[] = [
      {
        type: "tool-call",
        id: "tool-1",
        name: "Read",
        parameters: { file_path: "/test.txt" },
        parent_tool_use_id: null,
      },
      {
        type: "tool-result",
        id: "tool-1",
        is_error: false,
        parent_tool_use_id: null,
        result: "File contents here",
      },
      {
        type: "tool-call",
        id: "tool-2",
        name: "Write",
        parameters: { file_path: "/test2.txt", content: "new content" },
        parent_tool_use_id: null,
      },
    ];

    const result = getPendingToolCallErrorMessages({
      messages,
      interruptionReason: "user",
    });

    expect(result).toHaveLength(1);
    // Only tool-2 should get an error result
    expect(result[0]).toEqual({
      type: "tool-result",
      id: "tool-2",
      is_error: true,
      parent_tool_use_id: null,
      result: "Tool execution interrupted by user",
    });
  });

  it("should handle nested tool calls with parent IDs correctly", () => {
    const messages: DBMessage[] = [
      {
        type: "tool-call",
        id: "task-1",
        name: "Task",
        parameters: { description: "Complex operation" },
        parent_tool_use_id: null,
      },
      {
        type: "tool-call",
        id: "read-1",
        name: "Read",
        parameters: { file_path: "/nested.txt" },
        parent_tool_use_id: "task-1",
      },
    ];

    const result = getPendingToolCallErrorMessages({
      messages,
      interruptionReason: "user",
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      type: "tool-result",
      id: "task-1",
      is_error: true,
      parent_tool_use_id: null,
      result: "Tool execution interrupted by user",
    });
    expect(result[1]).toEqual({
      type: "tool-result",
      id: "read-1",
      is_error: true,
      parent_tool_use_id: "task-1",
      result: "Tool execution interrupted by user",
    });
  });

  it("should handle empty messages array", () => {
    const messages: DBMessage[] = [];
    const result = getPendingToolCallErrorMessages({
      messages,
      interruptionReason: "user",
    });
    expect(result).toEqual([]);
  });

  it("should handle messages with no pending tools", () => {
    const messages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Hello" }],
      },
      {
        type: "agent",
        parent_tool_use_id: null,
        parts: [{ type: "text", text: "Hi there!" }],
      },
    ];

    const result = getPendingToolCallErrorMessages({
      messages,
      interruptionReason: "user",
    });
    expect(result).toEqual([]);
  });
});

describe("getUserMessageToSend", () => {
  const createUserMessage = (
    text: string,
    model: "opus" | "sonnet" | null = null,
  ): DBUserMessage => ({
    type: "user",
    model,
    parts: [{ type: "text", text }],
    timestamp: new Date().toISOString(),
  });

  const createAgentMessage = (text: string): DBMessage => ({
    type: "agent",
    parent_tool_use_id: null,
    parts: [{ type: "text", text }],
  });

  const createToolCall = (name: string): DBMessage => ({
    type: "tool-call",
    id: "tool-1",
    name,
    parameters: {},
    parent_tool_use_id: null,
  });

  const createToolResult = (result: string): DBMessage => ({
    type: "tool-result",
    id: "tool-1",
    is_error: false,
    parent_tool_use_id: null,
    result,
  });

  it("a credential-source line does not end the un-answered window (#209 item 1)", () => {
    // The worker appends the attribution AFTER next-message built the prompt,
    // so a retried run re-reads [user, credential-source]. Breaking there
    // returned null and the retry silently ran nothing.
    const userMessage = createUserMessage("do the thing");
    const result = getUserMessageToSend({
      messages: [
        userMessage,
        { type: "credential-source", source: "built-in-credits" },
      ],
      currentMessage: null,
    });
    expect(result?.parts).toEqual(userMessage.parts);
  });

  it("should return current message when messages is null", () => {
    const currentMessage = createUserMessage("Hello");
    const result = getUserMessageToSend({
      messages: null,
      currentMessage,
    });
    expect(result).toBe(currentMessage);
  });

  it("should return current message when messages is empty", () => {
    const currentMessage = createUserMessage("Hello");
    const result = getUserMessageToSend({
      messages: [],
      currentMessage,
    });
    expect(result).toBe(currentMessage);
  });

  it("should return only the current message when it's the only user message", () => {
    const currentMessage = createUserMessage("Current message");
    const messages: DBMessage[] = [
      createAgentMessage("Previous response"),
      currentMessage,
    ];
    const result = getUserMessageToSend({
      messages,
      currentMessage,
    });
    expect(result!.parts).toHaveLength(1);
    expect(result!.parts[0]).toEqual({ type: "text", text: "Current message" });
  });

  it("should concatenate consecutive user messages", () => {
    const messages: DBMessage[] = [
      createAgentMessage("Previous response"),
      createUserMessage("First message"),
      createUserMessage("Second message"),
      createUserMessage("Third message"),
    ];
    const currentMessage = createUserMessage("Current message");

    const result = getUserMessageToSend({
      messages,
      currentMessage,
    });

    expect(result!.parts).toHaveLength(5);
    expect(result!.parts[0]).toEqual({ type: "text", text: "First message" });
    expect(result!.parts[1]).toEqual({ type: "text", text: "\n\n---\n\n" });
    expect(result!.parts[2]).toEqual({ type: "text", text: "Second message" });
    expect(result!.parts[3]).toEqual({ type: "text", text: "\n\n---\n\n" });
    expect(result!.parts[4]).toEqual({ type: "text", text: "Third message" });
    expect(result!.model).toBe((messages[3] as DBUserMessage).model);
  });

  it("should stop at agent messages", () => {
    const messages: DBMessage[] = [
      createUserMessage("Old message"),
      createAgentMessage("Agent response"),
      createUserMessage("First message"),
      createUserMessage("Second message"),
    ];
    const currentMessage = createUserMessage("Current message");

    const result = getUserMessageToSend({
      messages,
      currentMessage,
    });

    expect(result!.parts).toHaveLength(3);
    expect(result!.parts[0]).toEqual({ type: "text", text: "First message" });
    expect(result!.parts[1]).toEqual({ type: "text", text: "\n\n---\n\n" });
    expect(result!.parts[2]).toEqual({ type: "text", text: "Second message" });
  });

  it("should stop at tool-call messages", () => {
    const messages: DBMessage[] = [
      createUserMessage("Old message"),
      createToolCall("SomeTool"),
      createUserMessage("First message"),
      createUserMessage("Second message"),
    ];
    const currentMessage = createUserMessage("Current message");

    const result = getUserMessageToSend({
      messages,
      currentMessage,
    });

    expect(result!.parts).toHaveLength(3);
    expect(result!.parts[0]).toEqual({ type: "text", text: "First message" });
    expect(result!.parts[1]).toEqual({ type: "text", text: "\n\n---\n\n" });
    expect(result!.parts[2]).toEqual({ type: "text", text: "Second message" });
  });

  it("should stop at tool-result messages", () => {
    const messages: DBMessage[] = [
      createUserMessage("Old message"),
      createToolResult("Tool output"),
      createUserMessage("First message"),
      createUserMessage("Second message"),
    ];
    const currentMessage = createUserMessage("Current message");

    const result = getUserMessageToSend({
      messages,
      currentMessage,
    });

    expect(result!.parts).toHaveLength(3);
    expect(result!.parts[0]).toEqual({ type: "text", text: "First message" });
    expect(result!.parts[1]).toEqual({ type: "text", text: "\n\n---\n\n" });
    expect(result!.parts[2]).toEqual({ type: "text", text: "Second message" });
  });

  it("should stop at result-success meta messages", () => {
    const messages: DBMessage[] = [
      createUserMessage("Older message"),
      {
        type: "meta",
        subtype: "result-success",
        cost_usd: 0.01,
        duration_ms: 1000,
        duration_api_ms: 500,
        is_error: false,
        num_turns: 1,
        result: "done",
        session_id: "test-session-123",
      },
      createUserMessage("First message"),
      createUserMessage("Second message"),
    ];
    const currentMessage = createUserMessage("Current message");

    const result = getUserMessageToSend({
      messages,
      currentMessage,
    });

    expect(result!.parts).toHaveLength(3);
    expect(result!.parts[0]).toEqual({ type: "text", text: "First message" });
    expect(result!.parts[1]).toEqual({ type: "text", text: "\n\n---\n\n" });
    expect(result!.parts[2]).toEqual({ type: "text", text: "Second message" });
  });

  it("should skip stop messages", () => {
    const messages: DBMessage[] = [
      createAgentMessage("Previous response"),
      createUserMessage("First message"),
      { type: "stop" } as DBMessage,
      createUserMessage("Second message"),
    ];
    const currentMessage = createUserMessage("Current message");

    const result = getUserMessageToSend({
      messages,
      currentMessage,
    });

    expect(result!.parts).toHaveLength(3);
    expect(result!.parts[0]).toEqual({ type: "text", text: "First message" });
    expect(result!.parts[1]).toEqual({ type: "text", text: "\n\n---\n\n" });
    expect(result!.parts[2]).toEqual({ type: "text", text: "Second message" });
  });

  it("should skip error messages", () => {
    const messages: DBMessage[] = [
      createAgentMessage("Previous response"),
      createUserMessage("First message"),
      { type: "error" } as DBMessage,
      createUserMessage("Second message"),
    ];
    const currentMessage = createUserMessage("Current message");

    const result = getUserMessageToSend({
      messages,
      currentMessage,
    });

    expect(result!.parts).toHaveLength(3);
    expect(result!.parts[0]).toEqual({ type: "text", text: "First message" });
    expect(result!.parts[1]).toEqual({ type: "text", text: "\n\n---\n\n" });
    expect(result!.parts[2]).toEqual({ type: "text", text: "Second message" });
  });

  it("should skip meta messages", () => {
    const messages: DBMessage[] = [
      createAgentMessage("Previous response"),
      createUserMessage("First message"),
      {
        type: "meta",
        subtype: "system-init",
        session_id: "123",
        tools: [],
        mcp_servers: [],
      } as DBMessage,
      createUserMessage("Second message"),
    ];
    const currentMessage = createUserMessage("Current message");

    const result = getUserMessageToSend({
      messages,
      currentMessage,
    });

    expect(result!.parts).toHaveLength(3);
    expect(result!.parts[0]).toEqual({ type: "text", text: "First message" });
    expect(result!.parts[1]).toEqual({ type: "text", text: "\n\n---\n\n" });
    expect(result!.parts[2]).toEqual({ type: "text", text: "Second message" });
  });

  it("should skip git-diff messages", () => {
    const messages: DBMessage[] = [
      createAgentMessage("Previous response"),
      createUserMessage("First message"),
      {
        type: "git-diff",
        diff: "diff content",
        timestamp: new Date().toISOString(),
      } as DBMessage,
      createUserMessage("Second message"),
    ];
    const currentMessage = createUserMessage("Current message");

    const result = getUserMessageToSend({
      messages,
      currentMessage,
    });

    expect(result!.parts).toHaveLength(3);
    expect(result!.parts[0]).toEqual({ type: "text", text: "First message" });
    expect(result!.parts[1]).toEqual({ type: "text", text: "\n\n---\n\n" });
    expect(result!.parts[2]).toEqual({ type: "text", text: "Second message" });
  });

  it("should handle multiple types of parts (text, image, rich-text)", () => {
    const messages: DBMessage[] = [
      createAgentMessage("Previous response"),
      {
        type: "user",
        model: "opus",
        parts: [
          { type: "text", text: "Check this image:" },
          {
            type: "image",
            mime_type: "image/png",
            image_url: "https://example.com/image.png",
          },
        ],
      },
      {
        type: "user",
        model: "sonnet",
        parts: [
          {
            type: "rich-text",
            nodes: [
              { type: "text", text: "Here's a " },
              { type: "link", text: "link" },
            ],
          },
        ],
      },
    ];
    const currentMessage = createUserMessage("Current message");

    const result = getUserMessageToSend({
      messages,
      currentMessage,
    });

    expect(result!.parts).toHaveLength(4);
    expect(result!.parts[0]).toEqual({
      type: "text",
      text: "Check this image:",
    });
    expect(result!.parts[1]).toEqual({
      type: "image",
      mime_type: "image/png",
      image_url: "https://example.com/image.png",
    });
    expect(result!.parts[2]).toEqual({ type: "text", text: "\n\n---\n\n" });
    expect(result!.parts[3]).toEqual({
      type: "rich-text",
      nodes: [
        { type: "text", text: "Here's a " },
        { type: "link", text: "link" },
      ],
    });
    expect(result!.model).toBe("sonnet"); // Should use the last user message's model
  });

  it("should handle system messages between user messages without separators", () => {
    const messages: DBMessage[] = [
      createAgentMessage("Previous response"),
      createUserMessage("First user message"),
      {
        type: "system",
        message_type: "retry-git-commit-and-push",
        parts: [{ type: "text", text: "System message" }],
      } as DBSystemMessage,
      createUserMessage("Second user message"),
    ];
    const currentMessage = createUserMessage("Current message");

    const result = getUserMessageToSend({
      messages,
      currentMessage,
    });

    expect(result!.parts).toHaveLength(3);
    expect(result!.parts[0]).toEqual({
      type: "text",
      text: "First user message",
    });
    expect(result!.parts[1]).toEqual({ type: "text", text: "System message" });
    expect(result!.parts[2]).toEqual({
      type: "text",
      text: "Second user message",
    });
  });

  it("should preserve metadata from the last user message", () => {
    const messages: DBMessage[] = [
      createAgentMessage("Previous response"),
      {
        type: "user",
        model: "opus",
        parts: [{ type: "text", text: "First message" }],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "Second message" }],
        timestamp: "2024-01-01T00:01:00Z",
      },
    ];
    const currentMessage = createUserMessage("Current message");

    const result = getUserMessageToSend({
      messages,
      currentMessage,
    });

    expect(result!.model).toBe("sonnet");
    expect(result!.timestamp).toBe("2024-01-01T00:01:00Z");
  });

  it("should preserve permissionMode from the last message that has it", () => {
    const messages: DBMessage[] = [
      createAgentMessage("Previous response"),
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "First message" }],
        permissionMode: "plan",
      },
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Second message" }],
      },
    ];
    const currentMessage = createUserMessage("Current message");

    const result = getUserMessageToSend({
      messages,
      currentMessage,
    });

    expect(result!.permissionMode).toBe("plan");
  });

  it("should use the most recent permissionMode when multiple messages have it", () => {
    const messages: DBMessage[] = [
      createAgentMessage("Previous response"),
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "First message" }],
        permissionMode: "plan",
      },
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Second message" }],
        permissionMode: "allowAll",
      },
    ];
    const currentMessage = createUserMessage("Current message");

    const result = getUserMessageToSend({
      messages,
      currentMessage,
    });

    expect(result!.permissionMode).toBe("allowAll");
  });

  it("should default to allowAll when no permissionMode is set", () => {
    const messages: DBMessage[] = [
      createAgentMessage("Previous response"),
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "First message" }],
      },
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Second message" }],
      },
    ];
    const currentMessage = createUserMessage("Current message");

    const result = getUserMessageToSend({
      messages,
      currentMessage,
    });

    expect(result!.permissionMode).toBe("allowAll");
  });

  it("should handle messages with null entries", () => {
    const messages: (DBMessage | null)[] = [
      createAgentMessage("Previous response"),
      createUserMessage("First message"),
      null,
      createUserMessage("Second message"),
    ];
    const currentMessage = createUserMessage("Current message");

    const result = getUserMessageToSend({
      messages: messages as DBMessage[],
      currentMessage,
    });

    expect(result!.parts).toHaveLength(3);
    expect(result!.parts[0]).toEqual({ type: "text", text: "First message" });
    expect(result!.parts[1]).toEqual({ type: "text", text: "\n\n---\n\n" });
    expect(result!.parts[2]).toEqual({ type: "text", text: "Second message" });
  });

  it("should handle complex real-world scenario", () => {
    const messages: DBMessage[] = [
      createUserMessage("Initial request"),
      createAgentMessage("Working on it..."),
      createToolCall("Bash"),
      createToolResult("Command output"),
      createUserMessage("Actually, do this instead"),
      { type: "stop" } as DBMessage,
      createUserMessage("Wait, I changed my mind"),
      { type: "error" } as DBMessage,
      createUserMessage("Let me try again"),
    ];
    const currentMessage = createUserMessage("Current message");

    const result = getUserMessageToSend({
      messages,
      currentMessage,
    });

    expect(result!.parts).toHaveLength(5);
    expect(result!.parts[0]).toEqual({
      type: "text",
      text: "Actually, do this instead",
    });
    expect(result!.parts[1]).toEqual({ type: "text", text: "\n\n---\n\n" });
    expect(result!.parts[2]).toEqual({
      type: "text",
      text: "Wait, I changed my mind",
    });
    expect(result!.parts[3]).toEqual({ type: "text", text: "\n\n---\n\n" });
    expect(result!.parts[4]).toEqual({
      type: "text",
      text: "Let me try again",
    });
  });
});

describe("richTextToPlainText", () => {
  it("should return empty string for empty nodes", () => {
    const result = richTextToPlainText({
      type: "rich-text",
      nodes: [],
    });
    expect(result).toBe("");
  });

  it("should concatenate text from all nodes", () => {
    const result = richTextToPlainText({
      type: "rich-text",
      nodes: [
        { type: "text", text: "Hello " },
        { type: "link", text: "world" },
        { type: "text", text: "!" },
      ],
    });
    expect(result).toBe("Hello world!");
  });

  it("should handle mentions", () => {
    const result = richTextToPlainText({
      type: "rich-text",
      nodes: [
        { type: "text", text: "Hey " },
        { type: "mention", text: "src/user.ts" },
        { type: "text", text: ", check this out!" },
      ],
    });
    expect(result).toBe("Hey @src/user.ts, check this out!");
  });
});

describe("convertToPrompt", () => {
  it("should convert simple text message", async () => {
    const message: DBUserMessage = {
      type: "user",
      model: null,
      parts: [{ type: "text", text: "Hello world" }],
    };

    const writeFileBuffer = vi.fn();
    const result = await convertToPrompt(message, { writeFileBuffer });

    expect(result).toBe("Hello world");
    expect(writeFileBuffer).not.toHaveBeenCalled();
  });

  it("should join multiple text parts with spaces", async () => {
    const message: DBUserMessage = {
      type: "user",
      model: null,
      parts: [
        { type: "text", text: "First part" },
        { type: "text", text: "Second part" },
      ],
    };

    const writeFileBuffer = vi.fn();
    const result = await convertToPrompt(message, { writeFileBuffer });

    expect(result).toBe("First part Second part");
  });

  it("should convert rich text to plain text", async () => {
    const message: DBUserMessage = {
      type: "user",
      model: null,
      parts: [
        { type: "text", text: "Check out" },
        {
          type: "rich-text",
          nodes: [
            { type: "text", text: "this " },
            { type: "link", text: "link" },
          ],
        },
      ],
    };

    const writeFileBuffer = vi.fn();
    const result = await convertToPrompt(message, { writeFileBuffer });

    expect(result).toBe("Check out this link");
  });

  it("should handle images", async () => {
    const message: DBUserMessage = {
      type: "user",
      model: null,
      parts: [
        { type: "text", text: "Look at this:" },
        {
          type: "image",
          mime_type: "image/png",
          image_url: "https://example.com/image.png",
        },
      ],
    };

    const mockImageBuffer = Buffer.from("fake-image-data");
    const fetchFileBuffer = vi.fn().mockResolvedValue(mockImageBuffer);
    const writeFileBuffer = vi
      .fn()
      .mockImplementation(({ fileName }) => Promise.resolve(fileName));

    const result = await convertToPrompt(message, {
      writeFileBuffer,
      fetchFileBuffer,
    });

    expect(fetchFileBuffer).toHaveBeenCalledWith(
      "https://example.com/image.png",
    );
    expect(writeFileBuffer).toHaveBeenCalledWith({
      fileName: expect.stringMatching(/^\/tmp\/images\/image-.*\.png$/),
      content: mockImageBuffer,
    });
    expect(result).toMatch(/^Look at this: \/tmp\/images\/image-.*\.png$/);
  });

  it("should handle multiple images", async () => {
    const message: DBUserMessage = {
      type: "user",
      model: null,
      parts: [
        {
          type: "image",
          mime_type: "image/png",
          image_url: "https://example.com/image1.png",
        },
        { type: "text", text: "and" },
        {
          type: "image",
          mime_type: "image/png",
          image_url: "https://example.com/image2.png",
        },
      ],
    };

    const fetchFileBuffer = vi.fn().mockResolvedValue(Buffer.from("data"));
    const writeFileBuffer = vi
      .fn()
      .mockImplementation(({ fileName }) => Promise.resolve(fileName));

    const result = await convertToPrompt(message, {
      writeFileBuffer,
      fetchFileBuffer,
    });

    expect(fetchFileBuffer).toHaveBeenCalledTimes(2);
    expect(writeFileBuffer).toHaveBeenCalledTimes(2);
    expect(result).toMatch(
      /^\/tmp\/images\/image-.*\.png and \/tmp\/images\/image-.*\.png$/,
    );
  });

  it("should handle image fetch errors gracefully", async () => {
    const message: DBUserMessage = {
      type: "user",
      model: null,
      parts: [
        { type: "text", text: "Image:" },
        {
          type: "image",
          mime_type: "image/png",
          image_url: "https://example.com/image.png",
        },
      ],
    };

    const fetchFileBuffer = vi
      .fn()
      .mockRejectedValue(new Error("Network error"));
    const writeFileBuffer = vi.fn();

    await expect(
      convertToPrompt(message, {
        writeFileBuffer,
        fetchFileBuffer,
      }),
    ).rejects.toThrow("Network error");
  });
});

describe("getUserMessageToSend + convertToPrompt integration", () => {
  it("should handle concatenated messages with mixed content", async () => {
    const messages: DBMessage[] = [
      {
        type: "agent",
        parent_tool_use_id: null,
        parts: [{ type: "text", text: "Previous response" }],
      },
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "First message" }],
      },
      { type: "stop" },
      {
        type: "user",
        model: null,
        parts: [
          { type: "text", text: "Look at this:" },
          {
            type: "image",
            mime_type: "image/png",
            image_url: "https://example.com/img.png",
          },
        ],
      },
      { type: "error" },
      {
        type: "user",
        model: "opus",
        parts: [
          {
            type: "rich-text",
            nodes: [
              { type: "text", text: "And check " },
              { type: "link", text: "this link" },
            ],
          },
        ],
      },
    ];

    const currentMessage: DBUserMessage = {
      type: "user",
      model: null,
      parts: [{ type: "text", text: "Current" }],
    };

    // First, get the concatenated message
    const concatenatedMessage = getUserMessageToSend({
      messages,
      currentMessage,
    });

    // Verify it has all the parts including separators
    expect(concatenatedMessage!.parts).toHaveLength(6); // 3 messages + 2 separators
    expect(concatenatedMessage!.model).toBe("opus");

    // Then convert to prompt
    const fetchFileBuffer = vi.fn().mockResolvedValue(Buffer.from("img-data"));
    const writeFileBuffer = vi
      .fn()
      .mockImplementation(({ fileName }) => Promise.resolve(fileName));

    const prompt = await convertToPrompt(concatenatedMessage!, {
      writeFileBuffer,
      fetchFileBuffer,
    });

    expect(fetchFileBuffer).toHaveBeenCalledWith("https://example.com/img.png");
    expect(prompt.replace(/image-.*\.png/g, "image.png"))
      .toMatchInlineSnapshot(`
      "First message

      ---

      Look at this: /tmp/images/image.png

      ---

      And check this link"
    `);
  });

  it("should handle empty message history", async () => {
    const currentMessage: DBUserMessage = {
      type: "user",
      model: "sonnet",
      parts: [
        { type: "text", text: "Hello " },
        {
          type: "rich-text",
          nodes: [{ type: "mention", text: "src/assistant.ts" }],
        },
      ],
    };

    const concatenatedMessage = getUserMessageToSend({
      messages: null,
      currentMessage,
    });

    expect(concatenatedMessage).toBe(currentMessage);

    const writeFileBuffer = vi.fn();
    const prompt = await convertToPrompt(concatenatedMessage!, {
      writeFileBuffer,
    });

    expect(prompt).toBe("Hello @src/assistant.ts");
  });
});
