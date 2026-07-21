import type { BlockTolerance } from "@terragon/review/severity-policy";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { DEFAULT_TOLERANCE, TOLERANCE_ORDER } from "./constants";
import { ToleranceRadioCard } from "./tolerance-radio-card";

interface RepoRowProps {
  repoFullName: string;
  /** The persisted tolerance in effect for this repo (override or the default). */
  tolerance: BlockTolerance;
  /** Whether this repo has an explicit override (vs. running on the default). */
  hasOverride: boolean;
  /** Draft selection (may differ from the persisted value). */
  draft: BlockTolerance;
  expanded: boolean;
  dirty: boolean;
  saving: boolean;
  saved: boolean;
  saveError: string | null;
  onToggle(): void;
  onSelect(tolerance: BlockTolerance): void;
  onSave(): void;
  onDiscard(): void;
  onReset(): void;
}

export function RepoRow({
  repoFullName,
  tolerance,
  hasOverride,
  draft,
  expanded,
  dirty,
  saving,
  saved,
  saveError,
  onToggle,
  onSelect,
  onSave,
  onDiscard,
  onReset,
}: RepoRowProps) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-muted/50"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-sm">{repoFullName}</span>
          {dirty && (
            <span className="flex shrink-0 items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
              <span className="h-2 w-2 rounded-full bg-amber-500" aria-hidden />
              Unsaved
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge
            variant={hasOverride ? "secondary" : "outline"}
            className={cn("font-mono", hasOverride && "text-primary")}
          >
            {tolerance} · {hasOverride ? "custom" : "default"}
          </Badge>
          <ChevronDown
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform",
              expanded && "rotate-180",
            )}
            aria-hidden
          />
        </div>
      </button>

      {expanded && (
        <div className="border-t px-4 py-4">
          <div
            role="radiogroup"
            aria-label={`Review tolerance for ${repoFullName}`}
            className="grid grid-cols-1 gap-3 md:grid-cols-3"
          >
            {TOLERANCE_ORDER.map((option) => (
              <ToleranceRadioCard
                key={option}
                tolerance={option}
                selected={draft === option}
                isPersisted={tolerance === option}
                disabled={saving}
                onSelect={onSelect}
              />
            ))}
          </div>

          {dirty && (
            <p className="mt-3 text-xs text-amber-600 dark:text-amber-500">
              Unsaved change — reviews still use{" "}
              <span className="font-mono">{tolerance}</span> until you save.
            </p>
          )}

          {saved && !dirty && (
            <div className="mt-3 rounded-md border border-primary/40 bg-primary/10 p-3 text-xs text-primary">
              <div className="flex items-center gap-1 font-medium">
                <Check className="h-3 w-3" aria-hidden />
                Saved
              </div>
              <div className="mt-1 text-foreground/70">
                Applies to the next review run for this repository — in-flight
                reviews keep the previous tolerance.
              </div>
            </div>
          )}

          {saveError && (
            <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
              {saveError}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              type="button"
              size="sm"
              onClick={onSave}
              disabled={!dirty || saving}
            >
              {saving && (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              )}
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onDiscard}
              disabled={!dirty || saving}
            >
              Discard
            </Button>
            {hasOverride && (
              <Button
                type="button"
                size="sm"
                variant="link"
                onClick={onReset}
                disabled={saving}
                className="h-auto p-0 text-xs text-muted-foreground"
              >
                Reset to default ({DEFAULT_TOLERANCE})
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
