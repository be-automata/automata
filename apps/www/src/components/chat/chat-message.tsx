"use client";

import React, { memo, useState } from "react";
import {
  UIAgentMessage,
  UIMessage,
  UISystemMessage,
  UIUserMessage,
  UIGitDiffPart,
} from "@terragon/shared";
import { AIAgent } from "@terragon/agent/types";
import { MessagePart } from "./message-part";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight } from "lucide-react";
import { MessageToolbar } from "./chat-message-toolbar";
import { ImageLightbox } from "@/components/shared/image-lightbox";
import { GitDiffPart } from "./git-diff-part";

type UIUserOrAgentPart =
  | UIAgentMessage["parts"][number]
  | UIUserMessage["parts"][number];

type PartGroup = {
  type: UIUserOrAgentPart["type"] | "collapsible-agent-activity";
  parts: UIUserOrAgentPart[];
};

// Never collapse these tool names
const nonCollapsibleToolNames = new Set<string>([
  "SuggestFollowupTask",
  "mcp__terry__SuggestFollowupTask",
  "ExitPlanMode",
]);

function getPartGroupType({
  part,
  partIdx,
  numParts,
  lastTextPartIdx,
}: {
  part: UIUserOrAgentPart;
  partIdx: number;
  numParts: number;
  lastTextPartIdx: number;
}): PartGroup["type"] {
  const isLastPart = partIdx === numParts - 1;
  if (isLastPart) {
    return part.type;
  }
  const isLastTextPartOrAfter =
    lastTextPartIdx !== -1 && lastTextPartIdx <= partIdx;
  if (isLastTextPartOrAfter) {
    return part.type;
  }
  switch (part.type) {
    case "tool": {
      if (nonCollapsibleToolNames.has(part.name)) {
        return part.type;
      }
      return "collapsible-agent-activity";
    }
    case "text":
    case "thinking": {
      return "collapsible-agent-activity";
    }
    default: {
      return part.type;
    }
  }
}

// Group image parts together and identify collapsible tool sequences
function groupParts({
  parts,
  isLatestMessage,
  isAgentWorking,
}: {
  parts: UIUserOrAgentPart[];
  isLatestMessage: boolean;
  isAgentWorking: boolean;
}): PartGroup[] {
  const groups: PartGroup[] = [];
  let currentGroup: PartGroup | null = null;

  // Find the index of the last text part in the message
  let lastTextPartIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]?.type === "text") {
      lastTextPartIdx = i;
      break;
    }
  }

  const numParts = parts.length;
  for (let i = 0; i < numParts; i++) {
    const part = parts[i];
    if (!part) {
      continue;
    }
    const partGroupType = getPartGroupType({
      part,
      partIdx: i,
      numParts,
      lastTextPartIdx,
    });
    if (currentGroup === null) {
      currentGroup = { type: partGroupType, parts: [part] };
      continue;
    }
    if (partGroupType === currentGroup.type) {
      currentGroup.parts.push(part);
      continue;
    }
    if (partGroupType !== currentGroup.type) {
      groups.push(currentGroup);
      currentGroup = { type: partGroupType, parts: [part] };
      continue;
    }
  }
  // Handle the last group
  if (currentGroup) {
    groups.push(currentGroup);
  }
  return groups;
}

function ImageGroup({
  group,
  isLatestMessage = false,
}: {
  group: PartGroup;
  isLatestMessage?: boolean;
}) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const imageUrls = group.parts
    .filter(
      (part): part is { type: "image"; image_url: string } =>
        part.type === "image",
    )
    .map((part) => part.image_url);

  const numParts = group.parts.length;
  return (
    <>
      <div className="flex gap-2 flex-wrap">
        {group.parts.map((part, partIndex) => {
          return (
            <MessagePart
              key={partIndex}
              part={part}
              onClick={() => setExpandedIndex(partIndex)}
              isLatest={isLatestMessage && partIndex === numParts - 1}
            />
          );
        })}
      </div>
      {expandedIndex !== null && imageUrls[expandedIndex] && (
        <ImageLightbox
          imageUrl={imageUrls[expandedIndex]}
          isOpen={true}
          onClose={() => setExpandedIndex(null)}
          images={imageUrls}
          currentIndex={expandedIndex}
          onIndexChange={setExpandedIndex}
        />
      )}
    </>
  );
}

export const ChatMessage = memo(function ChatMessage({
  message,
  className,
  isLatestMessage = false,
  isAgentWorking = false,
}: {
  message: UIMessage;
  className?: string;
  isLatestMessage?: boolean;
  isAgentWorking?: boolean;
}) {
  if (message.role === "system") {
    return <SystemMessage message={message} />;
  }
  const groups = groupParts({
    parts: message.parts,
    isLatestMessage,
    isAgentWorking,
  });
  const lastGroupIndex = groups.length - 1;
  return (
    <div
      style={{ overflowAnchor: "none" }}
      className={cn(
        "p-2 rounded-md w-full break-words",
        {
          "bg-primary/10 ml-auto max-w-[80%] w-fit": message.role === "user",
          "mr-auto": message.role === "agent",
        },
        className,
      )}
    >
      <div className="flex flex-col gap-2">
        {groups.map((group, groupIndex) => {
          if (group.type === "collapsible-agent-activity") {
            return (
              <CollapsibleAgentActivityGroup
                key={groupIndex}
                agent={"agent" in message ? message.agent : null}
                group={group}
                isLatestMessage={isLatestMessage}
                isAgentWorking={isAgentWorking}
              />
            );
          }
          if (group.type === "image") {
            return (
              <ImageGroup
                key={groupIndex}
                group={group}
                isLatestMessage={isLatestMessage}
              />
            );
          }
          return (
            <React.Fragment key={groupIndex}>
              {group.parts.map((part, partIndex) => {
                return (
                  <MessagePart
                    key={`${groupIndex}-${partIndex}`}
                    part={part}
                    isLatest={isLatestMessage && groupIndex === lastGroupIndex}
                  />
                );
              })}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
});

export const ChatMessageWithToolbar = memo(function ChatMessageWithToolbar({
  message,
  messageIndex,
  className,
  isLatestMessage = false,
  isFirstUserMessage = false,
  isAgentWorking = false,
  isLatestAgentMessage = false,
}: {
  message: UIMessage;
  messageIndex: number;
  className?: string;
  isFirstUserMessage: boolean;
  isLatestMessage: boolean;
  isAgentWorking: boolean;
  isLatestAgentMessage: boolean;
}) {
  return (
    <div
      className="flex flex-col gap-1 group [scroll-margin-top:6rem]"
      data-message-index={messageIndex}
    >
      <ChatMessage
        message={message}
        className={className}
        isLatestMessage={isLatestMessage}
        isAgentWorking={isAgentWorking}
      />
      <MessageToolbar
        message={message}
        messageIndex={messageIndex}
        isFirstUserMessage={isFirstUserMessage}
        isLatestAgentMessage={isLatestAgentMessage}
        isAgentWorking={isAgentWorking}
      />
    </div>
  );
});

function SystemMessage({ message }: { message: UISystemMessage }) {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const getLabel = () => {
    switch (message.message_type) {
      case "retry-git-commit-and-push":
        return "Git commit and push failed. Retrying...";
      case "generic-retry":
        return "Retrying...";
      case "invalid-token-retry":
        return "Authentication token might have expired. Retrying...";
      case "clear-context":
        return "Conversation context cleared.";
      case "compact-result":
        return "Conversation context compacted.";
      case "cancel-schedule":
        return "Scheduled task cancelled.";
      case "fix-github-checks":
        return "Fixing GitHub Checks...";
      case "stop":
      case "git-diff":
      case "credential-source":
        return "";
      default:
        const _exhaustiveCheck: never = message;
        return _exhaustiveCheck;
    }
  };

  const getDotClassName = () => {
    switch (message.message_type) {
      case "retry-git-commit-and-push":
      case "fix-github-checks":
      case "generic-retry":
      case "invalid-token-retry":
        return "bg-red-500";
      case "clear-context":
      case "compact-result":
        return "bg-green-500";
      case "cancel-schedule":
        return "bg-muted-foreground";
      case "stop":
      case "git-diff":
      case "credential-source":
        return "";
      default:
        const _exhaustiveCheck: never = message;
        return _exhaustiveCheck;
    }
  };

  const showMoreButton = message.parts.length > 0;

  if (message.message_type === "stop") {
    return <div className="p-2">Execution interrupted by user.</div>;
  }
  if (message.message_type === "credential-source") {
    // No label ⇒ render NOTHING. toUIMessages already drops a source this
    // build does not know; this is the same rule one layer down, so a bare
    // "Credential:" can never appear.
    const label = message.parts[0]?.text;
    if (!label) return null;
    return (
      <div className="p-2 text-muted-foreground text-sm">
        Credential: {label}
      </div>
    );
  }
  if (message.message_type === "git-diff") {
    return (
      <div className="p-2">
        <GitDiffPart gitDiffPart={message.parts[0] as UIGitDiffPart} />
      </div>
    );
  }
  return (
    <div className="p-2 rounded-md mr-auto w-fit flex flex-col gap-2">
      <div className="flex flex-col gap-2">
        <div
          className="grid grid-cols-[auto_1fr] gap-2 text-muted-foreground"
          onClick={() => setIsCollapsed(!isCollapsed)}
        >
          <span className="h-6 flex items-center">
            <span
              className={cn(
                "shrink-0 size-2 rounded-full inline-block",
                getDotClassName(),
              )}
              aria-hidden="true"
            />
          </span>
          <span>
            <span>{getLabel()}</span>
            {showMoreButton && (
              <>
                &nbsp;
                <span
                  className="inline-block text-muted-foreground/70 select-none"
                  onClick={() => setIsCollapsed(!isCollapsed)}
                >
                  ({isCollapsed ? "Show more" : "Show less"})
                </span>
              </>
            )}
          </span>
        </div>
        {!isCollapsed && showMoreButton && (
          <div className="max-h-[150px] overflow-auto border border-border rounded-md p-1 mr-2">
            <pre className="whitespace-pre-wrap text-xs font-mono">
              {message.parts.map((part, partIndex) => {
                return part.text;
              })}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function CollapsibleAgentActivityGroupLabel({
  isLatestMessage,
  isAgentWorking,
}: {
  isLatestMessage: boolean;
  isAgentWorking: boolean;
}) {
  if (isLatestMessage && isAgentWorking) {
    return <span className="truncate animate-shine">Working...</span>;
  }
  return <span className="truncate">Finished working</span>;
}

function CollapsibleAgentActivityGroup({
  group,
  agent,
  isLatestMessage = false,
  isAgentWorking = false,
}: {
  group: PartGroup;
  agent: AIAgent | null;
  isLatestMessage: boolean;
  isAgentWorking: boolean;
}) {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const numParts = group.parts.length;
  return (
    <div className="flex flex-col gap-0.5 group/item">
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="flex items-center gap-1 py-1 text-sm text-muted-foreground opacity-75 group-hover/item:opacity-100 transition-opacity"
      >
        <CollapsibleAgentActivityGroupLabel
          isLatestMessage={isLatestMessage}
          isAgentWorking={isAgentWorking}
        />
        {isCollapsed ? (
          <ChevronRight className="h-4 w-4 shrink-0 opacity-75 group-hover/item:opacity-100 transition-opacity sm:opacity-0" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 opacity-75 group-hover/item:opacity-100 transition-opacity" />
        )}
      </button>
      {!isCollapsed && (
        <div className="flex flex-col gap-2 p-2 max-h-[50dvh] overflow-y-auto border rounded-md">
          {group.parts.map((part, partIndex) => {
            return (
              <MessagePart
                key={partIndex}
                part={part}
                isLatest={isLatestMessage && partIndex === numParts - 1}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
