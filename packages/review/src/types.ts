/**
 * Minimal review-domain types for the mounted review kernel (WI: review-package
 * mount, step 1).
 *
 * In orch-agents these live in the 481-line global `src/types.ts`. Only `Finding`
 * is reached by the pure kernel/state modules ported here, so it is copied
 * verbatim rather than dragging the whole global types file (which pulls
 * webhook-gateway / intake / kernel dependencies that belong to the deferred
 * pipeline layer). Keep this in sync with orch-agents `src/types.ts` `Finding`.
 */

export interface Finding {
  id: string;
  severity: "info" | "warning" | "error" | "critical";
  category: string;
  message: string;
  location?: string;
  /** Structured file path for inline review comments. */
  filePath?: string;
  /** Structured line number for inline review comments. */
  lineNumber?: number;
  /** Commit SHA for anchoring inline review comments. */
  commitSha?: string;
}
