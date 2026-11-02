import type { KnowledgeRepoStatusRow } from "@terragon/shared/model/knowledge-repo-status";

import type {
  KnowledgeRepoDto,
  KnowledgeTicketSource,
} from "@/components/settings/knowledge/knowledge-form";

/**
 * JSON shape of one onboarded repo's liveness row (D-17, D-19).
 * Ids, enums, integers, shas and dates only: never a payload, header or token.
 * The evidence counts (PD-25, PD-21) and the ticket source (PD-24) are integers
 * and a two-value enum: never a claim statement, ticket key or tracker URL.
 */
export function toKnowledgeRepoDto(
  row: KnowledgeRepoStatusRow,
  ticketSource: KnowledgeTicketSource | null = null,
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
    excludedDocClaims: row.excludedDocClaims,
    excludedInvalidClaims: row.excludedInvalidClaims,
    ticketClaimCount: row.ticketClaimCount,
    ticketSource: row.ticketClaimCount > 0 ? ticketSource : null,
  };
}
