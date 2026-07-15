import { WebClient } from "@slack/web-api";
import { db } from "@/lib/db";
import {
  getSlackAccountForSlackUserId,
  getSlackInstallationForTeam,
  getSlackSettingsForTeam,
} from "@terragon/shared/model/slack";
import { SlackAccount } from "@terragon/shared";
import { decryptValue } from "@terragon/utils/encryption";
import { env } from "@terragon/env/apps-www";
import { publicAppUrl } from "@terragon/env/next-public";
import { getUserFlags } from "@terragon/shared/model/user-flags";
import { newThreadInternal } from "@/server-lib/new-thread-internal";
import { getUserCredentials } from "@/server-lib/user-credentials";
import { getDefaultModel } from "@/lib/default-ai-model";
import { formatThreadContext } from "@/server-lib/ext-thread-context";

export interface SlackAppMentionEvent {
  type: string;
  user: string;
  text: string;
  ts: string;
  channel: string;
  thread_ts?: string;
  team?: string;
  edited?: {
    user: string;
    ts: string;
  };
}

export interface SlackInteractiveAction {
  action_id: string;
  value: string;
  type: string;
}

/**
 * Replaces user mentions like <@U123456> and bot mentions like <@B123456> with readable names
 */
function cleanSlackText({
  text,
  atMentionNameMap,
}: {
  text: string;
  atMentionNameMap: Map<string, string>;
}): string {
  // Replace user and bot mentions with actual names
  return text.replace(/<@([UB][A-Z0-9]+)>/g, (match, id) => {
    const name = atMentionNameMap.get(id);
    if (name) {
      return `@${name}`;
    }
    // fallback
    return `@${id}`;
  });
}

function normalizeName(name: string): string {
  if (name.includes(" ")) {
    return JSON.stringify(name);
  }
  return name;
}

async function getAtMentionNameMap({
  slack,
  event,
  messageTexts,
  messageBotIds,
  messageAuthorIds,
}: {
  slack: WebClient;
  event: SlackAppMentionEvent;
  messageBotIds: string[];
  messageAuthorIds: string[];
  messageTexts: string[];
}): Promise<Map<string, string>> {
  const atMentionNameMap = new Map<string, string>();
  const userIds = new Set<string>(messageAuthorIds);
  const botIds = new Set<string>(messageBotIds);
  for (const messageText of messageTexts) {
    const mentionMatches = messageText.matchAll(/<@([UB][A-Z0-9]+)>/g);
    for (const match of mentionMatches) {
      if (match[1]) {
        if (match[1].startsWith("U")) {
          userIds.add(match[1]);
        } else if (match[1].startsWith("B")) {
          botIds.add(match[1]);
        }
      }
    }
  }
  await Promise.all([
    ...Array.from(userIds).map(async (userId) => {
      const userInfo = await slack.users.info({ user: userId });
      if (userInfo.user) {
        atMentionNameMap.set(
          userId,
          normalizeName(
            userInfo.user.profile?.display_name ||
              userInfo.user.profile?.real_name ||
              userInfo.user.name ||
              userInfo.user.real_name ||
              userId,
          ),
        );
      }
    }),
    ...Array.from(botIds).map(async (botId) => {
      const botInfo = await slack.bots.info({ bot: botId });
      if (botInfo.bot) {
        atMentionNameMap.set(botId, normalizeName(botInfo.bot.name || botId));
      }
    }),
  ]);
  return atMentionNameMap;
}

/**
 * Generate a Slack permalink for a message
 * @param workspaceDomain - The Slack workspace domain
 * @param channel - The channel ID
 * @param messageTs - The timestamp of the specific message
 * @param threadTs - The parent thread timestamp (if in a thread)
 * @returns The Slack permalink URL or null if workspace domain is not available
 */
function getSlackMessagePermalink({
  workspaceDomain,
  channel,
  messageTs,
  threadTs,
}: {
  workspaceDomain: string | null;
  channel: string;
  messageTs: string;
  threadTs?: string;
}): string | null {
  if (!workspaceDomain) {
    return null;
  }

  const formattedTs = messageTs.replace(".", "");
  const baseUrl = `https://${workspaceDomain}.slack.com/archives/${channel}/p${formattedTs}`;

  // If it's a threaded message, add query parameters
  if (threadTs && threadTs !== messageTs) {
    return `${baseUrl}?thread_ts=${threadTs}&cid=${channel}`;
  }

  return baseUrl;
}

/**
 * Builds a formatted message for a Slack mention task
 * @param slack - Slack Web Client instance
 * @param event - The Slack app mention event
 * @param workspaceDomain - The Slack workspace domain for generating permalink
 * @returns Formatted message string
 */
export async function buildSlackMentionMessage({
  slackAccount,
  slack,
  event,
}: {
  slackAccount: SlackAccount;
  slack: WebClient;
  event: SlackAppMentionEvent;
}): Promise<string> {
  const threadTs = event.thread_ts || event.ts;

  // Fetch thread replies and channel name in parallel
  const [threadReplies, channelName] = await Promise.all([
    getThreadReplies({ slack, event }),
    getChannelName({ slack, event }),
  ]);

  // Build at-mention name map
  const messageAuthorIds = [event.user];
  const messageBotIds = [];
  const messageTexts = [event.text];
  for (const reply of threadReplies) {
    if (reply.type === "user") {
      messageAuthorIds.push(reply.id);
    } else if (reply.type === "bot") {
      messageBotIds.push(reply.id);
    }
    messageTexts.push(reply.text);
  }
  const atMentionNameMap = await getAtMentionNameMap({
    slack,
    event,
    messageAuthorIds,
    messageBotIds,
    messageTexts,
  });
  const [threadContext, cleanedMessageText] = await Promise.all([
    getThreadContext({
      slack,
      replies: threadReplies,
      atMentionNameMap,
    }),
    cleanSlackText({
      text: event.text,
      atMentionNameMap,
    }),
  ]);

  // Create Slack thread link to the specific message
  const slackThreadLink = getSlackMessagePermalink({
    workspaceDomain: slackAccount.slackTeamDomain,
    channel: event.channel,
    messageTs: event.ts,
    threadTs,
  });

  // Build the message parts
  const mentioningUserName = atMentionNameMap.get(event.user) || event.user;
  const messageParts = [
    `@${mentioningUserName} mentioned you in ${channelName} with the following message:`,
    cleanedMessageText,
  ];
  // Add thread context if available
  if (threadContext) {
    messageParts.push(`Here's the context of the thread:\n${threadContext}`);
  }
  messageParts.push(
    "Please work on this task. Your work will be sent to the user once you're done.",
  );
  if (slackThreadLink) {
    messageParts.push(slackThreadLink);
  }

  return messageParts.join("\n\n");
}

type ThreadReply =
  | { type: "user"; id: string; text: string }
  | { type: "bot"; id: string; text: string };

async function getThreadReplies({
  slack,
  event,
}: {
  slack: WebClient;
  event: SlackAppMentionEvent;
}): Promise<ThreadReply[]> {
  if (!event.thread_ts || event.thread_ts === event.ts) {
    return [];
  }
  const threadMessages = await slack.conversations.replies({
    channel: event.channel,
    ts: event.thread_ts || event.ts,
    limit: 100, // Get up to 100 messages in the thread
  });
  return (
    threadMessages.messages
      ?.filter((msg) => {
        if (!msg.ts) {
          return false;
        }
        // Include messages that came before OR are the current mention
        return parseFloat(msg.ts || "0") <= parseFloat(event.ts || "0");
      })
      .map((msg) => {
        if (msg.user && msg.text) {
          return { type: "user" as const, id: msg.user, text: msg.text };
        }
        if (msg.bot_id && msg.text) {
          return { type: "bot" as const, id: msg.bot_id, text: msg.text };
        }
        return undefined;
      })
      .filter((msg) => msg !== undefined) || []
  );
}

async function getChannelName({
  slack,
  event,
}: {
  slack: WebClient;
  event: SlackAppMentionEvent;
}): Promise<string> {
  try {
    const channelInfo = await slack.conversations.info({
      channel: event.channel,
    });
    return channelInfo.channel?.name || event.channel;
  } catch (error) {
    console.warn(
      `[slack webhook] Failed to fetch channel info for ${event.channel}`,
      error,
    );
    return event.channel;
  }
}

async function getThreadContext({
  slack,
  replies,
  atMentionNameMap,
}: {
  slack: WebClient;
  replies: ThreadReply[];
  atMentionNameMap: Map<string, string>;
}): Promise<string> {
  if (replies.length === 0) {
    return "";
  }
  const entries = replies.map((reply) => {
    const userName = atMentionNameMap.get(reply.id) || reply.id;
    const cleanedText = cleanSlackText({
      text: reply.text,
      atMentionNameMap,
    });
    return {
      author: userName,
      body: cleanedText,
    };
  });

  return formatThreadContext(entries);
}

async function sendSetupMessage({
  slack,
  event,
  threadTs,
  teamId,
  message,
}: {
  slack: WebClient;
  event: SlackAppMentionEvent;
  threadTs: string;
  teamId: string;
  message: string;
}): Promise<void> {
  // Store the message context in the button's value for retry
  const retryData = JSON.stringify({
    text: event.text,
    channel: event.channel,
    user: event.user,
    thread_ts: threadTs,
    team: teamId,
  });

  await slack.chat.postMessage({
    channel: event.channel,
    thread_ts: threadTs,
    text: message,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: message,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Try Again",
              emoji: true,
            },
            value: retryData,
            action_id: "retry_task_creation",
            style: "primary",
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Go to Settings",
              emoji: true,
            },
            url: `${publicAppUrl()}/settings/integrations`,
            action_id: "go_to_settings",
          },
        ],
      },
    ],
  });
}

export async function handleAppMentionEvent(
  event: SlackAppMentionEvent,
): Promise<void> {
  console.log("[slack webhook] Received app mention", event);
  // Skip processing if this is an edited message
  if (event.edited) {
    console.log("[slack webhook] Skipping edited message");
    return;
  }
  try {
    // Get the Slack connection for this team
    const teamId = event.team;
    if (!teamId) {
      console.error("[slack webhook] No team ID in app mention event");
      return;
    }

    const slackUserId = event.user;
    const [slackInstallation, slackAccount] = await Promise.all([
      getSlackInstallationForTeam({
        db,
        teamId,
      }),
      getSlackAccountForSlackUserId({
        db,
        teamId,
        slackUserId,
      }),
    ]);
    if (!slackInstallation) {
      console.error(
        `[slack webhook] No Slack installation found for team ${teamId}`,
      );
      return;
    }
    // Initialize Slack Web Client
    const slack = new WebClient(
      decryptValue(
        slackInstallation.botAccessTokenEncrypted,
        env.ENCRYPTION_MASTER_KEY,
      ),
    );
    // Always respond in thread (use thread_ts if it exists, otherwise use the message ts)
    const threadTs = event.thread_ts || event.ts;
    if (!slackAccount) {
      console.error(
        `[slack webhook] No Slack account found for user ${slackUserId} in team ${teamId}`,
      );
      await sendSetupMessage({
        slack,
        event,
        threadTs,
        teamId,
        message: `Hi <@${event.user}>! It looks like we're not connected yet. Please connect your Slack account in the <${publicAppUrl()}/settings|settings page>, then click "Try Again" below.`,
      });
      return;
    }
    const slackSettings = await getSlackSettingsForTeam({
      db,
      userId: slackAccount.userId,
      teamId,
    });
    if (!slackSettings) {
      console.error(
        `[slack webhook] No Slack settings found for user ${slackAccount.userId} in team ${teamId}`,
      );
      await sendSetupMessage({
        slack,
        event,
        threadTs,
        teamId,
        message: `Hi <@${event.user}>! It looks like we're not set up yet. Please set up your Slack account in the <${publicAppUrl()}/settings/integrations|settings page>, then click "Try Again" below.`,
      });
      return;
    }
    if (!slackSettings.defaultRepoFullName) {
      console.error(
        `[slack webhook] No default repository found for user ${slackAccount.userId} in team ${teamId}`,
      );
      await sendSetupMessage({
        slack,
        event,
        threadTs,
        teamId,
        message: `Hi <@${event.user}>! It looks like we're not set up yet. Please select a default repository in the <${publicAppUrl()}/settings/integrations|settings page>, then click "Try Again" below.`,
      });
      return;
    }

    const [defaultModel, formattedMessage] = await Promise.all([
      (async () => {
        if (slackSettings.defaultModel) {
          return slackSettings.defaultModel;
        }
        const [userFlags, userCredentials] = await Promise.all([
          getUserFlags({ db, userId: slackAccount.userId }),
          getUserCredentials({ userId: slackAccount.userId }),
        ]);
        return getDefaultModel({ userFlags, userCredentials });
      })(),
      buildSlackMentionMessage({
        slackAccount,
        slack,
        event,
      }),
    ]);
    console.log(
      "[slack webhook] Creating thread for user",
      slackAccount.userId,
    );

    const { threadId } = await newThreadInternal({
      userId: slackAccount.userId,
      // Derivation: a Slack workspace maps to one org via the installation
      // (WI-5 batch 1). Unambiguous (teamId → one installation). Nullable-safe.
      organizationId: slackInstallation.organizationId,
      message: {
        type: "user",
        model: defaultModel,
        parts: [
          {
            type: "text",
            text: formattedMessage,
          },
        ],
        timestamp: new Date().toISOString(),
      },
      parentThreadId: undefined,
      parentToolId: undefined,
      githubRepoFullName: slackSettings.defaultRepoFullName,
      baseBranchName: null,
      headBranchName: null,
      sourceType: "slack-mention",
      sourceMetadata: {
        type: "slack-mention",
        workspaceDomain: slackAccount.slackTeamDomain,
        channel: event.channel,
        messageTs: event.ts,
        threadTs,
      },
    });
    // Send an acknowledgment
    await slack.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: `✅ Task created in ${slackSettings.defaultRepoFullName}: ${publicAppUrl()}/task/${threadId}`,
    });
    console.log("[slack webhook] Successfully created thread", threadId);
  } catch (error) {
    console.error("[slack webhook] Error handling app mention:", error);
  }
}
