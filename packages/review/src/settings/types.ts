/**
 * Settings bounded context — the operator-mutable per-repository review
 * tolerance. On Automata this is persisted in Neon (`repo_review_settings`,
 * see `@terragon/shared`) and edited from the web dashboard; this module keeps
 * only the shared vocabulary. The pure resolution logic lives in
 * `./review-floor-resolver`; the kernel it maps into lives in
 * `../review/severity-policy`.
 */

import type { BlockTolerance } from "../review/severity-policy";
import type { TrustedAuthorThreshold } from "./posture-lattice";

export type { BlockTolerance };
export { BLOCK_TOLERANCES, isBlockTolerance } from "../review/severity-policy";

export type { TrustedAuthorThreshold };
export {
  TRUST_ORDER,
  DEFAULT_TRUSTED_AUTHOR_THRESHOLD,
  isTrustedAuthorThreshold,
  trustRank,
} from "./posture-lattice";

/** One per-repo review-tolerance override. `repo` is a lowercased 'owner/name' slug. */
export interface RepoReviewSetting {
  repo: string;
  blockTolerance: BlockTolerance;
  createdAt: string;
  updatedAt: string;
}
