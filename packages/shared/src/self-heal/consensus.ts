import { CONSENSUS_QUORUM, CONSENSUS_WINDOW } from "./audit-rules";

/**
 * R3 consensus over COMPLETE audit runs. A sighting window is newest-first and
 * holds at most CONSENSUS_WINDOW entries. Pure.
 */

export function pushSighting(
  prev: readonly boolean[],
  seen: boolean,
): boolean[] {
  return [seen, ...prev].slice(0, CONSENSUS_WINDOW);
}

export function hasQuorum(sightings: readonly boolean[]): boolean {
  return sightings.filter(Boolean).length >= CONSENSUS_QUORUM;
}
