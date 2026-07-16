import {
  Automation,
  DBUserMessage,
  ThreadSource,
  ThreadSourceMetadata,
} from "@terragon/shared";
import { createNewThread } from "./new-thread-shared";

/**
 * Internal version of newThread that accepts userId as a parameter.
 * This is used by webhooks and other background processes that don't have access to session context.
 */
export async function newThreadInternal({
  userId,
  organizationId,
  shadow,
  message,
  githubRepoFullName,
  baseBranchName,
  headBranchName,
  parentThreadId,
  parentToolId,
  automation,
  githubPRNumber,
  githubIssueNumber,
  sourceType,
  sourceMetadata,
}: {
  userId: string;
  // Tenant to stamp on the created thread (WI-5). Optional — background callers
  // (webhooks/automations) without a resolved org omit it (null = legacy).
  organizationId?: string | null;
  // Shadow mode (Somnio pilot): create the thread row but don't boot the agent.
  shadow?: boolean;
  message: DBUserMessage;
  githubRepoFullName: string;
  baseBranchName?: string | null;
  headBranchName?: string | null;
  parentThreadId?: string;
  parentToolId?: string;
  automation?: Automation;
  githubPRNumber?: number;
  githubIssueNumber?: number;
  sourceType: ThreadSource;
  sourceMetadata?: ThreadSourceMetadata;
}) {
  console.log("newThreadInternal for user", {
    userId,
    sourceType,
    githubRepoFullName,
  });
  // Use the shared function to create the thread
  return await createNewThread({
    userId,
    organizationId,
    shadow,
    message,
    githubRepoFullName,
    baseBranchName,
    headBranchName,
    parentThreadId,
    parentToolId,
    automation,
    generateName: true,
    githubPRNumber,
    githubIssueNumber,
    sourceType,
    sourceMetadata,
  });
}
