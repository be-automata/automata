import { env } from "@terragon/env/apps-www";
import type { DB } from "@terragon/shared/db";
import {
  getDecryptedEnvironmentVariables,
  getDecryptedGlobalEnvironmentVariables,
  getEnvironmentForUserRepo,
} from "@terragon/shared/model/environments";
import { getDecryptedOrganizationEnvironmentVariables } from "@terragon/shared/model/organization-environment";
import { getMembership } from "@terragon/shared/model/organizations";

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
 *
 * Three stores feed these reads, merged key by key (a later layer wins):
 *
 *   agents (sandbox, remote task run): personal global → organization → repo
 *   control plane (tracker config):    organization → repo — NEVER global
 *
 * The personal global row has no org fence (one row per user, shared by every
 * org that user belongs to), so a control-plane credential read from it would
 * cross org boundaries. Org values are read only while the user is still a
 * member of that org.
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

export type EnvSource = "global" | "organization" | "repository";

export interface EnvironmentLayer {
  source: EnvSource;
  variables: readonly EnvironmentVariable[];
}

/**
 * Key-by-key overlay of `layers` in order — a later layer wins — remembering
 * which layer each surviving value came from. Pure; inputs are not mutated.
 */
export function mergeEnvironmentLayers(
  layers: readonly EnvironmentLayer[],
): Record<string, { value: string; source: EnvSource }> {
  const merged: Record<string, { value: string; source: EnvSource }> = {};
  for (const layer of layers) {
    for (const { key, value } of layer.variables) {
      merged[key] = { value, source: layer.source };
    }
  }
  return merged;
}

function mergedValues(
  merged: Record<string, { value: string; source: EnvSource }>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(merged).map(([key, { value }]) => [key, value]),
  );
}

/**
 * The org's raw variables (control plane). Org owners/admins only — the
 * caller checks the role; this read does not.
 */
export async function getControlPlaneOrganizationEnvironmentVariables({
  db,
  organizationId,
}: {
  db: DB;
  organizationId: string;
}): Promise<EnvironmentVariable[]> {
  return await getDecryptedOrganizationEnvironmentVariables({
    db,
    organizationId,
    encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
  });
}

/**
 * The org layer as seen on behalf of `userId`: empty without an org, and
 * empty once the user is no longer a member — a stale thread org id or a
 * departed member never pulls the org's values.
 */
async function readOrganizationLayer({
  db,
  userId,
  organizationId,
}: {
  db: DB;
  userId: string;
  organizationId: string | null | undefined;
}): Promise<EnvironmentVariable[]> {
  if (!organizationId) return [];
  const membership = await getMembership({ db, organizationId, userId });
  if (!membership) return [];
  return await getControlPlaneOrganizationEnvironmentVariables({
    db,
    organizationId,
  });
}

/** A repo without an environment row simply has no variables. */
async function readRepositoryLayer({
  db,
  userId,
  organizationId,
  repoFullName,
}: {
  db: DB;
  userId: string;
  organizationId: string | null | undefined;
  repoFullName: string;
}): Promise<EnvironmentVariable[]> {
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
}

/**
 * The tracker's configuration source: the organization layer overlaid by the
 * owner's repository environment. The personal global layer is never read
 * here — it is user-scoped with no org fence. Raw values: control plane only.
 */
export async function getControlPlaneTrackerEnvironment({
  db,
  userId,
  organizationId,
  repoFullName,
}: {
  db: DB;
  userId: string;
  organizationId: string | null | undefined;
  repoFullName: string;
}): Promise<{
  variables: EnvironmentVariable[];
  sources: Record<string, EnvSource>;
}> {
  const [organizationVariables, repositoryVariables] = await Promise.all([
    readOrganizationLayer({ db, userId, organizationId }),
    readRepositoryLayer({ db, userId, organizationId, repoFullName }),
  ]);
  const merged = mergeEnvironmentLayers([
    { source: "organization", variables: organizationVariables },
    { source: "repository", variables: repositoryVariables },
  ]);
  return {
    variables: Object.entries(merged).map(([key, { value }]) => ({
      key,
      value,
    })),
    sources: Object.fromEntries(
      Object.entries(merged).map(([key, { source }]) => [key, source]),
    ),
  };
}

/**
 * What a sandbox's agent sees: personal global → organization → repository,
 * control-plane-only keys removed. The repository layer is the environment
 * the caller already resolved (`repoEnvironmentId`), or none.
 */
export async function getExecutionPlaneLayeredEnvironmentVariables({
  db,
  userId,
  organizationId,
  repoEnvironmentId,
}: {
  db: DB;
  userId: string;
  organizationId: string | null | undefined;
  repoEnvironmentId: string | null;
}): Promise<EnvironmentVariable[]> {
  const [globalVariables, organizationVariables, repositoryVariables] =
    await Promise.all([
      getControlPlaneGlobalEnvironmentVariables({ db, userId }),
      readOrganizationLayer({ db, userId, organizationId }),
      repoEnvironmentId
        ? getControlPlaneEnvironmentVariables({
            db,
            userId,
            environmentId: repoEnvironmentId,
          })
        : Promise.resolve([]),
    ]);
  const merged = mergeEnvironmentLayers([
    { source: "global", variables: globalVariables },
    { source: "organization", variables: organizationVariables },
    { source: "repository", variables: repositoryVariables },
  ]);
  return stripControlPlaneOnlyEnv(
    Object.entries(merged).map(([key, { value }]) => ({ key, value })),
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
 *
 * `personalTrackerToken` is the YOUTRACK_TOKEN from the user's OWN layers
 * (global, repository) only. An organization's YOUTRACK_TOKEN is shared by
 * every member and never reaches an agent in any form: an org that wants its
 * agents to reach the tracker sets YOUTRACK_AGENT_TOKEN explicitly.
 */
export function withAgentTrackerTokenFallback(
  variables: Record<string, string>,
  options?: { personalTrackerToken: string | undefined },
): Record<string, string> {
  // Without options every layer is personal (the pre-org callers); with
  // options, an absent personal token means NO fallback — never the merged
  // value, which may have come from the organization layer.
  const personalTrackerToken = options
    ? options.personalTrackerToken
    : variables.YOUTRACK_TOKEN;
  if (variables[AGENT_TRACKER_TOKEN_KEY] || !personalTrackerToken) {
    return variables;
  }
  return { ...variables, [AGENT_TRACKER_TOKEN_KEY]: personalTrackerToken };
}

/**
 * The variables a remote (worker-box) task run hands its agent: personal
 * global → organization → repository, the tracker token fallback applied
 * (from the personal layers only), then control-plane-only keys removed.
 * Otherwise the same merge the sandbox path performs (agent/sandbox.ts). The
 * fallback is deliberately remote-only: prompt-defined automations run on the
 * worker box, and no other execution plane needs the owner's tracker token.
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
  // Reads only: a repo without an environment row simply has no variables,
  // so dispatch never inserts one.
  const [globalVariables, organizationVariables, repositoryVariables] =
    await Promise.all([
      getControlPlaneGlobalEnvironmentVariables({ db, userId }),
      readOrganizationLayer({ db, userId, organizationId }),
      readRepositoryLayer({ db, userId, organizationId, repoFullName }),
    ]);
  const personal = mergedValues(
    mergeEnvironmentLayers([
      { source: "global", variables: globalVariables },
      { source: "repository", variables: repositoryVariables },
    ]),
  );
  const merged = withAgentTrackerTokenFallback(
    mergedValues(
      mergeEnvironmentLayers([
        { source: "global", variables: globalVariables },
        { source: "organization", variables: organizationVariables },
        { source: "repository", variables: repositoryVariables },
      ]),
    ),
    { personalTrackerToken: personal.YOUTRACK_TOKEN },
  );
  return Object.fromEntries(
    Object.entries(merged).filter(
      ([key]) => !CONTROL_PLANE_ONLY_ENV_KEYS.has(key),
    ),
  );
}
