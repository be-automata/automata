import type { KnowledgeRepoStatusRow } from "@terragon/shared/model/knowledge-repo-status";

import type { KnowledgeRepoDto } from "@/components/settings/knowledge/knowledge-form";

/**
 * JSON shape of one onboarded repo's liveness row (D-17, D-19).
 * Ids, enums, integers, shas and dates only: never a payload, header or token.
 */
export function toKnowledgeRepoDto(
  row: KnowledgeRepoStatusRow,
): KnowledgeRepoDto {
  return {
    repoFullName: row.repoFullName,
    defaultBranch: row.defaultBranch,
    lastPushAt: row.lastPushAt?.toISOString() ?? null,
    lastSha: row.lastSha,
    observedHeadSha: row.observedHeadSha,
    latestIntent: row.latestIntent
      ? {
          id: row.latestIntent.id,
          state: row.latestIntent.state,
          attempts: row.latestIntent.attempts,
          lastErrorCode: row.latestIntent.lastErrorCode,
          targetSha: row.latestIntent.targetSha,
          createdAt: row.latestIntent.createdAt.toISOString(),
          processedAt: row.latestIntent.processedAt?.toISOString() ?? null,
        }
      : null,
    pending: row.pending,
    pendingSince: row.pendingSince?.toISOString() ?? null,
    affectedClaimCount: row.affectedClaimCount,
  };
}
