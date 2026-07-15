import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleAppMentionEvent, SlackAppMentionEvent } from "./handlers";
import { User } from "@terragon/shared";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import { db } from "@/lib/db";
import { newThreadInternal } from "@/server-lib/new-thread-internal";
import { env } from "@terragon/env/apps-www";
import { encryptValue } from "@terragon/utils/encryption";
import {
  upsertSlackAccount,
  upsertSlackInstallation,
  upsertSlackSettings,
} from "@terragon/shared/model/slack";
import { createOrganization } from "@terragon/shared/model/organizations";
import { slackInstallation } from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import * as slackWebApi from "@slack/web-api";

const getDefaultWebClientMock = (overrides?: {
  messages?: any[];
  postMessageFn?: () => any;
  userInfoFn?: ({ user }: { user: any }) => any;
  botInfoFn?: ({ bot }: { bot: any }) => any;
}): slackWebApi.WebClient => {
  return {
    chat: {
      postMessage:
        overrides?.postMessageFn || vi.fn().mockResolvedValue({ ok: true }),
    },
    conversations: {
      replies: vi
        .fn()
        .mockResolvedValue({ messages: overrides?.messages || [] }),
      info: vi.fn().mockResolvedValue({ channel: { name: "general" } }),
    },
    users: {
      info: vi
        .fn()
        .mockImplementation(
          overrides?.userInfoFn ||
            (() => ({ user: { name: "testuser", real_name: "Test User" } })),
        ),
    },
    bots: {
      info: vi
        .fn()
        .mockImplementation(
          overrides?.botInfoFn || (() => ({ bot: { name: "testbot" } })),
        ),
    },
  } as unknown as slackWebApi.WebClient;
};

vi.mock("@slack/web-api", () => ({
  WebClient: vi.fn().mockImplementation(() => getDefaultWebClientMock()),
}));

vi.mock("@/server-lib/new-thread-internal", () => ({
  newThreadInternal: vi.fn(),
}));

describe("handleAppMentionEvent", () => {
  let user: User;
  let teamId: string;
  let slackUserId: string;
  let channelId: string;

  beforeEach(async () => {
    const testUserResult = await createTestUser({ db });
    user = testUserResult.user;
    slackUserId = `UUSER123-${user.id}`;
    teamId = `TTEAM123`;
    channelId = `CCHAN123`;
    await Promise.all([
      upsertSlackAccount({
        db,
        userId: user.id,
        teamId,
        account: {
          slackUserId,
          slackTeamName: "Test Team",
          slackTeamDomain: "test-workspace",
          accessTokenEncrypted: encryptValue(
            "access-token",
            env.ENCRYPTION_MASTER_KEY,
          ),
        },
      }),
      upsertSlackSettings({
        db,
        userId: user.id,
        teamId,
        settings: {
          defaultRepoFullName: "testorg/testrepo",
          defaultModel: null,
        },
      }),
    ]);
    await upsertSlackInstallation({
      db,
      userId: user.id,
      teamId,
      installation: {
        teamName: "Test Team",
        botUserId: "B123",
        botAccessTokenEncrypted: encryptValue(
          "bot-access-token",
          env.ENCRYPTION_MASTER_KEY,
        ),
        scope: "app_mentions:read,chat:write",
        appId: "A123",
      },
    });
    vi.clearAllMocks();
    vi.mocked(slackWebApi.WebClient).mockImplementation(() => {
      return getDefaultWebClientMock();
    });
    vi.mocked(newThreadInternal).mockResolvedValue({
      threadId: "new-thread-created-id",
      threadChatId: "new-thread-chat-created-id",
    });
  });

  const createBasicEvent = (
    overrides?: Partial<SlackAppMentionEvent>,
  ): SlackAppMentionEvent => ({
    type: "app_mention",
    user: slackUserId,
    text: `<@B123456789> please help me with this task`,
    ts: "1234567890.123456",
    channel: channelId,
    team: teamId,
    ...overrides,
  });

  describe("message formatting", () => {
    it("should format basic message sent to agent (snapshot)", async () => {
      const event = createBasicEvent({
        text: "<@B123456789> Can you fix the bug in login.ts?",
      });
      await handleAppMentionEvent(event);

      expect(newThreadInternal).toHaveBeenCalledTimes(1);
      expect(newThreadInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            parts: expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining(
                  "Can you fix the bug in login.ts?",
                ),
              }),
            ]),
          }),
        }),
      );
      const callArgs = vi.mocked(newThreadInternal).mock.calls[0]?.[0];
      // @ts-expect-error
      const messageText = callArgs?.message.parts[0]?.text;
      expect(messageText).toMatchInlineSnapshot(`
        "@testuser mentioned you in general with the following message:

        @testbot Can you fix the bug in login.ts?

        Please work on this task. Your work will be sent to the user once you're done.

        https://test-workspace.slack.com/archives/CCHAN123/p1234567890123456"
      `);
    });

    it("should format message with bot replies in thread (snapshot)", async () => {
      const userU111 = "U111";
      const botB222 = "B222";

      vi.mocked(slackWebApi.WebClient).mockImplementation(() => {
        return getDefaultWebClientMock({
          messages: [
            {
              user: userU111,
              text: "Hey team, can you help with this?",
              ts: "1234567890.000001",
            },
            {
              bot_id: botB222,
              text: `I can assist! Let me check the code.`,
              ts: "1234567890.000002",
            },
            {
              user: slackUserId,
              text: "<@B123456789> please continue from where the bot left off",
              ts: "1234567890.123456",
            },
          ],
          userInfoFn: ({ user }: { user: any }) => {
            if (user === userU111) {
              return { user: { name: "alice", real_name: "Alice Smith" } };
            }
            if (user === slackUserId) {
              return { user: { name: "testuser", real_name: "Test User" } };
            }
            return { user: { name: user, real_name: user } };
          },
          botInfoFn: ({ bot }: { bot: any }) => {
            if (bot === botB222) {
              return { bot: { name: "assistant-bot" } };
            }
            return { bot: { name: "testbot" } };
          },
        });
      });

      const event = createBasicEvent({
        text: "<@B123456789> please continue from where the bot left off",
        thread_ts: "1234567890.000001",
      });

      await handleAppMentionEvent(event);
      const callArgs = vi.mocked(newThreadInternal).mock.calls[0]?.[0];
      // @ts-expect-error
      const messageText = callArgs?.message.parts[0]?.text;
      expect(messageText).toMatchInlineSnapshot(`
        "@testuser mentioned you in general with the following message:

        @testbot please continue from where the bot left off

        Here's the context of the thread:
        > - @alice: Hey team, can you help with this?
        > - @assistant-bot: I can assist! Let me check the code.
        > - @testuser: @testbot please continue from where the bot left off

        Please work on this task. Your work will be sent to the user once you're done.

        https://test-workspace.slack.com/archives/CCHAN123/p1234567890123456?thread_ts=1234567890.000001&cid=CCHAN123"
      `);
    });

    it("should format message with thread context (snapshot)", async () => {
      const userU111 = "U111";
      const userU222 = "U222";

      vi.mocked(slackWebApi.WebClient).mockImplementation(() => {
        return getDefaultWebClientMock({
          messages: [
            {
              user: userU111,
              text: "Hey team, we have a bug",
              ts: "1234567890.000001",
            },
            {
              user: userU222,
              text: `I think it's in the <@${userU111}> login code`,
              ts: "1234567890.000002",
            },
            {
              user: slackUserId,
              text: "<@B123456789> can you investigate?",
              ts: "1234567890.123456",
            },
          ],
          userInfoFn: ({ user }: { user: any }) => {
            if (user === userU111) {
              return { user: { name: "alice", real_name: "Alice Smith" } };
            }
            if (user === userU222) {
              return { user: { name: "bob", real_name: "Bob Jones" } };
            }
            if (user === slackUserId) {
              return { user: { name: "testuser", real_name: "Test User" } };
            }
            return { user: { name: user, real_name: user } };
          },
        });
      });
      const event = createBasicEvent({
        text: "<@B123456789> can you investigate?",
        thread_ts: "1234567890.000001",
      });

      await handleAppMentionEvent(event);
      const callArgs = vi.mocked(newThreadInternal).mock.calls[0]?.[0];
      // @ts-expect-error
      const messageText = callArgs?.message.parts[0]?.text;
      expect(messageText).toMatchInlineSnapshot(`
        "@testuser mentioned you in general with the following message:

        @testbot can you investigate?

        Here's the context of the thread:
        > - @alice: Hey team, we have a bug
        > - @bob: I think it's in the @alice login code
        > - @testuser: @testbot can you investigate?

        Please work on this task. Your work will be sent to the user once you're done.

        https://test-workspace.slack.com/archives/CCHAN123/p1234567890123456?thread_ts=1234567890.000001&cid=CCHAN123"
      `);
    });

    it("should format message with complex mentions (snapshot)", async () => {
      const event = createBasicEvent({
        text: `<@U123456789> Review the PR and check the feedback`,
      });
      await handleAppMentionEvent(event);
      const callArgs = vi.mocked(newThreadInternal).mock.calls[0]?.[0];
      // @ts-expect-error
      const messageText = callArgs?.message.parts[0]?.text;
      expect(messageText).toMatchInlineSnapshot(`
        "@testuser mentioned you in general with the following message:

        @testuser Review the PR and check the feedback

        Please work on this task. Your work will be sent to the user once you're done.

        https://test-workspace.slack.com/archives/CCHAN123/p1234567890123456"
      `);
    });

    it("should format message in thread (snapshot)", async () => {
      const event = createBasicEvent({
        text: "<@B123456789> follow up on the previous task",
        thread_ts: "1234567890.000001",
        ts: "1234567890.123456",
      });

      await handleAppMentionEvent(event);
      const callArgs = vi.mocked(newThreadInternal).mock.calls[0]?.[0];
      // @ts-expect-error
      const messageText = callArgs?.message.parts[0]?.text;
      expect(messageText).toMatchInlineSnapshot(`
        "@testuser mentioned you in general with the following message:

        @testbot follow up on the previous task

        Please work on this task. Your work will be sent to the user once you're done.

        https://test-workspace.slack.com/archives/CCHAN123/p1234567890123456?thread_ts=1234567890.000001&cid=CCHAN123"
      `);
    });

    it("should handle thread with messages that have no text or user info", async () => {
      const userU111 = "U111";
      const botB222 = "B222";

      vi.mocked(slackWebApi.WebClient).mockImplementation(() => {
        return getDefaultWebClientMock({
          messages: [
            {
              user: userU111,
              text: "Valid message",
              ts: "1234567890.000001",
            },
            {
              // Message with no text (should be filtered out)
              bot_id: botB222,
              ts: "1234567890.000002",
            },
            {
              // Message with no user or bot_id (should be filtered out)
              text: "orphan message",
              ts: "1234567890.000003",
            },
            {
              user: slackUserId,
              text: "<@B123456789> help",
              ts: "1234567890.123456",
            },
          ],
          userInfoFn: ({ user }: { user: any }) => {
            if (user === userU111) {
              return { user: { name: "alice" } };
            }
            if (user === slackUserId) {
              return { user: { name: "testuser" } };
            }
            return { user: { name: user } };
          },
        });
      });

      const event = createBasicEvent({
        text: "<@B123456789> help",
        thread_ts: "1234567890.000001",
      });

      await handleAppMentionEvent(event);
      const callArgs = vi.mocked(newThreadInternal).mock.calls[0]?.[0];
      // @ts-expect-error
      const messageText = callArgs?.message.parts[0]?.text;
      // Only valid messages should appear in context
      expect(messageText).toMatchInlineSnapshot(`
        "@testuser mentioned you in general with the following message:

        @testbot help

        Here's the context of the thread:
        > - @alice: Valid message
        > - @testuser: @testbot help

        Please work on this task. Your work will be sent to the user once you're done.

        https://test-workspace.slack.com/archives/CCHAN123/p1234567890123456?thread_ts=1234567890.000001&cid=CCHAN123"
      `);
    });
  });

  describe("error cases", () => {
    it("should not create thread when team ID is missing", async () => {
      const event = createBasicEvent({ team: undefined });
      const postMessageFn = vi.fn().mockResolvedValue({ ok: true });
      vi.mocked(slackWebApi.WebClient).mockImplementation(() => {
        return getDefaultWebClientMock({ postMessageFn });
      });
      await handleAppMentionEvent(event);
      expect(newThreadInternal).not.toHaveBeenCalled();
      expect(postMessageFn).not.toHaveBeenCalled();
    });

    it("should send setup message when slack account not found", async () => {
      const event = createBasicEvent({ user: "user-with-no-installation" });

      const postMessageFn = vi.fn().mockResolvedValue({ ok: true });
      vi.mocked(slackWebApi.WebClient).mockImplementation(() => {
        return getDefaultWebClientMock({ postMessageFn });
      });

      await handleAppMentionEvent(event);
      expect(newThreadInternal).not.toHaveBeenCalled();
      expect(postMessageFn).toHaveBeenCalled();
      const postMessageCall = postMessageFn.mock.calls[0]?.[0];
      expect(postMessageCall.text).toMatchInlineSnapshot(
        `"Hi <@user-with-no-installation>! It looks like we're not connected yet. Please connect your Slack account in the <http://localhost:3000/settings|settings page>, then click "Try Again" below."`,
      );
      expect(postMessageCall.blocks).toMatchInlineSnapshot(`
        [
          {
            "text": {
              "text": "Hi <@user-with-no-installation>! It looks like we're not connected yet. Please connect your Slack account in the <http://localhost:3000/settings|settings page>, then click "Try Again" below.",
              "type": "mrkdwn",
            },
            "type": "section",
          },
          {
            "elements": [
              {
                "action_id": "retry_task_creation",
                "style": "primary",
                "text": {
                  "emoji": true,
                  "text": "Try Again",
                  "type": "plain_text",
                },
                "type": "button",
                "value": "{"text":"<@B123456789> please help me with this task","channel":"CCHAN123","user":"user-with-no-installation","thread_ts":"1234567890.123456","team":"TTEAM123"}",
              },
              {
                "action_id": "go_to_settings",
                "text": {
                  "emoji": true,
                  "text": "Go to Settings",
                  "type": "plain_text",
                },
                "type": "button",
                "url": "http://localhost:3000/settings/integrations",
              },
            ],
            "type": "actions",
          },
        ]
      `);
    });
  });

  describe("success acknowledgment", () => {
    it("should send success acknowledgment after creating thread (snapshot)", async () => {
      const event = createBasicEvent();
      const postMessageFn = vi.fn().mockResolvedValue({ ok: true });
      vi.mocked(slackWebApi.WebClient).mockImplementation(() => {
        return getDefaultWebClientMock({ postMessageFn });
      });
      await handleAppMentionEvent(event);

      expect(postMessageFn).toHaveBeenCalledWith({
        channel: channelId,
        thread_ts: event.ts,
        text: "✅ Task created in testorg/testrepo: http://localhost:3000/task/new-thread-created-id",
      });
    });

    it("should send acknowledgment in existing thread", async () => {
      const event = createBasicEvent({
        thread_ts: "1234567890.000001",
      });
      const postMessageFn = vi.fn().mockResolvedValue({ ok: true });
      vi.mocked(slackWebApi.WebClient).mockImplementation(() => {
        return getDefaultWebClientMock({ postMessageFn });
      });
      await handleAppMentionEvent(event);
      expect(postMessageFn).toHaveBeenCalledWith({
        channel: channelId,
        thread_ts: "1234567890.000001",
        text: "✅ Task created in testorg/testrepo: http://localhost:3000/task/new-thread-created-id",
      });
    });
  });

  describe("thread creation parameters", () => {
    it("should create thread with correct parameters", async () => {
      const event = createBasicEvent({
        text: "<@B123456789> Fix the authentication bug",
      });

      await handleAppMentionEvent(event);

      expect(newThreadInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: user.id,
          message: expect.objectContaining({
            type: "user",
            parts: expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining("Fix the authentication bug"),
              }),
            ]),
          }),
          parentThreadId: undefined,
          parentToolId: undefined,
          githubRepoFullName: "testorg/testrepo",
          baseBranchName: null,
          headBranchName: null,
          sourceType: "slack-mention",
          sourceMetadata: expect.objectContaining({
            type: "slack-mention",
          }),
        }),
      );
    });

    it("should use custom model from slack settings", async () => {
      await upsertSlackSettings({
        db,
        userId: user.id,
        teamId,
        settings: { defaultModel: "gpt-5-codex-high" },
      });

      const event = createBasicEvent();
      await handleAppMentionEvent(event);
      const callArgs = vi.mocked(newThreadInternal).mock.calls[0]?.[0];
      expect(callArgs?.message.model).toBe("gpt-5-codex-high");
    });

    it("derives the thread's org from the Slack installation (WI-5)", async () => {
      const org = await createOrganization({
        db,
        name: "Acme",
        slug: `acme-${nanoid(8).toLowerCase()}`,
      });
      await db
        .update(slackInstallation)
        .set({ organizationId: org.id })
        .where(eq(slackInstallation.teamId, teamId));

      await handleAppMentionEvent(createBasicEvent());

      const callArgs = vi.mocked(newThreadInternal).mock.calls[0]?.[0];
      expect(callArgs?.organizationId).toBe(org.id);
    });

    it("passes a null org when the installation has none (nullable-safe)", async () => {
      // The installation row is shared across tests in this file (constant
      // teamId); ensure no org so the nullable path is exercised.
      await db
        .update(slackInstallation)
        .set({ organizationId: null })
        .where(eq(slackInstallation.teamId, teamId));

      await handleAppMentionEvent(createBasicEvent());
      const callArgs = vi.mocked(newThreadInternal).mock.calls[0]?.[0];
      expect(callArgs?.organizationId ?? null).toBeNull();
    });
  });
});
