import React from "react";
import { AlertTriangle } from "lucide-react";
import {
  DEFAULT_SUPERSEDE_POLICY,
  SUPERSEDE_POLICIES,
  SUPERSEDE_POLICY_LABELS,
  type SupersedePolicy,
} from "@terragon/shared/model/repo-review-settings";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * #125 C6: the 3-policy selector, in CONSEQUENCE language (never engine
 * jargon). Radix RadioGroup provides the WAI radio-group pattern (roving
 * tabindex, arrow keys, space). The discard card carries an amber warning
 * and the nested "re-verify when the run finishes" toggle; selecting discard
 * announces the warning via the aria-live region. Pure/props-driven so the
 * five section states are testable without a DOM.
 */

export const POLICY_CONSEQUENCE: Record<SupersedePolicy, string> = {
  "newest-wins":
    "A new commit cancels the running review and reviews the newest code instead. You always get feedback on the latest push.",
  "complete-run-queue":
    "The running review finishes first; the new commit waits its turn. Reviews that are already stale skip themselves.",
  "complete-run-discard":
    "The running review finishes; commits pushed meanwhile are NOT reviewed.",
};

// The platform default lives in the shared model (the dispatch resolver uses
// the same constant), so the "Default" badge can never disagree with it.

export function PolicyRadioGroup({
  value,
  recheckOnComplete,
  disabled,
  onSelect,
  onRecheckChange,
  idPrefix = "supersede",
}: {
  /** The persisted/selected policy; null renders the default as selected. */
  value: SupersedePolicy | null;
  recheckOnComplete: boolean;
  disabled?: boolean;
  onSelect: (policy: SupersedePolicy) => void;
  onRecheckChange: (on: boolean) => void;
  idPrefix?: string;
}) {
  const selected = value ?? DEFAULT_SUPERSEDE_POLICY;
  return (
    <RadioGroup
      value={selected}
      onValueChange={(v) => onSelect(v as SupersedePolicy)}
      disabled={disabled}
      aria-label="What happens when a commit lands during a running review"
      className="grid gap-2"
    >
      {SUPERSEDE_POLICIES.map((policy) => {
        const isSelected = selected === policy;
        const id = `${idPrefix}-${policy}`;
        return (
          <label
            key={policy}
            htmlFor={id}
            className={cn(
              "block w-full cursor-pointer rounded-md border p-3 text-left transition-colors",
              "min-h-11", // 44px touch target
              isSelected
                ? "border-primary/50 bg-primary/10"
                : "hover:bg-muted/50",
              disabled && "cursor-not-allowed opacity-50",
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              <RadioGroupItem value={policy} id={id} />
              <span className="text-sm font-medium">
                {SUPERSEDE_POLICY_LABELS[policy]}
              </span>
              {policy === DEFAULT_SUPERSEDE_POLICY && (
                <span className="rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  Default
                </span>
              )}
            </div>
            <p className="mt-2 pl-6 text-xs text-foreground/80">
              {POLICY_CONSEQUENCE[policy]}
            </p>
            {policy === "complete-run-discard" && (
              <div className="mt-2 pl-6" aria-live="polite">
                {isSelected && (
                  <>
                    <p className="flex items-start gap-1 text-xs text-amber-600 dark:text-amber-500">
                      <AlertTriangle
                        className="mt-0.5 h-3 w-3 shrink-0"
                        aria-hidden
                      />
                      <span>
                        Commits pushed during a review will get no feedback
                        unless re-verification is on.
                      </span>
                    </p>
                    <div className="mt-2 flex min-h-11 items-center gap-2">
                      <Switch
                        id={`${idPrefix}-recheck`}
                        checked={recheckOnComplete}
                        onCheckedChange={onRecheckChange}
                        disabled={disabled}
                      />
                      <Label
                        htmlFor={`${idPrefix}-recheck`}
                        className="text-xs"
                      >
                        Re-verify the newest commit when the running review
                        finishes
                      </Label>
                    </div>
                  </>
                )}
              </div>
            )}
          </label>
        );
      })}
    </RadioGroup>
  );
}
