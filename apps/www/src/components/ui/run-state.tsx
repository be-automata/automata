import React from "react";
import type { RunState, RunStateKind } from "@terragon/shared/model/run-state";

import { cn } from "@/lib/utils";

/**
 * The run-state shape grammar (DESIGN.md "RunState"): needs you ■, waiting ◧,
 * running ●, done ✓, unverified ○. Shape carries the meaning so it reads in
 * greyscale; the color only confirms it. Always pair it with the word.
 */
const GLYPH_CLASS: Record<RunStateKind, string> = {
  "needs-you": "size-[9px] bg-state-needs-you",
  waiting:
    "size-[9px] bg-[linear-gradient(90deg,var(--state-waiting)_50%,transparent_50%)] shadow-[inset_0_0_0_1.5px_var(--state-waiting)]",
  running: "size-[9px] rounded-full bg-state-running",
  done: "relative size-[10px] after:absolute after:left-[2px] after:top-0 after:h-[7px] after:w-[4px] after:rotate-[40deg] after:border-state-done after:border-r-2 after:border-b-2",
  unverified: "size-[9px] rounded-full border-[1.5px] border-state-unverified",
};

export const RUN_STATE_TEXT_CLASS: Record<RunStateKind, string> = {
  "needs-you": "text-state-needs-you",
  waiting: "text-state-waiting",
  running: "text-state-running",
  done: "text-state-done",
  unverified: "text-state-unverified",
};

export function RunStateGlyph({
  kind,
  className,
}: {
  kind: RunStateKind;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block shrink-0", GLYPH_CLASS[kind], className)}
    />
  );
}

/** Glyph, status word and an optional muted reason ("queued · waiting for a free slot"). */
export function RunStateLabel({
  state,
  showReason = true,
  className,
}: {
  state: RunState;
  showReason?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap",
        className,
      )}
    >
      <RunStateGlyph kind={state.kind} />
      <span className={RUN_STATE_TEXT_CLASS[state.kind]}>{state.word}</span>
      {showReason && state.reason ? (
        <span className="min-w-0 truncate text-muted-foreground">
          · {state.reason}
        </span>
      ) : null}
    </span>
  );
}
