import { env } from "@terragon/env/apps-www";
import { wrapUntrusted, clip } from "@terragon/review/context/untrusted";
import type { MentionLaneStamp } from "@terragon/shared";
import type { Automation, DBUserMessage } from "@terragon/shared";
import type { GitHubMentionTriggerConfig } from "@terragon/shared/automations";
import { getGitHubMentionAutomationsForRepo } from "@terragon/shared/model/automations";
import { getInstallationOrgAndMode } from "@terragon/shared/model/github-installation";
import { getRepoInstallationId } from "@terragon/shared/github-app";
import { db } from "@/lib/db";
import { getOctokitForApp, parseRepoFullName } from "@/lib/github";
import { effectiveShadow } from "@/lib/github-side-effects";
import { isCrossRepoPull, runAutomation } from "@/server-lib/automations";
import { resolveBotLogin } from "@/server-lib/review/bot-login";
import { renderPrDiffContext } from "@/server-lib/review/pr-diff-context";
import { replyToMention } from "@/server-lib/review/mention-target-reply";
import { addEyesReactionToComment } from "./utils";
import { requireAppAccess } from "./webhook-skip";

/**
 * The org-owned, emit-only GitHub @-mention lane (legacy-orchestrator parity).
 *
 * A repo opts in with ONE enabled `github_mention` automation whose filter
 * sets `orgLane: true` and whose action is a `skill_message`. For such a repo
 * this module owns every mention and the per-user legacy path is skipped:
 *   - the mention must be a whole `@<app slug>` token, and what remains after
 *     stripping it is the instruction (empty → one short reply, no thread);
 *   - bots and the App itself never trigger it;
 *   - the commenter must be OWNER/MEMBER/COLLABORATOR on the comment AND hold
 *     write, maintain or admin on the repo per the App-token permission API —
 *     fail-closed: any error is a denial. They need no platform account: the
 *     thread runs as the automation's owner, attributed by the stamp;
 *   - one claim per comment: a redelivery answers nothing twice;
 *   - a PR whose head lives in another repository (a fork) gets one short
 *     reply and no thread: the run clones this repo at the head ref;
 *   - the thread is created through runAutomation (skill resolution, model
 *     pin, `automata:context` prefetch) with a `## Mention` block appended as
 *     untrusted content, and stamped so the finish writer replies as the App;
 *     when no thread starts, one short notice replies instead of silence.
 */

/** Author associations the comment payload must carry (the cheap pre-filter). */
export const TRUSTED_COMMENT_ASSOCIATIONS: ReadonlySet<string> = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

/** Repo permissions (GET …/collaborators/{login}/permission) that may invoke. */
const WRITE_CAPABLE_PERMISSIONS: ReadonlySet<string> = new Set([
  "admin",
  "maintain",
  "write",
]);

/** The diff hunk kept on the stamp and in the prompt (characters). */
const DIFF_HUNK_LIMIT = 4000;
/** The instruction kept in the prompt (characters). */
const INSTRUCTION_LIMIT = 8000;
/** A redelivered comment within this window starts no second thread. */
const INTAKE_CLAIM_TTL_SECONDS = 24 * 60 * 60;

/** The reply to a mention on a pull request whose head lives in a fork. */
export const CROSS_REPO_MENTION_REPLY =
  "This pull request's branch lives in another repository (a fork), so I " +
  "can't work on it from here.";

/** The reply when the mention was accepted but no run could be started. */
export const MENTION_NOT_STARTED_REPLY =
  "I couldn't start on this request. Mention me again to retry.";

/** The one reply an authorised mention with no instruction gets. */
export function emptyMentionReply(slug: string): string {
  return (
    `I need an instruction after the mention, for example ` +
    `\`@${slug} why does this test fail?\`, \`@${slug} fix the typo on line 42\` ` +
    `or \`@${slug} please re-review\`.`
  );
}

/**
 * The handle people type: the App name without the `[bot]` suffix GitHub
 * puts on App logins (`[` is not a username character). Null when unset.
 */
export function mentionSlug(
  appName: string = env.NEXT_PUBLIC_GITHUB_APP_NAME,
): string | null {
  const slug = (appName ?? "").trim().replace(/\[bot\]$/i, "");
  return slug.length > 0 ? slug : null;
}

export type MentionAnalysis =
  | { mentioned: false }
  | { mentioned: true; instruction: string | null };

/**
 * Legacy mention match: a whole-token, case-insensitive `@<slug>` — not part
 * of a longer handle (`@slug-other`, `@slug_x`) nor of a word (`me@slug`).
 * Every occurrence is stripped (the delimiter before it is kept); what
 * remains, trimmed, is the instruction, or null when nothing does.
 */
export function analyseMention(body: string, slug: string): MentionAnalysis {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[^\\w-])@${escaped}(?=$|[^\\w-])`, "gi");
  if (!pattern.test(body)) return { mentioned: false };
  pattern.lastIndex = 0;
  const instruction = body.replace(pattern, "$1").trim();
  return {
    mentioned: true,
    instruction: instruction.length > 0 ? instruction : null,
  };
}

export type CommenterDecision =
  | { allowed: true; permission: string }
  | {
      allowed: false;
      reason:
        | "association_prefilter"
        | "insufficient_permission"
        | "permission_api_error";
      detail?: string;
    };

/**
 * The commenter gate, fail-closed: the payload's author_association must be a
 * trusted one AND the authoritative permission read must say write, maintain
 * or admin. A read that throws or returns nothing usable denies.
 */
export async function authorizeCommenter({
  association,
  readPermission,
}: {
  association: string | null | undefined;
  /** The repo permission of the commenter: `permission` and `role_name`. */
  readPermission: () => Promise<{
    permission?: string | null;
    roleName?: string | null;
  }>;
}): Promise<CommenterDecision> {
  if (!association || !TRUSTED_COMMENT_ASSOCIATIONS.has(association)) {
    return { allowed: false, reason: "association_prefilter" };
  }
  let result: { permission?: string | null; roleName?: string | null };
  try {
    result = await readPermission();
  } catch (error) {
    return {
      allowed: false,
      reason: "permission_api_error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  // `permission` folds maintain into write; `role_name` keeps it. Either one
  // naming a write-capable level is enough.
  for (const value of [result.permission, result.roleName]) {
    const level = (value ?? "").toLowerCase();
    if (WRITE_CAPABLE_PERMISSIONS.has(level)) {
      return { allowed: true, permission: level };
    }
  }
  return {
    allowed: false,
    reason: "insufficient_permission",
    detail: `${result.permission ?? "none"}/${result.roleName ?? "none"}`,
  };
}

/** An automation that turns the repo's mentions over to this lane. */
export function isOrgLaneAutomation(automation: Automation): boolean {
  if (automation.triggerType !== "github_mention") return false;
  if (!automation.enabled) return false;
  if (automation.action?.type !== "skill_message") return false;
  const config = automation.triggerConfig as
    | GitHubMentionTriggerConfig
    | null
    | undefined;
  return config?.filter?.orgLane === true;
}

/** The repo's enabled org-lane mention automations (usually zero or one). */
export async function findOrgLaneAutomations(
  repoFullName: string,
): Promise<Automation[]> {
  const automations = await getGitHubMentionAutomationsForRepo({
    db,
    repoFullName,
  });
  return automations.filter(isOrgLaneAutomation);
}

/**
 * The `## Mention` block appended to the skill prompt. Everything a person
 * typed (and the diff hunk the comment sits on) is untrusted content.
 */
export function renderMentionBlock(
  stamp: MentionLaneStamp,
  instruction: string,
): string {
  const lines = [
    `Commenter: @${stamp.commenterLogin}`,
    `Kind: ${stamp.commentKind === "review_comment" ? "review_comment (inline, on a line of the diff)" : "issue (a PR conversation or issue comment)"}`,
    `On: ${stamp.isPullRequest ? "pull request" : "issue"} #${stamp.issueOrPrNumber} in ${stamp.repoFullName}`,
    `Comment id: ${stamp.commentId}`,
  ];
  if (stamp.commentKind === "review_comment") {
    lines.push(`Anchored to: ${stamp.path ?? "(unknown)"}:${stamp.line ?? ""}`);
  }
  lines.push("", "Instruction:", clip(instruction, INSTRUCTION_LIMIT));
  if (stamp.commentKind === "review_comment" && stamp.diffHunk) {
    lines.push("", "Diff hunk:", "```diff", stamp.diffHunk, "```");
  }
  const source =
    stamp.commentKind === "review_comment"
      ? "github_pull_request_review_comment"
      : "github_issue_comment";
  return `## Mention\n\n${wrapUntrusted(lines.join("\n"), source)}`;
}

export interface OrgMentionInput {
  repoFullName: string;
  /** The payload's installation id; absent on a repo-level webhook. */
  installationId: number | null | undefined;
  isPullRequest: boolean;
  issueOrPrNumber: number;
  commentKind: "issue" | "review_comment";
  comment: {
    id: number;
    body: string;
    authorAssociation: string | null | undefined;
    user: { login: string; type?: string | null };
    path?: string | null;
    line?: number | null;
    diffHunk?: string | null;
    inReplyToId?: number | null;
  };
}

type Log = (message: string, meta?: Record<string, unknown>) => void;
const log: Log = (message, meta) =>
  console.log(`[org-mention] ${message}`, meta ?? {});

function isBotLogin(login: string, type: string | null | undefined): boolean {
  if (type === "Bot") return true;
  if (login.toLowerCase().endsWith("[bot]")) return true;
  return login.toLowerCase() === resolveBotLogin().toLowerCase();
}

/**
 * True when the repo has an enabled org-lane mention automation — the caller
 * must then NOT run the legacy per-user mention path for this delivery.
 */
export async function isOrgLaneRepo(repoFullName: string): Promise<boolean> {
  return (await findOrgLaneAutomations(repoFullName)).length > 0;
}

/**
 * Handle one mention through the org lane. Returns false when the repo has no
 * enabled org-lane automation (the legacy path runs, unchanged); true when the
 * lane owned the delivery — whether it started a thread, replied, or skipped.
 */
export async function handleOrgLaneMention(
  input: OrgMentionInput,
): Promise<boolean> {
  const { repoFullName, comment } = input;
  const automations = await findOrgLaneAutomations(repoFullName);
  if (automations.length === 0) return false;
  const meta = {
    repoFullName,
    number: input.issueOrPrNumber,
    commentId: comment.id,
    kind: input.commentKind,
    commenter: comment.user.login,
  };

  if (isBotLogin(comment.user.login, comment.user.type)) {
    log("skip: bot sender", meta);
    return true;
  }
  const slug = mentionSlug();
  if (!slug) {
    log("skip: NEXT_PUBLIC_GITHUB_APP_NAME is not set", meta);
    return true;
  }
  const mention = analyseMention(comment.body, slug);
  if (!mention.mentioned) {
    log(`skip: no whole-token @${slug} mention (near miss)`, meta);
    return true;
  }

  const [owner, repo] = parseRepoFullName(repoFullName);
  // A repo-level webhook carries no installation: look it up from the App,
  // as mirror-intake does. A lookup failure other than "not installed"
  // propagates so the delivery shows failed and can be redelivered.
  const installationId =
    input.installationId ?? (await getRepoInstallationId(owner, repo));
  if (installationId === null || installationId === undefined) {
    log("skip: the App is not installed on this repo", meta);
    return true;
  }
  const { organizationId, mode } = await getInstallationOrgAndMode({
    db,
    installationId,
  });
  const automation = automations.find(
    (candidate) =>
      organizationId !== null && candidate.organizationId === organizationId,
  );
  if (!automation) {
    log("skip: no org-lane automation belongs to the installation's org", {
      ...meta,
      installationId,
      installationOrg: organizationId,
      automationOrgs: automations.map((a) => a.organizationId),
    });
    return true;
  }
  const shadow = effectiveShadow(mode);

  const octokit = await requireAppAccess(
    () => getOctokitForApp({ owner, repo }),
    meta,
  );
  const decision = await authorizeCommenter({
    association: comment.authorAssociation,
    readPermission: async () => {
      const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
        owner,
        repo,
        username: comment.user.login,
      });
      return {
        permission: data.permission,
        roleName: (data as { role_name?: string | null }).role_name ?? null,
      };
    },
  });
  if (!decision.allowed) {
    log("skip: commenter not authorised", {
      ...meta,
      association: comment.authorAssociation ?? null,
      reason: decision.reason,
      detail: decision.detail,
    });
    return true;
  }

  const stamp = buildMentionStamp(input);
  // One redelivered webhook must not answer twice — the empty-mention reply
  // included — so the claim comes before anything is posted.
  if (!(await claimIntake(input))) {
    log("skip: this comment was already handled (redelivery)", meta);
    return true;
  }
  const reply = async (body: string, what: string) => {
    if (shadow) {
      log(`[shadow] ${what} — reply suppressed`, meta);
      return;
    }
    log(`${what} — replying`, meta);
    try {
      await replyToMention({
        octokit,
        stamp,
        // A review-thread reply already notifies its participants.
        body:
          stamp.commentKind === "issue"
            ? `@${stamp.commenterLogin} ${body}`
            : body,
      });
    } catch (error) {
      console.error("[org-mention] short reply failed", {
        ...meta,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  if (mention.instruction === null) {
    await reply(emptyMentionReply(slug), "empty mention");
    return true;
  }

  // Until a thread exists, a failed read must not strand the claim: release
  // it and let the delivery fail, so a redelivery can retry the mention.
  let branchName: string;
  let prBaseBranchName: string | undefined;
  // PR mentions only: the base/head facts every PR-event prompt carries.
  let prContext: string | undefined;
  try {
    if (input.isPullRequest) {
      const { data: pr } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: input.issueOrPrNumber,
      });
      // The run clones THIS repo at the head ref: a head that lives in a
      // fork would check out (and push to) a same-named branch here instead.
      if (isCrossRepoPull(pr)) {
        await reply(CROSS_REPO_MENTION_REPLY, "cross-repo pull request");
        return true;
      }
      branchName = pr.head.ref;
      prBaseBranchName = pr.base.ref;
      prContext = renderPrDiffContext({
        prNumber: input.issueOrPrNumber,
        baseRef: pr.base.ref,
        baseSha: pr.base.sha,
        headRef: pr.head.ref,
        headSha: pr.head.sha,
      });
    } else {
      const { data } = await octokit.rest.repos.get({ owner, repo });
      branchName = data.default_branch;
    }
  } catch (error) {
    await releaseIntake(input);
    throw error;
  }
  if (!shadow) {
    await addEyesReactionToComment({
      octokit,
      owner,
      repo,
      commentId: comment.id,
      commentType:
        input.commentKind === "review_comment"
          ? "review_comment"
          : "issue_comment",
    });
  }

  const mentionBlock = renderMentionBlock(stamp, mention.instruction);
  let threadId: string | undefined;
  try {
    const result = await runAutomation({
      userId: automation.userId,
      automationId: automation.id,
      source: "automated",
      options: {
        branchName,
        prBaseBranchName,
        ...(input.isPullRequest
          ? { prNumber: input.issueOrPrNumber }
          : { issueNumber: input.issueOrPrNumber }),
        transformMessage: (message) =>
          appendMentionBlock(
            prContext ? prependPrContext(message, prContext) : message,
            mentionBlock,
          ),
        stampExtra: { mention: stamp },
      },
    });
    threadId = result?.threadId;
  } catch (error) {
    console.error("[org-mention] runAutomation failed", {
      ...meta,
      automationId: automation.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (threadId === undefined) {
    // No thread means no finish writer: answer now rather than leave the
    // person on silence. No reply marker, so a thread that did start after
    // all still posts its own answer.
    await reply(MENTION_NOT_STARTED_REPLY, "no thread started");
    return true;
  }
  log("thread created", {
    ...meta,
    automationId: automation.id,
    threadId,
    shadow,
  });
  return true;
}

/** The stamp a mention-lane thread carries: the comment it answers. */
export function buildMentionStamp(input: OrgMentionInput): MentionLaneStamp {
  const { comment } = input;
  return {
    repoFullName: input.repoFullName,
    issueOrPrNumber: input.issueOrPrNumber,
    isPullRequest: input.isPullRequest,
    commentId: comment.id,
    commentKind: input.commentKind,
    commenterLogin: comment.user.login,
    ...(input.commentKind === "review_comment"
      ? {
          path: comment.path ?? undefined,
          line: comment.line ?? null,
          ...(comment.diffHunk
            ? { diffHunk: clip(comment.diffHunk, DIFF_HUNK_LIMIT) }
            : {}),
          ...(comment.inReplyToId ? { inReplyToId: comment.inReplyToId } : {}),
        }
      : {}),
  };
}

/**
 * Lead a PR mention's prompt with the control-plane PR facts (base, head, diff
 * command), the same paragraph a PR-event review carries: the skill body may
 * not name the base, and on a stacked PR the default branch is the wrong one.
 */
export function prependPrContext(
  message: DBUserMessage,
  prContext: string,
): DBUserMessage {
  return {
    ...message,
    parts: [{ type: "text", text: prContext }, ...message.parts],
  };
}

/** Append the mention block to the resolved skill message. */
export function appendMentionBlock(
  message: DBUserMessage,
  mentionBlock: string,
): DBUserMessage {
  return {
    ...message,
    parts: [...message.parts, { type: "text", text: `\n\n${mentionBlock}` }],
  };
}

function intakeClaimKey(input: OrgMentionInput): string {
  return `org-mention:${input.repoFullName.toLowerCase()}:${input.commentKind}:${input.comment.id}`;
}

/**
 * One redelivered webhook must not be handled twice. Fail-open: when the
 * claim store is unreachable a duplicate thread beats a lost mention.
 */
async function claimIntake(input: OrgMentionInput): Promise<boolean> {
  try {
    const { redis } = await import("@/lib/redis");
    const taken = await redis.set(intakeClaimKey(input), "1", {
      nx: true,
      ex: INTAKE_CLAIM_TTL_SECONDS,
    });
    return taken === "OK";
  } catch (error) {
    console.warn("[org-mention] intake claim unavailable — proceeding", {
      repoFullName: input.repoFullName,
      commentId: input.comment.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

/** Best effort: a claim that cannot be released only expires. */
async function releaseIntake(input: OrgMentionInput): Promise<void> {
  try {
    const { redis } = await import("@/lib/redis");
    await redis.del(intakeClaimKey(input));
  } catch (error) {
    console.warn("[org-mention] intake claim release failed", {
      repoFullName: input.repoFullName,
      commentId: input.comment.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
