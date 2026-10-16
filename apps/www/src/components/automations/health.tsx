import React from "react";
import Link from "next/link";
import type {
  AutomationHealth,
  AutomationHealthKind,
} from "@terragon/shared/model/automation-health";
import type { RunStateKind } from "@terragon/shared/model/run-state";

import {
  RUN_STATE_TEXT_CLASS,
  RunStateGlyph,
  RunStateLabel,
} from "@/components/ui/run-state";
import { formatRelativeTime } from "@/lib/format-relative-time";
import { cn } from "@/lib/utils";

const HEALTH: Record<
  AutomationHealthKind,
  { kind: RunStateKind; word: string }
> = {
  healthy: { kind: "done", word: "healthy" },
  degraded: { kind: "waiting", word: "degraded" },
  running: { kind: "running", word: "running" },
  idle: { kind: "unverified", word: "no runs yet" },
  paused: { kind: "unverified", word: "paused" },
};

export function AutomationHealthLabel({
  health,
  className,
}: {
  health: AutomationHealthKind;
  className?: string;
}) {
  const { kind, word } = HEALTH[health];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap",
        className,
      )}
    >
      <RunStateGlyph kind={kind} />
      <span className={RUN_STATE_TEXT_CLASS[kind]}>{word}</span>
    </span>
  );
}

/** The last runs as glyphs, oldest first: flakiness reads at a glance. */
export function AutomationHistoryStrip({
  health,
}: {
  health: AutomationHealth;
}) {
  if (health.history.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span
      className="inline-flex items-center gap-[3px]"
      aria-label={`Last ${health.history.length} runs`}
    >
      {health.history.map((run) => (
        <span key={run.threadId} title={`${run.state.word} · ${run.title}`}>
          <RunStateGlyph kind={run.state.kind} />
        </span>
      ))}
    </span>
  );
}

export function formatSuccessRate(rate: number | null) {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

/** Health, the last-14 strip and the runs with their result, newest first. */
export function AutomationHealthPanel({
  health,
}: {
  health: AutomationHealth | undefined;
}) {
  if (!health) {
    return null;
  }
  const runs = [...health.history].reverse();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <AutomationHealthLabel health={health.health} />
        {health.history.length > 0 ? (
          <span className="text-muted-foreground">
            · {health.failuresInLast5} of the last{" "}
            {Math.min(5, health.history.length)} runs failed · 7-day success{" "}
            {formatSuccessRate(health.successRate7d)}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-3 text-xs">
        <span className="w-16 text-muted-foreground">Last 14</span>
        <AutomationHistoryStrip health={health} />
      </div>
      <section aria-label="Runs">
        <div className="flex items-baseline gap-2.5 border-b border-border pb-1.5">
          <h3 className="text-[15px] font-bold leading-5">Runs</h3>
          <span className="text-xs text-muted-foreground">
            {health.history.length} recent
          </span>
        </div>
        {runs.length === 0 ? (
          <p className="py-3 font-sans text-[13px] text-muted-foreground">
            This automation has not run yet. Use Run now to try it.
          </p>
        ) : (
          <ul>
            {runs.map((run) => (
              <li
                key={run.threadId}
                className="grid grid-cols-[minmax(0,auto)_1fr_auto] items-center gap-3 border-b border-line-soft py-2 text-xs"
              >
                <RunStateLabel state={run.state} />
                <Link
                  href={`/task/${run.threadId}`}
                  className="min-w-0 truncate underline-offset-2 hover:underline"
                  title={run.title}
                >
                  {run.title}
                </Link>
                <span className="text-muted-foreground">
                  {formatRelativeTime(run.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
