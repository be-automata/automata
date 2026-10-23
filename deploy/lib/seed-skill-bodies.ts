/**
 * The skill-version bodies `deploy/seed-pilot-mirror.ts` seeds (#54 C3),
 * built from the tracked review methodology. A pure function, so the seed's
 * text is unit-tested without a database (seed-skill-bodies.test.ts in www).
 *
 * The automations REFERENCE these bodies instead of inlining them:
 * runAutomation resolves the current version at thread creation and renders
 * `{{repoFullName}}`/`{{baseBranch}}`, so the bodies carry placeholders, never
 * a concrete repo or branch. That is what lets one skill row serve every repo
 * the org onboards, and what keeps a stacked PR (whose base is another PR's
 * branch) from being diffed against `origin/main`.
 *
 * github-ops = a short PR-review preamble with the tracked methodology
 * appended. The preamble says only what the methodology does not: which repo,
 * which diff base, no gh. HOW the verdict is delivered (the block's shape, its
 * fence tag in orchestrated mode, emitting it once) is left to the
 * methodology's own delivery section, which carries a classic and an
 * orchestrated variant. Restating it here would contradict one of them.
 */
export function buildSeedSkillBodies(
  reviewSkillBody: string,
): Record<string, string> {
  return {
    "github-ops":
      `A pull request was opened or updated in {{repoFullName}}. Perform a substantive PR review.\n\n` +
      `You are running as a REVIEW agent: you have NO gh and NO GitHub token, so you cannot post to GitHub. You deliver your verdict by emitting it in your final message, in the one fenced block the methodology's "How you deliver your verdict" section describes. The control plane posts your review exactly once from that block.\n\n` +
      `Compute the PR delta with \`git diff origin/{{baseBranch}}...HEAD\` (the base branch is \`{{baseBranch}}\`; its ref is pre-fetched + deepened to the merge-base so this resolves OFFLINE) and Read/Grep/Glob to inspect files at HEAD. Do NOT use \`git diff HEAD~1...HEAD\` (the clone is shallow) and do NOT run gh.\n\n` +
      `Follow the review methodology below in full (verify-before-block quote rules, severity→verdict mapping, the review dimensions, the delivery section).\n\n` +
      `----- BEGIN REVIEW METHODOLOGY -----\n${reviewSkillBody}\n----- END REVIEW METHODOLOGY -----`,
    "github-deep-research":
      "An issue was opened in {{repoFullName}}. Research it (prod skill: github-deep-research).",
    // The mention lane's validator requires the emit-only reply contract; the
    // full skill is deploy/skills/github-mention/SKILL.md (push it with
    // skill-push.ts for a repo onboarded onto the org mention lane).
    "github-mention":
      "Respond to the GitHub mention. Your final message ends with exactly one block:\n" +
      '```json mention-reply\n{ "kind": "mention-reply", "reply": "<your reply>" }\n```',
  };
}
