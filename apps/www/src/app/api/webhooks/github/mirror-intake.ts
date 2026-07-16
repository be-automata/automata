import { db } from "@/lib/db";
import { newThreadInternal } from "@/server-lib/new-thread-internal";
import { getInstallationOrgAndMode } from "@terragon/shared/model/github-installation";
import { getOrganizationOwnerUserId } from "@terragon/shared/model/organizations";
import { DBUserMessage } from "@terragon/shared/db/db-message";
import { effectiveShadow } from "@/lib/github-side-effects";
import { WebhookSkip } from "./webhook-skip";

/**
 * Mirror-intake (Somnio pilot). Prod orch-agents' WORKFLOW.md routes marketplace
 * events to skills UNCONDITIONALLY per repo; the chassis only routes PR/issue
 * events through opt-in user automations and mention events natively. This module
 * closes the gap for the event classes the chassis has no task-creation path for:
 *
 *   - pull_request.review_requested        -> "Review PR #N (review requested)"
 *   - pull_request.closed (merged=true)    -> "Post-merge follow-up for PR #N"
 *   - pull_request_review.changes_requested-> "Address changes requested on PR #N"
 *   - workflow_run (conclusion=failure)    -> "Fix CI: run '<name>' failed"
 *   - issues.labeled [bug|enhancement]     -> "Handle issue #N (labeled <label>)"
 *
 * (opened/synchronize/issues.opened are mirrored via seeded automations, not here,
 * to avoid double-firing — see deploy/SOMNIO-PILOT.md.)
 *
 * Each event produces one task in the bound org, attributed to the org owner (a
 * PR opening has no "commenter"), created SHADOW when the installation is in
 * shadow mode (row created + dashboard-visible, no boot, zero GitHub side
 * effects). Business rejections raise WebhookSkip so the route fast-acks 2xx
 * (WI-8) — GitHub must never retry an unbound/owner-less installation.
 */
export type MirrorIntent =
  | {
      kind: "pr-review-requested";
      prNumber: number;
      headBranch?: string | null;
      baseBranch?: string | null;
    }
  | { kind: "pr-merged"; prNumber: number; baseBranch?: string | null }
  | {
      kind: "pr-changes-requested";
      prNumber: number;
      headBranch?: string | null;
      baseBranch?: string | null;
    }
  | {
      kind: "ci-failure";
      runName: string;
      runId: number;
      headBranch?: string | null;
    }
  | { kind: "issue-labeled"; issueNumber: number; label: string };

function describeIntent(
  intent: MirrorIntent,
  repoFullName: string,
): {
  prompt: string;
  githubPRNumber?: number;
  githubIssueNumber?: number;
  headBranch?: string | null;
  baseBranch?: string | null;
} {
  switch (intent.kind) {
    case "pr-review-requested":
      return {
        prompt: `Review requested on PR #${intent.prNumber} in ${repoFullName}. Perform a PR review (prod skill: github-ops).`,
        githubPRNumber: intent.prNumber,
        headBranch: intent.headBranch,
        baseBranch: intent.baseBranch,
      };
    case "pr-merged":
      return {
        prompt: `PR #${intent.prNumber} in ${repoFullName} was merged. Run the post-merge follow-up (prod skill: github-pr-merged-jira).`,
        githubPRNumber: intent.prNumber,
        baseBranch: intent.baseBranch,
      };
    case "pr-changes-requested":
      return {
        prompt: `Changes were requested on PR #${intent.prNumber} in ${repoFullName}. Address the review and re-request (prod skill: github-ops).`,
        githubPRNumber: intent.prNumber,
        headBranch: intent.headBranch,
        baseBranch: intent.baseBranch,
      };
    case "ci-failure":
      return {
        prompt: `CI failed: workflow run '${intent.runName}' (run ${intent.runId}) in ${repoFullName} concluded in failure. Investigate and fix (prod skill: gh-fix-ci).`,
        headBranch: intent.headBranch,
      };
    case "issue-labeled":
      return {
        prompt: `Issue #${intent.issueNumber} in ${repoFullName} was labeled '${intent.label}'. Handle it (prod skill: github-ops).`,
        githubIssueNumber: intent.issueNumber,
      };
    default: {
      const _exhaustive: never = intent;
      throw new Error(`Unhandled mirror intent: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export async function createMirrorTask({
  repoFullName,
  installationId,
  accountLogin,
  intent,
}: {
  repoFullName: string;
  installationId: number | string | null | undefined;
  accountLogin?: string | null;
  intent: MirrorIntent;
}): Promise<void> {
  const { organizationId, mode } = await getInstallationOrgAndMode({
    db,
    installationId,
  });
  if (!organizationId) {
    // WI-8: unbound installation is a business rejection, not an error. Fast-ack
    // 2xx with a log naming the id + account so an operator can bind it.
    throw new WebhookSkip(
      "unmapped_installation",
      `No org bound to installation for ${repoFullName}`,
      { installationId, accountLogin, repoFullName, intent: intent.kind },
    );
  }
  const ownerUserId = await getOrganizationOwnerUserId({
    db,
    organizationId,
  });
  if (!ownerUserId) {
    throw new WebhookSkip(
      "no_mapped_users",
      `Bound org ${organizationId} has no member to attribute the task to`,
      { installationId, accountLogin, repoFullName, organizationId },
    );
  }

  const { prompt, githubPRNumber, githubIssueNumber, headBranch, baseBranch } =
    describeIntent(intent, repoFullName);

  const message: DBUserMessage = {
    type: "user",
    model: null,
    parts: [{ type: "text", text: prompt }],
    timestamp: new Date().toISOString(),
  };

  // Per-installation mode, folded with the deployment-level side-effects switch.
  const shadow = effectiveShadow(mode);
  console.log("[mirror-intake] creating task", {
    repoFullName,
    organizationId,
    mode,
    intent: intent.kind,
  });

  await newThreadInternal({
    userId: ownerUserId,
    organizationId,
    shadow,
    message,
    githubRepoFullName: repoFullName,
    baseBranchName: baseBranch ?? undefined,
    headBranchName: headBranch ?? undefined,
    githubPRNumber,
    githubIssueNumber,
    sourceType: "automation",
  });
}
