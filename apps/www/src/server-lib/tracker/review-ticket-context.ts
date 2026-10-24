import { db } from "@/lib/db";

import { extractTicketKeys } from "./extract-ticket-keys";
import { createTrackerClient } from "./tracker-client";
import { resolveTrackerConfig } from "./tracker-config";
import { renderTicketSection, roleOf } from "./tracker-context";
import { describeTrackerError, type TrackerClient } from "./tracker-types";

/**
 * The `ticket` review-context block: the tickets a pull request delivers,
 * fetched by the control plane so the review agent can check the ticket's
 * acceptance criteria BEFORE the merge (the post-merge audit, ADR-008, checks
 * them after). Read-only, and the agent still holds no tracker credential:
 * only the rendered ticket text reaches it.
 *
 * The text is rendered inside a context block that render.ts already wraps as
 * untrusted, so the sections carry no `<user_content>` tags of their own. Every
 * case with nothing to check says so, and the review skills key off that
 * sentence to leave their acceptance-criteria group out.
 */

/** The run the review belongs to: whose tracker config to read. */
export interface ReviewTicketScope {
  organizationId: string | null;
  /** The org owner the automation runs as (the merged lane's identity too). */
  ownerUserId: string;
  shadow: boolean;
}

export interface ReviewTicketPullRequest {
  title: string | null | undefined;
  body: string | null | undefined;
  headBranch: string | null | undefined;
}

/**
 * A slow tracker must cost the review its ticket, never the thread: this read
 * runs alongside the GitHub prefetch at thread creation.
 */
const REVIEW_TRACKER_TIMEOUT_MS = 4_000;

const SKIP_SENTENCE = "Leave the ticket acceptance-criteria group out.";

function notice(reason: string): string {
  return `<ticket_context tickets="0">\n${reason} ${SKIP_SENTENCE}\n</ticket_context>`;
}

export async function buildReviewTicketContext({
  scope,
  repoFullName,
  pullRequest,
  resolveConfig = resolveTrackerConfig,
  createClient = createTrackerClient,
}: {
  scope: ReviewTicketScope;
  repoFullName: string;
  pullRequest: ReviewTicketPullRequest;
  /** Injected by tests. */
  resolveConfig?: typeof resolveTrackerConfig;
  /** Injected by tests. */
  createClient?: typeof createTrackerClient;
}): Promise<string> {
  if (scope.shadow) {
    return notice("Omitted: this installation is in shadow mode.");
  }
  const config = await resolveConfig({
    db,
    userId: scope.ownerUserId,
    organizationId: scope.organizationId,
    repoFullName,
  });
  if (!config) {
    return notice("No tracker is configured for this repository.");
  }
  const extraction = extractTicketKeys({
    title: pullRequest.title,
    body: pullRequest.body,
    headBranch: pullRequest.headBranch,
    projects: config.projects,
  });
  if (extraction.auditKeys.length === 0) {
    return notice(
      extraction.referencedKeys.length === 0
        ? "No ticket key was found in the PR title, description or branch name."
        : `The PR mentions ${extraction.referencedKeys.join(", ")} but names none as the ticket it delivers (title, head branch or a closing keyword).`,
    );
  }
  const tracker: TrackerClient = createClient(config, {
    timeoutMs: REVIEW_TRACKER_TIMEOUT_MS,
  });
  // Independent reads: one slow ticket must not stretch the others' timeouts.
  const sections = await Promise.all(
    extraction.auditKeys.map(async (key) => {
      try {
        return renderTicketSection(
          await tracker.getIssue(key),
          roleOf(key, extraction),
          {
            wrap: false,
            cutNote:
              "(The description above was cut. Check what is visible and say in the group that the ticket was truncated.)",
          },
        );
      } catch (error) {
        const detail = describeTrackerError(error);
        console.warn("[review-ticket-context] ticket fetch failed", {
          repoFullName,
          key,
          detail,
        });
        return `### ${key}\n\nTracker unavailable for this ticket (${detail}). Do not check its criteria.`;
      }
    }),
  );
  if (extraction.referencedKeys.length > 0) {
    sections.push(
      `### Referenced only\n\n${extraction.referencedKeys.join(", ")} — mentioned by the PR, not delivered by it. Never check their criteria.`,
    );
  }
  return [
    `<ticket_context tickets="${extraction.auditKeys.length}">`,
    ...sections,
    "</ticket_context>",
  ].join("\n\n");
}
