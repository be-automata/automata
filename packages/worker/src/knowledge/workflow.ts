import {
  ConcurrencyLimitStrategy,
  type JsonObject,
} from "@hatchet-dev/typescript-sdk";
import {
  KNOWLEDGE_MIRROR_PURGE_WORKFLOW,
  KNOWLEDGE_RECONCILE_WORKFLOW,
  type KnowledgeMirrorPurgeInput,
  type KnowledgeReconcileInput,
} from "@terragon/knowledge/reconcile-wire";

import { hatchet } from "../hatchet-client";
import { purgeOrgMirrors, sweepMirrorTombstones } from "./mirror";
import { orgMirrorDirs } from "./mirror-paths";
import {
  loadKnowledgeWorkerConfig,
  type KnowledgeWorkerConfig,
} from "./reconcile-config";
import { runKnowledgeReconcile, type ReconcileResult } from "./reconcile-task";
import { createReconcileClient, type ReconcileClient } from "./www-client";

/**
 * The reconcile task's registration options, exported pure so tests read them
 * without an engine (like agent-run/definition.ts).
 *
 * PD-2: scheduleTimeout 5m and executionTimeout 10m both sit inside the 20 min
 * intent lease. retries 0 is explicit, but Hatchet may still re-attempt
 * internally, so the body is idempotent on intentId. One reconcile per
 * (org, repo) at the engine too, GROUP_ROUND_ROBIN: never a cancel-in-progress strategy
 * (a cancel would cut a publish in half).
 *
 * No task or step here is named `run`: growth triggers count action ids ending
 * `:run`, so knowledge runs must not skew queue-wait alerts.
 */
export const KNOWLEDGE_RECONCILE_OPTIONS = {
  name: KNOWLEDGE_RECONCILE_WORKFLOW,
  scheduleTimeout: "5m",
  executionTimeout: "10m",
  retries: 0,
  concurrency: [
    {
      expression: "input.organizationId + ':' + input.repoFullName",
      maxRuns: 1,
      limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
    },
  ],
} as const;

export const KNOWLEDGE_MIRROR_PURGE_OPTIONS = {
  name: KNOWLEDGE_MIRROR_PURGE_WORKFLOW,
  scheduleTimeout: "30m",
  executionTimeout: "5m",
  retries: 0,
} as const;

const SHA40 = /^[0-9a-f]{40}$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** Reference-only input check (T-13-36); anything else is rejected before work. */
export function isKnowledgeReconcileInput(
  value: unknown,
): value is KnowledgeReconcileInput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    isNonEmptyString(v.intentId) &&
    isNonEmptyString(v.organizationId) &&
    isNonEmptyString(v.repoFullName) &&
    typeof v.targetSha === "string" &&
    SHA40.test(v.targetSha)
  );
}

/** T-13-39: an org id that could steer the purge outside its hashed directory. */
export function isKnowledgePurgeInput(
  value: unknown,
): value is KnowledgeMirrorPurgeInput {
  if (typeof value !== "object" || value === null) return false;
  const id = (value as Record<string, unknown>).organizationId;
  return isNonEmptyString(id) && !id.includes("/") && !id.includes("..");
}

export interface KnowledgeTaskDeps {
  env?: NodeJS.ProcessEnv;
  createClient?: (opts: { baseUrl: string; secret: string }) => ReconcileClient;
  runReconcile?: typeof runKnowledgeReconcile;
  log?: (message: string) => void;
}

function describeWarnings(cfg: KnowledgeWorkerConfig): string[] {
  return cfg.warnings.map((w) => `config warning ${w}`);
}

/**
 * The reconcile task body. Never throws: a Hatchet failure would only add
 * engine re-attempts, and the intent row is the source of truth.
 */
export async function handleKnowledgeReconcile(
  input: unknown,
  deps: KnowledgeTaskDeps = {},
): Promise<ReconcileResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  if (!isKnowledgeReconcileInput(input)) {
    log("[knowledge-reconcile] input rejected (not a reference-only input)");
    return { outcome: "failed", code: "control_plane_rejected" };
  }
  let cfg: KnowledgeWorkerConfig;
  try {
    cfg = loadKnowledgeWorkerConfig(deps.env ?? process.env);
  } catch (error) {
    log(
      `[knowledge-reconcile] config invalid (${error instanceof Error ? error.name : "unknown"})`,
    );
    return { outcome: "failed", code: "worker_error" };
  }
  if (cfg.reconcile === null) {
    for (const line of describeWarnings(cfg))
      log(`[knowledge-reconcile] ${line}`);
    log(
      "[knowledge-reconcile] reconcile is not configured on this worker; the intent lease will requeue",
    );
    return { outcome: "noop" };
  }
  try {
    const client = (deps.createClient ?? createReconcileClient)({
      baseUrl: cfg.reconcile.controlPlaneUrl,
      secret: cfg.reconcile.secret,
    });
    return await (deps.runReconcile ?? runKnowledgeReconcile)(input, {
      client,
      mirrorConfig: cfg.mirror,
      tenantId: cfg.tenantId,
    });
  } catch (error) {
    log(
      `[knowledge-reconcile] unexpected failure (${error instanceof Error ? error.name : "unknown"})`,
    );
    return { outcome: "failed", code: "worker_error" };
  }
}

export interface MirrorPurgeResult {
  outcome: "purged" | "failed";
}

/**
 * The purge task body. It reads ONLY config.mirror and config.tenantId, never
 * config.reconcile, so it runs when the reconcile credentials are unset or
 * rotated (PD-20).
 */
export async function handleKnowledgeMirrorPurge(
  input: unknown,
  deps: KnowledgeTaskDeps = {},
): Promise<MirrorPurgeResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  if (!isKnowledgePurgeInput(input)) {
    log("[knowledge-mirror-purge] input rejected");
    return { outcome: "failed" };
  }
  try {
    const { mirror, tenantId } = loadKnowledgeWorkerConfig(
      deps.env ?? process.env,
    );
    await purgeOrgMirrors({
      root: mirror.root,
      tenantId,
      organizationId: input.organizationId,
    });
    const { tenantDir } = orgMirrorDirs(
      mirror.root,
      tenantId,
      input.organizationId,
    );
    await sweepMirrorTombstones(tenantDir);
    return { outcome: "purged" };
  } catch (error) {
    log(
      `[knowledge-mirror-purge] failed (${error instanceof Error ? error.name : "unknown"})`,
    );
    return { outcome: "failed" };
  }
}

/** The engine stores task output as JSON: drop undefined fields, widen to JsonObject. */
function toJsonObject(value: object): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

export const knowledgeReconcileTask = hatchet.task({
  ...KNOWLEDGE_RECONCILE_OPTIONS,
  concurrency: [...KNOWLEDGE_RECONCILE_OPTIONS.concurrency],
  // The engine hands over JSON; handleKnowledgeReconcile validates it.
  fn: async (input: Record<string, unknown>): Promise<JsonObject> =>
    toJsonObject(await handleKnowledgeReconcile(input)),
});

export const knowledgeMirrorPurgeTask = hatchet.task({
  ...KNOWLEDGE_MIRROR_PURGE_OPTIONS,
  fn: async (input: Record<string, unknown>): Promise<JsonObject> =>
    toJsonObject(await handleKnowledgeMirrorPurge(input)),
});

/**
 * The workflows of the dedicated knowledge worker (PD-18). They run only
 * there, never through buildWorkflows, so knowledge work never holds a review
 * slot.
 */
export function buildKnowledgeWorkflows() {
  return [knowledgeReconcileTask, knowledgeMirrorPurgeTask];
}
