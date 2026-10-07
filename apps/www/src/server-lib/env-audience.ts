import { env } from "@terragon/env/apps-www";
import type { DB } from "@terragon/shared/db";
import {
  getDecryptedEnvironmentVariables,
  getDecryptedGlobalEnvironmentVariables,
  getEnvironmentForUserRepo,
} from "@terragon/shared/model/environments";

/**
 * The ONLY module that decrypts stored environment variables (ADR-008 I1).
 *
 * A repository environment holds two kinds of value: variables meant for the
 * agent's sandbox, and credentials the control plane uses on the repo's
 * behalf (a tracker token). They share one store — it is the only encrypted,
 * org-fenced, dashboard-editable secret store there is — so the AUDIENCE has
 * to be chosen at the read, not remembered at each use:
 *
 *   getExecutionPlaneEnv…  → everything an agent may see. Control-plane-only
 *                            keys are already removed. Use for anything handed
 *                            to a sandbox, a worker, a setup script, a terminal.
 *   getControlPlaneEnv…    → the raw set. Use only where the values stay on
 *                            the control plane (tracker config, the owner's
 *                            own dashboard page).
 *
 * `env-audience.test.ts` fails if any other module imports the shared
 * decrypt functions directly, so a new consumer cannot skip the choice.
 */

/** Stored on a repo environment, but never delivered to an agent. */
export const CONTROL_PLANE_ONLY_ENV_KEYS: ReadonlySet<string> = new Set([
  // The post-merge audit's tracker token: every tracker write is performed by
  // the control plane, so the agent has no use for it.
  "YOUTRACK_TOKEN",
]);

export interface EnvironmentVariable {
  key: string;
  value: string;
}

export function stripControlPlaneOnlyEnv<T extends { key: string }>(
  variables: readonly T[],
): T[] {
  return variables.filter(
    (variable) => !CONTROL_PLANE_ONLY_ENV_KEYS.has(variable.key),
  );
}

export async function getControlPlaneEnvironmentVariables({
  db,
  userId,
  environmentId,
}: {
  db: DB;
  userId: string;
  environmentId: string;
}): Promise<EnvironmentVariable[]> {
  return await getDecryptedEnvironmentVariables({
    db,
    userId,
    environmentId,
    encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
  });
}

export async function getExecutionPlaneEnvironmentVariables(args: {
  db: DB;
  userId: string;
  environmentId: string;
}): Promise<EnvironmentVariable[]> {
  return stripControlPlaneOnlyEnv(
    await getControlPlaneEnvironmentVariables(args),
  );
}

export async function getControlPlaneGlobalEnvironmentVariables({
  db,
  userId,
}: {
  db: DB;
  userId: string;
}): Promise<EnvironmentVariable[]> {
  return await getDecryptedGlobalEnvironmentVariables({
    db,
    userId,
    encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
  });
}

export async function getExecutionPlaneGlobalEnvironmentVariables(args: {
  db: DB;
  userId: string;
}): Promise<EnvironmentVariable[]> {
  return stripControlPlaneOnlyEnv(
    await getControlPlaneGlobalEnvironmentVariables(args),
  );
}

/** The tracker token a prompt-defined automation's agent reads. */
export const AGENT_TRACKER_TOKEN_KEY = "YOUTRACK_AGENT_TOKEN";

/**
 * An owner who can only mint a personal YouTrack token stores it once, as
 * YOUTRACK_TOKEN. When no dedicated agent token is set, a remote task run's
 * agent gets that value under YOUTRACK_AGENT_TOKEN — an owner decision
 * (2026-10-07) accepting that the agent then writes as the owner. The
 * control-plane key itself is still stripped.
 */
export function withAgentTrackerTokenFallback(
  variables: Record<string, string>,
): Record<string, string> {
  const fallback = variables.YOUTRACK_TOKEN;
  if (variables[AGENT_TRACKER_TOKEN_KEY] || !fallback) {
    return variables;
  }
  return { ...variables, [AGENT_TRACKER_TOKEN_KEY]: fallback };
}

/**
 * The variables a remote (worker-box) task run hands its agent: the owner's
 * global set overlaid by the repository environment's, the tracker token
 * fallback applied, then control-plane-only keys removed. Otherwise the same
 * merge the sandbox path performs (agent/sandbox.ts).
 */
export async function getExecutionPlaneRunEnvironment({
  db,
  userId,
  organizationId,
  repoFullName,
}: {
  db: DB;
  userId: string;
  organizationId: string | null;
  repoFullName: string;
}): Promise<Record<string, string>> {
  // A read: a repo without an environment row simply has no variables, so
  // dispatch never inserts one.
  const readRepoVariables = async (): Promise<EnvironmentVariable[]> => {
    const environment = await getEnvironmentForUserRepo({
      db,
      userId,
      organizationId,
      repoFullName,
    });
    return environment
      ? await getControlPlaneEnvironmentVariables({
          db,
          userId,
          environmentId: environment.id,
        })
      : [];
  };
  const [globalVariables, repoVariables] = await Promise.all([
    getControlPlaneGlobalEnvironmentVariables({ db, userId }),
    readRepoVariables(),
  ]);
  const merged = withAgentTrackerTokenFallback(
    Object.fromEntries(
      [...globalVariables, ...repoVariables].map(({ key, value }) => [
        key,
        value,
      ]),
    ),
  );
  return Object.fromEntries(
    Object.entries(merged).filter(
      ([key]) => !CONTROL_PLANE_ONLY_ENV_KEYS.has(key),
    ),
  );
}
