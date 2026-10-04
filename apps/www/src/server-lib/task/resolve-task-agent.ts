import type { RepoReviewSetting } from "@terragon/shared/db/types";
import {
  TASK_AGENT_FIELD,
  findReviewAgentFieldError,
} from "@terragon/shared/model/review-agent-settings";

/**
 * Task-run packs for one NON-review dispatch (phase 7): which battery packs a
 * manual, scheduled or mention task run gets seeded into its HOME.
 *
 * PRECEDENCE: the first non-null `taskBatteries` of [repo row, '*' org-default
 * row]; nothing stored = none, exactly today's task runs. An explicit `[]` on
 * the repo row means none even when the '*' row lists packs.
 *
 * DEGRADES, NEVER THROWS: an invalid stored value (only possible after a pack
 * id was removed from BATTERY_PACK_IDS, because writes are validated) resolves
 * to no packs plus an `invalid` detail the dispatch logs. Throwing would stop
 * every task run of a repo that still stores the removed id; the review path
 * never consults this field at all.
 *
 * The result is the shape the worker sees; the settings table never crosses
 * the plane (mirrored structurally as TaskAgentShape in packages/worker).
 * The dispatcher reads the (repo, '*') rows once per dispatch and passes them
 * in, so this module never touches the DB.
 */

/** Effective task-run packs; non-review runs only. Structural twin of worker TaskAgentShape. */
export interface TaskAgentDispatch {
  batteries: string[];
}

export type TaskAgentResolution =
  | { taskAgent: TaskAgentDispatch }
  | { taskAgent: undefined }
  | { taskAgent: undefined; invalid: string };

type TaskAgentStoredRow = Pick<
  RepoReviewSetting,
  "repoFullName" | typeof TASK_AGENT_FIELD
>;

/** A stored row whose `taskBatteries` is set (non-null): the precedence winner. */
function hasTaskBatteries(
  row: TaskAgentStoredRow | undefined,
): row is TaskAgentStoredRow & { taskBatteries: string[] } {
  return row?.taskBatteries != null;
}

/** Pure resolution (no DB, never throws). Returns a fresh array. */
export function resolveTaskAgentFromRows({
  organizationId,
  repo,
  orgDefault,
}: {
  organizationId: string;
  repo: TaskAgentStoredRow | undefined;
  orgDefault: TaskAgentStoredRow | undefined;
}): TaskAgentResolution {
  const winner = [repo, orgDefault].find(hasTaskBatteries);
  if (winner === undefined) {
    return { taskAgent: undefined };
  }
  const value = winner.taskBatteries;
  const error = findReviewAgentFieldError({ [TASK_AGENT_FIELD]: value });
  if (error !== undefined) {
    return {
      taskAgent: undefined,
      invalid: `(${organizationId}, ${winner.repoFullName}) ${error}`,
    };
  }
  if (value.length === 0) {
    return { taskAgent: undefined };
  }
  return { taskAgent: { batteries: [...value] } };
}
