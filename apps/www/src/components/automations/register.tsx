"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Automation } from "@terragon/shared";
import type { AutomationTriggerType } from "@terragon/shared/automations";
import type { AutomationHealth } from "@terragon/shared/model/automation-health";

import { cn } from "@/lib/utils";
import { AutomationItem } from "./item";
import {
  AutomationHealthLabel,
  AutomationHealthPanel,
  formatSuccessRate,
} from "./health";

type Filter = "all" | AutomationTriggerType | "attention";

const TRIGGER_LABEL: Record<AutomationTriggerType, string> = {
  schedule: "Schedule",
  pull_request: "Pull request",
  issue: "Issue",
  github_mention: "Mention",
  manual: "Manual",
};

const WIDE_QUERY = "(min-width: 1024px)";

function needsAttention(health: AutomationHealth | undefined) {
  return (
    !!health &&
    (health.health === "degraded" || health.lastRun?.state.kind === "needs-you")
  );
}

/**
 * Automations as a reliability register (DESIGN.md): a health list on the
 * left, the selected automation's trigger, health and runs on the right. The
 * selection lives in `?selected=` so it survives a reload and can be shared;
 * below 1024px a row opens the automation's own page instead.
 */
export function AutomationsRegister({
  automations,
  healthById,
  onEdit,
  onDuplicate,
}: {
  automations: Automation[];
  healthById: Map<string, AutomationHealth>;
  onEdit: (automation: Automation) => void;
  onDuplicate: (automation: Automation) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [filter, setFilter] = useState<Filter>("all");

  const filters = useMemo(() => {
    const counts = new Map<Filter, number>([["all", automations.length]]);
    for (const automation of automations) {
      counts.set(
        automation.triggerType,
        (counts.get(automation.triggerType) ?? 0) + 1,
      );
      if (needsAttention(healthById.get(automation.id))) {
        counts.set("attention", (counts.get("attention") ?? 0) + 1);
      }
    }
    const options: { value: Filter; label: string; count: number }[] = [
      { value: "all", label: "All", count: automations.length },
    ];
    for (const type of Object.keys(TRIGGER_LABEL) as AutomationTriggerType[]) {
      const count = counts.get(type) ?? 0;
      if (count > 0) {
        options.push({ value: type, label: TRIGGER_LABEL[type], count });
      }
    }
    const attention = counts.get("attention") ?? 0;
    if (attention > 0) {
      options.push({
        value: "attention",
        label: "Needs attention",
        count: attention,
      });
    }
    return options;
  }, [automations, healthById]);

  const visible = automations.filter((automation) =>
    filter === "all"
      ? true
      : filter === "attention"
        ? needsAttention(healthById.get(automation.id))
        : automation.triggerType === filter,
  );

  const selectedId = searchParams.get("selected");
  const selected =
    automations.find((a) => a.id === selectedId) ??
    automations.find((a) => needsAttention(healthById.get(a.id))) ??
    automations[0];

  const select = (automation: Automation) => {
    if (!window.matchMedia(WIDE_QUERY).matches) {
      router.push(`/automations/${automation.id}`);
      return;
    }
    const params = new URLSearchParams(searchParams.toString());
    params.set("selected", automation.id);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <section aria-label="Automation health" className="min-w-0">
        <div
          className="mb-2 flex flex-wrap gap-1.5"
          role="group"
          aria-label="Filter automations"
        >
          {filters.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={filter === option.value}
              onClick={() => setFilter(option.value)}
              className={cn(
                "min-h-7 rounded-md border border-border px-2.5 text-xs transition-colors duration-150 max-md:min-h-11",
                filter === option.value
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-card hover:bg-accent",
              )}
            >
              {option.label} {option.count}
            </button>
          ))}
        </div>
        <ul className="border-t border-border">
          {visible.map((automation) => {
            const health = healthById.get(automation.id);
            const isSelected = selected?.id === automation.id;
            return (
              <li key={automation.id}>
                <button
                  type="button"
                  onClick={() => select(automation)}
                  aria-current={isSelected ? "true" : undefined}
                  className={cn(
                    "grid w-full grid-cols-[96px_minmax(0,1fr)_48px] items-center gap-3 border-b border-line-soft px-2 py-2 text-left text-xs transition-colors duration-150 hover:bg-accent/60",
                    isSelected && "lg:bg-accent",
                  )}
                >
                  {health ? (
                    <AutomationHealthLabel health={health.health} />
                  ) : (
                    <span className="text-muted-foreground">…</span>
                  )}
                  <span className="min-w-0">
                    <span
                      className={cn(
                        "block truncate",
                        !automation.enabled && "text-muted-foreground",
                      )}
                    >
                      {automation.name}
                    </span>
                    <span className="block truncate text-muted-foreground">
                      {TRIGGER_LABEL[automation.triggerType]} ·{" "}
                      {automation.repoFullName}
                      {automation.triggerType === "schedule" ||
                      automation.triggerType === "manual"
                        ? ` · ${automation.branchName}`
                        : ""}
                    </span>
                  </span>
                  <span className="text-right">
                    {formatSuccessRate(health?.successRate7d ?? null)}
                  </span>
                </button>
              </li>
            );
          })}
          {visible.length === 0 ? (
            <li className="py-3 font-sans text-[13px] text-muted-foreground">
              No automations match this filter.
            </li>
          ) : null}
        </ul>
      </section>
      {selected ? (
        <section
          aria-label="Selected automation"
          className="hidden min-w-0 flex-col gap-5 lg:flex lg:border-l lg:border-border lg:pl-6"
        >
          <AutomationItem
            automation={selected}
            onEdit={onEdit}
            onDuplicate={onDuplicate}
            verbose={true}
          />
          <AutomationHealthPanel health={healthById.get(selected.id)} />
        </section>
      ) : null}
    </div>
  );
}
