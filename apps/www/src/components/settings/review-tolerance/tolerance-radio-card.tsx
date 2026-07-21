import type { BlockTolerance } from "@terragon/review/severity-policy";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  blocksUnder,
  INFO_WARNING_NOTE,
  SEVERITY_CHIPS,
  TOLERANCE_COPY,
  TOLERANCE_DESCRIPTOR,
} from "./constants";

interface ToleranceRadioCardProps {
  tolerance: BlockTolerance;
  /** Currently selected in the draft. */
  selected: boolean;
  /** This card matches the persisted (saved) value for the repo. */
  isPersisted: boolean;
  disabled?: boolean;
  onSelect(tolerance: BlockTolerance): void;
}

export function ToleranceRadioCard({
  tolerance,
  selected,
  isPersisted,
  disabled,
  onSelect,
}: ToleranceRadioCardProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={() => onSelect(tolerance)}
      className={cn(
        "w-full rounded-md border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        selected ? "border-primary/50 bg-primary/10" : "hover:bg-muted/50",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm">{tolerance}</span>
        <span className="text-xs text-muted-foreground">
          {TOLERANCE_DESCRIPTOR[tolerance]}
        </span>
        {tolerance === "warning" && (
          <span className="rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            Default
          </span>
        )}
        {isPersisted && !selected && (
          <span className="rounded border border-primary/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-primary">
            Active
          </span>
        )}
      </div>
      <p className="mt-2 text-xs text-foreground/80">
        {TOLERANCE_COPY[tolerance]}
      </p>
      {tolerance === "info" && (
        <p className="mt-2 flex items-start gap-1 text-xs text-amber-600 dark:text-amber-500">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          <span>{INFO_WARNING_NOTE}</span>
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-1">
        {SEVERITY_CHIPS.map((severity) => {
          const danger = blocksUnder(tolerance, severity);
          return (
            <span
              key={severity}
              className={cn(
                "rounded px-1.5 py-0.5 font-mono text-[10px]",
                danger
                  ? "bg-destructive/10 text-destructive"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {severity}
            </span>
          );
        })}
      </div>
    </button>
  );
}
