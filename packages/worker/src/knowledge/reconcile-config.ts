import { loadMirrorConfig, type MirrorConfig } from "./mirror-paths";

/**
 * Config of the dedicated knowledge worker (PD-18). Every knob is read through
 * the `env` parameter. Knobs:
 *
 *   WORKER_RECONCILE_SLOTS        integer 1..2, default 1: the knowledge worker's
 *                                 own slot pool, never shared with review runs.
 *   WORKER_CONTROL_PLANE_URL      the www base URL. Runs carry daemonCallbackUrl,
 *                                 but the reconcile input is reference-only, so
 *                                 the base URL needs its own knob. HTTPS is
 *                                 required outside loopback because the context
 *                                 response carries an installation token.
 *   KNOWLEDGE_RECONCILE_SECRET    the shared reconcile secret. NEVER logged.
 *   HATCHET_ENGINE_TENANT_ID      the mirror tenant directory (empty -> "default").
 *   WORKER_MIRROR_*               see loadMirrorConfig.
 *
 * `reconcile` and `mirror` are independent: a missing, half-set or insecure
 * reconcile config degrades to `reconcile: null` plus a warning enum and never
 * blocks mirror purge (PD-20).
 */
export interface KnowledgeWorkerConfig {
  slots: number;
  tenantId: string;
  mirror: MirrorConfig;
  reconcile: { controlPlaneUrl: string; secret: string } | null;
  warnings: KnowledgeConfigWarning[];
}

export type KnowledgeConfigWarning =
  | "reconcile_half_configured"
  | "reconcile_insecure_url";

const SLOTS_MAX = 2;

function parseReconcileSlots(raw: string | undefined): number {
  const v = (raw ?? "").trim();
  if (v === "") return 1;
  const n = Number(v);
  if (!/^\d+$/.test(v) || n < 1 || n > SLOTS_MAX) {
    throw new Error(
      `WORKER_RECONCILE_SLOTS must be an integer between 1 and ${SLOTS_MAX}, got ${JSON.stringify(v)}`,
    );
  }
  return n;
}

function isSecureOrLoopback(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  );
}

export function loadKnowledgeWorkerConfig(
  env: NodeJS.ProcessEnv,
): KnowledgeWorkerConfig {
  const slots = parseReconcileSlots(env.WORKER_RECONCILE_SLOTS);
  const mirror = loadMirrorConfig(env);
  const tenantId = env.HATCHET_ENGINE_TENANT_ID?.trim() || "default";
  const url = env.WORKER_CONTROL_PLANE_URL?.trim() ?? "";
  const secret = env.KNOWLEDGE_RECONCILE_SECRET?.trim() ?? "";
  const warnings: KnowledgeConfigWarning[] = [];
  let reconcile: KnowledgeWorkerConfig["reconcile"] = null;
  if (url !== "" && secret !== "") {
    if (isSecureOrLoopback(url)) {
      reconcile = { controlPlaneUrl: url, secret };
    } else {
      warnings.push("reconcile_insecure_url");
    }
  } else if (url !== "" || secret !== "") {
    warnings.push("reconcile_half_configured");
  }
  return { slots, tenantId, mirror, reconcile, warnings };
}
