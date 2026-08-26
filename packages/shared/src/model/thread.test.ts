import { beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  createTestThread,
  createTestAutomation,
} from "./test-helpers";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import { ThreadInsert, ThreadChatInsert, User } from "../db/types";
import { DBMessage, DBUserMessage } from "../db/db-message";
import {
  createThread,
  updateThread,
  getThreads,
  getThreadsForAdmin,
  getThread,
  deleteThreadById,
  getStalledThreads,
  stopStalledThreads,
  atomicDequeueThreadChats,
  getActiveThreadCount,
  getUserIdsWithThreadsStuckInQueue,
  getThreadWithPermissions,
  getUserIdsWithThreadsReadyToProcess,
  updateThreadChatStatusAtomic,
  getEligibleQueuedThreadChats,
  getThreadsAndPRsStats,
  updateThreadChat,
  getThreadChat,
  getThreadMinimal,
} from "./threads";
import { LEGACY_THREAD_CHAT_ID } from "../utils/thread-utils";
import { upsertGithubPR } from "./github";
import {
  markThreadChatAsUnread,
  markThreadChatAsRead,
} from "./thread-read-status";
import { updateThreadVisibility } from "./thread-visibility";
import * as schema from "../db/schema";
import { eq } from "drizzle-orm";
import { tz } from "@date-fns/tz";
import { set as setDateValues, subDays } from "date-fns";

const db = createDb(env.DATABASE_URL!);

describe("thread", () => {
  let user: User;

  beforeEach(async () => {
    const testUserAndAccount = await createTestUser({ db });
    user = testUserAndAccount.user;
  });

  describe("createThread", () => {
    it("should create a thread", async () => {
      const { threadId } = await createThread({
        db,
        userId: user.id,
        threadValues: {
          githubRepoFullName: "terragon/terragon",
          repoBaseBranchName: "main",
          sandboxProvider: "e2b",
        },
        initialChatValues: {
          agent: "claudeCode",
        },
      });
      expect(threadId).toBeDefined();
      const threads = await getThreads({ db, userId: user.id });
      expect(threads.length).toBe(1);
      expect(threads[0]!.id).toBe(threadId);
    });

    describe("enableThreadChatCreation parameter", () => {
      it("should create legacy thread when enableThreadChatCreation is false", async () => {
        const scheduleAt = new Date();
        const { threadId, threadChatId } = await createThread({
          db,
          userId: user.id,
          threadValues: {
            githubRepoFullName: "terragon/terragon",
            repoBaseBranchName: "main",
            sandboxProvider: "e2b",
          },
          initialChatValues: {
            scheduleAt,
          },
          enableThreadChatCreation: false,
        });

        expect(threadId).toBeDefined();
        expect(threadChatId).toBe(LEGACY_THREAD_CHAT_ID);

        const thread = await getThread({ db, threadId, userId: user.id });
        expect(thread).toBeDefined();
        expect(thread!.threadChats).toHaveLength(1);
        expect(thread!.threadChats[0]!.id).toBe(LEGACY_THREAD_CHAT_ID);

        // Verify chat data is stored on the thread table
        const dbThread = await db.query.thread.findFirst({
          where: eq(schema.thread.id, threadId),
        });
        expect(dbThread!.scheduleAt).toEqual(scheduleAt);
      });

      it("should create thread with separate threadChat when enableThreadChatCreation is true", async () => {
        const scheduleAt = new Date();
        const { threadId, threadChatId } = await createThread({
          db,
          userId: user.id,
          threadValues: {
            githubRepoFullName: "terragon/terragon",
            repoBaseBranchName: "main",
            sandboxProvider: "e2b",
          },
          initialChatValues: {
            scheduleAt,
          },
          enableThreadChatCreation: true,
        });

        expect(threadId).toBeDefined();
        expect(threadChatId).toBeDefined();
        expect(threadChatId).not.toBe(LEGACY_THREAD_CHAT_ID);

        const thread = await getThread({ db, threadId, userId: user.id });
        expect(thread).toBeDefined();
        expect(thread!.threadChats).toHaveLength(1);
        expect(thread!.threadChats[0]!.id).toBe(threadChatId);
        expect(thread!.threadChats[0]!.id).not.toBe(LEGACY_THREAD_CHAT_ID);

        // Verify separate threadChat record exists
        const dbThreadChat = await db.query.threadChat.findFirst({
          where: eq(schema.threadChat.id, threadChatId),
        });
        console.log({ dbThreadChat });
        expect(dbThreadChat).toBeDefined();
        expect(dbThreadChat!.threadId).toBe(threadId);
        expect(dbThreadChat!.scheduleAt).toEqual(scheduleAt);

        // Verify thread table doesn't have chat data
        const dbThread = await db.query.thread.findFirst({
          where: eq(schema.thread.id, threadId),
        });
        expect(dbThread!.scheduleAt).toBeNull();
      });
    });
  });

  describe("getThreadChat", () => {
    it("should retrieve legacy thread chat when enableThreadChatCreation is false", async () => {
      const { threadId, threadChatId } = await createThread({
        db,
        userId: user.id,
        threadValues: {
          githubRepoFullName: "terragon/terragon",
          repoBaseBranchName: "main",
          sandboxProvider: "e2b",
        },
        initialChatValues: {
          agent: "claudeCode",
          status: "working",
        },
        enableThreadChatCreation: false,
      });

      const threadChat = await getThreadChat({
        db,
        threadId,
        threadChatId,
        userId: user.id,
      });

      expect(threadChat).toBeDefined();
      expect(threadChat!.id).toBe(LEGACY_THREAD_CHAT_ID);
      expect(threadChat!.threadId).toBe(threadId);
      expect(threadChat!.agent).toBe("claudeCode");
      expect(threadChat!.status).toBe("working");
    });

    it("should retrieve separate thread chat when enableThreadChatCreation is true", async () => {
      const { threadId, threadChatId } = await createThread({
        db,
        userId: user.id,
        threadValues: {
          githubRepoFullName: "terragon/terragon",
          repoBaseBranchName: "main",
          sandboxProvider: "e2b",
        },
        initialChatValues: {
          agent: "claudeCode",
          status: "queued",
        },
        enableThreadChatCreation: true,
      });

      const threadChat = await getThreadChat({
        db,
        threadId,
        threadChatId,
        userId: user.id,
      });

      expect(threadChat).toBeDefined();
      expect(threadChat!.id).toBe(threadChatId);
      expect(threadChat!.id).not.toBe(LEGACY_THREAD_CHAT_ID);
      expect(threadChat!.threadId).toBe(threadId);
      expect(threadChat!.agent).toBe("claudeCode");
      expect(threadChat!.status).toBe("queued");
    });

    it("should return undefined for non-existent thread chat", async () => {
      const { threadId } = await createThread({
        db,
        userId: user.id,
        threadValues: {
          githubRepoFullName: "terragon/terragon",
          repoBaseBranchName: "main",
          sandboxProvider: "e2b",
        },
        initialChatValues: {
          agent: "claudeCode",
        },
        enableThreadChatCreation: true,
      });

      const threadChat = await getThreadChat({
        db,
        threadId,
        threadChatId: "non-existent-chat-id",
        userId: user.id,
      });

      expect(threadChat).toBeUndefined();
    });

    it("should return undefined for wrong user", async () => {
      const { user: otherUser } = await createTestUser({ db });
      const { threadId, threadChatId } = await createThread({
        db,
        userId: user.id,
        threadValues: {
          githubRepoFullName: "terragon/terragon",
          repoBaseBranchName: "main",
          sandboxProvider: "e2b",
        },
        initialChatValues: {
          agent: "claudeCode",
        },
        enableThreadChatCreation: true,
      });

      const threadChat = await getThreadChat({
        db,
        threadId,
        threadChatId,
        userId: otherUser.id,
      });

      expect(threadChat).toBeUndefined();
    });

    it("should include messages and queuedMessages when enableThreadChatCreation is true", async () => {
      const { threadId, threadChatId } = await createThread({
        db,
        userId: user.id,
        threadValues: {
          githubRepoFullName: "terragon/terragon",
          repoBaseBranchName: "main",
          sandboxProvider: "e2b",
        },
        initialChatValues: {
          agent: "claudeCode",
        },
        enableThreadChatCreation: true,
      });

      const message: DBMessage = {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Test message" }],
      };
      const queuedMessage: DBUserMessage = {
        type: "user",
        model: null,
        parts: [{ type: "text", text: "Queued message" }],
      };

      await updateThreadChat({
        db,
        userId: user.id,
        threadId,
        threadChatId,
        updates: {
          appendMessages: [message],
          appendQueuedMessages: [queuedMessage],
        },
      });

      const threadChat = await getThreadChat({
        db,
        threadId,
        threadChatId,
        userId: user.id,
      });
      expect(threadChat).toBeDefined();
      expect(threadChat!.messages).toHaveLength(1);
      expect(threadChat!.messages?.[0]).toEqual(message);
      expect(threadChat!.queuedMessages).toHaveLength(1);
      expect(threadChat!.queuedMessages?.[0]).toEqual(queuedMessage);
    });
  });

  describe("updateThread", () => {
    it("should update a thread", async () => {
      const { threadId, threadChatId } = await createTestThread({
        db,
        userId: user.id,
      });
      const threadChat = await getThreadChat({
        db,
        threadId,
        threadChatId,
        userId: user.id,
      });
      expect(threadChat!.status).toBe("queued");
      await updateThread({
        db: db,
        userId: user.id,
        threadId,
        updates: {
          name: "test-thread-2",
        },
      });
      const updatedThread = await getThreadMinimal({
        db,
        threadId,
        userId: user.id,
      });
      expect(updatedThread!.id).toBe(threadId);
      expect(updatedThread!.name).toBe("test-thread-2");
    });
  });

  describe("updateThreadChat", () => {
    describe("appendMessages", () => {
      it("should append messages to empty thread", async () => {
        const { threadId, threadChatId } = await createTestThread({
          db,
          userId: user.id,
        });
        const threadChat = await getThreadChat({
          db,
          threadId,
          threadChatId,
          userId: user.id,
        });

        const newMessage: DBMessage = {
          type: "user",
          model: null,
          parts: [{ type: "text", text: "Hello world" }],
        };

        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId: threadChat!.id,
          updates: {
            appendMessages: [newMessage],
          },
        });
        const updatedThreadChat = await getThreadChat({
          db,
          threadId,
          threadChatId,
          userId: user.id,
        });
        expect(updatedThreadChat!.messages).toHaveLength(1);
        expect(updatedThreadChat!.messages?.[0]).toEqual(newMessage);
      });

      it("should append messages to existing messages", async () => {
        const { threadId, threadChatId } = await createTestThread({
          db,
          userId: user.id,
        });

        // First add some messages
        const firstMessage: DBMessage = {
          type: "user",
          model: null,
          parts: [{ type: "text", text: "First message" }],
        };

        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            appendMessages: [firstMessage],
          },
        });

        // Now append more messages
        const secondMessage: DBMessage = {
          type: "agent",
          parent_tool_use_id: null,
          parts: [{ type: "text", text: "Response" }],
        };

        const thirdMessage: DBMessage = {
          type: "user",
          model: null,
          parts: [{ type: "text", text: "Another message" }],
        };

        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            appendMessages: [secondMessage, thirdMessage],
          },
        });
        const updatedThreadChat = await getThreadChat({
          db,
          threadId,
          threadChatId,
          userId: user.id,
        });
        expect(updatedThreadChat!.messages).toHaveLength(3);
        expect(updatedThreadChat!.messages?.[0]).toEqual(firstMessage);
        expect(updatedThreadChat!.messages?.[1]).toEqual(secondMessage);
        expect(updatedThreadChat!.messages?.[2]).toEqual(thirdMessage);
      });

      it("should not modify messages when appendMessages is empty array", async () => {
        const { threadId, threadChatId } = await createTestThread({
          db,
          userId: user.id,
        });
        const existingMessage: DBMessage = {
          type: "user",
          model: null,
          parts: [{ type: "text", text: "Existing" }],
        };

        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            errorMessage: null,
            appendMessages: [existingMessage],
          },
        });

        // Update with empty appendMessages
        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            errorMessage: null,
            appendMessages: [],
          },
        });
        const updatedThreadChat = await getThreadChat({
          db,
          threadId,
          threadChatId,
          userId: user.id,
        });
        expect(updatedThreadChat!.messages).toHaveLength(1);
        expect(updatedThreadChat!.messages?.[0]).toEqual(existingMessage);
      });

      it("should update other fields while appending messages", async () => {
        const { threadId, threadChatId } = await createTestThread({
          db,
          userId: user.id,
        });
        const message: DBMessage = {
          type: "user",
          model: null,
          parts: [{ type: "text", text: "Test" }],
        };

        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            errorMessage: "unknown-error",
            appendMessages: [message],
          },
        });
        const updatedThreadChat = await getThreadChat({
          db,
          threadId,
          threadChatId,
          userId: user.id,
        });
        expect(updatedThreadChat!.errorMessage).toBe("unknown-error");
        expect(updatedThreadChat!.messages).toHaveLength(1);
        expect(updatedThreadChat!.messages?.[0]).toEqual(message);
      });

      it("should handle concurrent message appends safely", async () => {
        const { threadId, threadChatId } = await createTestThread({
          db,
          userId: user.id,
        });
        // Simulate concurrent appends
        const promises = [];
        for (let i = 0; i < 5; i++) {
          const message: DBMessage = {
            type: "user",
            model: null,
            parts: [{ type: "text", text: `Message ${i}` }],
          };

          promises.push(
            updateThreadChat({
              db,
              userId: user.id,
              threadId,
              threadChatId,
              updates: {
                appendMessages: [message],
              },
            }),
          );
        }

        await Promise.all(promises);

        // Check final state
        const finalChat = await getThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
        });

        expect(finalChat).not.toBeNull();

        // All 5 messages should be appended
        expect(finalChat!.messages).toHaveLength(5);

        // Messages should contain all 5 texts (order may vary due to concurrency)
        const messageTexts = finalChat!.messages
          ?.map((m) => {
            if (m.type === "user" && m.parts[0]?.type === "text") {
              return m.parts[0].text;
            }
            return "";
          })
          .sort();

        expect(messageTexts).toEqual([
          "Message 0",
          "Message 1",
          "Message 2",
          "Message 3",
          "Message 4",
        ]);
      });

      it("should handle appending to non-existent thread gracefully", async () => {
        const message: DBMessage = {
          type: "user",
          model: null,
          parts: [{ type: "text", text: "Test" }],
        };

        // When appending to non-existent thread, the update will return 0 rows
        // and throw "Thread not found" error
        await expect(
          updateThreadChat({
            db,
            userId: user.id,
            threadId: "non-existent-thread",
            threadChatId: LEGACY_THREAD_CHAT_ID,
            updates: {
              appendMessages: [message],
            },
          }),
        ).rejects.toThrow("Failed to update thread");
      });

      it("should handle null messages array when appending", async () => {
        const { threadId, threadChatId } = await createTestThread({
          db,
          userId: user.id,
        });
        // Ensure thread has null messages
        await db
          .update(schema.thread)
          .set({ messages: null })
          .where(eq(schema.thread.id, threadId));
        const message: DBMessage = {
          type: "user",
          model: null,
          parts: [{ type: "text", text: "First message on null" }],
        };

        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            appendMessages: [message],
          },
        });
        const updatedThreadChat = await getThreadChat({
          db,
          threadId,
          threadChatId: LEGACY_THREAD_CHAT_ID,
          userId: user.id,
        });
        expect(updatedThreadChat!.messages).toHaveLength(1);
        expect(updatedThreadChat!.messages?.[0]).toEqual(message);
      });
    });

    describe("sanitizeForJson", () => {
      it("should sanitize null bytes in appendMessages", async () => {
        const { threadId, threadChatId } = await createTestThread({
          db,
          userId: user.id,
        });
        const messageWithNullBytes: DBMessage = {
          type: "user",
          model: null,
          parts: [{ type: "text", text: "Hello\x00World" }],
        };
        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            appendMessages: [messageWithNullBytes],
          },
        });
        const updatedThreadChat = await getThreadChat({
          db,
          threadId,
          threadChatId,
          userId: user.id,
        });
        expect(updatedThreadChat!.messages).toHaveLength(1);
        expect(updatedThreadChat!.messages?.[0]?.type).toBe("user");
        const firstMessage = updatedThreadChat!.messages?.[0];
        if (firstMessage?.type === "user") {
          expect(firstMessage.parts[0]).toEqual({
            type: "text",
            text: "HelloWorld", // Null byte removed
          });
        }
      });

      it("should sanitize control characters in appendMessages while keeping valid ones", async () => {
        const { threadId, threadChatId } = await createTestThread({
          db,
          userId: user.id,
        });
        const messageWithControlChars: DBMessage = {
          type: "user",
          model: null,
          parts: [
            {
              type: "text",
              text: "Valid:\t\n\rInvalid:\x01\x02\x03\x04\x05\x06\x07\x08\x0B\x0C\x0E\x0F",
            },
          ],
        };
        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            appendMessages: [messageWithControlChars],
          },
        });
        const updatedThreadChat = await getThreadChat({
          db,
          threadId,
          threadChatId,
          userId: user.id,
        });
        expect(updatedThreadChat!.messages).toHaveLength(1);
        const firstMessage = updatedThreadChat!.messages?.[0];
        if (firstMessage?.type === "user") {
          expect(firstMessage.parts[0]).toEqual({
            type: "text",
            text: "Valid:\t\n\rInvalid:", // Control chars removed, tab/newline/CR kept
          });
        }
      });

      it("should sanitize nested structures in appendMessages", async () => {
        const { threadId, threadChatId } = await createTestThread({
          db,
          userId: user.id,
        });
        const complexMessage: DBMessage = {
          type: "tool-result",
          id: "tool-123",
          is_error: false,
          parent_tool_use_id: null,
          result: "Command output\x00with null\x01byte",
        };
        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            appendMessages: [complexMessage],
          },
        });
        const updatedThreadChat = await getThreadChat({
          db,
          threadId,
          threadChatId,
          userId: user.id,
        });
        expect(updatedThreadChat!.messages).toHaveLength(1);
        const savedMessage = updatedThreadChat!.messages?.[0];
        expect(savedMessage?.type).toBe("tool-result");
        if (savedMessage?.type === "tool-result") {
          expect(savedMessage.result).toBe("Command outputwith nullbyte");
        }
      });

      it("should sanitize multiple messages in appendMessages", async () => {
        const { threadId, threadChatId } = await createTestThread({
          db,
          userId: user.id,
        });
        const messages: DBMessage[] = [
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "First\x00message" }],
          },
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: "Second\x01message\x02here" }],
          },
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "Third\x03\x04message" }],
          },
        ];
        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            appendMessages: messages,
          },
        });
        const updatedThreadChat = await getThreadChat({
          db,
          threadId,
          threadChatId,
          userId: user.id,
        });
        expect(updatedThreadChat!.messages).toHaveLength(3);
        const msg0 = updatedThreadChat!.messages?.[0];
        if (msg0?.type === "user") {
          expect(msg0.parts[0]).toEqual({
            type: "text",
            text: "Firstmessage",
          });
        }
        const msg1 = updatedThreadChat!.messages?.[1];
        if (msg1?.type === "agent") {
          expect(msg1.parts[0]).toEqual({
            type: "text",
            text: "Secondmessagehere",
          });
        }
        const msg2 = updatedThreadChat!.messages?.[2];
        if (msg2?.type === "user") {
          expect(msg2.parts[0]).toEqual({
            type: "text",
            text: "Thirdmessage",
          });
        }
      });

      it("should sanitize null bytes in queuedMessages", async () => {
        const { threadId, threadChatId } = await createTestThread({
          db,
          userId: user.id,
        });
        const queuedMessagesWithNullBytes: DBUserMessage[] = [
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "Queued\x00message\x01test" }],
          },
        ];
        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            appendQueuedMessages: queuedMessagesWithNullBytes,
          },
        });
        const updatedThreadChat = await getThreadChat({
          db,
          threadId,
          threadChatId,
          userId: user.id,
        });
        expect(updatedThreadChat!.queuedMessages).toHaveLength(1);
        const msg = updatedThreadChat!.queuedMessages?.[0];
        if (msg?.type === "user") {
          expect(msg.parts[0]).toEqual({
            type: "text",
            text: "Queuedmessagetest",
          });
        }
      });

      it("should sanitize complex nested queuedMessages", async () => {
        const { threadId, threadChatId } = await createTestThread({
          db,
          userId: user.id,
        });
        const complexQueuedMessages: DBUserMessage[] = [
          {
            type: "user",
            model: null,
            parts: [
              {
                type: "text",
                text: "echo 'test\x00command'\nTest\x01description",
              },
            ],
          },
          {
            type: "user",
            model: null,
            parts: [
              {
                type: "text",
                text: "Output\x00with\x02null\x03bytes",
              },
            ],
          },
        ];
        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            appendQueuedMessages: complexQueuedMessages,
          },
        });
        const updatedThreadChat = await getThreadChat({
          db,
          threadId,
          threadChatId,
          userId: user.id,
        });
        expect(updatedThreadChat!.queuedMessages).toHaveLength(2);
        const msg0 = updatedThreadChat!.queuedMessages?.[0];
        if (msg0?.type === "user") {
          expect(msg0.parts[0]).toEqual({
            type: "text",
            text: "echo 'testcommand'\nTestdescription",
          });
        }

        const msg1 = updatedThreadChat!.queuedMessages?.[1];
        if (msg1?.type === "user") {
          expect(msg1.parts[0]).toEqual({
            type: "text",
            text: "Outputwithnullbytes",
          });
        }
      });

      it("should handle concurrent updates with sanitization", async () => {
        const { threadId, threadChatId } = await createTestThread({
          db,
          userId: user.id,
        });
        // Simulate concurrent updates with invalid characters
        const promises = [];
        for (let i = 0; i < 5; i++) {
          const message: DBMessage = {
            type: "user",
            model: null,
            parts: [{ type: "text", text: `Message ${i}\x00with\x01null` }],
          };
          promises.push(
            updateThreadChat({
              db,
              userId: user.id,
              threadId,
              threadChatId,
              updates: {
                appendMessages: [message],
              },
            }),
          );
        }

        await Promise.all(promises);

        // Check final state - all messages should be sanitized
        const finalChat = await getThreadChat({
          db,
          threadId,
          threadChatId,
          userId: user.id,
        });

        expect(finalChat).not.toBeNull();
        expect(finalChat!.messages).toHaveLength(5);
        finalChat!.messages?.forEach((msg) => {
          if (msg.type === "user") {
            const text = msg.parts[0]?.type === "text" ? msg.parts[0].text : "";
            // Should not contain null bytes or control characters
            expect(text).not.toContain("\x00");
            expect(text).not.toContain("\x01");
            expect(text).toMatch(/^Message \d+withnull$/);
          }
        });
      });

      it("should sanitize both appendMessages and queuedMessages in same update", async () => {
        const { threadId, threadChatId } = await createTestThread({
          db,
          userId: user.id,
        });

        const appendMessage: DBMessage = {
          type: "user",
          model: null,
          parts: [{ type: "text", text: "Append\x00message" }],
        };

        const queuedMessage: DBUserMessage = {
          type: "user",
          model: null,
          parts: [{ type: "text", text: "Queued\x01message" }],
        };

        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            appendMessages: [appendMessage],
            appendQueuedMessages: [queuedMessage],
          },
        });

        const updatedThreadChat = await getThreadChat({
          db,
          threadId,
          threadChatId,
          userId: user.id,
        });
        expect(updatedThreadChat!.messages).toHaveLength(1);
        const appendedMsg = updatedThreadChat!.messages?.[0];
        if (appendedMsg?.type === "user") {
          expect(appendedMsg.parts[0]).toEqual({
            type: "text",
            text: "Appendmessage",
          });
        }

        expect(updatedThreadChat!.queuedMessages).toHaveLength(1);
        const queuedMsg = updatedThreadChat!.queuedMessages?.[0];
        if (queuedMsg?.type === "user") {
          expect(queuedMsg.parts[0]).toEqual({
            type: "text",
            text: "Queuedmessage",
          });
        }
      });
    });

    describe("replaceQueuedMessages", () => {
      it("should replace all queued messages", async () => {
        const { threadId, threadChatId } = await createTestThread({
          db,
          userId: user.id,
        });
        // First add some initial queued messages
        const initialMessages: DBUserMessage[] = [
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "Initial message 1" }],
          },
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "Initial message 2" }],
          },
        ];

        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            appendQueuedMessages: initialMessages,
          },
        });

        // Now replace all queued messages
        const replacementMessages: DBUserMessage[] = [
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "Replacement message 1" }],
          },
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "Replacement message 2" }],
          },
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "Replacement message 3" }],
          },
        ];

        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            replaceQueuedMessages: replacementMessages,
          },
        });

        const updatedThreadChat = await getThreadChat({
          db,
          threadId,
          threadChatId,
          userId: user.id,
        });
        expect(updatedThreadChat!.queuedMessages).toHaveLength(3);
        expect(updatedThreadChat!.queuedMessages?.[0]?.type).toBe("user");
        expect(updatedThreadChat!.queuedMessages?.[1]?.type).toBe("user");
        expect(updatedThreadChat!.queuedMessages?.[2]?.type).toBe("user");

        const msg0 = updatedThreadChat!.queuedMessages?.[0];
        if (msg0?.type === "user") {
          expect(msg0.parts[0]).toEqual({
            type: "text",
            text: "Replacement message 1",
          });
        }

        const msg1 = updatedThreadChat!.queuedMessages?.[1];
        if (msg1?.type === "user") {
          expect(msg1.parts[0]).toEqual({
            type: "text",
            text: "Replacement message 2",
          });
        }

        const msg2 = updatedThreadChat!.queuedMessages?.[2];
        if (msg2?.type === "user") {
          expect(msg2.parts[0]).toEqual({
            type: "text",
            text: "Replacement message 3",
          });
        }
      });

      it("should replace with empty array to clear queued messages", async () => {
        const { threadId, threadChatId } = await createTestThread({
          db,
          userId: user.id,
        });

        // First add some queued messages
        const initialMessages: DBUserMessage[] = [
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "Message to be cleared" }],
          },
        ];
        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            appendQueuedMessages: initialMessages,
          },
        });
        let updatedThreadChat = await getThreadChat({
          db,
          threadId,
          threadChatId,
          userId: user.id,
        });
        expect(updatedThreadChat!.queuedMessages).toHaveLength(1);
        // @ts-expect-error
        expect(updatedThreadChat!.queuedMessages?.[0]?.parts[0].text).toEqual(
          "Message to be cleared",
        );
        // Replace with empty array
        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            replaceQueuedMessages: [],
          },
        });
        updatedThreadChat = await getThreadChat({
          db,
          threadId,
          threadChatId,
          userId: user.id,
        });
        expect(updatedThreadChat!.queuedMessages).toHaveLength(0);
      });

      it("should sanitize null bytes in replaceQueuedMessages", async () => {
        const { threadId, threadChatId } = await createTestThread({
          db,
          userId: user.id,
        });
        const messagesWithNullBytes: DBUserMessage[] = [
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "Replace\x00message\x01test" }],
          },
        ];

        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            replaceQueuedMessages: messagesWithNullBytes,
          },
        });

        const updatedThreadChat = await getThreadChat({
          db,
          threadId,
          threadChatId,
          userId: user.id,
        });
        expect(updatedThreadChat!.queuedMessages).toHaveLength(1);
        const msg = updatedThreadChat!.queuedMessages?.[0];
        if (msg?.type === "user") {
          expect(msg.parts[0]).toEqual({
            type: "text",
            text: "Replacemessagetest",
          });
        }
      });
    });

    describe("appendAndResetQueuedMessages", () => {
      it("should append queued messages to messages and clear queued messages", async () => {
        const { threadId, threadChatId } = await createTestThread({
          db,
          userId: user.id,
        });
        // First add some regular messages
        const existingMessage: DBMessage = {
          type: "user",
          model: null,
          parts: [{ type: "text", text: "Existing message" }],
        };

        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            appendMessages: [existingMessage],
          },
        });

        // Then add some queued messages
        const queuedMessages: DBUserMessage[] = [
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "Queued message 1" }],
          },
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "Queued message 2" }],
          },
        ];

        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            appendQueuedMessages: queuedMessages,
          },
        });

        // Now append and reset queued messages
        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            appendAndResetQueuedMessages: true,
          },
        });

        // Check that messages now contains all messages
        const updatedThreadChat = await getThreadChat({
          db,
          threadId,
          threadChatId,
          userId: user.id,
        });
        expect(updatedThreadChat!.messages).toHaveLength(3);
        expect(updatedThreadChat!.messages?.[0]?.type).toBe("user");

        const msg0 = updatedThreadChat!.messages?.[0];
        if (msg0?.type === "user") {
          expect(msg0.parts[0]).toEqual({
            type: "text",
            text: "Existing message",
          });
        }

        const msg1 = updatedThreadChat!.messages?.[1];
        if (msg1?.type === "user") {
          expect(msg1.parts[0]).toEqual({
            type: "text",
            text: "Queued message 1",
          });
        }

        const msg2 = updatedThreadChat!.messages?.[2];
        if (msg2?.type === "user") {
          expect(msg2.parts[0]).toEqual({
            type: "text",
            text: "Queued message 2",
          });
        }

        // Check that queued messages are now empty
        expect(updatedThreadChat!.queuedMessages).toHaveLength(0);
      });

      it("should handle appendAndResetQueuedMessages when no queued messages exist", async () => {
        const { threadId, threadChatId } = await createTestThread({
          db,
          userId: user.id,
        });
        // Add a regular message
        const existingMessage: DBMessage = {
          type: "user",
          model: null,
          parts: [{ type: "text", text: "Existing message" }],
        };

        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            appendMessages: [existingMessage],
          },
        });

        // Append and reset when no queued messages (null)
        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            appendAndResetQueuedMessages: true,
          },
        });

        // Messages should remain unchanged (COALESCE handles null queuedMessages)
        const updatedThreadChat = await getThreadChat({
          db,
          threadId,
          threadChatId,
          userId: user.id,
        });
        expect(updatedThreadChat!.messages).toHaveLength(1);
        expect(updatedThreadChat!.messages?.[0]?.type).toBe("user");

        const msg = updatedThreadChat!.messages?.[0];
        if (msg?.type === "user") {
          expect(msg.parts[0]).toEqual({
            type: "text",
            text: "Existing message",
          });
        }

        // Queued messages should be empty array
        expect(updatedThreadChat!.queuedMessages).toEqual([]);
      });

      it("should handle appendAndResetQueuedMessages with empty messages array", async () => {
        const { threadId, threadChatId } = await createTestThread({
          db,
          userId: user.id,
        });
        // Add some queued messages
        const queuedMessages: DBUserMessage[] = [
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "Queued message" }],
          },
        ];

        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            appendQueuedMessages: queuedMessages,
          },
        });

        // Append and reset when messages is empty
        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            appendAndResetQueuedMessages: true,
          },
        });

        // Messages should now contain the queued message
        const updatedThreadChat = await getThreadChat({
          db,
          threadId,
          threadChatId,
          userId: user.id,
        });
        expect(updatedThreadChat!.messages).toHaveLength(1);
        const msg = updatedThreadChat!.messages?.[0];
        if (msg?.type === "user") {
          expect(msg.parts[0]).toEqual({
            type: "text",
            text: "Queued message",
          });
        }

        // Queued messages should be empty
        expect(updatedThreadChat!.queuedMessages).toHaveLength(0);
      });
    });

    describe("queued messages edge cases", () => {
      it("should handle multiple queued message operations in sequence", async () => {
        const { threadId, threadChatId } = await createTestThread({
          db,
          userId: user.id,
        });
        // First append some queued messages
        const firstMessages: DBUserMessage[] = [
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "First batch 1" }],
          },
        ];
        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            appendQueuedMessages: firstMessages,
          },
        });
        let updatedThreadChat = await getThreadChat({
          db,
          threadId,
          threadChatId,
          userId: user.id,
        });
        expect(updatedThreadChat!.queuedMessages).toHaveLength(1);
        // @ts-expect-error
        expect(updatedThreadChat!.queuedMessages?.[0]?.parts[0].text).toEqual(
          "First batch 1",
        );
        // Then append more
        const secondMessages: DBUserMessage[] = [
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "Second batch 1" }],
          },
        ];

        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            appendQueuedMessages: secondMessages,
          },
        });

        updatedThreadChat = await getThreadChat({
          db,
          threadId,
          threadChatId,
          userId: user.id,
        });
        expect(updatedThreadChat!.queuedMessages).toHaveLength(2);
        // @ts-expect-error
        expect(updatedThreadChat!.queuedMessages?.[0]?.parts[0].text).toEqual(
          "First batch 1",
        );
        // @ts-expect-error
        expect(updatedThreadChat!.queuedMessages?.[1]?.parts[0].text).toEqual(
          "Second batch 1",
        );

        // Then replace all
        const replacementMessages: DBUserMessage[] = [
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "Replaced all" }],
          },
        ];

        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            replaceQueuedMessages: replacementMessages,
          },
        });
        updatedThreadChat = await getThreadChat({
          db,
          threadId,
          threadChatId,
          userId: user.id,
        });
        expect(updatedThreadChat!.queuedMessages).toHaveLength(1);
        // @ts-expect-error
        expect(updatedThreadChat!.queuedMessages?.[0]?.parts[0].text).toEqual(
          "Replaced all",
        );
      });

      it("should prioritize appendAndResetQueuedMessages over other queued operations", async () => {
        const { threadId, threadChatId } = await createTestThread({
          db,
          userId: user.id,
        });

        // Add initial queued messages
        const initialMessages: DBUserMessage[] = [
          {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "Initial queued" }],
          },
        ];

        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            appendQueuedMessages: initialMessages,
          },
        });

        // Try to do multiple operations at once - appendAndResetQueuedMessages should take precedence
        await updateThreadChat({
          db,
          userId: user.id,
          threadId,
          threadChatId,
          updates: {
            appendAndResetQueuedMessages: true,
            replaceQueuedMessages: [
              {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "This should be ignored" }],
              },
            ],
          },
        });

        // Messages should contain the initial queued message
        const updatedThreadChat = await getThreadChat({
          db,
          threadId,
          threadChatId,
          userId: user.id,
        });
        expect(updatedThreadChat!.messages).toHaveLength(1);
        const msg = updatedThreadChat!.messages?.[0];
        if (msg?.type === "user") {
          expect(msg.parts[0]).toEqual({
            type: "text",
            text: "Initial queued",
          });
        }

        // Queued messages should be empty (not replaced)
        expect(updatedThreadChat!.queuedMessages).toHaveLength(0);
      });
    });
  });

  describe("getThread", () => {
    it("should get single thread with metadata", async () => {
      const { threadId } = await createThread({
        db: db,
        userId: user.id,
        threadValues: {
          githubRepoFullName: "terragon/terragon",
          repoBaseBranchName: "main",
          name: "Test Thread",
          sandboxProvider: "e2b",
        },
        initialChatValues: {
          agent: "claudeCode",
        },
      });
      const retrievedThread = await getThread({
        db,
        threadId,
        userId: user.id,
      });
      expect(retrievedThread).toBeDefined();
      expect(retrievedThread!.id).toBe(threadId);
      expect(retrievedThread!.name).toBe("Test Thread");
      expect(retrievedThread!.userId).toBe(user.id);
      expect(retrievedThread!.prStatus).toBeNull(); // No PR created

      // Test with non-existent thread
      const nonExistentThread = await getThread({
        db,
        threadId: "non-existent",
        userId: user.id,
      });
      expect(nonExistentThread).toBeUndefined();

      // Test with wrong user
      const { user: otherUser } = await createTestUser({ db });
      const wrongUserThread = await getThread({
        db,
        threadId,
        userId: otherUser.id,
      });
      expect(wrongUserThread).toBeUndefined();
    });

    it("should get thread with child threads", async () => {
      const { threadId } = await createTestThread({
        db,
        userId: user.id,
      });
      const { threadId: childThread1ThreadId } = await createTestThread({
        db,
        userId: user.id,
        overrides: {
          parentThreadId: threadId,
          parentToolId: "tool-1",
        },
      });
      const { threadId: childThread2ThreadId } = await createTestThread({
        db,
        userId: user.id,
        overrides: {
          parentThreadId: threadId,
          parentToolId: "tool-2",
        },
      });
      const retrievedThread = await getThread({
        db,
        threadId,
        userId: user.id,
      });
      expect(retrievedThread).toBeDefined();
      expect(retrievedThread!.childThreads).toEqual([
        { id: childThread2ThreadId, parentToolId: "tool-2" },
        { id: childThread1ThreadId, parentToolId: "tool-1" },
      ]);
    });

    describe("isUnread status logic", () => {
      it("should return false isUnread by default for new threads", async () => {
        const { threadId } = await createTestThread({
          db,
          userId: user.id,
        });
        // getThread should return false isUnread by default
        const retrievedThread = await getThread({
          db,
          threadId,
          userId: user.id,
        });
        expect(retrievedThread!.isUnread).toBe(false);

        // getThreads should also return false isUnread by default
        const threads = await getThreads({ db, userId: user.id });
        expect(threads.length).toBe(1);
        expect(threads[0]!.isUnread).toBeFalsy();
      });

      it("should correctly mark thread as unread and reflect in getThread and getThreads", async () => {
        const { threadId, threadChatId } = await createTestThread({
          db,
          userId: user.id,
        });
        // Mark thread as unread
        await markThreadChatAsUnread({
          db,
          userId: user.id,
          threadId,
          threadChatIdOrNull: threadChatId,
        });
        // getThread should return true isUnread
        const retrievedThread = await getThread({
          db,
          threadId,
          userId: user.id,
        });
        expect(retrievedThread!.isUnread).toBe(true);

        // getThreads should also return true isUnread
        const threads = await getThreads({ db, userId: user.id });
        expect(threads.length).toBe(1);
        expect(threads[0]!.isUnread).toBe(true);
      });

      it("should correctly mark thread as read and reflect in getThread and getThreads", async () => {
        const { threadId, threadChatId } = await createTestThread({
          db,
          userId: user.id,
        });
        // First mark as unread
        await markThreadChatAsUnread({
          db,
          userId: user.id,
          threadId,
          threadChatIdOrNull: threadChatId,
        });

        // Then mark as read
        await markThreadChatAsRead({
          db,
          userId: user.id,
          threadId,
          threadChatId,
        });

        // getThread should return false isUnread
        const retrievedThread = await getThread({
          db,
          threadId,
          userId: user.id,
        });
        expect(retrievedThread!.isUnread).toBe(false);

        // getThreads should also return false isUnread
        const threads = await getThreads({ db, userId: user.id });
        expect(threads.length).toBe(1);
        expect(threads[0]!.isUnread).toBe(false);
      });

      it("should handle per-user unread status independently", async () => {
        const { user: otherUser } = await createTestUser({ db });
        const { threadId: thread1ThreadId, threadChatId: thread1ThreadChatId } =
          await createTestThread({
            db,
            userId: user.id,
          });
        const { threadId: thread2ThreadId, threadChatId: thread2ThreadChatId } =
          await createTestThread({
            db,
            userId: user.id,
          });

        // user reads thread1
        await markThreadChatAsUnread({
          db,
          userId: user.id,
          threadId: thread1ThreadId,
          threadChatIdOrNull: thread1ThreadChatId,
        });
        // otherUser reads thread2
        await markThreadChatAsUnread({
          db,
          userId: otherUser.id,
          threadId: thread2ThreadId,
          threadChatIdOrNull: thread2ThreadChatId,
        });

        const thread1Result = await getThread({
          db,
          threadId: thread1ThreadId,
          userId: user.id,
        });
        expect(thread1Result!.isUnread).toBe(true);
        const thread2Result = await getThread({
          db,
          threadId: thread2ThreadId,
          userId: user.id,
        });
        expect(thread2Result!.isUnread).toBe(false);
        // user reads thread2
        await markThreadChatAsUnread({
          db,
          userId: user.id,
          threadId: thread2ThreadId,
          threadChatIdOrNull: thread2ThreadChatId,
        });
        const thread2Result2 = await getThread({
          db,
          threadId: thread2ThreadId,
          userId: user.id,
        });
        expect(thread2Result2!.isUnread).toBe(true);
      });

      it("should handle multiple threads with different unread statuses", async () => {
        // Create multiple threads
        const { threadId: thread1ThreadId, threadChatId: thread1ThreadChatId } =
          await createTestThread({
            db,
            userId: user.id,
          });
        const { threadId: thread2ThreadId } = await createTestThread({
          db,
          userId: user.id,
        });
        const { threadId: thread3ThreadId, threadChatId: thread3ThreadChatId } =
          await createTestThread({
            db,
            userId: user.id,
          });

        // Mark thread1 as unread, thread2 as read (default), thread3 as unread then read
        await markThreadChatAsUnread({
          db,
          userId: user.id,
          threadId: thread1ThreadId,
          threadChatIdOrNull: thread1ThreadChatId,
        });
        await markThreadChatAsUnread({
          db,
          userId: user.id,
          threadId: thread3ThreadId,
          threadChatIdOrNull: thread3ThreadChatId,
        });
        await markThreadChatAsRead({
          db,
          userId: user.id,
          threadId: thread3ThreadId,
          threadChatId: thread3ThreadChatId,
        });

        // Check individual threads (getThread works correctly)
        const retrievedThread1 = await getThread({
          db,
          threadId: thread1ThreadId,
          userId: user.id,
        });
        expect(retrievedThread1!.isUnread).toBe(true);

        const retrievedThread2 = await getThread({
          db,
          threadId: thread2ThreadId,
          userId: user.id,
        });
        expect(retrievedThread2!.isUnread).toBe(false);

        const retrievedThread3 = await getThread({
          db,
          threadId: thread3ThreadId,
          userId: user.id,
        });
        expect(retrievedThread3!.isUnread).toBe(false);

        // Check bulk retrieval
        const threads = await getThreads({ db, userId: user.id });
        expect(threads.length).toBe(3);

        const foundThread1 = threads.find((t) => t.id === thread1ThreadId);
        const foundThread2 = threads.find((t) => t.id === thread2ThreadId);
        const foundThread3 = threads.find((t) => t.id === thread3ThreadId);

        expect(foundThread1!.isUnread).toBe(true);
        expect(foundThread2!.isUnread).toBe(false);
        expect(foundThread3!.isUnread).toBe(false);
      });

      it("should mark thread as unread when thread-level record (threadChatId=null) is unread", async () => {
        const { threadId } = await createTestThread({
          db,
          userId: user.id,
        });

        // Mark thread-level as unread (threadChatId = null)
        await markThreadChatAsUnread({
          db,
          userId: user.id,
          threadId,
          threadChatIdOrNull: null,
        });

        // Thread should be unread
        const retrievedThread = await getThread({
          db,
          threadId,
          userId: user.id,
        });
        expect(retrievedThread!.isUnread).toBe(true);

        const threads = await getThreads({ db, userId: user.id });
        expect(threads[0]!.isUnread).toBe(true);
      });
    });

    describe("PR status logic", () => {
      it("should return null prStatus when thread has no PR", async () => {
        const { threadId } = await createTestThread({
          db,
          userId: user.id,
        });
        // getThread should return null prStatus
        const retrievedThread = await getThread({
          db,
          threadId,
          userId: user.id,
        });
        expect(retrievedThread!.prStatus).toBeNull();

        // getThreads should also return null prStatus
        const threads = await getThreads({ db, userId: user.id });
        expect(threads.length).toBe(1);
        expect(threads[0]!.prStatus).toBeNull();
      });

      it("should return correct prStatus when thread has PR", async () => {
        const prNumber = 123;
        const repoFullName = "terragon/repo1";

        // Create thread with PR number
        const { threadId } = await createTestThread({
          db,
          userId: user.id,
          overrides: {
            githubRepoFullName: repoFullName,
          },
        });
        // Update thread to have PR number
        await updateThread({
          db,
          userId: user.id,
          threadId,
          updates: { githubPRNumber: prNumber },
        });
        // Create a GitHub PR first
        await upsertGithubPR({
          db,
          repoFullName: repoFullName,
          number: prNumber,
          updates: {
            status: "open",
          },
        });
        // getThread should return correct prStatus
        const retrievedThread = await getThread({
          db,
          threadId,
          userId: user.id,
        });
        expect(retrievedThread!.prStatus).toBe("open");

        // getThreads should also return correct prStatus
        const threads = await getThreads({ db, userId: user.id });
        expect(threads.length).toBe(1);
        expect(threads[0]!.prStatus).toBe("open");
      });

      it("should handle different PR statuses", async () => {
        // Create threads with different PR numbers
        const { threadId: openThreadId } = await createTestThread({
          db,
          userId: user.id,
        });
        const openThread = await getThread({
          db,
          threadId: openThreadId,
          userId: user.id,
        });
        await updateThread({
          db,
          userId: user.id,
          threadId: openThreadId,
          updates: { githubPRNumber: 1 },
        });

        const { threadId: closedThreadId } = await createTestThread({
          db,
          userId: user.id,
        });
        const closedThread = await getThread({
          db,
          threadId: closedThreadId,
          userId: user.id,
        });
        await updateThread({
          db,
          userId: user.id,
          threadId: closedThreadId,
          updates: { githubPRNumber: 2 },
        });

        const { threadId: mergedThreadId } = await createTestThread({
          db,
          userId: user.id,
        });
        const mergedThread = await getThread({
          db,
          threadId: mergedThreadId,
          userId: user.id,
        });
        await updateThread({
          db,
          userId: user.id,
          threadId: mergedThreadId,
          updates: { githubPRNumber: 3 },
        });
        // Create PRs with different statuses
        await upsertGithubPR({
          db,
          repoFullName: openThread!.githubRepoFullName,
          number: 1,
          updates: {
            status: "open",
          },
        });
        await upsertGithubPR({
          db,
          repoFullName: closedThread!.githubRepoFullName,
          number: 2,
          updates: {
            status: "closed",
          },
        });
        await upsertGithubPR({
          db,
          repoFullName: mergedThread!.githubRepoFullName,
          number: 3,
          updates: {
            status: "merged",
          },
        });

        // Test individual thread retrieval
        const openResult = await getThread({
          db,
          threadId: openThreadId,
          userId: user.id,
        });
        expect(openResult!.prStatus).toBe("open");

        const closedResult = await getThread({
          db,
          threadId: closedThreadId,
          userId: user.id,
        });
        expect(closedResult!.prStatus).toBe("closed");

        const mergedResult = await getThread({
          db,
          threadId: mergedThreadId,
          userId: user.id,
        });
        expect(mergedResult!.prStatus).toBe("merged");

        // Test bulk thread retrieval
        const allThreads = await getThreads({ db, userId: user.id });
        expect(allThreads.length).toBe(3);

        const openThreadResult = allThreads.find((t) => t.id === openThreadId);
        const closedThreadResult = allThreads.find(
          (t) => t.id === closedThreadId,
        );
        const mergedThreadResult = allThreads.find(
          (t) => t.id === mergedThreadId,
        );

        expect(openThreadResult!.prStatus).toBe("open");
        expect(closedThreadResult!.prStatus).toBe("closed");
        expect(mergedThreadResult!.prStatus).toBe("merged");
      });

      it("should return null when PR exists but thread has no PR number", async () => {
        const repoFullName = "terragon/repo1";
        // Create thread without PR number
        const { threadId } = await createTestThread({
          db,
          userId: user.id,
          overrides: {
            githubRepoFullName: repoFullName,
          },
        });
        // Create a GitHub PR
        await upsertGithubPR({
          db,
          repoFullName,
          number: 123,
          updates: {
            status: "open",
          },
        });
        // Should return null prStatus since thread doesn't reference the PR
        const retrievedThread = await getThread({
          db,
          threadId,
          userId: user.id,
        });
        expect(retrievedThread!.prStatus).toBeNull();
      });

      it("should return null when thread has PR number but PR doesn't exist", async () => {
        const nonExistentPRNumber = 999;
        // Create thread with non-existent PR number
        const { threadId } = await createTestThread({
          db,
          userId: user.id,
        });
        await updateThread({
          db,
          userId: user.id,
          threadId,
          updates: {
            githubPRNumber: nonExistentPRNumber,
          },
        });

        // Should return null prStatus since the PR doesn't exist
        const retrievedThread = await getThread({
          db,
          threadId,
          userId: user.id,
        });
        expect(retrievedThread!.prStatus).toBeNull();
      });

      it("should handle multiple threads with same PR", async () => {
        const prNumber = 456;

        // Create multiple threads referencing the same PR
        const { threadId: thread1ThreadId } = await createTestThread({
          db,
          userId: user.id,
        });
        const thread1 = await getThread({
          db,
          threadId: thread1ThreadId,
          userId: user.id,
        });
        await updateThread({
          db,
          userId: user.id,
          threadId: thread1ThreadId,
          updates: { githubPRNumber: prNumber },
        });

        const { threadId: thread2ThreadId } = await createTestThread({
          db,
          userId: user.id,
        });
        await updateThread({
          db,
          userId: user.id,
          threadId: thread2ThreadId,
          updates: { githubPRNumber: prNumber },
        });

        // Create a GitHub PR
        await upsertGithubPR({
          db,
          repoFullName: thread1!.githubRepoFullName,
          number: prNumber,
          updates: {
            status: "merged",
          },
        });

        // Both threads should get the same PR status
        const threads = await getThreads({ db, userId: user.id });
        expect(threads.length).toBe(2);
        expect(threads[0]!.prStatus).toBe("merged");
        expect(threads[1]!.prStatus).toBe("merged");
      });

      it("should handle threads from different repos with same PR number", async () => {
        const repo1 = "terragon/repo1";
        const repo2 = "terragon/repo2";
        const prNumber = 1;

        // Create PRs in different repos with same number but different status
        await upsertGithubPR({
          db,
          repoFullName: repo1,
          number: prNumber,
          updates: {
            status: "open",
          },
        });
        await upsertGithubPR({
          db,
          repoFullName: repo2,
          number: prNumber,
          updates: {
            status: "closed",
          },
        });

        // Create threads in different repos
        const { threadId: thread1ThreadId } = await createTestThread({
          db,
          userId: user.id,
          overrides: {
            githubRepoFullName: repo1,
            githubPRNumber: prNumber,
          },
        });
        const { threadId: thread2ThreadId } = await createTestThread({
          db,
          userId: user.id,
          overrides: {
            githubRepoFullName: repo2,
            githubPRNumber: prNumber,
          },
        });

        // Each thread should get the correct PR status for its repo
        const repo1Thread = await getThread({
          db,
          threadId: thread1ThreadId,
          userId: user.id,
        });
        expect(repo1Thread!.prStatus).toBe("open");

        const repo2Thread = await getThread({
          db,
          threadId: thread2ThreadId,
          userId: user.id,
        });
        expect(repo2Thread!.prStatus).toBe("closed");

        // Test bulk retrieval
        const allThreads = await getThreads({ db, userId: user.id });
        expect(allThreads.length).toBe(2);

        const repo1Result = allThreads.find(
          (t) => t.githubRepoFullName === repo1,
        );
        const repo2Result = allThreads.find(
          (t) => t.githubRepoFullName === repo2,
        );

        expect(repo1Result!.prStatus).toBe("open");
        expect(repo2Result!.prStatus).toBe("closed");
      });
    });
  });

  describe("getThreadWithPermissions", () => {
    it("should allow owner to view their own thread", async () => {
      const { threadId } = await createTestThread({
        db,
        userId: user.id,
      });
      await updateThreadVisibility({
        db,
        userId: user.id,
        threadId,
        visibility: "private",
      });
      const result = await getThreadWithPermissions({
        db,
        threadId,
        userId: user.id,
      });
      expect(result).toBeDefined();
      expect(result!.id).toBe(threadId);
      expect(result!.visibility).toBe("private");

      await updateThreadVisibility({
        db,
        userId: user.id,
        threadId,
        visibility: "link",
      });

      const result2 = await getThreadWithPermissions({
        db,
        threadId,
        userId: user.id,
      });
      expect(result2).toBeDefined();
      expect(result2!.id).toBe(threadId);
      expect(result2!.visibility).toBe("link");

      await updateThreadVisibility({
        db,
        userId: user.id,
        threadId,
        visibility: "repo",
      });

      const result3 = await getThreadWithPermissions({
        db,
        threadId,
        userId: user.id,
      });
      expect(result3).toBeDefined();
      expect(result3!.id).toBe(threadId);
      expect(result3!.visibility).toBe("repo");
    });

    it("should allow admin to view any thread regardless of visibility", async () => {
      // Create a thread owned by a different user
      const { user: otherUser } = await createTestUser({ db });
      const { threadId } = await createTestThread({
        db,
        userId: otherUser.id,
      });
      await updateThreadVisibility({
        db,
        userId: otherUser.id,
        threadId,
        visibility: "private",
      });

      // Create an admin user
      const { user: adminUser } = await createTestUser({ db });
      await db
        .update(schema.user)
        .set({ role: "admin" })
        .where(eq(schema.user.id, adminUser.id));

      const result = await getThreadWithPermissions({
        db,
        threadId,
        userId: adminUser.id,
        allowAdmin: true,
      });

      expect(result).toBeDefined();
      expect(result!.id).toBe(threadId);
      expect(result!.visibility).toBe("private");
    });

    it("should not allow admin to view private thread when allowAdmin is false", async () => {
      // Create a thread owned by a different user
      const { user: otherUser } = await createTestUser({ db });
      const { threadId } = await createTestThread({
        db,
        userId: otherUser.id,
      });
      await updateThreadVisibility({
        db,
        userId: otherUser.id,
        threadId,
        visibility: "private",
      });
      // Create an admin user
      const { user: adminUser } = await createTestUser({ db });
      await db
        .update(schema.user)
        .set({ role: "admin" })
        .where(eq(schema.user.id, adminUser.id));

      const result = await getThreadWithPermissions({
        db,
        threadId,
        userId: adminUser.id,
        allowAdmin: false,
      });

      expect(result).toBeUndefined();
    });

    it("should not allow non-owner to view private thread", async () => {
      const { user: otherUser } = await createTestUser({ db });
      const { threadId } = await createTestThread({
        db,
        userId: otherUser.id,
      });
      await updateThreadVisibility({
        db,
        userId: otherUser.id,
        threadId,
        visibility: "private",
      });
      const result = await getThreadWithPermissions({
        db,
        threadId,
        userId: user.id,
      });

      expect(result).toBeUndefined();
    });

    it("should allow non-owner to view thread with link visibility", async () => {
      const { user: otherUser } = await createTestUser({ db });
      const { threadId } = await createTestThread({
        db,
        userId: otherUser.id,
      });
      await updateThreadVisibility({
        db,
        userId: otherUser.id,
        threadId,
        visibility: "link",
      });
      const result = await getThreadWithPermissions({
        db,
        threadId,
        userId: user.id,
      });
      expect(result).toBeDefined();
      expect(result!.id).toBe(threadId);
      expect(result!.visibility).toBe("link");
    });

    it("should allow non-owner to view thread with repo visibility if they have repo permissions", async () => {
      const { user: otherUser } = await createTestUser({ db });
      const { threadId } = await createTestThread({
        db,
        userId: otherUser.id,
        overrides: {
          githubRepoFullName: "test-org/test-repo",
        },
      });
      await updateThreadVisibility({
        db,
        userId: otherUser.id,
        threadId,
        visibility: "repo",
      });

      const result = await getThreadWithPermissions({
        db,
        threadId,
        userId: user.id,
        getHasRepoPermissions: async (repoFullName) => {
          return repoFullName === "test-org/test-repo";
        },
      });

      expect(result).toBeDefined();
      expect(result!.id).toBe(threadId);
      expect(result!.visibility).toBe("repo");
    });

    it("should not allow non-owner to view thread with repo visibility without repo permissions", async () => {
      const { user: otherUser } = await createTestUser({ db });
      const { threadId } = await createTestThread({
        db,
        userId: otherUser.id,
        overrides: {
          githubRepoFullName: "test-org/test-repo",
        },
      });
      await updateThreadVisibility({
        db,
        userId: otherUser.id,
        threadId,
        visibility: "repo",
      });

      const result = await getThreadWithPermissions({
        db,
        threadId,
        userId: user.id,
        getHasRepoPermissions: async () => false,
      });

      expect(result).toBeUndefined();
    });

    it("should return undefined for non-existent thread", async () => {
      const result = await getThreadWithPermissions({
        db,
        threadId: "non-existent-thread-id",
        userId: user.id,
      });

      expect(result).toBeUndefined();
    });

    it("should return undefined for non-existent user when checking permissions", async () => {
      const { user: otherUser } = await createTestUser({ db });
      const { threadId } = await createTestThread({
        db,
        userId: otherUser.id,
      });
      await updateThreadVisibility({
        db,
        userId: otherUser.id,
        threadId,
        visibility: "link",
      });

      const result = await getThreadWithPermissions({
        db,
        threadId,
        userId: "non-existent-user-id",
      });

      expect(result).toBeUndefined();
    });

    it("should use default visibility when thread visibility is not set", async () => {
      const { threadId } = await createTestThread({
        db,
        userId: user.id,
      });
      // Don't set any visibility explicitly
      const result = await getThreadWithPermissions({
        db,
        threadId,
        userId: user.id,
      });
      expect(result).toBeDefined();
      expect(result!.id).toBe(threadId);
      // Should default to 'private' as per the SQL query
      expect(result!.visibility).toBe("private");
    });

    it("should use user default visibility when set", async () => {
      // Set user default visibility to 'link'
      await db.insert(schema.userSettings).values({
        userId: user.id,
        defaultThreadVisibility: "link",
      });

      const { threadId } = await createTestThread({
        db,
        userId: user.id,
      });
      // Don't set any visibility explicitly
      const result = await getThreadWithPermissions({
        db,
        threadId,
        userId: user.id,
      });

      expect(result).toBeDefined();
      expect(result!.id).toBe(threadId);
      expect(result!.visibility).toBe("link");
    });
  });

  describe("deleteThreadById", () => {
    it("should delete a thread successfully", async () => {
      const { threadId } = await createTestThread({ db, userId: user.id });
      // Verify thread exists
      const threadBefore = await getThread({
        db,
        threadId,
        userId: user.id,
      });
      expect(threadBefore).toBeDefined();

      // Delete the thread
      const deletedThread = await deleteThreadById({
        db,
        threadId,
        userId: user.id,
      });

      expect(deletedThread.id).toBe(threadId);

      // Verify thread no longer exists
      const threadAfter = await getThread({
        db,
        threadId,
        userId: user.id,
      });
      expect(threadAfter).toBeUndefined();

      // Verify it's not in the thread list
      const threads = await getThreads({ db, userId: user.id });
      expect(threads.length).toBe(0);
    });

    it("should fail to delete thread with wrong user", async () => {
      const { threadId } = await createTestThread({
        db,
        userId: user.id,
      });
      const { user: otherUser } = await createTestUser({ db });

      // Attempt to delete with wrong user should fail
      await expect(
        deleteThreadById({
          db,
          threadId,
          userId: otherUser.id,
        }),
      ).rejects.toThrow("Failed to delete thread");

      // Verify thread still exists
      const threadAfter = await getThread({
        db,
        threadId,
        userId: user.id,
      });
      expect(threadAfter).toBeDefined();
    });

    it("should fail to delete non-existent thread", async () => {
      await expect(
        deleteThreadById({
          db,
          threadId: "non-existent-thread-id",
          userId: user.id,
        }),
      ).rejects.toThrow("Failed to delete thread");
    });

    it("should handle deletion of thread with child threads", async () => {
      const { threadId: parentThreadId } = await createTestThread({
        db,
        userId: user.id,
      });
      const { threadId: childThread1ThreadId } = await createTestThread({
        db,
        userId: user.id,
        overrides: {
          parentThreadId,
          parentToolId: "tool-1",
        },
      });
      const { threadId: childThread2ThreadId } = await createTestThread({
        db,
        userId: user.id,
        overrides: {
          parentThreadId,
          parentToolId: "tool-2",
        },
      });

      // Delete parent thread
      await deleteThreadById({
        db,
        threadId: parentThreadId,
        userId: user.id,
      });

      // Verify parent thread is deleted
      const parentAfter = await getThread({
        db,
        threadId: parentThreadId,
        userId: user.id,
      });
      expect(parentAfter).toBeUndefined();

      // Verify child threads still exist but have null parentThreadId
      const child1After = await getThread({
        db,
        threadId: childThread1ThreadId,
        userId: user.id,
      });
      expect(child1After).toBeDefined();
      expect(child1After!.parentThreadId).toBeNull();

      const child2After = await getThread({
        db,
        threadId: childThread2ThreadId,
        userId: user.id,
      });
      expect(child2After).toBeDefined();
      expect(child2After!.parentThreadId).toBeNull();
    });
  });

  describe("getStalledThreads", () => {
    it("should return threads stuck in transitional states", async () => {
      // Create threads with different statuses
      const bootingThread = await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "booting" },
      });
      const workingThread = await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "working" },
      });
      const stoppingThread = await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "stopping" },
      });
      const stoppedThread = await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "complete" },
      });
      // Initially no stalled threads (all were just created)
      const stalledThreads = await getStalledThreads({ db, cutoffSecs: 60 });
      const recentThreadIds = [
        bootingThread.threadId,
        workingThread.threadId,
        stoppingThread.threadId,
        stoppedThread.threadId,
      ];
      const recentStalledThreads = stalledThreads.filter((t) =>
        recentThreadIds.includes(t.id),
      );
      expect(recentStalledThreads.length).toBe(0);

      // Manually update the updatedAt timestamp to simulate old threads
      const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
      await db
        .update(schema.thread)
        .set({ updatedAt: oldDate })
        .where(eq(schema.thread.id, bootingThread.threadId));
      await db
        .update(schema.thread)
        .set({ updatedAt: oldDate })
        .where(eq(schema.thread.id, workingThread.threadId));
      await db
        .update(schema.thread)
        .set({ updatedAt: oldDate })
        .where(eq(schema.thread.id, stoppingThread.threadId));
      await db
        .update(schema.thread)
        .set({ updatedAt: oldDate })
        .where(eq(schema.thread.id, stoppedThread.threadId));

      // Now we should get the stalled threads (booting, working, stopping only)
      const stalledThreadsAfter = await getStalledThreads({
        db,
        cutoffSecs: 60 * 60,
      });
      const ourStalledThreads = stalledThreadsAfter.filter((t) =>
        recentThreadIds.includes(t.id),
      );
      expect(ourStalledThreads.length).toBe(3);

      const stalledIds = ourStalledThreads.map((t) => t.id);
      expect(stalledIds).toContain(bootingThread.threadId);
      expect(stalledIds).toContain(workingThread.threadId);
      expect(stalledIds).toContain(stoppingThread.threadId);
      expect(stalledIds).not.toContain(stoppedThread.threadId);
    });

    it("should respect custom cutoff time", async () => {
      const { threadId } = await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "booting" },
      });

      // Set to 30 seconds ago
      const thirtySecsAgo = new Date(Date.now() - 30 * 1000);
      await db
        .update(schema.thread)
        .set({ updatedAt: thirtySecsAgo })
        .where(eq(schema.thread.id, threadId));

      // Should not appear with 60 second cutoff
      const stalled60 = await getStalledThreads({ db, cutoffSecs: 60 });
      const ourStalled60 = stalled60.filter((t) => t.id === threadId);
      expect(ourStalled60.length).toBe(0);

      // Should appear with 10 second cutoff
      const stalled10 = await getStalledThreads({ db, cutoffSecs: 10 });
      const ourStalled10 = stalled10.filter((t) => t.id === threadId);
      expect(ourStalled10.length).toBe(1);
      expect(ourStalled10[0]!.id).toBe(threadId);
    });
  });

  describe("stopStalledThreads", () => {
    it("should update status and error message for stalled threads", async () => {
      const { threadId: thread1Id, threadChatId: thread1ChatId } =
        await createTestThread({
          db,
          userId: user.id,
          chatOverrides: { status: "complete" },
        });

      const { threadId: thread2Id, threadChatId: thread2ChatId } =
        await createTestThread({
          db,
          userId: user.id,
          chatOverrides: { status: "working" },
        });

      // Stop both threads
      await stopStalledThreads({
        db,
        threadIds: [thread1Id, thread2Id],
      });

      // Verify they are stopped with error message
      let updatedThreadChat = await getThreadChat({
        db,
        threadId: thread1Id,
        threadChatId: thread1ChatId,
        userId: user.id,
      });
      // BEHAVIOUR CHANGE: thread1 was created ALREADY `complete`, i.e. not in a
      // reapable status. The watchdog used to clobber it anyway — a bare UPDATE
      // with no status guard, so a second cron tick (or a thread that finished
      // between getStalledThreads and stopStalledThreads) overwrote a terminal
      // the thread had legitimately reached. It now routes through
      // markThreadsTerminal, whose WHERE only matches reapable statuses, so an
      // already-terminal thread is left alone. In production getStalledThreads
      // only ever returns reapable threads, so this guard fires solely on that
      // TOCTOU window — where skipping is the correct outcome.
      expect(updatedThreadChat!.status).toBe("complete");
      expect(updatedThreadChat!.errorMessage).toBeNull();

      updatedThreadChat = await getThreadChat({
        db,
        threadId: thread2Id,
        threadChatId: thread2ChatId,
        userId: user.id,
      });
      expect(updatedThreadChat!.status).toBe("complete");
      expect(updatedThreadChat!.errorMessage).toBe("request-timeout");
    });

    it("should handle empty array", async () => {
      await expect(
        stopStalledThreads({ db, threadIds: [] }),
      ).resolves.not.toThrow();
    });
  });

  describe("atomicDequeueThread", () => {
    it("should atomically dequeue a single thread", async () => {
      // Create multiple queued threads
      const { threadId: thread1Id } = await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "queued-tasks-concurrency" },
      });

      // Dequeue the thread
      const eligibleThreadChats = await getEligibleQueuedThreadChats({
        db,
        userId: user.id,
        concurrencyLimitReached: false,
        sandboxCreationRateLimitReached: false,
      });
      const result = await atomicDequeueThreadChats({
        db,
        userId: user.id,
        eligibleThreadChats,
      });
      expect(result).toBeDefined();
      expect(result!.threadId).toBe(thread1Id);
      expect(result!.oldStatus).toBe("queued-tasks-concurrency");
    });

    it("should return undefined when no eligible threads exist", async () => {
      // Create non-queued thread
      await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "working" },
      });
      const eligibleThreadChats = await getEligibleQueuedThreadChats({
        db,
        userId: user.id,
        concurrencyLimitReached: false,
        sandboxCreationRateLimitReached: false,
      });
      const result = await atomicDequeueThreadChats({
        db,
        userId: user.id,
        eligibleThreadChats,
      });
      expect(result).toBeUndefined();
    });

    it("should handle concurrent dequeue operations correctly", async () => {
      // Create multiple queued threads
      await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "queued-tasks-concurrency" },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "queued-tasks-concurrency" },
      });

      // Simulate concurrent dequeue operations
      const eligibleThreadChats = await getEligibleQueuedThreadChats({
        db,
        userId: user.id,
        concurrencyLimitReached: false,
        sandboxCreationRateLimitReached: false,
      });
      const [result1, result2] = await Promise.all([
        atomicDequeueThreadChats({ db, userId: user.id, eligibleThreadChats }),
        atomicDequeueThreadChats({ db, userId: user.id, eligibleThreadChats }),
      ]);

      // Both operations should succeed and get different threads
      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
      expect(result1!.threadId).not.toBe(result2!.threadId);
      expect(result1!.oldStatus).toBe("queued-tasks-concurrency");
      expect(result2!.oldStatus).toBe("queued-tasks-concurrency");
    });

    it("should dequeue in order of creation time", async () => {
      // Create threads with different creation times
      const thread1 = await createTestThread({
        db,
        userId: user.id,
        overrides: {
          createdAt: new Date(Date.now() - 20 * 1000),
        },
        chatOverrides: {
          status: "queued-tasks-concurrency",
        },
      });
      const thread2 = await createTestThread({
        db,
        userId: user.id,
        overrides: {
          createdAt: new Date(Date.now() - 10 * 1000),
        },
        chatOverrides: {
          status: "queued-sandbox-creation-rate-limit",
        },
      });
      const thread3 = await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "queued-tasks-concurrency" },
      });
      const eligibleThreadChats = await getEligibleQueuedThreadChats({
        db,
        userId: user.id,
        concurrencyLimitReached: false,
        sandboxCreationRateLimitReached: false,
      });
      // First dequeue should get thread1 (oldest)
      const result1 = await atomicDequeueThreadChats({
        db,
        userId: user.id,
        eligibleThreadChats,
      });
      expect(result1!.threadId).toBe(thread1.threadId);

      // Second dequeue should get thread2
      const result2 = await atomicDequeueThreadChats({
        db,
        userId: user.id,
        eligibleThreadChats,
      });
      expect(result2!.threadId).toBe(thread2.threadId);

      // Third dequeue should get thread3
      const result3 = await atomicDequeueThreadChats({
        db,
        userId: user.id,
        eligibleThreadChats,
      });
      expect(result3!.threadId).toBe(thread3.threadId);
    });

    it("should respect concurrency limit", async () => {
      // Create thread with concurrency limited status
      await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "queued-tasks-concurrency" },
      });

      // Should not dequeue when includeConcurrencyLimited is false
      const eligibleThreadChats = await getEligibleQueuedThreadChats({
        db,
        userId: user.id,
        concurrencyLimitReached: true,
        sandboxCreationRateLimitReached: false,
      });
      const result1 = await atomicDequeueThreadChats({
        db,
        userId: user.id,
        eligibleThreadChats,
      });
      expect(result1).toBeUndefined();
    });

    it("should respect sandbox creation rate limit", async () => {
      // Create thread with rate limited status
      const { threadId } = await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "queued-sandbox-creation-rate-limit" },
      });

      // Should not dequeue when sandboxCreationRateLimitReached is true
      let eligibleThreadChats = await getEligibleQueuedThreadChats({
        db,
        userId: user.id,
        concurrencyLimitReached: false,
        sandboxCreationRateLimitReached: true,
      });
      const result1 = await atomicDequeueThreadChats({
        db,
        userId: user.id,
        eligibleThreadChats,
      });
      expect(result1).toBeUndefined();

      // Should dequeue when sandboxCreationRateLimitReached is false
      eligibleThreadChats = await getEligibleQueuedThreadChats({
        db,
        userId: user.id,
        concurrencyLimitReached: false,
        sandboxCreationRateLimitReached: false,
      });
      const result2 = await atomicDequeueThreadChats({
        db,
        userId: user.id,
        eligibleThreadChats,
      });
      expect(result2!.threadId).toBe(threadId);
    });

    it("should only dequeue threads for the specified user", async () => {
      const { user: otherUser } = await createTestUser({ db });

      // Create threads for different users
      const thread1 = await createTestThread({
        db,
        userId: otherUser.id,
        chatOverrides: { status: "queued-tasks-concurrency" },
      });

      const thread2 = await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "queued-tasks-concurrency" },
      });

      // Should only dequeue thread for the specified user
      const eligibleThreadChats = await getEligibleQueuedThreadChats({
        db,
        userId: user.id,
        concurrencyLimitReached: false,
        sandboxCreationRateLimitReached: false,
      });
      const result = await atomicDequeueThreadChats({
        db,
        userId: user.id,
        eligibleThreadChats,
      });
      expect(result!.threadId).toBe(thread2.threadId);
      expect(result!.oldStatus).toBe("queued-tasks-concurrency");

      // Other user's thread should still be queued
      const otherThreadChat = await getThreadChat({
        db,
        threadId: thread1.threadId,
        threadChatId: thread1.threadChatId,
        userId: otherUser.id,
      });
      expect(otherThreadChat!.status).toBe("queued-tasks-concurrency");
    });

    it("should handle agent rate limit with reattemptQueueAt", async () => {
      // Create thread with agent rate limit and future reattemptQueueAt
      const futureTime = new Date(Date.now() + 60 * 1000);
      await createTestThread({
        db,
        userId: user.id,
        chatOverrides: {
          status: "queued-agent-rate-limit",
          reattemptQueueAt: futureTime,
        },
      });

      // Create thread with agent rate limit and past reattemptQueueAt
      const pastTime = new Date(Date.now() - 60 * 1000);
      const { threadId: thread2Id, threadChatId: thread2ChatId } =
        await createTestThread({
          db,
          userId: user.id,
          chatOverrides: {
            status: "queued-agent-rate-limit",
            reattemptQueueAt: pastTime,
          },
        });

      // Get eligible threads
      const eligibleThreadChats = await getEligibleQueuedThreadChats({
        db,
        userId: user.id,
        concurrencyLimitReached: false,
        sandboxCreationRateLimitReached: false,
      });

      // Should only get thread2 (past reattempt time)
      expect(eligibleThreadChats.length).toBe(1);
      expect(eligibleThreadChats[0]!.threadId).toBe(thread2Id);
      expect(eligibleThreadChats[0]!.threadChatId).toBe(thread2ChatId);

      // Dequeue should get thread2
      const result = await atomicDequeueThreadChats({
        db,
        userId: user.id,
        eligibleThreadChats,
      });
      expect(result!.threadId).toBe(thread2Id);
      expect(result!.threadChatId).toBe(thread2ChatId);
      expect(result!.oldStatus).toBe("queued-agent-rate-limit");
    });
  });

  describe("getActiveThreadCount", () => {
    it("should return 0 when no active threads", async () => {
      const count = await getActiveThreadCount({ db, userId: user.id });
      expect(count).toBe(0);
    });

    it("should return 1 when there is one active thread", async () => {
      await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "booting" },
      });
      const count = await getActiveThreadCount({ db, userId: user.id });
      expect(count).toBe(1);
    });

    it("should return 2 when there are two active threads", async () => {
      await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "booting" },
      });
      await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "working" },
      });
      const count = await getActiveThreadCount({ db, userId: user.id });
      expect(count).toBe(2);
    });

    it("should only count threads for the specific user", async () => {
      const { user: otherUser } = await createTestUser({ db });

      // Create 5 threads for other user
      for (let i = 0; i < 5; i++) {
        await createTestThread({
          db,
          userId: otherUser.id,
          chatOverrides: { status: "working" },
        });
      }

      await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "working" },
      });
      const count = await getActiveThreadCount({ db, userId: user.id });
      expect(count).toBe(1);
      const otherUserCount = await getActiveThreadCount({
        db,
        userId: otherUser.id,
      });
      expect(otherUserCount).toBe(5);
    });

    it("should not count non-active threads", async () => {
      // Create various non-active threads
      const statuses = [
        "complete",
        "stopping",
        "queued",
        "queued-blocked",
        "queued-tasks-concurrency",
        "queued-sandbox-creation-rate-limit",
        "working-error",
      ];
      for (const status of statuses) {
        await createTestThread({
          db,
          userId: user.id,
          chatOverrides: { status: status as any },
        });
      }
      const count = await getActiveThreadCount({ db, userId: user.id });
      expect(count).toBe(0);
    });

    it("should count threads with active threadChats when enableThreadChatCreation is true", async () => {
      // Thread is complete but threadChat is active
      await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "working" },
        enableThreadChatCreation: true,
      });

      const count = await getActiveThreadCount({ db, userId: user.id });
      expect(count).toBe(1);
    });

    it("should not count threadChat when it is complete", async () => {
      await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "complete" },
        enableThreadChatCreation: true,
      });

      const count = await getActiveThreadCount({ db, userId: user.id });
      expect(count).toBe(0);
    });
  });

  describe("getThreads", () => {
    it("no threads", async () => {
      const threads = await getThreads({
        db,
        userId: user.id,
        archived: false,
      });
      expect(threads).toEqual([]);
    });

    it("multiple users", async () => {
      const { user: otherUser } = await createTestUser({ db });

      // Create unread thread for main user
      const { threadId: thread1Id, threadChatId: thread1ThreadChatId } =
        await createTestThread({
          db,
          userId: user.id,
        });
      await markThreadChatAsUnread({
        db,
        userId: user.id,
        threadId: thread1Id,
        threadChatIdOrNull: thread1ThreadChatId,
      });

      // Create unread thread for other user
      const { threadId: thread2Id, threadChatId: thread2ThreadChatId } =
        await createTestThread({
          db,
          userId: otherUser.id,
        });
      await markThreadChatAsUnread({
        db,
        userId: otherUser.id,
        threadId: thread2Id,
        threadChatIdOrNull: thread2ThreadChatId,
      });

      const userThreads = await getThreads({
        db,
        userId: user.id,
        archived: false,
      });
      expect(userThreads.length).toBe(1);
      expect(userThreads[0]!.id).toBe(thread1Id);

      const otherUserThreads = await getThreads({
        db,
        userId: otherUser.id,
        archived: false,
      });
      expect(otherUserThreads.length).toBe(1);
      expect(otherUserThreads[0]!.id).toBe(thread2Id);
    });

    it("should not return threads from other users", async () => {
      const { user: user1 } = await createTestUser({ db });
      const { user: user2 } = await createTestUser({ db });
      const { user: user3 } = await createTestUser({ db });

      // Create threads for different users
      const { threadId: user1ThreadId } = await createTestThread({
        db,
        userId: user1.id,
      });

      const { threadId: user2ThreadId1 } = await createTestThread({
        db,
        userId: user2.id,
      });

      const { threadId: user2ThreadId2 } = await createTestThread({
        db,
        userId: user2.id,
      });

      await createTestThread({
        db,
        userId: user3.id,
      });

      // User 1 should only see their own thread
      const user1Threads = await getThreads({
        db,
        userId: user1.id,
      });
      expect(user1Threads.length).toBe(1);
      expect(user1Threads[0]!.id).toBe(user1ThreadId);
      expect(user1Threads[0]!.userId).toBe(user1.id);

      // User 2 should only see their two threads
      const user2Threads = await getThreads({
        db,
        userId: user2.id,
      });
      expect(user2Threads.length).toBe(2);
      expect(user2Threads.map((t) => t.id)).toContain(user2ThreadId1);
      expect(user2Threads.map((t) => t.id)).toContain(user2ThreadId2);
      expect(user2Threads.every((t) => t.userId === user2.id)).toBe(true);

      // User 3 should only see their one thread
      const user3Threads = await getThreads({
        db,
        userId: user3.id,
      });
      expect(user3Threads.length).toBe(1);
      expect(user3Threads[0]!.userId).toBe(user3.id);

      // Verify no cross-contamination
      expect(user1Threads[0]!.id).not.toBe(user2ThreadId1);
      expect(user1Threads[0]!.id).not.toBe(user2ThreadId2);
    });

    it("should return threadChats array for legacy threads", async () => {
      const { threadId } = await createTestThread({
        db,
        userId: user.id,
        enableThreadChatCreation: false,
        chatOverrides: {
          agent: "claudeCode",
          status: "working",
          errorMessage: "unknown-error",
        },
      });

      const threads = await getThreads({
        db,
        userId: user.id,
      });

      expect(threads.length).toBe(1);
      expect(threads[0]!.id).toBe(threadId);
      expect(threads[0]!.threadChats).toHaveLength(1);
      expect(threads[0]!.threadChats[0]).toMatchObject({
        id: LEGACY_THREAD_CHAT_ID,
        agent: "claudeCode",
        status: "working",
        errorMessage: "unknown-error",
      });
    });

    it("should return threadChats array for threads with separate chats", async () => {
      const { threadId } = await createThread({
        db,
        userId: user.id,
        threadValues: {
          githubRepoFullName: "test/repo",
          repoBaseBranchName: "main",
          sandboxProvider: "e2b",
        },
        initialChatValues: {
          agent: "claudeCode",
          status: "working",
        },
        enableThreadChatCreation: true,
      });

      // Add second chat
      const [chat2] = await db
        .insert(schema.threadChat)
        .values({
          threadId,
          userId: user.id,
          agent: "claudeCode",
          status: "complete",
          errorMessage: null,
        })
        .returning();

      const threads = await getThreads({
        db,
        userId: user.id,
      });

      expect(threads.length).toBe(1);
      expect(threads[0]!.id).toBe(threadId);
      expect(threads[0]!.threadChats).toHaveLength(2);
      expect(threads[0]!.threadChats[0]!.status).toBe("working");
      expect(threads[0]!.threadChats[1]!.id).toBe(chat2!.id);
      expect(threads[0]!.threadChats[1]!.status).toBe("complete");
    });

    it("should include visibility when set", async () => {
      const { threadId } = await createTestThread({
        db,
        userId: user.id,
      });

      await updateThreadVisibility({
        db,
        threadId,
        userId: user.id,
        visibility: "repo",
      });

      const threads = await getThreads({
        db,
        userId: user.id,
      });

      expect(threads.length).toBe(1);
      expect(threads[0]!.visibility).toBe("repo");
    });

    it("should filter by archived status", async () => {
      const { threadId: archivedId } = await createTestThread({
        db,
        userId: user.id,
        overrides: { archived: true },
      });

      const { threadId: unarchivedId } = await createTestThread({
        db,
        userId: user.id,
        overrides: { archived: false },
      });

      const archivedThreads = await getThreads({
        db,
        userId: user.id,
        archived: true,
      });

      expect(archivedThreads.length).toBe(1);
      expect(archivedThreads[0]!.id).toBe(archivedId);

      const unarchivedThreads = await getThreads({
        db,
        userId: user.id,
        archived: false,
      });

      expect(unarchivedThreads.length).toBe(1);
      expect(unarchivedThreads[0]!.id).toBe(unarchivedId);
    });

    it("should filter by githubRepoFullName", async () => {
      await createTestThread({
        db,
        userId: user.id,
        overrides: { githubRepoFullName: "owner/repo1" },
      });

      await createTestThread({
        db,
        userId: user.id,
        overrides: { githubRepoFullName: "owner/repo2" },
      });

      const threads = await getThreads({
        db,
        userId: user.id,
        githubRepoFullName: "owner/repo1",
      });

      expect(threads.length).toBe(1);
      expect(threads[0]!.githubRepoFullName).toBe("owner/repo1");
    });

    it("should filter by githubPRNumber when githubRepoFullName is also provided", async () => {
      await createTestThread({
        db,
        userId: user.id,
        overrides: {
          githubRepoFullName: "owner/repo",
          githubPRNumber: 100,
        },
      });

      await createTestThread({
        db,
        userId: user.id,
        overrides: {
          githubRepoFullName: "owner/repo",
          githubPRNumber: 200,
        },
      });

      const threads = await getThreads({
        db,
        userId: user.id,
        githubRepoFullName: "owner/repo",
        githubPRNumber: 100,
      });

      expect(threads.length).toBe(1);
      expect(threads[0]!.githubPRNumber).toBe(100);
    });

    it("should filter by automationId", async () => {
      const automation1 = await createTestAutomation({
        db,
        userId: user.id,
      });
      const automation2 = await createTestAutomation({
        db,
        userId: user.id,
      });
      const { threadId: auto1Id } = await createTestThread({
        db,
        userId: user.id,
        overrides: { automationId: automation1.id },
      });

      await createTestThread({
        db,
        userId: user.id,
        overrides: { automationId: automation2.id },
      });

      const threads = await getThreads({
        db,
        userId: user.id,
        automationId: automation1.id,
      });

      expect(threads.length).toBe(1);
      expect(threads[0]!.id).toBe(auto1Id);
      expect(threads[0]!.automationId).toBe(automation1.id);
    });

    it("should order threads by updatedAt descending", async () => {
      const { threadId: thread1 } = await createTestThread({
        db,
        userId: user.id,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const { threadId: thread2 } = await createTestThread({
        db,
        userId: user.id,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const { threadId: thread3 } = await createTestThread({
        db,
        userId: user.id,
      });

      const threads = await getThreads({
        db,
        userId: user.id,
      });

      expect(threads.length).toBe(3);
      expect(threads[0]!.id).toBe(thread3);
      expect(threads[1]!.id).toBe(thread2);
      expect(threads[2]!.id).toBe(thread1);
    });

    it("should handle pagination correctly with archived threads", async () => {
      // Create 10 threads total
      const threadChats: { threadId: string; threadChatId: string }[] = [];
      for (let i = 0; i < 10; i++) {
        const { threadId, threadChatId } = await createTestThread({
          db,
          userId: user.id,
        });
        threadChats.push({ threadId, threadChatId });
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      // Mark as unread
      for (const { threadId, threadChatId } of threadChats) {
        await markThreadChatAsUnread({
          db,
          userId: user.id,
          threadId,
          threadChatIdOrNull: threadChatId,
        });
      }
      // Archive threads 0, 2, 4, 6, 8 (5 threads)
      await Promise.all([
        updateThread({
          db,
          userId: user.id,
          threadId: threadChats[0]!.threadId,
          updates: { archived: true },
        }),
        updateThread({
          db,
          userId: user.id,
          threadId: threadChats[2]!.threadId,
          updates: { archived: true },
        }),
        updateThread({
          db,
          userId: user.id,
          threadId: threadChats[4]!.threadId,
          updates: { archived: true },
        }),
        updateThread({
          db,
          userId: user.id,
          threadId: threadChats[6]!.threadId,
          updates: { archived: true },
        }),
        updateThread({
          db,
          userId: user.id,
          threadId: threadChats[8]!.threadId,
          updates: { archived: true },
        }),
      ]);
      // Request first page with limit 3
      const page1 = await getThreads({
        db,
        userId: user.id,
        archived: false,
        limit: 3,
        offset: 0,
      });

      // Should get 3 unarchived threads (from threads 9, 7, 5 in that order due to desc timestamp)
      expect(page1.length).toBe(3);
      expect(page1.map((t) => t.id)).toEqual([
        threadChats[9]!.threadId,
        threadChats[7]!.threadId,
        threadChats[5]!.threadId,
      ]);

      // Request second page
      const page2 = await getThreads({
        db,
        userId: user.id,
        archived: false,
        limit: 3,
        offset: 3,
      });

      // Should get the remaining 2 unarchived threads (threads 3, 1)
      expect(page2.length).toBe(2);
      expect(page2.map((t) => t.id)).toEqual([
        threadChats[3]!.threadId,
        threadChats[1]!.threadId,
      ]);

      // Request third page
      const page3 = await getThreads({
        db,
        userId: user.id,
        archived: false,
        limit: 3,
        offset: 6,
      });

      // Should be empty as we've exhausted all unarchived unread threads
      expect(page3.length).toBe(0);
    });
  });

  describe("getUserIdsWithThreadsStuckInQueue", () => {
    it("should return empty array when no threads are queued", async () => {
      // Create fresh users for this test to avoid interference
      const { user: testUser } = await createTestUser({ db });

      // Create threads with non-queued-tasks-concurrency statuses
      await createTestThread({
        db,
        userId: testUser.id,
        chatOverrides: { status: "working" },
      });

      const userIds = await getUserIdsWithThreadsStuckInQueue({ db });
      // Should not contain our test user since they have no queued-tasks-concurrency threads
      expect(userIds).not.toContain(testUser.id);
    });

    it("should return empty array when users have queued threads but also have active threads", async () => {
      // Create fresh user for this test
      const { user: testUser } = await createTestUser({ db });

      // Create a user with a queued thread
      await createTestThread({
        db,
        userId: testUser.id,
        chatOverrides: { status: "queued-tasks-concurrency" },
      });

      // Create an active thread for the same user
      await createTestThread({
        db,
        userId: testUser.id,
        chatOverrides: { status: "working" },
      });

      const userIds = await getUserIdsWithThreadsStuckInQueue({ db });
      // Should not contain our test user since they have active threads
      expect(userIds).not.toContain(testUser.id);
    });

    it("should return user IDs when users have only queued threads and no active threads", async () => {
      // Create fresh user for this test
      const { user: testUser } = await createTestUser({ db });

      // Create a user with only queued threads
      await createTestThread({
        db,
        userId: testUser.id,
        chatOverrides: { status: "queued-tasks-concurrency" },
      });

      await createTestThread({
        db,
        userId: testUser.id,
        chatOverrides: { status: "queued-tasks-concurrency" },
      });

      const userIds = await getUserIdsWithThreadsStuckInQueue({ db });
      expect(userIds).toContain(testUser.id);
    });

    it("should handle multiple users with different thread statuses", async () => {
      const { user: user1 } = await createTestUser({ db });
      const { user: user2 } = await createTestUser({ db });
      const { user: user3 } = await createTestUser({ db });

      // User 1: Has queued threads and active threads (should not be stuck)
      await createTestThread({
        db,
        userId: user1.id,
        chatOverrides: { status: "queued-tasks-concurrency" },
      });
      await createTestThread({
        db,
        userId: user1.id,
        chatOverrides: { status: "working" },
      });

      // User 2: Has only queued threads (should be stuck)
      await createTestThread({
        db,
        userId: user2.id,
        chatOverrides: { status: "queued-tasks-concurrency" },
      });

      // User 3: Has only active threads (should not be stuck)
      await createTestThread({
        db,
        userId: user3.id,
        chatOverrides: { status: "booting" },
      });

      const userIds = await getUserIdsWithThreadsStuckInQueue({ db });
      expect(userIds).toContain(user2.id);
      expect(userIds).not.toContain(user1.id);
      expect(userIds).not.toContain(user3.id);
    });

    it("should only consider queued-tasks-concurrency status for queued threads", async () => {
      // Create fresh user for this test
      const { user: testUser } = await createTestUser({ db });

      // Create threads with different queued statuses
      await createTestThread({
        db,
        userId: testUser.id,
        chatOverrides: { status: "queued-sandbox-creation-rate-limit" },
      });

      await createTestThread({
        db,
        userId: testUser.id,
        chatOverrides: { status: "queued" },
      });

      const userIds = await getUserIdsWithThreadsStuckInQueue({ db });
      // Should not contain our test user since they have no queued-tasks-concurrency threads
      expect(userIds).not.toContain(testUser.id);
    });

    it("should handle users with mix of queued-tasks-concurrency and non-active threads", async () => {
      // Create fresh user for this test
      const { user: testUser } = await createTestUser({ db });

      // Create threads with queued-tasks-concurrency and completed threads
      await createTestThread({
        db,
        userId: testUser.id,
        chatOverrides: { status: "queued-tasks-concurrency" },
      });

      await createTestThread({
        db,
        userId: testUser.id,
        chatOverrides: { status: "complete" },
      });

      await createTestThread({
        db,
        userId: testUser.id,
        chatOverrides: { status: "working-error" },
      });

      // User should be stuck because they have queued threads but no active threads
      const userIds = await getUserIdsWithThreadsStuckInQueue({ db });
      expect(userIds).toContain(testUser.id);
    });

    it("should correctly identify all active thread statuses", async () => {
      const { user: user1 } = await createTestUser({ db });
      const { user: user2 } = await createTestUser({ db });
      const { user: user3 } = await createTestUser({ db });

      // Create queued threads for all users
      await createTestThread({
        db,
        userId: user1.id,
        chatOverrides: { status: "queued-tasks-concurrency" },
      });

      await createTestThread({
        db,
        userId: user2.id,
        chatOverrides: { status: "queued-tasks-concurrency" },
      });

      await createTestThread({
        db,
        userId: user3.id,
        chatOverrides: { status: "queued-tasks-concurrency" },
      });

      // Give user1 a booting thread (active)
      await createTestThread({
        db,
        userId: user1.id,
        chatOverrides: { status: "booting" },
      });

      // Give user2 a working thread (active)
      await createTestThread({
        db,
        userId: user2.id,
        chatOverrides: { status: "working" },
      });

      // User3 has no active threads, so should be stuck
      const userIds = await getUserIdsWithThreadsStuckInQueue({ db });
      expect(userIds).toContain(user3.id);
      expect(userIds).not.toContain(user1.id);
      expect(userIds).not.toContain(user2.id);
    });

    it("should handle empty results when no users have queued-tasks-concurrency threads", async () => {
      // Create fresh user for this test
      const { user: testUser } = await createTestUser({ db });

      // Create threads with other statuses
      await createTestThread({
        db,
        userId: testUser.id,
        chatOverrides: { status: "working" },
      });

      await createTestThread({
        db,
        userId: testUser.id,
        chatOverrides: { status: "complete" },
      });

      const userIds = await getUserIdsWithThreadsStuckInQueue({ db });
      // Should not contain our test user
      expect(userIds).not.toContain(testUser.id);
    });

    it("should detect stuck users with queued threadChats when enableThreadChatCreation is true", async () => {
      const { user: testUser } = await createTestUser({ db });

      // Create thread with queued threadChat but no active threads
      await createTestThread({
        db,
        userId: testUser.id,
        chatOverrides: { status: "queued-tasks-concurrency" },
        enableThreadChatCreation: true,
      });

      const userIds = await getUserIdsWithThreadsStuckInQueue({ db });
      expect(userIds).toContain(testUser.id);
    });

    it("should not return users with active threadChats when enableThreadChatCreation is true", async () => {
      const { user: testUser } = await createTestUser({ db });

      // User has an active threadChat
      await createTestThread({
        db,
        userId: testUser.id,
        chatOverrides: { status: "working" },
        enableThreadChatCreation: true,
      });

      const userIds = await getUserIdsWithThreadsStuckInQueue({ db });
      expect(userIds).not.toContain(testUser.id);
    });

    it("should return multiple stuck user IDs when multiple users are stuck", async () => {
      const { user: user1 } = await createTestUser({ db });
      const { user: user2 } = await createTestUser({ db });
      const { user: user3 } = await createTestUser({ db });

      // All users have queued threads but no active threads
      await createTestThread({
        db,
        userId: user1.id,
        chatOverrides: { status: "queued-tasks-concurrency" },
      });

      await createTestThread({
        db,
        userId: user2.id,
        chatOverrides: { status: "queued-tasks-concurrency" },
      });

      await createTestThread({
        db,
        userId: user3.id,
        chatOverrides: { status: "queued-tasks-concurrency" },
      });

      const userIds = await getUserIdsWithThreadsStuckInQueue({ db });
      expect(userIds).toContain(user1.id);
      expect(userIds).toContain(user2.id);
      expect(userIds).toContain(user3.id);
    });

    it("should handle users with multiple queued-tasks-concurrency threads", async () => {
      // Create fresh user for this test
      const { user: testUser } = await createTestUser({ db });

      // Create multiple queued threads for the same user
      await createTestThread({
        db,
        userId: testUser.id,
        chatOverrides: { status: "queued-tasks-concurrency" },
      });

      await createTestThread({
        db,
        userId: testUser.id,
        chatOverrides: { status: "queued-tasks-concurrency" },
      });

      await createTestThread({
        db,
        userId: testUser.id,
        chatOverrides: { status: "queued-tasks-concurrency" },
      });

      const userIds = await getUserIdsWithThreadsStuckInQueue({ db });
      expect(userIds).toContain(testUser.id);
    });
  });

  describe("getThreadsForAdmin", () => {
    it("should return all threads without user filtering", async () => {
      const { user: user2 } = await createTestUser({ db });

      // Create threads for different users
      const thread1 = await createTestThread({ db, userId: user.id });
      const thread2 = await createTestThread({ db, userId: user2.id });
      const thread3 = await createTestThread({ db, userId: user.id });

      // Get all threads using admin function
      const allThreads = await getThreadsForAdmin({ db });

      // Should contain threads from both users
      const threadIds = allThreads.map((t) => t.thread.id);
      expect(threadIds).toContain(thread1.threadId);
      expect(threadIds).toContain(thread2.threadId);
      expect(threadIds).toContain(thread3.threadId);

      // All threads should have isUnread set to false (admin view doesn't track read status)
      expect(allThreads.every((t) => t.thread.isUnread === false)).toBe(true);
    });

    it("should support filtering by status", async () => {
      // Create threads with different statuses
      const thread1 = await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "working" },
      });

      const thread2 = await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "complete" },
      });

      // Filter by working status
      const workingThreads = await getThreadsForAdmin({
        db,
        status: ["working"],
      });
      const workingThreadIds = workingThreads.map((t) => t.thread.id);
      expect(workingThreadIds).toContain(thread1.threadId);

      // Filter by complete status
      const completeThreads = await getThreadsForAdmin({
        db,
        status: ["complete"],
      });
      const completeThreadIds = completeThreads.map((t) => t.thread.id);
      expect(completeThreadIds).toContain(thread2.threadId);
    });

    it("should support filtering by archived status", async () => {
      // Create archived and non-archived threads
      const thread1 = await createTestThread({ db, userId: user.id });
      const thread2 = await createTestThread({ db, userId: user.id });
      await updateThread({
        db,
        userId: user.id,
        threadId: thread2.threadId,
        updates: { archived: true },
      });

      // Get non-archived threads
      const nonArchivedThreads = await getThreadsForAdmin({
        db,
        archived: false,
      });
      const nonArchivedIds = nonArchivedThreads.map((t) => t.thread.id);
      expect(nonArchivedIds).toContain(thread1.threadId);
      expect(nonArchivedIds).not.toContain(thread2.threadId);

      // Get archived threads
      const archivedThreads = await getThreadsForAdmin({
        db,
        archived: true,
      });
      const archivedIds = archivedThreads.map((t) => t.thread.id);
      expect(archivedIds).not.toContain(thread1.threadId);
      expect(archivedIds).toContain(thread2.threadId);
    });

    it("should include PR status when available", async () => {
      const prNumber = 789;
      const repoFullName = "terragon/repo1";

      // Create thread with PR
      const { threadId } = await createTestThread({
        db,
        userId: user.id,
        overrides: { githubRepoFullName: repoFullName },
      });
      await updateThread({
        db,
        userId: user.id,
        threadId,
        updates: { githubPRNumber: prNumber },
      });

      // Create a GitHub PR
      await upsertGithubPR({
        db,
        repoFullName,
        number: prNumber,
        updates: { status: "open" },
      });

      // Get threads using admin function
      const threads = await getThreadsForAdmin({ db });
      const adminThread = threads.find((t) => t.thread.id === threadId);
      expect(adminThread).toBeDefined();
      expect(adminThread!.thread.prStatus).toBe("open");
    });

    it("should support pagination", async () => {
      // Create multiple threads with a unique repo name to isolate from other tests
      const uniqueRepo = `terragon/test-pagination-${Date.now()}`;
      const threadIds = [];
      for (let i = 0; i < 5; i++) {
        const { threadId } = await createTestThread({
          db,
          userId: user.id,
          overrides: { githubRepoFullName: uniqueRepo },
        });
        threadIds.push(threadId);
        await new Promise((resolve) => setTimeout(resolve, 10)); // Ensure different timestamps
      }

      // Get first page
      const page1 = await getThreadsForAdmin({
        db,
        limit: 2,
        offset: 0,
        githubRepoFullName: uniqueRepo,
      });
      expect(page1.length).toBe(2);

      // Get second page
      const page2 = await getThreadsForAdmin({
        db,
        limit: 2,
        offset: 2,
        githubRepoFullName: uniqueRepo,
      });
      expect(page2.length).toBe(2);

      // Get third page
      const page3 = await getThreadsForAdmin({
        db,
        limit: 2,
        offset: 4,
        githubRepoFullName: uniqueRepo,
      });
      expect(page3.length).toBe(1);

      // Verify all pages contain our threads
      const allPageIds = [
        ...page1.map((t) => t.thread.id),
        ...page2.map((t) => t.thread.id),
        ...page3.map((t) => t.thread.id),
      ];
      expect(allPageIds.sort()).toEqual(threadIds.sort());

      // Verify no overlap between pages
      const page1Ids = page1.map((t) => t.thread.id);
      const page2Ids = page2.map((t) => t.thread.id);
      const page3Ids = page3.map((t) => t.thread.id);
      expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false);
      expect(page1Ids.some((id) => page3Ids.includes(id))).toBe(false);
      expect(page2Ids.some((id) => page3Ids.includes(id))).toBe(false);
    });
  });

  describe("getEligibleQueuedThreadIds", () => {
    it("should return empty array when no threads exist", async () => {
      const eligibleThreads = await getEligibleQueuedThreadChats({
        db,
        userId: user.id,
        concurrencyLimitReached: false,
        sandboxCreationRateLimitReached: false,
      });
      expect(eligibleThreads).toEqual([]);
    });

    it("should return queued-tasks-concurrency threads when concurrency limit not reached", async () => {
      const { threadId, threadChatId } = await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "queued-tasks-concurrency" },
      });

      const eligibleThreadChats = await getEligibleQueuedThreadChats({
        db,
        userId: user.id,
        concurrencyLimitReached: false,
        sandboxCreationRateLimitReached: false,
      });

      expect(eligibleThreadChats.length).toBe(1);
      expect(eligibleThreadChats[0]!.threadId).toBe(threadId);
      expect(eligibleThreadChats[0]!.threadChatId).toBe(threadChatId);
      expect(eligibleThreadChats[0]!.status).toBe("queued-tasks-concurrency");
    });

    it("should not return queued-tasks-concurrency threads when concurrency limit reached", async () => {
      await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "queued-tasks-concurrency" },
      });

      const eligibleThreadChats = await getEligibleQueuedThreadChats({
        db,
        userId: user.id,
        concurrencyLimitReached: true,
        sandboxCreationRateLimitReached: false,
      });

      expect(eligibleThreadChats).toEqual([]);
    });

    it("should return queued-sandbox-creation-rate-limit threads when rate limit not reached", async () => {
      const { threadId, threadChatId } = await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "queued-sandbox-creation-rate-limit" },
      });

      const eligibleThreads = await getEligibleQueuedThreadChats({
        db,
        userId: user.id,
        concurrencyLimitReached: false,
        sandboxCreationRateLimitReached: false,
      });

      expect(eligibleThreads.length).toBe(1);
      expect(eligibleThreads[0]!.threadId).toBe(threadId);
      expect(eligibleThreads[0]!.threadChatId).toBe(threadChatId);
      expect(eligibleThreads[0]!.status).toBe(
        "queued-sandbox-creation-rate-limit",
      );
    });

    it("should not return queued-sandbox-creation-rate-limit threads when rate limit reached", async () => {
      await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "queued-sandbox-creation-rate-limit" },
      });

      const eligibleThreads = await getEligibleQueuedThreadChats({
        db,
        userId: user.id,
        concurrencyLimitReached: false,
        sandboxCreationRateLimitReached: true,
      });

      expect(eligibleThreads).toEqual([]);
    });

    it("should return queued-agent-rate-limit threads with past reattemptQueueAt", async () => {
      const pastTime = new Date(Date.now() - 60 * 1000);
      const { threadId, threadChatId } = await createTestThread({
        db,
        userId: user.id,
        chatOverrides: {
          status: "queued-agent-rate-limit",
          reattemptQueueAt: pastTime,
        },
      });

      const eligibleThreadChats = await getEligibleQueuedThreadChats({
        db,
        userId: user.id,
        concurrencyLimitReached: false,
        sandboxCreationRateLimitReached: false,
      });

      expect(eligibleThreadChats.length).toBe(1);
      expect(eligibleThreadChats[0]!.threadId).toBe(threadId);
      expect(eligibleThreadChats[0]!.threadChatId).toBe(threadChatId);
      expect(eligibleThreadChats[0]!.status).toBe("queued-agent-rate-limit");
    });

    it("should not return queued-agent-rate-limit threads with future reattemptQueueAt", async () => {
      const futureTime = new Date(Date.now() + 60 * 1000);
      await createTestThread({
        db,
        userId: user.id,
        chatOverrides: {
          status: "queued-agent-rate-limit",
          reattemptQueueAt: futureTime,
        },
      });

      const eligibleThreadChats = await getEligibleQueuedThreadChats({
        db,
        userId: user.id,
        concurrencyLimitReached: false,
        sandboxCreationRateLimitReached: false,
      });

      expect(eligibleThreadChats).toEqual([]);
    });

    it("should handle mixed thread statuses correctly", async () => {
      // Create various threads
      const { threadId: thread1Id, threadChatId: thread1ChatId } =
        await createTestThread({
          db,
          userId: user.id,
          chatOverrides: { status: "queued-tasks-concurrency" },
        });

      const { threadId: thread2Id, threadChatId: thread2ChatId } =
        await createTestThread({
          db,
          userId: user.id,
          chatOverrides: { status: "queued-sandbox-creation-rate-limit" },
        });

      const pastTime = new Date(Date.now() - 60 * 1000);
      const { threadId: thread3Id, threadChatId: thread3ChatId } =
        await createTestThread({
          db,
          userId: user.id,
          chatOverrides: {
            status: "queued-agent-rate-limit",
            reattemptQueueAt: pastTime,
          },
        });

      // Future reattempt time - should not be included
      const futureTime = new Date(Date.now() + 60 * 1000);
      await createTestThread({
        db,
        userId: user.id,
        chatOverrides: {
          status: "queued-agent-rate-limit",
          reattemptQueueAt: futureTime,
        },
      });

      // Non-queued thread - should not be included
      await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "working" },
      });

      const eligibleThreadChats = await getEligibleQueuedThreadChats({
        db,
        userId: user.id,
        concurrencyLimitReached: false,
        sandboxCreationRateLimitReached: false,
      });

      expect(eligibleThreadChats.length).toBe(3);
      const threadIds = eligibleThreadChats.map((t) => t.threadId);
      expect(threadIds).toContain(thread1Id);
      expect(threadIds).toContain(thread2Id);
      expect(threadIds).toContain(thread3Id);
      const threadChatIds = eligibleThreadChats.map((t) => t.threadChatId);
      expect(threadChatIds).toContain(thread1ChatId);
      expect(threadChatIds).toContain(thread2ChatId);
      expect(threadChatIds).toContain(thread3ChatId);
    });

    it("should respect both limit flags", async () => {
      // Create threads of each type
      await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "queued-tasks-concurrency" },
      });

      await createTestThread({
        db,
        userId: user.id,
        chatOverrides: { status: "queued-sandbox-creation-rate-limit" },
      });

      const pastTime = new Date(Date.now() - 60 * 1000);
      const { threadId: thread3ThreadId, threadChatId: thread3ThreadChatId } =
        await createTestThread({
          db,
          userId: user.id,
          chatOverrides: {
            status: "queued-agent-rate-limit",
            reattemptQueueAt: pastTime,
          },
        });

      // Both limits reached - should only get agent rate limit thread
      const eligibleThreadChats = await getEligibleQueuedThreadChats({
        db,
        userId: user.id,
        concurrencyLimitReached: true,
        sandboxCreationRateLimitReached: true,
      });

      expect(eligibleThreadChats.length).toBe(1);
      expect(eligibleThreadChats[0]!.threadId).toBe(thread3ThreadId);
      expect(eligibleThreadChats[0]!.threadChatId).toBe(thread3ThreadChatId);
      expect(eligibleThreadChats[0]!.status).toBe("queued-agent-rate-limit");
    });

    it("should only return threads for specified user", async () => {
      const { user: otherUser } = await createTestUser({ db });

      // Create threads for different users
      await createTestThread({
        db,
        userId: otherUser.id,
        chatOverrides: { status: "queued-tasks-concurrency" },
      });

      const { threadId: userThreadId, threadChatId: userThreadChatId } =
        await createTestThread({
          db,
          userId: user.id,
          chatOverrides: { status: "queued-tasks-concurrency" },
        });

      const eligibleThreadChats = await getEligibleQueuedThreadChats({
        db,
        userId: user.id,
        concurrencyLimitReached: false,
        sandboxCreationRateLimitReached: false,
      });

      expect(eligibleThreadChats.length).toBe(1);
      expect(eligibleThreadChats[0]!.threadId).toBe(userThreadId);
      expect(eligibleThreadChats[0]!.threadChatId).toBe(userThreadChatId);
    });

    it("should handle agent rate limit with null reattemptQueueAt", async () => {
      await createTestThread({
        db,
        userId: user.id,
        chatOverrides: {
          status: "queued-agent-rate-limit",
          reattemptQueueAt: null,
        },
      });

      const eligibleThreads = await getEligibleQueuedThreadChats({
        db,
        userId: user.id,
        concurrencyLimitReached: false,
        sandboxCreationRateLimitReached: false,
      });

      // Should not return threads with null reattemptQueueAt
      expect(eligibleThreads.length).toBe(0);
    });
  });

  describe("reattemptQueueAt functionality", () => {
    it("should return users with threads ready to process", async () => {
      const user2 = (await createTestUser({ db })).user;
      const user3 = (await createTestUser({ db })).user;

      // Create threads with different reattempt times
      await createTestThread({
        db,
        userId: user.id,
        chatOverrides: {
          status: "queued-sandbox-creation-rate-limit",
          reattemptQueueAt: null,
        },
      });
      await createTestThread({
        db,
        userId: user2.id,
        chatOverrides: {
          status: "queued-sandbox-creation-rate-limit",
          reattemptQueueAt: new Date(Date.now() - 60 * 1000),
        },
      });
      await createTestThread({
        db,
        userId: user3.id,
        chatOverrides: {
          status: "queued-sandbox-creation-rate-limit",
          reattemptQueueAt: new Date(Date.now() + 60 * 1000),
        },
      });
      // Should return users with null or past reattempt times
      const readyUsers = await getUserIdsWithThreadsReadyToProcess({ db });
      expect(readyUsers).toContain(user.id); // null reattemptQueueAt
      expect(readyUsers).toContain(user2.id); // past reattemptQueueAt
      expect(readyUsers).not.toContain(user3.id); // future reattemptQueueAt
    });

    it("should clear reattemptQueueAt when transitioning away from rate-limited status", async () => {
      const reattemptTime = new Date(Date.now() + 60 * 1000);
      const { threadId, threadChatId } = await createTestThread({
        db,
        userId: user.id,
        chatOverrides: {
          status: "queued-sandbox-creation-rate-limit",
          reattemptQueueAt: reattemptTime,
        },
      });
      const threadChat = await getThreadChat({
        db,
        threadId,
        threadChatId,
        userId: user.id,
      });
      expect(threadChat!.reattemptQueueAt).toEqual(reattemptTime);
      // Transition to different status
      await updateThreadChatStatusAtomic({
        db,
        userId: user.id,
        threadId,
        threadChatId,
        fromStatus: "queued-sandbox-creation-rate-limit",
        toStatus: "queued",
      });
      const updatedThreadChat = await getThreadChat({
        db,
        threadId,
        threadChatId,
        userId: user.id,
      });
      // Verify it was cleared
      expect(updatedThreadChat!.reattemptQueueAt).toBeNull();
    });

    it("should handle agent rate limit status in getUserIdsWithThreadsReadyToProcess", async () => {
      // Create users with threads in various states
      const user2 = await createTestUser({ db });
      const user3 = await createTestUser({ db });

      // User 1: agent rate limit with null reattemptQueueAt
      await createTestThread({
        db,
        userId: user.id,
        chatOverrides: {
          status: "queued-agent-rate-limit",
          reattemptQueueAt: null,
        },
      });

      // User 2: agent rate limit with past reattemptQueueAt
      await createTestThread({
        db,
        userId: user2.user.id,
        chatOverrides: {
          status: "queued-agent-rate-limit",
          reattemptQueueAt: new Date(Date.now() - 60 * 1000),
        },
      });

      // User 3: agent rate limit with future reattemptQueueAt
      await createTestThread({
        db,
        userId: user3.user.id,
        chatOverrides: {
          status: "queued-agent-rate-limit",
          reattemptQueueAt: new Date(Date.now() + 60 * 1000),
        },
      });

      // Should return users with null or past reattempt times
      const readyUsers = await getUserIdsWithThreadsReadyToProcess({ db });
      expect(readyUsers).toContain(user.id); // null reattemptQueueAt
      expect(readyUsers).toContain(user2.user.id); // past reattemptQueueAt
      expect(readyUsers).not.toContain(user3.user.id); // future reattemptQueueAt
    });

    it("should return users with threadChats ready to process when enableThreadChatCreation is true", async () => {
      const user2 = await createTestUser({ db });
      const user3 = await createTestUser({ db });

      // User 1: threadChat with null reattemptQueueAt
      await createTestThread({
        db,
        userId: user.id,
        chatOverrides: {
          status: "queued-sandbox-creation-rate-limit",
          reattemptQueueAt: null,
        },
        enableThreadChatCreation: true,
      });

      // User 2: threadChat with past reattemptQueueAt
      await createTestThread({
        db,
        userId: user2.user.id,
        chatOverrides: {
          status: "queued-agent-rate-limit",
          reattemptQueueAt: new Date(Date.now() - 60 * 1000),
        },
        enableThreadChatCreation: true,
      });

      // User 3: threadChat with future reattemptQueueAt
      await createTestThread({
        db,
        userId: user3.user.id,
        chatOverrides: {
          status: "queued-sandbox-creation-rate-limit",
          reattemptQueueAt: new Date(Date.now() + 60 * 1000),
        },
        enableThreadChatCreation: true,
      });

      const readyUsers = await getUserIdsWithThreadsReadyToProcess({ db });
      expect(readyUsers).toContain(user.id);
      expect(readyUsers).toContain(user2.user.id);
      expect(readyUsers).not.toContain(user3.user.id);
    });

    it("should clear reattemptQueueAt when transitioning away from agent rate limit status", async () => {
      const reattemptTime = new Date(Date.now() + 60 * 1000);
      const { threadId, threadChatId } = await createTestThread({
        db,
        userId: user.id,
        chatOverrides: {
          status: "queued-agent-rate-limit",
          reattemptQueueAt: reattemptTime,
        },
      });
      // Verify it was set
      const threadChat = await getThreadChat({
        db,
        threadId,
        threadChatId,
        userId: user.id,
      });
      expect(threadChat!.reattemptQueueAt).toEqual(reattemptTime);

      // Transition to a different status
      await updateThreadChatStatusAtomic({
        db,
        userId: user.id,
        threadId,
        threadChatId,
        fromStatus: "queued-agent-rate-limit",
        toStatus: "queued",
      });

      // Verify it was cleared
      const updatedThreadChat = await getThreadChat({
        db,
        threadId,
        threadChatId,
        userId: user.id,
      });
      expect(updatedThreadChat!.reattemptQueueAt).toBeNull();
    });

    it("should not clear reattemptQueueAt when transitioning to agent rate limit status", async () => {
      const { threadId, threadChatId } = await createTestThread({
        db,
        userId: user.id,
        chatOverrides: {
          status: "queued",
        },
      });
      // Transition to rate limit status with a specific reattempt time
      const reattemptTime = new Date(Date.now() + 3600 * 1000);
      await updateThreadChatStatusAtomic({
        db,
        userId: user.id,
        threadId,
        threadChatId,
        fromStatus: "queued",
        toStatus: "queued-agent-rate-limit",
        reattemptQueueAt: reattemptTime,
      });

      // Verify it was set
      const updatedThreadChat = await getThreadChat({
        db,
        threadId,
        threadChatId,
        userId: user.id,
      });
      expect(updatedThreadChat!.reattemptQueueAt).toEqual(reattemptTime);
    });
  });

  describe("getThreadsAndPRsStats", () => {
    it("should return empty array when user has no threads", async () => {
      const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const endDate = new Date();
      const stats = await getThreadsAndPRsStats({
        db,
        userId: user.id,
        startDate,
        endDate,
      });
      expect(stats.threadsCreated).toEqual([]);
      expect(stats.prsMerged).toEqual([]);
    });

    it("should count threads created per day", async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      // Create threads on different days
      await createTestThread({
        db,
        userId: user.id,
        overrides: {
          createdAt: yesterday,
        },
      });
      await createTestThread({
        db,
        userId: user.id,
        overrides: {
          createdAt: today,
        },
      });
      await createTestThread({
        db,
        userId: user.id,
        overrides: {
          createdAt: today,
        },
      });

      const startDate = new Date(yesterday);
      startDate.setDate(startDate.getDate() - 1);
      const endDate = new Date(today);
      endDate.setDate(endDate.getDate() + 1);

      const stats = await getThreadsAndPRsStats({
        db,
        userId: user.id,
        startDate,
        endDate,
      });

      expect(stats.threadsCreated).toHaveLength(2);
      expect(stats.prsMerged).toHaveLength(0);
      expect(stats.threadsCreated).toEqual([
        {
          date: yesterday.toISOString().split("T")[0],
          threadsCreated: 1,
        },
        {
          date: today.toISOString().split("T")[0],
          threadsCreated: 2,
        },
      ]);
    });

    it("should count merged PRs per day", async () => {
      const yesterday = new Date();
      yesterday.setHours(0, 0, 0, 0);
      yesterday.setDate(yesterday.getDate() - 1);

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Create threads with PRs
      const { threadId: thread1Id } = await createTestThread({
        db,
        userId: user.id,
        overrides: {
          githubPRNumber: 123,
          createdAt: yesterday,
        },
      });
      const thread1 = await getThread({
        db,
        threadId: thread1Id,
        userId: user.id,
      });

      const { threadId: thread2Id } = await createTestThread({
        db,
        userId: user.id,
        overrides: {
          githubPRNumber: 124,
          createdAt: yesterday,
        },
      });
      const thread2 = await getThread({
        db,
        threadId: thread2Id,
        userId: user.id,
      });

      const { threadId: thread3Id } = await createTestThread({
        db,
        userId: user.id,
        overrides: {
          githubPRNumber: 125,
          createdAt: today,
        },
      });
      const thread3 = await getThread({
        db,
        threadId: thread3Id,
        userId: user.id,
      });

      // Create PRs with different statuses
      await upsertGithubPR({
        db,
        repoFullName: thread1!.githubRepoFullName,
        number: 123,
        updates: {
          status: "merged",
          updatedAt: today,
        },
      });
      await upsertGithubPR({
        db,
        repoFullName: thread2!.githubRepoFullName,
        number: 124,
        updates: {
          status: "merged",
          updatedAt: today,
        },
      });

      await upsertGithubPR({
        db,
        repoFullName: thread3!.githubRepoFullName,
        number: 125,
        updates: {
          status: "open", // Not merged
          updatedAt: today,
        },
      });

      const startDate = new Date(today);
      startDate.setDate(startDate.getDate() - 2);
      const endDate = new Date(today);
      endDate.setDate(endDate.getDate() + 1);
      const stats = await getThreadsAndPRsStats({
        db,
        userId: user.id,
        startDate,
        endDate,
      });

      expect(stats.threadsCreated).toHaveLength(2);
      expect(stats.prsMerged).toHaveLength(1);
      expect(stats.threadsCreated).toEqual([
        {
          date: yesterday.toISOString().split("T")[0],
          threadsCreated: 2,
        },
        {
          date: today.toISOString().split("T")[0],
          threadsCreated: 1,
        },
      ]);
      expect(stats.prsMerged).toEqual([
        {
          date: today.toISOString().split("T")[0],
          prsMerged: 2,
        },
      ]);
    });

    it("should only count threads within date range", async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const lastWeek = new Date(today);
      lastWeek.setDate(lastWeek.getDate() - 7);
      const nextWeek = new Date(today);
      nextWeek.setDate(nextWeek.getDate() + 7);

      // Create threads outside date range
      await createTestThread({
        db,
        userId: user.id,
        overrides: {
          createdAt: lastWeek,
        },
      });

      // Create thread within date range
      await createTestThread({
        db,
        userId: user.id,
        overrides: {
          createdAt: today,
        },
      });

      // Create thread outside date range
      await createTestThread({
        db,
        userId: user.id,
        overrides: {
          createdAt: nextWeek,
        },
      });

      const startDate = new Date(today);
      startDate.setDate(startDate.getDate() - 1);
      const endDate = new Date(today);
      endDate.setDate(endDate.getDate() + 1);

      const stats = await getThreadsAndPRsStats({
        db,
        userId: user.id,
        startDate,
        endDate,
      });

      expect(stats.threadsCreated).toHaveLength(1);
      expect(stats.prsMerged).toHaveLength(0);
      expect(stats.threadsCreated).toEqual([
        {
          date: today.toISOString().split("T")[0],
          threadsCreated: 1,
        },
      ]);
    });

    it("should only count threads for the specific user", async () => {
      const otherUser = await createTestUser({ db });
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Create threads for different users
      await createTestThread({
        db,
        userId: user.id,
        overrides: {
          createdAt: today,
        },
      });

      await createTestThread({
        db,
        userId: otherUser.user.id,
        overrides: {
          createdAt: today,
        },
      });

      const startDate = new Date(today);
      startDate.setDate(startDate.getDate() - 1);
      const endDate = new Date(today);
      endDate.setDate(endDate.getDate() + 1);

      const stats = await getThreadsAndPRsStats({
        db,
        userId: user.id,
        startDate,
        endDate,
      });

      expect(stats.threadsCreated).toHaveLength(1);
      expect(stats.prsMerged).toHaveLength(0);
      expect(stats.threadsCreated).toEqual([
        {
          date: today.toISOString().split("T")[0],
          threadsCreated: 1,
        },
      ]);
    });

    it("should handle timezone parameter correctly", async () => {
      // Create thread at 2021-01-01 23:00 UTC
      // In UTC: 2021-01-01
      // In Europe/Paris (UTC+1): 2021-01-02
      const { threadId: thread1Id } = await createTestThread({
        db,
        userId: user.id,
        overrides: {
          createdAt: new Date("2021-01-01T23:00:00Z"),
          githubPRNumber: 100,
        },
      });
      const thread1 = await getThread({
        db,
        threadId: thread1Id,
        userId: user.id,
      });

      // Create PR for thread1
      await upsertGithubPR({
        db,
        repoFullName: thread1!.githubRepoFullName!,
        number: 100,
        updates: {
          status: "merged",
        },
      });

      // Create thread at 2021-01-02 01:00 UTC
      // In UTC: 2021-01-02
      // In Europe/Paris (UTC+1): 2021-01-02
      const { threadId: thread2Id } = await createTestThread({
        db,
        userId: user.id,
        overrides: {
          createdAt: new Date("2021-01-02T01:00:00Z"),
          githubPRNumber: 101,
        },
      });
      const thread2 = await getThread({
        db,
        threadId: thread2Id,
        userId: user.id,
      });

      // Create PR for thread2
      await upsertGithubPR({
        db,
        repoFullName: thread2!.githubRepoFullName!,
        number: 101,
        updates: {
          status: "merged",
          updatedAt: new Date("2021-01-01T01:00:00Z"),
        },
      });

      // Test with UTC timezone (default)
      const statsUTC = await getThreadsAndPRsStats({
        db,
        userId: user.id,
        startDate: new Date("2021-01-01T00:00:00Z"),
        endDate: new Date("2021-01-02T23:59:59Z"),
      });

      expect(statsUTC.threadsCreated).toHaveLength(2);
      expect(statsUTC.prsMerged).toHaveLength(1);
      expect(statsUTC.threadsCreated).toEqual([
        {
          date: "2021-01-01",
          threadsCreated: 1,
        },
        {
          date: "2021-01-02",
          threadsCreated: 1,
        },
      ]);
      expect(statsUTC.prsMerged).toEqual([
        {
          date: "2021-01-01",
          prsMerged: 1,
        },
      ]);

      // Test with Europe/Paris timezone (UTC+1)
      const statsParis = await getThreadsAndPRsStats({
        db,
        userId: user.id,
        startDate: new Date("2021-01-01T00:00:00Z"),
        endDate: new Date("2021-01-02T23:59:59Z"),
        timezone: "Europe/Paris",
      });

      expect(statsParis.threadsCreated).toHaveLength(1);
      expect(statsParis.prsMerged).toHaveLength(1);
      expect(statsParis.threadsCreated).toEqual([
        {
          date: "2021-01-02",
          threadsCreated: 2,
        },
      ]);
    });

    it("should handle timezone boundaries correctly with toUTC", async () => {
      await createTestThread({
        db,
        userId: user.id,
        overrides: {
          createdAt: new Date("2025-07-23 16:00:16.850631"),
        },
      });
      const end = setDateValues(
        new Date("2025-07-23T19:30:10.573-07:00"),
        {},
        { in: tz("America/Los_Angeles") },
      );
      const start = setDateValues(
        subDays(end, 1, {
          in: tz("America/Los_Angeles"),
        }),
        { hours: 0, minutes: 0, seconds: 0, milliseconds: 0 },
      );
      const stats = await getThreadsAndPRsStats({
        db,
        userId: user.id,
        startDate: start,
        endDate: end,
        timezone: "America/Los_Angeles",
      });
      expect(stats.threadsCreated).toHaveLength(1);
      expect(stats.prsMerged).toHaveLength(0);
      expect(stats.threadsCreated).toEqual([
        {
          date: "2025-07-23",
          threadsCreated: 1,
        },
      ]);
    });
  });

  describe("text field sanitization for updateThread and updateThreadChat", () => {
    it("should sanitize null bytes from text fields", async () => {
      const { threadId, threadChatId } = await createTestThread({
        db,
        userId: user.id,
      });
      await updateThread({
        db,
        userId: user.id,
        threadId,
        updates: {
          name: "Test\x00Thread",
          branchName: "feature\x00branch",
          codesandboxId: "sandbox\x00id",
          parentToolId: "tool\x00id",
          gitDiff: "diff\x00content",
        },
      });
      await updateThreadChat({
        db,
        userId: user.id,
        threadId,
        threadChatId,
        updates: {
          errorMessage: "error\x00message" as any,
          errorMessageInfo: "error\x00info",
          sessionId: "session\x00id",
        },
      });
      const updatedThread = await getThread({
        db,
        threadId,
        userId: user.id,
      });
      const updatedThreadChat = await getThreadChat({
        db,
        threadId,
        threadChatId,
        userId: user.id,
      });
      expect(updatedThread!.name).toBe("TestThread");
      expect(updatedThread!.branchName).toBe("featurebranch");
      expect(updatedThreadChat!.errorMessage).toBe("errormessage");
      expect(updatedThreadChat!.errorMessageInfo).toBe("errorinfo");
      expect(updatedThreadChat!.sessionId).toBe("sessionid");
      expect(updatedThread!.codesandboxId).toBe("sandboxid");
      expect(updatedThread!.parentToolId).toBe("toolid");
      expect(updatedThread!.gitDiff).toBe("diffcontent");
    });

    it("should keep valid control characters in text fields", async () => {
      const { threadId, threadChatId } = await createTestThread({
        db,
        userId: user.id,
      });

      await updateThread({
        db,
        userId: user.id,
        threadId,
        updates: {
          name: "Test\tThread\nWith\rNewlines",
          gitDiff: "diff --git a/file.txt b/file.txt\n+line1\n-line2",
        },
      });
      await updateThreadChat({
        db,
        userId: user.id,
        threadId,
        threadChatId,
        updates: {
          errorMessageInfo: "Error\tInfo\nMultiline",
          sessionId: "session\x00id",
        },
      });
      const updatedThread = await getThread({
        db,
        threadId,
        userId: user.id,
      });
      expect(updatedThread!.name).toBe("Test\tThread\nWith\rNewlines");
      expect(updatedThread!.gitDiff).toBe(
        "diff --git a/file.txt b/file.txt\n+line1\n-line2",
      );
      const updatedThreadChat = await getThreadChat({
        db,
        threadId,
        threadChatId,
        userId: user.id,
      });
      expect(updatedThreadChat!.errorMessageInfo).toBe(
        "Error\tInfo\nMultiline",
      );
    });

    it("should remove other control characters from text fields", async () => {
      const { threadId, threadChatId } = await createTestThread({
        db,
        userId: user.id,
      });
      await updateThread({
        db,
        userId: user.id,
        threadId,
        updates: {
          name: "Test\x01\x02\x03Thread",
          gitDiff: "diff\x04\x05\x06content",
          branchName: "branch\x07\x08name",
        },
      });
      await updateThreadChat({
        db,
        userId: user.id,
        threadId,
        threadChatId,
        updates: {
          errorMessageInfo: "info\x0B\x0C\x0Etext",
          sessionId: "session\x00id",
        },
      });
      const updatedThread = await getThread({
        db,
        threadId,
        userId: user.id,
      });
      const updatedThreadChat = await getThreadChat({
        db,
        threadId,
        threadChatId,
        userId: user.id,
      });
      expect(updatedThread!.name).toBe("TestThread");
      expect(updatedThread!.gitDiff).toBe("diffcontent");
      expect(updatedThread!.branchName).toBe("branchname");
      expect(updatedThreadChat!.errorMessageInfo).toBe("infotext");
    });

    it("should not affect non-text fields", async () => {
      const { threadId, threadChatId } = await createTestThread({
        db,
        userId: user.id,
      });

      await updateThread({
        db,
        userId: user.id,
        threadId,
        updates: {
          archived: true,
          githubPRNumber: 123,
        },
      });
      await updateThreadChat({
        db,
        userId: user.id,
        threadId,
        threadChatId,
        updates: {
          contextLength: 1000,
        },
      });
      const updatedThread = await getThread({
        db,
        threadId,
        userId: user.id,
      });
      const updatedThreadChat = await getThreadChat({
        db,
        threadId,
        threadChatId,
        userId: user.id,
      });
      expect(updatedThread!.archived).toBe(true);
      expect(updatedThread!.githubPRNumber).toBe(123);
      expect(updatedThreadChat!.contextLength).toBe(1000);
    });

    it("should handle null and undefined text fields correctly", async () => {
      const { threadId, threadChatId } = await createTestThread({
        db,
        userId: user.id,
      });
      await updateThread({
        db,
        userId: user.id,
        threadId,
        updates: {
          name: null,
          branchName: undefined,
        },
      });
      await updateThreadChat({
        db,
        userId: user.id,
        threadId,
        threadChatId,
        updates: {
          errorMessageInfo: null,
        },
      });
      const updatedThread = await getThread({
        db,
        threadId,
        userId: user.id,
      });
      expect(updatedThread!.name).toBe(null);
      // branchName should remain unchanged since undefined is not updated
      expect(updatedThread!.branchName).toBe(null);
      const updatedThreadChat = await getThreadChat({
        db,
        threadId,
        threadChatId,
        userId: user.id,
      });
      expect(updatedThreadChat!.errorMessageInfo).toBe(null);
    });

    it("should sanitize all PgText fields in a single update", async () => {
      const { threadId, threadChatId } = await createTestThread({
        db,
        userId: user.id,
      });
      const updates: Partial<ThreadInsert> = {
        // All text fields that should be sanitized
        name: "Name\x00with\x01null",
        githubRepoFullName: "org\x00/repo\x01name",
        repoBaseBranchName: "main\x02branch",
        branchName: "feature\x03branch",
        bootingSubstatus: "test\x04status" as any,
        codesandboxId: "sandbox\x05id",
        gitDiff: "diff\x06content",
        sandboxProvider: "e2b" as any, // This is text but has specific enum values
        parentToolId: "tool\x0Eid",
      };
      const chatUpdates: ThreadChatInsert = {
        agent: "claudeCode" as any, // This is text but has specific enum values
        errorMessage: "error\x08msg" as any,
        errorMessageInfo: "error\x0Finfo",
        status: "complete" as any, // This is text but has specific enum values
        sessionId: "session\x07id",
      };

      await updateThread({
        db,
        userId: user.id,
        threadId,
        updates,
      });
      await updateThreadChat({
        db,
        userId: user.id,
        threadId,
        threadChatId,
        updates: chatUpdates,
      });

      const updatedThread = await getThread({
        db,
        threadId,
        userId: user.id,
      });
      const updatedThreadChat = await getThreadChat({
        db,
        threadId,
        threadChatId,
        userId: user.id,
      });
      expect(updatedThread!.name).toBe("Namewithnull");
      expect(updatedThread!.githubRepoFullName).toBe("org/reponame");
      expect(updatedThread!.repoBaseBranchName).toBe("mainbranch");
      expect(updatedThread!.branchName).toBe("featurebranch");
      expect(updatedThread!.bootingSubstatus).toBe("teststatus");
      expect(updatedThread!.codesandboxId).toBe("sandboxid");
      expect(updatedThread!.gitDiff).toBe("diffcontent");
      expect(updatedThread!.sandboxProvider).toBe("e2b");
      expect(updatedThread!.parentToolId).toBe("toolid");
      expect(updatedThreadChat!.agent).toBe("claudeCode");
      expect(updatedThreadChat!.status).toBe("complete");
      expect(updatedThreadChat!.sessionId).toBe("sessionid");
      expect(updatedThreadChat!.errorMessage).toBe("errormsg");
      expect(updatedThreadChat!.errorMessageInfo).toBe("errorinfo");
    });

    it("should not affect fields that are not PgText type", async () => {
      const { threadId, threadChatId } = await createTestThread({
        db,
        userId: user.id,
      });
      // These fields should not be processed by sanitization
      await updateThread({
        db,
        userId: user.id,
        threadId,
        updates: {
          // boolean, integer, timestamp fields
          archived: false,
          githubPRNumber: 456,
        },
      });
      await updateThreadChat({
        db,
        userId: user.id,
        threadId,
        threadChatId,
        updates: {
          contextLength: 2000,
          reattemptQueueAt: new Date(),
        },
      });
      const updatedThread = await getThread({
        db,
        threadId,
        userId: user.id,
      });
      // Verify non-text fields are updated without sanitization
      expect(updatedThread!.archived).toBe(false);
      expect(updatedThread!.githubPRNumber).toBe(456);
      const updatedThreadChat = await getThreadChat({
        db,
        threadId,
        threadChatId,
        userId: user.id,
      });
      expect(updatedThreadChat!.contextLength).toBe(2000);
      expect(updatedThreadChat!.reattemptQueueAt).toBeInstanceOf(Date);
    });

    it("should handle edge cases with empty strings and special characters", async () => {
      const { threadId, threadChatId } = await createTestThread({
        db,
        userId: user.id,
      });

      await updateThread({
        db,
        userId: user.id,
        threadId,
        updates: {
          name: "",
          branchName: "\x00\x01\x02\x03",
          gitDiff: "Unicode: émojis 🎉 and special çhars ñ",
        },
      });
      await updateThreadChat({
        db,
        userId: user.id,
        threadId,
        threadChatId,
        updates: {
          errorMessageInfo: "Valid chars: !@#$%^&*()_+-=[]{}|;':\",./<>?",
        },
      });
      const updatedThread = await getThread({
        db,
        threadId,
        userId: user.id,
      });
      expect(updatedThread!.name).toBe("");
      expect(updatedThread!.branchName).toBe(""); // All control chars removed
      const updatedThreadChat = await getThreadChat({
        db,
        threadId,
        threadChatId,
        userId: user.id,
      });
      expect(updatedThreadChat!.errorMessageInfo).toBe(
        "Valid chars: !@#$%^&*()_+-=[]{}|;':\",./<>?",
      );
      expect(updatedThread!.gitDiff).toBe(
        "Unicode: émojis 🎉 and special çhars ñ",
      );
    });

    it("should sanitize text fields along with message operations", async () => {
      const { threadId, threadChatId } = await createTestThread({
        db,
        userId: user.id,
      });
      await updateThreadChat({
        db,
        userId: user.id,
        threadId,
        threadChatId,
        updates: {
          errorMessage: "error\x01occurred" as any,
          appendMessages: [
            {
              type: "user",
              model: null,
              parts: [{ type: "text", text: "Message with\x00null byte" }],
            },
          ],
          appendQueuedMessages: [
            {
              type: "user",
              model: null,
              parts: [{ type: "text", text: "Queued\x01message" }],
            },
          ],
        },
      });
      const updatedThreadChat = await getThreadChat({
        db,
        threadId,
        threadChatId,
        userId: user.id,
      });
      expect(updatedThreadChat!.errorMessage).toBe("erroroccurred");
      // Messages should also be sanitized (existing functionality)
      expect(updatedThreadChat!.messages).toHaveLength(1);
      const message = updatedThreadChat!.messages?.[0];
      if (message?.type === "user") {
        expect(message.parts[0]).toEqual({
          type: "text",
          text: "Message withnull byte",
        });
      }

      expect(updatedThreadChat!.queuedMessages).toHaveLength(1);
      const queuedMessage = updatedThreadChat!.queuedMessages?.[0];
      if (queuedMessage?.type === "user") {
        expect(queuedMessage.parts[0]).toEqual({
          type: "text",
          text: "Queuedmessage",
        });
      }
    });

    it("should handle concurrent updates with text field sanitization", async () => {
      const { threadId, threadChatId } = await createTestThread({
        db,
        userId: user.id,
      });
      // Simulate concurrent updates with different text fields containing invalid chars
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          updateThread({
            db,
            userId: user.id,
            threadId,
            updates: {
              name: `Thread${i}\x00with\x01null`,
            },
          }),
          updateThreadChat({
            db,
            userId: user.id,
            threadId,
            threadChatId,
            updates: {
              errorMessageInfo: `Info${i}\x02text`,
            },
          }),
        );
      }
      await Promise.all(promises);
      const finalThread = await getThread({
        db,
        threadId,
        userId: user.id,
      });
      expect(finalThread!.name).toMatch(/^Thread\d+withnull$/);
      const updatedThreadChat = await getThreadChat({
        db,
        threadId,
        threadChatId,
        userId: user.id,
      });
      expect(updatedThreadChat!.errorMessageInfo).toMatch(/^Info\d+text$/);
    });
  });
});
