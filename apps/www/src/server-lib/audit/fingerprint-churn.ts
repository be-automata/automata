export interface ChurnRun {
  id: string;
  complete: boolean;
  fingerprints: string[];
}

export interface FingerprintChurn {
  fromRunId: string;
  toRunId: string;
  /** |A symmetric-difference B| / |A union B|; 0 when both sets are empty. */
  churn: number;
}

/**
 * The dry-run exit metric (DRYRUN-EXIT): how much the set of finding
 * fingerprints moves between consecutive COMPLETE runs. `runs` must be in
 * chronological order (oldest first); incomplete runs are skipped, so one
 * partial run never fakes churn. Fewer than two complete runs yields [].
 */
export function computeFingerprintChurn(runs: ChurnRun[]): FingerprintChurn[] {
  const complete = runs.filter((run) => run.complete);
  const out: FingerprintChurn[] = [];
  for (let i = 1; i < complete.length; i++) {
    const prev = complete[i - 1]!;
    const next = complete[i]!;
    const a = new Set(prev.fingerprints);
    const b = new Set(next.fingerprints);
    const union = new Set([...a, ...b]);
    let common = 0;
    for (const fp of a) if (b.has(fp)) common++;
    const churn = union.size === 0 ? 0 : (union.size - common) / union.size;
    out.push({ fromRunId: prev.id, toRunId: next.id, churn });
  }
  return out;
}
