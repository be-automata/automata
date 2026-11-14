import { env } from "@terragon/env/apps-www";

/**
 * The remote-cell broker routes (/api/cell/git, /api/v3, /api/graphql) answer
 * 404 unless CELL_BROKER_ENABLED. A host concern: the broker package reads no
 * environment.
 */
export function cellBrokerEnabled(): boolean {
  return env.CELL_BROKER_ENABLED;
}
