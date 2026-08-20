import type { Octokit } from "octokit";
import { getOctokitForBackground, parseRepoFullName } from "@/lib/github";

/**
 * Repo-file skill override (#54 C5): fetch `.automata/skills/<skillName>.md`
 * from the target repo's DEFAULT BRANCH — the top-precedence tier of
 * resolveReviewSkill, making "edit a skill from the terminal" plain
 * `git commit` on the repo itself.
 *
 * SECURITY INVARIANT (test-pinned): the content request passes NO `ref`, so
 * GitHub serves the repository's default branch by construction. A PR head is
 * attacker-controlled (any fork PR could smuggle a skill body that the review
 * agent would then execute against itself); by never naming a ref there is no
 * code path that could resolve one.
 *
 * Returns the raw file text, or null when the file is absent (the normal case
 * — resolution falls through to the DB tiers) or unreadable (logged; a broken
 * override must degrade to the DB tiers, never block the run).
 */
/**
 * The production glue runAutomation injects as resolveReviewSkill's tier-0
 * thunk: acquire the background octokit, then fetch the override. EVERY
 * failure — octokit acquisition included — degrades to null (DB tiers); an
 * override can never block a run. Lives here, not inline in runAutomation,
 * so the acquisition + degrade behavior is directly unit-testable.
 */
export function buildRepoOverrideFetcher({
  userId,
  repoFullName,
  skillName,
}: {
  userId: string;
  repoFullName: string;
  skillName: string;
}): () => Promise<string | null> {
  return async () => {
    try {
      const octokit = await getOctokitForBackground({ userId, repoFullName });
      return await fetchRepoSkillOverride({ octokit, repoFullName, skillName });
    } catch (err) {
      console.error(
        `buildRepoOverrideFetcher: override fetch for '${skillName}' ` +
          `(${repoFullName}) failed — using DB tiers:`,
        err,
      );
      return null;
    }
  };
}

export async function fetchRepoSkillOverride({
  octokit,
  repoFullName,
  skillName,
}: {
  octokit: Octokit;
  repoFullName: string;
  skillName: string;
}): Promise<string | null> {
  const [owner, repo] = parseRepoFullName(repoFullName);
  const path = `.automata/skills/${skillName}.md`;
  try {
    // NO `ref` — default branch only. See the invariant above.
    const res = await octokit.rest.repos.getContent({ owner, repo, path });
    const data = res.data;
    if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
      console.error(
        `fetchRepoSkillOverride: ${repoFullName}/${path} is not a file — ignoring override.`,
      );
      return null;
    }
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) return null;
    console.error(
      `fetchRepoSkillOverride: reading ${repoFullName}/${path} failed ` +
        `(status ${status ?? "unknown"}) — falling through to DB tiers:`,
      err,
    );
    return null;
  }
}
