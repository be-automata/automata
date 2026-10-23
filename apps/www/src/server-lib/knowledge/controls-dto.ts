import type { KnowledgeControls } from "@terragon/shared/model/knowledge-controls";

/** JSON shape of the knowledge controls (ISO dates). Ids, enums and integers only. */
export function controlsToDto(c: KnowledgeControls) {
  return {
    engine: c.engine,
    budgetMicroUsd: c.budgetMicroUsd,
    effectiveBudgetMicroUsd: c.effectiveBudgetMicroUsd,
    ceilingMicroUsd: c.ceilingMicroUsd,
    offboardedAt: c.offboardedAt?.toISOString() ?? null,
    purgeAfter: c.purgeAfter?.toISOString() ?? null,
    purgedAt: c.purgedAt?.toISOString() ?? null,
    enabled: c.enabled,
    gateReason: c.gateReason,
    updatedAt: c.updatedAt?.toISOString() ?? null,
  };
}
