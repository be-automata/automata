import { ENV_NAME } from "./container-policy";
import { isReservedRepoEnvKey } from "./daemon-env";

/**
 * The owner's repo env as a run gets it, on the box (the run env file) and in
 * a cell (the settings `env` block, #706): one reserved rule
 * (`isReservedRepoEnvKey`, #717), names only in what is reported. Pure.
 */
export interface FilteredRepoEnv {
  /** The names and values the agent gets. */
  env: Record<string, string>;
  /** The identifier names dropped (reserved, or a NUL in the value), sorted. Never values. */
  dropped: string[];
  /** How many names were dropped for not being an identifier (not listed: a name is free text). */
  invalidNames: number;
}

export function filterRepoEnv(
  repoEnv: Record<string, string> | undefined,
): FilteredRepoEnv {
  const env: Record<string, string> = {};
  const dropped: string[] = [];
  let invalidNames = 0;
  for (const [key, value] of Object.entries(repoEnv ?? {})) {
    if (!ENV_NAME.test(key)) invalidNames += 1;
    else if (isReservedRepoEnvKey(key) || value.includes("\0")) {
      dropped.push(key);
    } else env[key] = value;
  }
  return { env, dropped: dropped.sort(), invalidNames };
}

/** The key-only note both paths log, or null when nothing was dropped. */
export function repoEnvDroppedNote({
  dropped,
  invalidNames,
}: FilteredRepoEnv): string | null {
  if (dropped.length === 0 && invalidNames === 0) return null;
  return (
    `repo env names not set (reserved): ${dropped.join(", ") || "none"}` +
    (invalidNames > 0 ? ` (+${invalidNames} not an env name)` : "")
  );
}
