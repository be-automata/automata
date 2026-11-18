/**
 * What a cell run recorded about how it ended, for onFailure (#656). A run that
 * ends this way cannot, or must not, post `run-failed`: the post would 401 or
 * would hit a thread another attempt owns. One bounded map keyed by the
 * workflow run id replaces three separate sets, with ONE precedence rule.
 */

export type RunEndMark = "fenced" | "tokenGone" | "retired";

/**
 * Precedence when a run collects more than one mark: fenced > tokenGone >
 * retired. Fenced is strongest: the thread belongs to a newer attempt, so
 * nothing at all may be posted for it. A deleted token (409) and a retired
 * token (terminal read) both only make the post impossible.
 */
const RANK: Record<RunEndMark, number> = {
  retired: 1,
  tokenGone: 2,
  fenced: 3,
};

/** The info line onFailure logs (never an error) for each mark, after the run's id prefix. */
export const RUN_END_MARK_MESSAGES: Record<RunEndMark, string> = {
  retired:
    "run-failed not posted: token retired at the terminal read (expected, #656)",
  tokenGone:
    "run-failed not posted: token deleted by www on cell_step_conflict (expected)",
  fenced:
    "run-failed not posted: a newer attempt fenced this run and owns the thread (expected, #656)",
};

/** A Map that forgets its oldest entry past `max`: a run id that never reaches onFailure must not leak. */
export class BoundedRunMap {
  private readonly marks = new Map<string, RunEndMark>();
  constructor(private readonly max: number) {}

  /** Records `kind`, keeping the stronger mark when the run already has one. */
  mark(runId: string, kind: RunEndMark): void {
    if (!runId) return;
    const held = this.marks.get(runId);
    if (held !== undefined && RANK[held] >= RANK[kind]) return;
    this.marks.delete(runId);
    this.marks.set(runId, kind);
    if (this.marks.size > this.max) {
      const oldest = this.marks.keys().next().value;
      if (oldest !== undefined) this.marks.delete(oldest);
    }
  }

  get(runId: string): RunEndMark | undefined {
    return this.marks.get(runId);
  }

  /** Reads and forgets the run's mark (onFailure runs once per run). */
  take(runId: string): RunEndMark | undefined {
    const kind = this.marks.get(runId);
    this.marks.delete(runId);
    return kind;
  }
}

/** The process-wide registry: the cell executor writes it, onFailure reads it. */
export const runEndMarks = new BoundedRunMap(4096);
