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

/**
 * The variables a remote (worker-box) task run hands its agent: the owner's
 * global set overlaid by the repository environment's, control-plane-only
 * keys removed. The same merge the sandbox path performs (agent/sandbox.ts),
 * so a prompt-defined automation sees the same variables on either plane.
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
      ? await getExecutionPlaneEnvironmentVariables({
          db,
          userId,
          environmentId: environment.id,
        })
      : [];
  };
  const [globalVariables, repoVariables] = await Promise.all([
    getExecutionPlaneGlobalEnvironmentVariables({ db, userId }),
    readRepoVariables(),
  ]);
  return Object.fromEntries(
    [...globalVariables, ...repoVariables].map(({ key, value }) => [
      key,
      value,
    ]),
  );
}
