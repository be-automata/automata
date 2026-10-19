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
 * The engine caps of one registration (#372). BOTH keys are PER WORKFLOW VARIANT
 * on the engine (the "global" key rides a constant expression, and Hatchet
 * scopes a concurrency group to its workflow — observed,
 * docs/uat/hatchet-lite-v0.94.10-observed.md §5), so with four variants the
 * engine admits up to 4 × globalMaxRuns in total; the BOX budget is the
 * worker's `slots` (= WORKER_BOX_SLOTS) plus the kernel box lock (box-lock.ts)
 * and the memory-headroom check (#371). `globalMaxRuns` must equal
 * WORKER_BOX_SLOTS and `perOrgMaxRuns` must not exceed it — loadWorkerConfig
 * refuses the tuple at boot and at every run (config.ts), and this module's
 * pure guard refuses a per-org cap above the global one so no registration can
 * carry a cap no run could reach.
 */
export interface EngineCaps {
  /** `'agent-run-global-memory-budget'` GROUP_ROUND_ROBIN key, per variant. */
  globalMaxRuns: number;
  /** `input.orgId` GROUP_ROUND_ROBIN key: fair ORDERING across orgs, and the most one org may hold of the global cap (equal is allowed — a single-org box must be able to use every slot). */
  perOrgMaxRuns: number;
}

/**
 * Today's compile-time caps, kept as the DEFAULT so every two-argument caller
 * (the E2E suites bind the shipped shape with a stub fn) registers exactly the
 * pre-#372 concurrency stack. Held at 1 since the orch-agents ENOMEM wall (4+
 * SDK sessions tripped fork/posix_spawn on a 7.6 GB box); raising them is the
 * whole-tuple move (#372): WORKER_GLOBAL_MAX_RUNS = WORKER_BOX_SLOTS ≥
 * WORKER_PER_ORG_MAX_RUNS, with WORKER_RUN_MEMORY_MAX and the swap sized for it.
 */
export const DEFAULT_GLOBAL_MAX_RUNS = 1;
export const DEFAULT_PER_ORG_MAX_RUNS = 1;
export const DEFAULT_ENGINE_CAPS: EngineCaps = {
  globalMaxRuns: DEFAULT_GLOBAL_MAX_RUNS,
  perOrgMaxRuns: DEFAULT_PER_ORG_MAX_RUNS,
};

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
  caps: EngineCaps = DEFAULT_ENGINE_CAPS,
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
    slotCost: number;
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
  if (
    !Number.isInteger(caps.globalMaxRuns) ||
    !Number.isInteger(caps.perOrgMaxRuns) ||
    caps.globalMaxRuns < 1 ||
    caps.perOrgMaxRuns < 1 ||
    caps.perOrgMaxRuns > caps.globalMaxRuns
  ) {
    throw new Error(
      `buildAgentRunDefinition(${name}): engine caps must be integers ≥ 1 with perOrgMaxRuns ≤ globalMaxRuns, got ${JSON.stringify(caps)}`,
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
          maxRuns: caps.perOrgMaxRuns,
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
          // NOT box-wide: Hatchet scopes this group PER WORKFLOW, so with the
          // variants registered it caps each variant separately (observed,
          // docs/uat/hatchet-lite-v0.94.10-observed.md §5). The box-wide
          // budget is enforced by the worker's kernel box lock (box-lock.ts).
          expression: "'agent-run-global-memory-budget'",
          maxRuns: caps.globalMaxRuns,
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
      // EXPLICIT retries: 0 — and it stays 0 (#371 measured why). A single
      // agent-run is a minutes-long, NON-idempotent side-effecting operation (it
      // clones, runs the agent, posts a GitHub review); the engine retries its
      // OWN failures too (an executionTimeout re-executes the task under the
      // retry policy — hatchet-lite v0.94.10, admission-deferral IT), and a
      // retried attempt re-enters a CANCEL_IN_PROGRESS group as the newest item,
      // cancelling the genuinely newer run. So the memory-headroom deferral
      // (#371) is waited out IN PROCESS (workflow.ts), never as an engine
      // retry. Engine redelivery after a worker death is a separate mechanism,
      // absorbed by the www single-writer.
      retries: 0,
      // #372: EXPLICIT — every agent run weighs exactly one of the worker's
      // `slots` (= WORKER_BOX_SLOTS, the budget). A heavier lane (a task run
      // that needs two slots' worth of memory) would be a per-lane cost knob,
      // not this ticket; until then the per-run ceiling (#204) and the
      // headroom check (#371) are what bound a run's weight on the box.
      slotCost: 1,
    },
  };
}
