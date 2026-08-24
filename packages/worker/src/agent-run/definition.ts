import {
  ConcurrencyLimitStrategy,
  type Duration,
} from "@hatchet-dev/typescript-sdk";

/**
 * The PURE registration shape of the agent-run workflows (#125 C1): the
 * concurrency stack, the variant table and the run task's options — with NO
 * task fn and NO Hatchet client import. workflow.ts binds the real run fn;
 * supersede.integration.test.ts (#128) binds a stub against an isolated
 * engine. Keeping this module side-effect-free is what lets the E2E suite
 * import the SHIPPED shapes without a live token at import time.
 */

/**
 * Per-org concurrency cap. GROUP_ROUND_ROBIN on `input.orgId` gives fair ORDERING
 * across orgs; the cap itself is 1 and MUST stay ≤ the global cap so no single org
 * can ever hold every slot. Raising this is gated on #3b (real per-org parallelism).
 */
export const PER_ORG_MAX_RUNS = 1;

/**
 * Global concurrency cap = the single-box daemon memory budget. Held at 1: N
 * concurrent agents each spawn a full `claude` process, and the orch-agents ENOMEM
 * wall (4+ SDK sessions tripped fork/posix_spawn on a 7.6GB box, safe only after an
 * 8GiB swap file) is the precedent. Raise ONLY after per-agent RSS × N + headroom is
 * validated on the pilot box (plan's "Concurrency > 1 is gated on memory"), and set
 * `slotCost` to reflect the weight at the same time. Per-run daemon isolation (the
 * `--socket-path` flag) removes the socket-collision blocker but NOT the memory one.
 */
export const GLOBAL_MAX_RUNS = 1;

/**
 * The per-PR concurrency strategy of a policy variant, or null for the legacy
 * workflow (no per-PR entry at all — its concurrency is byte-identical to
 * pre-#125, so flag-off dispatches are unaffected).
 */
export type PerPrStrategy = ConcurrencyLimitStrategy | null;

/**
 * Variant table (#125 C1). STRUCTURALLY DUPLICATED (never imported) by the
 * control plane's POLICY_TO_WORKFLOW (apps/www/src/agent/hatchet/transport.ts).
 * Every registered variant shares ONE task fn and ONE config; the only
 * difference is the per-PR entry's limitStrategy. `as const` so a typo in a
 * name is a type error at the registry.
 */
export const AGENT_RUN_VARIANTS = {
  "agent-run": null,
  "agent-run-newest": ConcurrencyLimitStrategy.CANCEL_IN_PROGRESS,
  "agent-run-strict": ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
  "agent-run-discard": ConcurrencyLimitStrategy.CANCEL_NEWEST,
} as const satisfies Record<string, PerPrStrategy>;
export type AgentRunVariantName = keyof typeof AGENT_RUN_VARIANTS;

/** The strategies a per-PR entry may carry. Anything else fails registration. */
const SUPPORTED_PER_PR_STRATEGIES: ReadonlySet<ConcurrencyLimitStrategy> =
  new Set([
    ConcurrencyLimitStrategy.CANCEL_IN_PROGRESS,
    ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
    ConcurrencyLimitStrategy.CANCEL_NEWEST,
  ]);

/**
 * Idempotency window for the policy variants: the GitHub webhook redelivery
 * window (a redelivered `X-GitHub-Delivery` within 24h dedupes to ONE run).
 * Intentional re-dispatches (recheck, redo) mint DISTINCT delivery ids at the
 * control plane and are never deduped here.
 */
const DELIVERY_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The PURE registration shape of one agent-run workflow — the workflow
 * options (name + stacked concurrency) and the run task's options, minus the
 * task fn. Exported so #128's E2E suite registers the EXACT production
 * concurrency/idempotency shapes against an isolated engine with a stub fn:
 * the shapes under test are the shipped ones, never a hand-copied lookalike.
 * Unknown strategy → throws (fail-loud, never a silently mis-strategied group).
 */
export function buildAgentRunDefinition(
  name: string,
  perPrStrategy: PerPrStrategy,
): {
  workflow: {
    name: string;
    concurrency: {
      expression: string;
      maxRuns: number;
      limitStrategy: ConcurrencyLimitStrategy;
    }[];
    /**
     * WORKFLOW-level, not task-level: the SDK's registration only serializes
     * `workflow.idempotency` (a task-level option is dropped silently).
     * INERT on hatchet-lite v0.94.10 — the engine persists no workflow
     * idempotency config, so a repeated deliveryId still runs twice. It is
     * registered anyway so nothing else changes the day the engine honours
     * it. See docs/uat/hatchet-lite-v0.94.10-observed.md §3.
     */
    idempotency?: { strategy: "ttl"; expression: string; ttlMs: number };
  };
  task: {
    name: string;
    scheduleTimeout: Duration;
    executionTimeout: Duration;
    retries: number;
  };
} {
  if (
    perPrStrategy !== null &&
    !SUPPORTED_PER_PR_STRATEGIES.has(perPrStrategy)
  ) {
    throw new Error(
      `buildAgentRunDefinition(${name}): unsupported per-PR concurrency strategy ${String(perPrStrategy)}`,
    );
  }
  return {
    workflow: {
      name,
      concurrency: [
        ...(perPrStrategy !== null
          ? [
              {
                // Per-PR key (`${orgId}/${repo}/${prNumber}`, built by www C2).
                // The CEL references the FIELD — never an interpolation.
                expression: "input.prKey",
                maxRuns: 1,
                limitStrategy: perPrStrategy,
              },
            ]
          : []),
        {
          expression: "input.orgId",
          maxRuns: PER_ORG_MAX_RUNS,
          limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
        },
        {
          // Renamed from 'agent-run-shared-daemon-socket' (2026-08-19). Two reasons:
          // (1) the cap's real justification is the single-box MEMORY budget — the
          // shared-socket collision it was named for was solved by per-run sockets
          // (Phase 0.2b); (2) the old group's scheduler state deadlocked in
          // hatchet-lite after repeated worker re-registrations (stale
          // GROUP_ROUND_ROBIN strategy rows chain into active ones and the child
          // slot is never granted — tasks sit QUEUED forever with idle workers).
          // The rename minted fresh strategy state on registration but did NOT
          // prevent rot — the new group has since re-rotted (#69 §2.3, verified
          // live 2026-08-23). The group name is NOT rotated again (#69 §3.1.1:
          // rotation trades this deadlock for a worse one — two concurrent
          // agent-runs on a box budgeted for one). Instead an engine-DB repairer
          // (scheduling-maintenance.ts, opt-in, dry-run by default) detects and
          // prunes the corrupted chain pointers behind this group name.
          expression: "'agent-run-global-memory-budget'",
          maxRuns: GLOBAL_MAX_RUNS,
          limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
        },
      ],
      ...(perPrStrategy !== null
        ? {
            idempotency: {
              strategy: "ttl" as const,
              expression: "input.deliveryId",
              ttlMs: DELIVERY_IDEMPOTENCY_TTL_MS,
            },
          }
        : {}),
    },
    task: {
      name: "run",
      scheduleTimeout: "30m",
      executionTimeout: "30m",
      // EXPLICIT retries: 0 (the SDK default is already 0). A single agent-run is a
      // minutes-long, NON-idempotent side-effecting operation (it clones, runs the
      // agent, and posts a GitHub review) — auto-retrying it would re-execute the
      // agent and risk a double side-effect. Keep this explicit so a future edit
      // can't silently enable retries. This is Phase 1.4 mechanism #1 (exactly-once):
      // at retries:0 + workflow maxRuns:1 the only at-least-once window is engine
      // redelivery, which the www single-writer (HEAD+verdict idempotency) absorbs.
      retries: 0,
      // slotCost DEFERRED (#8): meaningless at GLOBAL_MAX_RUNS=1 (one run at a time), so
      // it stays unset until #3b raises the global cap — at which point set slotCost to
      // model each agent-run's memory weight so a worker's physical slots reflect real
      // capacity. Wiring it now would have no effect. See workflow-level concurrency doc.
    },
  };
}
