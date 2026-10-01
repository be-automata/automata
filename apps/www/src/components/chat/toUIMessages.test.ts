import { describe, test, expect } from "vitest";
import { toUIMessages } from "./toUIMessages";
import type { DBMessage } from "@terragon/shared";

describe("toUIMessages", () => {
  test("groups agent text and tool interactions", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "hi" }],
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "hello" }],
        parent_tool_use_id: null,
      },
      {
        type: "tool-call",
        id: "1",
        name: "search",
        parameters: { q: "abc" },
        parent_tool_use_id: null,
      },
      {
        type: "tool-result",
        id: "1",
        result: "found",
        is_error: null,
        parent_tool_use_id: null,
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "done" }],
        parent_tool_use_id: null,
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result).toEqual([
      { role: "user", parts: [{ type: "text", text: "hi" }], model: null },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [
          { type: "text", text: "hello" },
          {
            type: "tool",
            agent: "claudeCode",
            id: "1",
            name: "search",
            parameters: { q: "abc" },
            status: "completed",
            result: "found",
            parts: [],
          },
          { type: "text", text: "done" },
        ],
      },
    ]);
  });

  test("handles nested tool calls with parent_tool_use_id", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "run a task" }],
      },
      {
        type: "tool-call",
        id: "task-1",
        name: "Task",
        parameters: { description: "Complex task" },
        parent_tool_use_id: null,
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "Starting task..." }],
        parent_tool_use_id: "task-1",
      },
      {
        type: "tool-call",
        id: "read-1",
        name: "Read",
        parameters: { file_path: "test.txt" },
        parent_tool_use_id: "task-1",
      },
      {
        type: "tool-result",
        id: "read-1",
        result: "file contents",
        is_error: null,
        parent_tool_use_id: "task-1",
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "Task completed" }],
        parent_tool_use_id: "task-1",
      },
      {
        type: "tool-result",
        id: "task-1",
        result: "Task finished successfully",
        is_error: null,
        parent_tool_use_id: null,
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "run a task" }],
        model: null,
      },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [
          {
            type: "tool",
            agent: "claudeCode",
            id: "task-1",
            name: "Task",
            parameters: { description: "Complex task" },
            status: "completed",
            result: "Task finished successfully",
            parts: [
              { type: "text", text: "Starting task..." },
              {
                type: "tool",
                agent: "claudeCode",
                id: "read-1",
                name: "Read",
                parameters: { file_path: "test.txt" },
                status: "completed",
                result: "file contents",
                parts: [],
              },
              { type: "text", text: "Task completed" },
            ],
          },
        ],
      },
    ]);
  });

  test("handles deeply nested tool calls", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "start" }],
      },
      {
        type: "tool-call",
        id: "task-1",
        name: "Task",
        parameters: { description: "Main task" },
        parent_tool_use_id: null,
      },
      {
        type: "tool-call",
        id: "subtask-1",
        name: "Task",
        parameters: { description: "Subtask" },
        parent_tool_use_id: "task-1",
      },
      {
        type: "tool-call",
        id: "read-1",
        name: "Read",
        parameters: { file_path: "deep.txt" },
        parent_tool_use_id: "subtask-1",
      },
      {
        type: "tool-result",
        id: "read-1",
        result: "deep file contents",
        is_error: null,
        parent_tool_use_id: "subtask-1",
      },
      {
        type: "tool-result",
        id: "subtask-1",
        result: "Subtask done",
        is_error: null,
        parent_tool_use_id: "task-1",
      },
      {
        type: "tool-result",
        id: "task-1",
        result: "Main task done",
        is_error: null,
        parent_tool_use_id: null,
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result).toEqual([
      { role: "user", parts: [{ type: "text", text: "start" }], model: null },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [
          {
            type: "tool",
            agent: "claudeCode",
            id: "task-1",
            name: "Task",
            parameters: { description: "Main task" },
            status: "completed",
            result: "Main task done",
            parts: [
              {
                type: "tool",
                agent: "claudeCode",
                id: "subtask-1",
                name: "Task",
                parameters: { description: "Subtask" },
                status: "completed",
                result: "Subtask done",
                parts: [
                  {
                    type: "tool",
                    agent: "claudeCode",
                    id: "read-1",
                    name: "Read",
                    parameters: { file_path: "deep.txt" },
                    status: "completed",
                    result: "deep file contents",
                    parts: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
  });

  test("handles multiple user messages with agent responses", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "first question" }],
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "first answer" }],
        parent_tool_use_id: null,
      },
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "second question" }],
      },
      {
        type: "tool-call",
        id: "tool-1",
        name: "Read",
        parameters: { file_path: "test.txt" },
        parent_tool_use_id: null,
      },
      {
        type: "tool-result",
        id: "tool-1",
        result: "file content",
        is_error: null,
        parent_tool_use_id: null,
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "second answer" }],
        parent_tool_use_id: null,
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "first question" }],
        model: null,
      },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [{ type: "text", text: "first answer" }],
      },
      {
        role: "user",
        parts: [{ type: "text", text: "second question" }],
        model: null,
      },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [
          {
            type: "tool",
            agent: "claudeCode",
            id: "tool-1",
            name: "Read",
            parameters: { file_path: "test.txt" },
            status: "completed",
            result: "file content",
            parts: [],
          },
          { type: "text", text: "second answer" },
        ],
      },
    ]);
  });

  test("handles orphaned tool results gracefully", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "test" }],
      },
      {
        type: "tool-result",
        id: "orphaned-tool",
        result: "This result has no corresponding tool call",
        is_error: null,
        parent_tool_use_id: null,
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "Done" }],
        parent_tool_use_id: null,
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    // Orphaned tool results should be ignored
    expect(result).toEqual([
      { role: "user", parts: [{ type: "text", text: "test" }], model: null },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [{ type: "text", text: "Done" }],
      },
    ]);
  });

  test("handles mixed nested and non-nested tools", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "do multiple things" }],
      },
      {
        type: "tool-call",
        id: "read-1",
        name: "Read",
        parameters: { file_path: "file1.txt" },
        parent_tool_use_id: null,
      },
      {
        type: "tool-result",
        id: "read-1",
        result: "content 1",
        is_error: null,
        parent_tool_use_id: null,
      },
      {
        type: "tool-call",
        id: "task-1",
        name: "Task",
        parameters: { description: "Complex task" },
        parent_tool_use_id: null,
      },
      {
        type: "tool-call",
        id: "read-2",
        name: "Read",
        parameters: { file_path: "file2.txt" },
        parent_tool_use_id: "task-1",
      },
      {
        type: "tool-result",
        id: "read-2",
        result: "content 2",
        is_error: null,
        parent_tool_use_id: "task-1",
      },
      {
        type: "tool-result",
        id: "task-1",
        result: "task done",
        is_error: null,
        parent_tool_use_id: null,
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "All done!" }],
        parent_tool_use_id: null,
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "do multiple things" }],
        model: null,
      },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [
          {
            type: "tool",
            agent: "claudeCode",
            id: "read-1",
            name: "Read",
            parameters: { file_path: "file1.txt" },
            status: "completed",
            result: "content 1",
            parts: [],
          },
          {
            type: "tool",
            agent: "claudeCode",
            id: "task-1",
            name: "Task",
            parameters: { description: "Complex task" },
            status: "completed",
            result: "task done",
            parts: [
              {
                type: "tool",
                agent: "claudeCode",
                id: "read-2",
                name: "Read",
                parameters: { file_path: "file2.txt" },
                result: "content 2",
                status: "completed",
                parts: [],
              },
            ],
          },
          { type: "text", text: "All done!" },
        ],
      },
    ]);
  });

  test("handles interleaved tool calls and results", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "analyze files" }],
      },
      {
        type: "tool-call",
        id: "tool-1",
        name: "LS",
        parameters: { path: "/" },
        parent_tool_use_id: null,
      },
      {
        type: "tool-call",
        id: "tool-2",
        name: "Grep",
        parameters: { pattern: "TODO" },
        parent_tool_use_id: null,
      },
      {
        type: "tool-result",
        id: "tool-1",
        result: "file1.txt\nfile2.txt",
        is_error: null,
        parent_tool_use_id: null,
      },
      {
        type: "tool-result",
        id: "tool-2",
        result: "Found 5 TODOs",
        is_error: null,
        parent_tool_use_id: null,
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "analyze files" }],
        model: null,
      },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [
          {
            type: "tool",
            agent: "claudeCode",
            id: "tool-1",
            name: "LS",
            parameters: { path: "/" },
            status: "completed",
            result: "file1.txt\nfile2.txt",
            parts: [],
          },
          {
            type: "tool",
            agent: "claudeCode",
            id: "tool-2",
            name: "Grep",
            parameters: { pattern: "TODO" },
            status: "completed",
            result: "Found 5 TODOs",
            parts: [],
          },
        ],
      },
    ]);
  });

  test("handles tools with empty parts array", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "tool-call",
        id: "tool-1",
        name: "TodoRead",
        parameters: {},
        parent_tool_use_id: null,
      },
      {
        type: "tool-result",
        id: "tool-1",
        result: "[]",
        is_error: null,
        parent_tool_use_id: null,
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result).toEqual([
      {
        role: "agent",
        agent: "claudeCode",
        parts: [
          {
            type: "tool",
            agent: "claudeCode",
            id: "tool-1",
            name: "TodoRead",
            parameters: {},
            status: "completed",
            result: "[]",
            parts: [],
          },
        ],
      },
    ]);
  });

  test("handles stop message", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "agent",
        parts: [{ type: "text", text: "Processing..." }],
        parent_tool_use_id: null,
      },
      {
        type: "stop",
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result).toEqual([
      {
        role: "agent",
        agent: "claudeCode",
        parts: [{ type: "text", text: "Processing..." }],
      },
      {
        role: "system",
        message_type: "stop",
        parts: [{ type: "stop" }],
      },
    ]);
  });

  test("handles git-diff message", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "show changes" }],
      },
      {
        type: "git-diff",
        diff: "diff --git a/file.txt b/file.txt\n+new line",
        diffStats: { files: 1, additions: 1, deletions: 0 },
        timestamp: "2023-01-01T00:00:00Z",
        description: "Added new line",
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "show changes" }],
        model: null,
      },
      {
        role: "system",
        message_type: "git-diff",
        parts: [
          {
            type: "git-diff",
            diff: "diff --git a/file.txt b/file.txt\n+new line",
            diffStats: { files: 1, additions: 1, deletions: 0 },
            timestamp: "2023-01-01T00:00:00Z",
            description: "Added new line",
          },
        ],
      },
    ]);
  });

  test("ignores meta messages", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "run a task" }],
      },
      {
        type: "meta",
        subtype: "system-init",
        session_id: "test-session-123",
        tools: ["Read", "Write", "Task"],
        mcp_servers: [{ name: "server1", status: "connected" }],
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "Task started" }],
        parent_tool_use_id: null,
      },
      {
        type: "meta",
        subtype: "result-success",
        cost_usd: 0.01,
        duration_ms: 1000,
        duration_api_ms: 500,
        is_error: false,
        num_turns: 1,
        result: "Task completed successfully",
        session_id: "test-session-123",
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    // Meta messages should be completely ignored
    expect(result).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "run a task" }],
        model: null,
      },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [{ type: "text", text: "Task started" }],
      },
    ]);
  });

  test("flushes message buffers at result-success boundaries", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "first user" }],
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "first agent" }],
        parent_tool_use_id: null,
      },
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
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "second user" }],
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "second agent" }],
        parent_tool_use_id: null,
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result).toEqual([
      {
        role: "user",
        model: null,
        parts: [{ type: "text", text: "first user" }],
      },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [{ type: "text", text: "first agent" }],
      },
      {
        role: "user",
        model: null,
        parts: [{ type: "text", text: "second user" }],
      },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [{ type: "text", text: "second agent" }],
      },
    ]);
  });

  test("handles real-world Task agent with nested Read operations", () => {
    const dbMessages: DBMessage[] = [
      {
        id: "toolu_01GKLEkUWeCqNRrwnjNZaS8V",
        name: "LS",
        parameters: {
          path: "/workspace/repo",
        },
        parent_tool_use_id: null,
        type: "tool-call",
      },
      {
        id: "toolu_01CgPFfrLkPFHCd87kY6PG8h",
        name: "Task",
        parameters: {
          description: "Summarize project README",
          prompt:
            "Please read the README.md file in the root directory and provide a concise summary.",
        },
        parent_tool_use_id: null,
        type: "tool-call",
      },
      {
        id: "toolu_01GKLEkUWeCqNRrwnjNZaS8V",
        parent_tool_use_id: null,
        result: "- /workspace/repo/ - CLAUDE.md - README.md",
        is_error: null,
        type: "tool-result",
      },
      {
        id: "toolu_0197Eg9mB1TUyNLrhNDCR3Q7",
        name: "Read",
        parameters: {
          file_path: "/workspace/repo/README.md",
        },
        parent_tool_use_id: "toolu_01CgPFfrLkPFHCd87kY6PG8h",
        type: "tool-call",
      },
      {
        id: "toolu_0197Eg9mB1TUyNLrhNDCR3Q7",
        parent_tool_use_id: "toolu_01CgPFfrLkPFHCd87kY6PG8h",
        result: "README_CONTENTS",
        is_error: null,
        type: "tool-result",
      },
      {
        id: "toolu_01CgPFfrLkPFHCd87kY6PG8h",
        parent_tool_use_id: null,
        result:
          '[{"type":"text","text":"Based on the README.md file, here\'s a concise summary..."}]',
        is_error: null,
        type: "tool-result",
      },
      {
        parent_tool_use_id: null,
        parts: [
          {
            text: "**Directory listing:** Contains CLAUDE.md, ...**README Summary:** Terragon is a...",
            type: "text",
          },
        ],
        type: "agent",
      },
    ];
    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result).toEqual([
      {
        role: "agent",
        agent: "claudeCode",
        parts: [
          {
            type: "tool",
            agent: "claudeCode",
            id: "toolu_01GKLEkUWeCqNRrwnjNZaS8V",
            name: "LS",
            parameters: {
              path: "/workspace/repo",
            },
            parts: [],
            result: "- /workspace/repo/ - CLAUDE.md - README.md",
            status: "completed",
          },
          {
            type: "tool",
            agent: "claudeCode",
            id: "toolu_01CgPFfrLkPFHCd87kY6PG8h",
            name: "Task",
            parameters: {
              description: "Summarize project README",
              prompt:
                "Please read the README.md file in the root directory and provide a concise summary.",
            },
            parts: [
              {
                type: "tool",
                agent: "claudeCode",
                id: "toolu_0197Eg9mB1TUyNLrhNDCR3Q7",
                name: "Read",
                parameters: {
                  file_path: "/workspace/repo/README.md",
                },
                parts: [],
                result: "README_CONTENTS",
                status: "completed",
              },
            ],
            result:
              '[{"type":"text","text":"Based on the README.md file, here\'s a concise summary..."}]',
            status: "completed",
          },
          {
            text: "**Directory listing:** Contains CLAUDE.md, ...**README Summary:** Terragon is a...",
            type: "text",
          },
        ],
      },
    ]);
  });

  test("deduplicates consecutive TodoWrite tool calls", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "manage todos" }],
      },
      {
        type: "tool-call",
        id: "todo-1",
        name: "TodoWrite",
        parameters: { todos: [{ content: "First todo", status: "pending" }] },
        parent_tool_use_id: null,
      },
      {
        type: "tool-result",
        id: "todo-1",
        result: "success",
        is_error: null,
        parent_tool_use_id: null,
      },
      {
        type: "tool-call",
        id: "todo-2",
        name: "TodoWrite",
        parameters: { todos: [{ content: "Updated todo", status: "pending" }] },
        parent_tool_use_id: null,
      },
      {
        type: "tool-result",
        id: "todo-2",
        result: "success",
        is_error: null,
        parent_tool_use_id: null,
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "manage todos" }],
        model: null,
      },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [
          {
            type: "tool",
            agent: "claudeCode",
            id: "todo-2",
            name: "TodoWrite",
            parameters: {
              todos: [{ content: "Updated todo", status: "pending" }],
            },
            status: "completed",
            result: "success",
            parts: [],
          },
        ],
      },
    ]);
  });

  test("does not deduplicate TodoWrite calls with other tools in between", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "manage todos and read file" }],
      },
      {
        type: "tool-call",
        id: "todo-1",
        name: "TodoWrite",
        parameters: { todos: [{ content: "First todo", status: "pending" }] },
        parent_tool_use_id: null,
      },
      {
        type: "tool-result",
        id: "todo-1",
        result: "success",
        is_error: null,
        parent_tool_use_id: null,
      },
      {
        type: "tool-call",
        id: "read-1",
        name: "Read",
        parameters: { file_path: "test.txt" },
        parent_tool_use_id: null,
      },
      {
        type: "tool-result",
        id: "read-1",
        result: "file content",
        is_error: null,
        parent_tool_use_id: null,
      },
      {
        type: "tool-call",
        id: "todo-2",
        name: "TodoWrite",
        parameters: { todos: [{ content: "Second todo", status: "pending" }] },
        parent_tool_use_id: null,
      },
      {
        type: "tool-result",
        id: "todo-2",
        result: "success",
        is_error: null,
        parent_tool_use_id: null,
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "manage todos and read file" }],
        model: null,
      },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [
          {
            type: "tool",
            agent: "claudeCode",
            id: "todo-1",
            name: "TodoWrite",
            parameters: {
              todos: [{ content: "First todo", status: "pending" }],
            },
            status: "completed",
            result: "success",
            parts: [],
          },
          {
            type: "tool",
            agent: "claudeCode",
            id: "read-1",
            name: "Read",
            parameters: { file_path: "test.txt" },
            status: "completed",
            result: "file content",
            parts: [],
          },
          {
            type: "tool",
            agent: "claudeCode",
            id: "todo-2",
            name: "TodoWrite",
            parameters: {
              todos: [{ content: "Second todo", status: "pending" }],
            },
            status: "completed",
            result: "success",
            parts: [],
          },
        ],
      },
    ]);
  });

  test("deduplicates nested TodoWrite calls within Task", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "complex task" }],
      },
      {
        type: "tool-call",
        id: "task-1",
        name: "Task",
        parameters: { description: "Manage todos" },
        parent_tool_use_id: null,
      },
      {
        type: "tool-call",
        id: "todo-1",
        name: "TodoWrite",
        parameters: { todos: [{ content: "Initial todo", status: "pending" }] },
        parent_tool_use_id: "task-1",
      },
      {
        type: "tool-result",
        id: "todo-1",
        result: "success",
        is_error: null,
        parent_tool_use_id: "task-1",
      },
      {
        type: "tool-call",
        id: "todo-2",
        name: "TodoWrite",
        parameters: { todos: [{ content: "Updated todo", status: "pending" }] },
        parent_tool_use_id: "task-1",
      },
      {
        type: "tool-result",
        id: "todo-2",
        result: "success",
        is_error: null,
        parent_tool_use_id: "task-1",
      },
      {
        type: "tool-result",
        id: "task-1",
        result: "Task completed",
        is_error: null,
        parent_tool_use_id: null,
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "complex task" }],
        model: null,
      },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [
          {
            type: "tool",
            agent: "claudeCode",
            id: "task-1",
            name: "Task",
            parameters: { description: "Manage todos" },
            status: "completed",
            result: "Task completed",
            parts: [
              {
                type: "tool",
                agent: "claudeCode",
                id: "todo-2",
                name: "TodoWrite",
                parameters: {
                  todos: [{ content: "Updated todo", status: "pending" }],
                },
                status: "completed",
                result: "success",
                parts: [],
              },
            ],
          },
        ],
      },
    ]);
  });

  test("preserves user message timestamps", () => {
    const timestamp = "2024-01-01T12:00:00Z";
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Hello" }],
        timestamp,
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "Hi there!" }],
        parent_tool_use_id: null,
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result[0]).toEqual({
      role: "user",
      parts: [{ type: "text", text: "Hello" }],
      timestamp,
      model: null,
    });
  });

  test("does not deduplicate TodoWrite when previous part is not TodoWrite", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "manage stuff" }],
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "Starting..." }],
        parent_tool_use_id: null,
      },
      {
        type: "tool-call",
        id: "todo-1",
        name: "TodoWrite",
        parameters: { todos: [{ content: "New todo", status: "pending" }] },
        parent_tool_use_id: null,
      },
      {
        type: "tool-result",
        id: "todo-1",
        result: "success",
        is_error: null,
        parent_tool_use_id: null,
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "manage stuff" }],
        model: null,
      },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [
          { type: "text", text: "Starting..." },
          {
            type: "tool",
            agent: "claudeCode",
            id: "todo-1",
            name: "TodoWrite",
            parameters: { todos: [{ content: "New todo", status: "pending" }] },
            status: "completed",
            result: "success",
            parts: [],
          },
        ],
      },
    ]);
  });

  test("handles system messages with retry-git-commit-and-push message type", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Create a PR" }],
      },
      {
        type: "system",
        message_type: "retry-git-commit-and-push",
        parts: [
          {
            type: "text",
            text: "Git commit failed. Please retry the operation.",
          },
        ],
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "I'll retry the git operation" }],
        parent_tool_use_id: null,
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "Create a PR" }],
        model: null,
      },
      {
        role: "system",
        message_type: "retry-git-commit-and-push",
        parts: [
          {
            type: "text",
            text: "Git commit failed. Please retry the operation.",
          },
        ],
      },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [{ type: "text", text: "I'll retry the git operation" }],
      },
    ]);
  });

  test("handles system messages with timestamps", () => {
    const timestamp = "2024-01-01T10:00:00Z";
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Test message" }],
      },
      {
        type: "system",
        message_type: "retry-git-commit-and-push",
        parts: [{ type: "text", text: "System message with timestamp" }],
        timestamp,
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "Test message" }],
        model: null,
      },
      {
        role: "system",
        message_type: "retry-git-commit-and-push",
        parts: [{ type: "text", text: "System message with timestamp" }],
      },
    ]);
  });

  test("handles system messages mixed with other message types", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Push changes" }],
      },
      {
        type: "tool-call",
        id: "bash-1",
        name: "Bash",
        parameters: { command: "git push origin main" },
        parent_tool_use_id: null,
      },
      {
        type: "tool-result",
        id: "bash-1",
        result: "error: push failed",
        is_error: true,
        parent_tool_use_id: null,
      },
      {
        type: "system",
        message_type: "retry-git-commit-and-push",
        parts: [
          { type: "text", text: "Auto-recovery queued for git push failure" },
        ],
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "I'll handle the git push failure" }],
        parent_tool_use_id: null,
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });

    // The user message is preserved and tool-call triggers an agent message
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({
      role: "user",
      parts: [{ type: "text", text: "Push changes" }],
      timestamp: undefined,
      model: null,
    });
    expect(result[1]).toEqual({
      role: "agent",
      agent: "claudeCode",
      parts: [
        {
          type: "tool",
          agent: "claudeCode",
          id: "bash-1",
          name: "Bash",
          parameters: { command: "git push origin main" },
          status: "error",
          result: "error: push failed",
          parts: [],
        },
      ],
    });
    expect(result[2]).toEqual({
      role: "system",
      message_type: "retry-git-commit-and-push",
      parts: [
        { type: "text", text: "Auto-recovery queued for git push failure" },
      ],
    });
    expect(result[3]).toEqual({
      role: "agent",
      agent: "claudeCode",
      parts: [{ type: "text", text: "I'll handle the git push failure" }],
    });
  });

  test("consolidates consecutive user messages", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "First message" }],
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Second message" }],
        timestamp: "2024-01-01T00:01:00Z",
      },
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Third message" }],
        timestamp: "2024-01-01T00:02:00Z",
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", text: "First message" },
          { type: "text", text: "Second message" },
          { type: "text", text: "Third message" },
        ],
        timestamp: "2024-01-01T00:02:00Z", // Latest timestamp
        model: null,
      },
    ]);
  });

  test("does not consolidate user messages interrupted by agent messages", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "First question" }],
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "First answer" }],
        parent_tool_use_id: null,
      },
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Follow-up question" }],
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "First question" }],
        model: null,
      },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [{ type: "text", text: "First answer" }],
      },
      {
        role: "user",
        parts: [{ type: "text", text: "Follow-up question" }],
        model: null,
      },
    ]);
  });

  test("clears current user message when encountering system message", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "User message" }],
      },
      {
        type: "system",
        message_type: "retry-git-commit-and-push",
        parts: [{ type: "text", text: "System interruption" }],
      },
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "New user message" }],
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "User message" }],
        model: null,
      },
      {
        role: "system",
        message_type: "retry-git-commit-and-push",
        parts: [{ type: "text", text: "System interruption" }],
      },
      {
        role: "user",
        parts: [{ type: "text", text: "New user message" }],
        model: null,
      },
    ]);
  });

  test("clears current user message when encountering git-diff", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Show me the changes" }],
      },
      {
        type: "git-diff",
        diff: "diff --git a/file.txt b/file.txt\n+added line",
        timestamp: "2024-01-01T00:00:00Z",
        description: "Added new content",
      },
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Another request" }],
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "Show me the changes" }],
        model: null,
      },
      {
        role: "system",
        message_type: "git-diff",
        parts: [
          {
            type: "git-diff",
            diff: "diff --git a/file.txt b/file.txt\n+added line",
            timestamp: "2024-01-01T00:00:00Z",
            description: "Added new content",
          },
        ],
      },
      {
        role: "user",
        parts: [{ type: "text", text: "Another request" }],
        model: null,
      },
    ]);
  });

  test("handles stop message with user message clearing", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Do something" }],
      },
      {
        type: "stop",
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "Task stopped" }],
        parent_tool_use_id: null,
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "Do something" }],
        timestamp: undefined,
        model: null,
      },
      {
        role: "system",
        message_type: "stop",
        parts: [{ type: "stop" }],
      },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [{ type: "text", text: "Task stopped" }],
      },
    ]);
  });

  test("consolidates user messages with mixed content types", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Text part" }],
      },
      {
        type: "user",
        model: null,
        parts: [
          {
            type: "image",
            mime_type: "image/png",
            image_url: "https://example.com/image.png",
          },
          { type: "text", text: "Image description" },
        ],
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", text: "Text part" },
          {
            type: "image",
            mime_type: "image/png",
            image_url: "https://example.com/image.png",
          },
          { type: "text", text: "Image description" },
        ],
        model: null,
      },
    ]);
  });

  test("marks pending tool calls as completed when user message follows", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Do something" }],
      },
      {
        type: "tool-call",
        id: "tool-1",
        name: "Read",
        parameters: { file_path: "test.txt" },
        parent_tool_use_id: null,
      },
      // No tool-result message, so tool should remain pending initially
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Never mind, do something else" }],
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "Do something" }],
        model: null,
      },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [
          {
            type: "tool",
            agent: "claudeCode",
            id: "tool-1",
            name: "Read",
            parameters: { file_path: "test.txt" },
            status: "completed", // Should be marked as completed because user message follows
            result: "[Tool execution was interrupted]",
            parts: [],
          },
        ],
      },
      {
        role: "user",
        parts: [{ type: "text", text: "Never mind, do something else" }],
        model: null,
      },
    ]);
  });

  test("marks pending tool calls as completed when git diff follows", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Make changes" }],
      },
      {
        type: "tool-call",
        id: "tool-1",
        name: "Write",
        parameters: { file_path: "test.txt", content: "new content" },
        parent_tool_use_id: null,
      },
      // No tool-result message, so tool should remain pending initially
      {
        type: "git-diff",
        diff: "diff --git a/test.txt b/test.txt\n+new content",
        timestamp: "2024-01-01T00:00:00Z",
        description: "Added new content",
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "Make changes" }],
        model: null,
      },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [
          {
            type: "tool",
            agent: "claudeCode",
            id: "tool-1",
            name: "Write",
            parameters: { file_path: "test.txt", content: "new content" },
            status: "completed", // Should be marked as completed because git-diff follows
            result: "[Tool execution was interrupted]",
            parts: [],
          },
        ],
      },
      {
        role: "system",
        message_type: "git-diff",
        parts: [
          {
            type: "git-diff",
            diff: "diff --git a/test.txt b/test.txt\n+new content",
            timestamp: "2024-01-01T00:00:00Z",
            description: "Added new content",
          },
        ],
      },
    ]);
  });

  test("marks multiple pending tool calls as completed when user message follows", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Do multiple things" }],
      },
      {
        type: "tool-call",
        id: "tool-1",
        name: "Read",
        parameters: { file_path: "file1.txt" },
        parent_tool_use_id: null,
      },
      {
        type: "tool-call",
        id: "tool-2",
        name: "Write",
        parameters: { file_path: "file2.txt", content: "content" },
        parent_tool_use_id: null,
      },
      // No tool-result messages
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Actually, do something different" }],
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "Do multiple things" }],
        model: null,
      },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [
          {
            type: "tool",
            agent: "claudeCode",
            id: "tool-1",
            name: "Read",
            parameters: { file_path: "file1.txt" },
            status: "completed", // Both tools marked as completed
            result: "[Tool execution was interrupted]",
            parts: [],
          },
          {
            type: "tool",
            agent: "claudeCode",
            id: "tool-2",
            name: "Write",
            parameters: { file_path: "file2.txt", content: "content" },
            status: "completed",
            result: "[Tool execution was interrupted]",
            parts: [],
          },
        ],
      },
      {
        role: "user",
        parts: [{ type: "text", text: "Actually, do something different" }],
        model: null,
      },
    ]);
  });

  test("marks pending tool calls as completed when stop message follows", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Do something" }],
      },
      {
        type: "tool-call",
        id: "tool-1",
        name: "Read",
        parameters: { file_path: "test.txt" },
        parent_tool_use_id: null,
      },
      // Agent stops
      {
        type: "stop",
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(result).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "Do something" }],
        model: null,
      },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [
          {
            type: "tool",
            agent: "claudeCode",
            id: "tool-1",
            name: "Read",
            parameters: { file_path: "test.txt" },
            status: "completed",
            result: "[Tool execution was interrupted]",
            parts: [],
          },
        ],
      },
      {
        role: "system",
        message_type: "stop",
        parts: [{ type: "stop" }],
      },
    ]);
  });

  test("marks pending tool calls as completed when error message follows", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Do something" }],
      },
      {
        type: "tool-call",
        id: "tool-1",
        name: "Write",
        parameters: { file_path: "test.txt", content: "content" },
        parent_tool_use_id: null,
      },
      // Agent encounters an error
      {
        type: "error",
        error_type: "rate_limit",
        error_info: "Rate limit exceeded",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    // Error messages are not shown in UI messages
    expect(result).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "Do something" }],
        model: null,
      },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [
          {
            type: "tool",
            agent: "claudeCode",
            id: "tool-1",
            name: "Write",
            parameters: { file_path: "test.txt", content: "content" },
            status: "completed",
            result: "[Tool execution was interrupted]",
            parts: [],
          },
        ],
      },
    ]);
  });

  test("marks pending tool calls as completed when max turns error follows", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Do something complex" }],
      },
      {
        type: "tool-call",
        id: "tool-1",
        name: "Task",
        parameters: { description: "Complex task" },
        parent_tool_use_id: null,
      },
      // Agent hits max turns
      {
        type: "meta",
        subtype: "result-error-max-turns",
        cost_usd: 0.01,
        duration_ms: 5000,
        duration_api_ms: 4000,
        is_error: true,
        num_turns: 25,
        session_id: "test-session",
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    // Meta messages are not shown in UI messages
    expect(result).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "Do something complex" }],
        model: null,
      },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [
          {
            type: "tool",
            agent: "claudeCode",
            id: "tool-1",
            name: "Task",
            parameters: { description: "Complex task" },
            status: "completed",
            result: "[Tool execution was interrupted]",
            parts: [],
          },
        ],
      },
    ]);
  });

  test("marks pending tool calls as completed when thread status is not working", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Do something" }],
      },
      {
        type: "tool-call",
        id: "tool-1",
        name: "Read",
        parameters: { file_path: "test.txt" },
        parent_tool_use_id: null,
      },
      // No more messages - tools remain pending in messages
    ];

    // Without thread status, tool remains pending
    const resultWithoutStatus = toUIMessages({
      dbMessages,
      agent: "claudeCode",
    });
    expect(resultWithoutStatus).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "Do something" }],
        model: null,
      },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [
          {
            type: "tool",
            agent: "claudeCode",
            id: "tool-1",
            name: "Read",
            parameters: { file_path: "test.txt" },
            status: "pending",
            parts: [],
          },
        ],
      },
    ]);

    // With non-working thread status, tool is marked complete
    const resultWithCompleteStatus = toUIMessages({
      dbMessages,
      agent: "claudeCode",
      threadStatus: "complete",
    });
    expect(resultWithCompleteStatus).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "Do something" }],
        model: null,
      },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [
          {
            type: "tool",
            agent: "claudeCode",
            id: "tool-1",
            name: "Read",
            parameters: { file_path: "test.txt" },
            status: "completed",
            result: "[Tool execution was interrupted]",
            parts: [],
          },
        ],
      },
    ]);

    // With working thread status, tool remains pending
    const resultWithWorkingStatus = toUIMessages({
      dbMessages,
      agent: "claudeCode",
      threadStatus: "working",
    });
    expect(resultWithWorkingStatus).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "Do something" }],
        model: null,
      },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [
          {
            type: "tool",
            agent: "claudeCode",
            id: "tool-1",
            name: "Read",
            parameters: { file_path: "test.txt" },
            status: "pending",
            parts: [],
          },
        ],
      },
    ]);
  });
  test("renders one system line per credential source", () => {
    const cases = [
      ["user-credential", "your connected credential"],
      ["built-in-credits", "built-in credits"],
      ["box-key", "this box's own API key"],
    ] as const;

    for (const [source, label] of cases) {
      const dbMessages: DBMessage[] = [
        {
          type: "credential-source",
          source,
          timestamp: "2026-09-30T00:00:00Z",
        },
      ];
      expect(toUIMessages({ dbMessages, agent: "claudeCode" })).toEqual([
        {
          role: "system",
          message_type: "credential-source",
          parts: [{ type: "text", text: label }],
        },
      ]);
    }
  });

  test("produces no credential-source message when none was recorded", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "hi" }],
      },
    ];

    const result = toUIMessages({ dbMessages, agent: "claudeCode" });
    expect(
      result.filter(
        (m) => m.role === "system" && m.message_type === "credential-source",
      ),
    ).toEqual([]);
  });

  test("renders nothing for an unknown credential source value", () => {
    const dbMessages = [
      { type: "credential-source", source: "from-the-future" },
    ] as unknown as DBMessage[];

    expect(toUIMessages({ dbMessages, agent: "claudeCode" })).toEqual([]);
  });

  test("credential-source closes the current agent and user messages", () => {
    const dbMessages: DBMessage[] = [
      {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "go" }],
      },
      {
        type: "credential-source",
        source: "built-in-credits",
      },
      {
        type: "agent",
        parts: [{ type: "text", text: "working" }],
        parent_tool_use_id: null,
      },
    ];

    expect(toUIMessages({ dbMessages, agent: "claudeCode" })).toEqual([
      { role: "user", parts: [{ type: "text", text: "go" }], model: null },
      {
        role: "system",
        message_type: "credential-source",
        parts: [{ type: "text", text: "built-in credits" }],
      },
      {
        role: "agent",
        agent: "claudeCode",
        parts: [{ type: "text", text: "working" }],
      },
    ]);
  });
});
