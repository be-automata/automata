import { AIModel } from "@terragon/agent/types";
import {
  DBMessage,
  DBUserMessage,
  DBRichTextPart,
  DBSystemMessage,
} from "@terragon/shared";

import { nanoid } from "nanoid/non-secure";

export function getPendingToolCallErrorMessages({
  messages,
  interruptionReason,
}: {
  messages: DBMessage[];
  interruptionReason: "user" | "error";
}): DBMessage[] {
  const pendingToolCalls = new Map<string, { parentId: string | null }>();

  // First pass: collect all pending tool calls with their parent IDs
  for (const message of messages) {
    if (message.type === "tool-call") {
      pendingToolCalls.set(message.id, {
        parentId: message.parent_tool_use_id,
      });
    } else if (message.type === "tool-result") {
      pendingToolCalls.delete(message.id);
    }
  }

  // Second pass: add error results for pending tool calls
  const messagesToAppend: DBMessage[] = [];
  const interruptionMessage =
    interruptionReason === "error"
      ? "Tool execution interrupted by error"
      : "Tool execution interrupted by user";

  for (const [toolId, { parentId }] of pendingToolCalls) {
    messagesToAppend.push({
      type: "tool-result",
      id: toolId,
      is_error: true,
      parent_tool_use_id: parentId,
      result: interruptionMessage,
    });
  }

  return messagesToAppend;
}

/**
 * Concatenates all consecutive user messages that have not received a response yet.
 * This handles scenarios where:
 * - A user sends a message, hits the stop button, then sends another message
 * - A user sends a message, encounters an error, then sends another message
 *
 * The function traverses the message history backwards until it finds a non-user message
 * (excluding stop, error, meta, and git-diff messages), then combines all those user
 * messages into a single message to send to the agent.
 *
 * We want to concatenate all the user messages that have not received a response yet,
 * and send them to the agent.
 */
export function getUserMessageToSend({
  messages,
  currentMessage,
}: {
  messages: DBMessage[] | null;
  currentMessage: DBUserMessage | null;
}): DBUserMessage | null {
  if (messages) {
    const userMessagesToSend: (DBUserMessage | DBSystemMessage)[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (!message) {
        continue;
      }
      if (message.type === "user") {
        userMessagesToSend.push(message);
        continue;
      }
      if (message.type === "system") {
        if (message.message_type === "compact-result") {
          userMessagesToSend.push(message);
          break;
        }
        if (message.message_type === "clear-context") {
          break;
        }
        if (message.message_type === "cancel-schedule") {
          continue;
        }
        userMessagesToSend.push(message);
        continue;
      }
      if (message.type === "meta" && message.subtype === "result-success") {
        break;
      }
      if (
        message.type === "thread-context" ||
        message.type === "thread-context-result" ||
        message.type === "stop" ||
        message.type === "error" ||
        message.type === "meta" ||
        message.type === "git-diff" ||
        // #209 item 1: the credential attribution is an operator artifact
        // appended AFTER the prompt was built, so it sits between the user's
        // message and any agent output. It is not a response — breaking here
        // would make a retried run see "nothing to run" and silently drop the
        // user's prompt.
        message.type === "credential-source"
      ) {
        continue;
      }
      break;
    }
    // The messages are in reverse order, so we need to reverse them.
    userMessagesToSend.reverse();
    if (userMessagesToSend.length > 0) {
      // If we have multiple messages, add separators between them for clarity
      const allParts: DBUserMessage["parts"] = [];
      let lastMessageType: string | null = null;
      let lastPermissionMode: "allowAll" | "plan" | null = null;
      for (let i = 0; i < userMessagesToSend.length; i++) {
        let msg = userMessagesToSend[i];
        if (!msg) continue;

        // Add separator between consecutive user messages
        if (i > 0 && msg.type === "user" && lastMessageType === "user") {
          allParts.push({ type: "text" as const, text: "\n\n---\n\n" });
        }

        if (msg.type === "system" && msg.message_type === "compact-result") {
          msg = {
            ...msg,
            parts: msg.parts.map((part) => ({
              ...part,
              text: `\nThe user has run out of context. This is a summary of what has been done: <summary>\n${part.text}\n</summary>\n\n`,
            })),
          };
        }

        allParts.push(...msg.parts);
        lastMessageType = msg.type;
        if ("permissionMode" in msg && msg.permissionMode) {
          lastPermissionMode = msg.permissionMode;
        }
      }

      return {
        type: "user",
        model: getLastUserMessageModel(messages),
        timestamp: userMessagesToSend[userMessagesToSend.length - 1]!.timestamp,
        permissionMode: lastPermissionMode || "allowAll",
        parts: allParts,
      };
    }
  }
  if (!currentMessage) {
    return null;
  }
  return currentMessage;
}

export function getLastUserMessageModel(messages: DBMessage[]): AIModel | null {
  if (!messages) {
    return null;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) {
      continue;
    }
    if (message.type === "user" && message.model) {
      return message.model;
    }
    if (
      message.type === "system" &&
      message.message_type === "generic-retry" &&
      message.model
    ) {
      return message.model;
    }
  }
  return null;
}

/**
 * Converts rich text to plain text by concatenating all text nodes.
 * Mentions are serialized with @ prefix to indicate file/folder references.
 */
export function richTextToPlainText(richText: DBRichTextPart): string {
  if (!richText.nodes || richText.nodes.length === 0) {
    return "";
  }
  return richText.nodes
    .map((node) => {
      if (node.type === "mention") {
        // Serialize mentions with @ prefix to indicate file/folder reference
        return `@${node.text}`;
      }
      return node.text;
    })
    .join("");
}

/**
 * Options for converting a message to a prompt.
 */
export interface ConvertToPromptOptions {
  /** Function to write file buffers. Returns the file path where the file was written. */
  writeFileBuffer: (imageData: {
    fileName: string;
    content: Buffer;
  }) => Promise<string>;
  /** Function to fetch image data from a URL */
  fetchFileBuffer?: (url: string) => Promise<Buffer>;
}

async function fetchImageUrl(url: string): Promise<Buffer> {
  const res = await fetch(url);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Converts a user message to a prompt string, handling text, rich-text, and images.
 * Images are downloaded and written to files, with their paths included in the prompt.
 */
export async function convertToPrompt(
  message: DBUserMessage,
  options: ConvertToPromptOptions,
): Promise<string> {
  const { writeFileBuffer, fetchFileBuffer = fetchImageUrl } = options;
  const imageUrlToFilePath: Record<string, string> = {};
  const pdfUrlToFilePath: Record<string, string> = {};
  const fileUrlToFilePath: Record<string, string> = {};

  // Process images, PDFs, and documents first
  await Promise.all(
    message.parts.map(async (part) => {
      if (part.type === "image") {
        const fileName = `/tmp/images/image-${nanoid()}.png`;
        const content = await fetchFileBuffer(part.image_url);
        const filePath = await writeFileBuffer({ fileName, content });
        imageUrlToFilePath[part.image_url] = filePath;
      } else if (part.type === "pdf") {
        const fileName = `/tmp/pdfs/${part.filename || `pdf-${nanoid()}.pdf`}`;
        const content = await fetchFileBuffer(part.pdf_url);
        const filePath = await writeFileBuffer({ fileName, content });
        pdfUrlToFilePath[part.pdf_url] = filePath;
      } else if (part.type === "text-file") {
        const fileName = `/tmp/text-files/${part.filename || `file-${nanoid()}.txt`}`;
        const content = await fetchFileBuffer(part.file_url);
        const filePath = await writeFileBuffer({ fileName, content });
        fileUrlToFilePath[part.file_url] = filePath;
      }
    }),
  );
  return convertToPlainText({
    message,
    imageUrlToFilePath,
    pdfUrlToFilePath,
    fileUrlToFilePath,
  });
}

export function convertToPlainText({
  message,
  imageUrlToFilePath = {},
  pdfUrlToFilePath = {},
  fileUrlToFilePath = {},
  skipAttachments = false,
}: {
  message: DBUserMessage;
  imageUrlToFilePath?: Record<string, string>;
  pdfUrlToFilePath?: Record<string, string>;
  fileUrlToFilePath?: Record<string, string>;
  skipAttachments?: boolean;
}): string {
  const promptParts: string[] = [];
  // Build prompt parts
  for (const part of message.parts) {
    if (part.type === "text") {
      promptParts.push(part.text);
    } else if (part.type === "rich-text") {
      promptParts.push(richTextToPlainText(part));
    } else if (!skipAttachments) {
      if (part.type === "image") {
        promptParts.push(imageUrlToFilePath[part.image_url] ?? "<image>");
      } else if (part.type === "pdf") {
        const filePath = pdfUrlToFilePath[part.pdf_url];
        const fileName = part.filename || "document.pdf";
        promptParts.push(
          filePath
            ? `PDF file at ${filePath} (${fileName})`
            : `<PDF: ${fileName}>`,
        );
      } else if (part.type === "text-file") {
        const filePath = fileUrlToFilePath[part.file_url];
        const fileName = part.filename || "file.txt";
        promptParts.push(
          filePath
            ? `Attached file at ${filePath} (${fileName})`
            : `<Attached file: ${fileName}>`,
        );
      }
    }
  }

  const promptPartsWithSpacing: string[] = [];
  for (let i = 0; i < promptParts.length; i++) {
    const currentPart = promptParts[i]!;
    const previousPart = promptParts[i - 1];
    const shouldNotAddSpace =
      i === 0 || /\s$/.test(previousPart!) || /^\s/.test(currentPart);
    if (!shouldNotAddSpace) {
      promptPartsWithSpacing.push(" ");
    }
    promptPartsWithSpacing.push(currentPart);
  }
  return promptPartsWithSpacing.join("").trim();
}

export function estimateMessageSize(message: DBUserMessage): number {
  let size = 0;
  for (const part of message.parts) {
    if (part.type === "text") {
      size += part.text.length;
    }
  }
  return size;
}

export function imageCount(message: DBUserMessage): number {
  return message.parts.filter((part) => part.type === "image").length;
}

export function pdfCount(message: DBUserMessage): number {
  return message.parts.filter((part) => part.type === "pdf").length;
}
