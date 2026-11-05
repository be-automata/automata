import { buildKnowledgeWorkflows } from "./workflow";
import {
  loadKnowledgeWorkerConfig,
  type KnowledgeWorkerConfig,
} from "./reconcile-config";

/**
 * PD-18: the knowledge tasks register ONLY on this second Hatchet worker, in the
 * same process as the review worker, with their own slot pool
 * (WORKER_RECONCILE_SLOTS). The review worker (hello/worker.ts) keeps
 * `workflows: buildWorkflows(...)` and `slots: boxSlots`, so knowledge work
 * never holds a review slot.
 *
 * `handleKill: false` is mandatory. The SDK installs
 * `process.on('SIGTERM'|'SIGINT', () => exitGracefully(handle_kill))` for EVERY
 * worker it creates (worker-internal.js:100-102), and exitGracefully calls
 * `process.exit(0)` as soon as that worker's own futures resolve
 * (worker-internal.js:672-726). With the default an idle knowledge worker would
 * exit the process while a review run drains. The review worker's handler is
 * the one that exits the process after the review drain; a knowledge run in
 * flight at that moment is requeued at its intent lease expiry (idempotent on
 * the intent id).
 *
 * Shared client side effect: on SIGTERM the knowledge worker's exitGracefully
 * also stops `durableListener` on the shared Hatchet client. Harmless while no
 * workflow on either worker is durable; add a durable task only after giving
 * the knowledge worker its own client.
 */
export const KNOWLEDGE_WORKER_NAME_PREFIX = "automata-knowledge-";

export interface KnowledgeWorkerOptions {
  workflows: ReturnType<typeof buildKnowledgeWorkflows>;
  slots: number;
  handleKill: false;
}

export function knowledgeWorkerOptions(
  cfg: Pick<KnowledgeWorkerConfig, "slots">,
): KnowledgeWorkerOptions {
  return {
    workflows: buildKnowledgeWorkflows(),
    slots: cfg.slots,
    handleKill: false,
  };
}

export interface KnowledgeWorkerDeps {
  hatchet: {
    worker(
      name: string,
      options: KnowledgeWorkerOptions,
    ): Promise<{ start(): Promise<unknown> }>;
  };
  boxId: string;
  env: NodeJS.ProcessEnv;
  log: (message: string) => void;
}

function knobOf(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return (
    /\b(?:WORKER|KNOWLEDGE|HATCHET)_[A-Z_]+/.exec(message)?.[0] ?? "unknown"
  );
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/**
 * Starts the knowledge worker. Never rejects: a config or registration error is
 * logged as one `[worker-boot] knowledge` line and the review worker keeps
 * running (T-13-38c). The promise settles when the worker stops.
 */
export async function startKnowledgeWorker(
  deps: KnowledgeWorkerDeps,
): Promise<void> {
  let cfg: KnowledgeWorkerConfig;
  try {
    cfg = loadKnowledgeWorkerConfig(deps.env);
  } catch (error) {
    deps.log(
      `[worker-boot] knowledge worker: OFF (config invalid: ${knobOf(error)})`,
    );
    return;
  }
  const name = `${KNOWLEDGE_WORKER_NAME_PREFIX}${deps.boxId}`;
  for (const warning of cfg.warnings) {
    deps.log(`[worker-boot] knowledge worker: config warning ${warning}`);
  }
  try {
    deps.log(
      `[worker-boot] knowledge worker: ${name} slots=${cfg.slots} reconcile=${cfg.reconcile ? "on" : "off"} (PD-18: own slot pool, never shares review slots)`,
    );
    const worker = await deps.hatchet.worker(name, knowledgeWorkerOptions(cfg));
    await worker.start();
  } catch (error) {
    deps.log(
      `[worker-boot] knowledge worker: registration failed (${nameOf(error)})`,
    );
  }
}
