import type { MentionLaneStamp } from "@terragon/shared";
import type { ThreadSourceMetadata } from "@terragon/shared/db/types";

/** A mention-lane stamp for tests; override any field of the defaults. */
export function mentionStamp({
  isPullRequest,
  ...overrides
}: { isPullRequest: boolean } & Partial<MentionLaneStamp>): MentionLaneStamp {
  return {
    repoFullName: "acme/widgets",
    issueOrPrNumber: 7,
    isPullRequest,
    commentId: 1,
    commentKind: "issue",
    commenterLogin: "octocat",
    ...overrides,
  };
}

/** The thread's `sourceMetadata` the mention lane writes around a stamp. */
export function mentionSourceMetadata(
  stamp: MentionLaneStamp,
): ThreadSourceMetadata {
  return {
    type: "automation-skill",
    skillName: "github-mention",
    contentSha: "sha",
    source: "org",
    mention: stamp,
  };
}
