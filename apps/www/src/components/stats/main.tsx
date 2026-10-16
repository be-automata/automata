"use client";

import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import {
  TRIGGER_LABELS,
  type TriggerKind,
} from "@terragon/shared/model/run-state";

import { timeZoneAtom } from "@/atoms/user-cookies";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import {
  formatPercent,
  LoadError,
  PageTitleView,
} from "@/components/ui/register";
import { useAgentActivity } from "@/queries/agent-activity-queries";
import { useActiveOrganization } from "@/queries/organization-queries";
import { statsQueryOptions } from "@/queries/stats-queries";
import { formatRelativeTime } from "@/lib/format-relative-time";
import type {
  DailyUsageStats,
  UsageBreakdowns,
  UsageStatsSummary,
} from "@/server-actions/stats";
import { UsageChart } from "./usage-chart";

type Range = "7" | "30";
type Scope = "mine" | "everyone";

const RANGE_OPTIONS = [
  { value: "7", label: "7d" },
  { value: "30", label: "30d" },
] as const;
const SCOPE_OPTIONS = [
  { value: "mine", label: "Mine" },
  { value: "everyone", label: "Everyone" },
] as const;
const SOURCE_ORDER: TriggerKind[] = [
  "web",
  "automation",
  "github",
  "slack",
  "cli",
];
const SOURCE_SHADES = [
  "bg-foreground",
  "bg-muted-foreground",
  "bg-border",
  "bg-line-soft",
  "bg-muted",
];
const th =
  "h-7 px-2.5 text-left text-[11px] font-normal text-muted-foreground whitespace-nowrap";
const td = "h-8 px-2.5 border-b border-line-soft whitespace-nowrap";

function Band({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="grid grid-cols-1 gap-4 border-t border-border py-4 md:grid-cols-[140px_minmax(0,1fr)]"
    >
      <h2 className="text-[13px] font-bold leading-[18px]">{title}</h2>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function Figure({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  return (
    <div>
      <div className={`text-xl font-bold leading-6 ${className ?? ""}`}>
        {value}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  return (
    <span className="inline-flex h-5 items-end gap-[2px]" aria-hidden="true">
      {values.map((v, i) => (
        <span
          key={i}
          className="w-[5px] bg-foreground/80"
          style={{ height: `${Math.max(1, Math.round((v / max) * 20))}px` }}
        />
      ))}
    </span>
  );
}

export function Stats() {
  const [timeZone] = useAtom(timeZoneAtom);
  const [range, setRange] = useState<Range>("7");
  const [scope, setScope] = useState<Scope>("everyone");
  const { activeOrganization } = useActiveOrganization();
  const { data, isLoading, isError, refetch } = useQuery(
    statsQueryOptions({
      numDays: Number(range),
      timezone: timeZone,
      mineOnly: scope === "mine",
    }),
  );
  // Same key as the sidebar badge, so the running count costs no extra poll.
  const { data: activity } = useAgentActivity({
    mineOnly: false,
    peopleOnly: false,
  });
  return (
    <StatsView
      organization={activeOrganization}
      data={data}
      isLoading={isLoading}
      isError={isError}
      onRetry={() => refetch()}
      runningNow={activity?.counts.running ?? 0}
      scope={scope}
      onScopeChange={setScope}
      range={range}
      onRangeChange={setRange}
    />
  );
}

/** Usage without data fetching, so its states can be rendered in tests. */
export function StatsView({
  organization,
  data,
  isLoading,
  isError,
  onRetry,
  runningNow,
  scope,
  onScopeChange,
  range,
  onRangeChange,
}: {
  organization: { id: string; name: string; logo?: string | null } | null;
  data:
    | {
        dailyStats: DailyUsageStats[];
        summary: UsageStatsSummary;
        breakdowns: UsageBreakdowns | null;
      }
    | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  runningNow: number;
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  range: Range;
  onRangeChange: (range: Range) => void;
}) {
  const header = (
    <PageTitleView title="Usage" organization={organization}>
      <Segmented
        ariaLabel="Whose usage"
        value={scope}
        options={SCOPE_OPTIONS}
        onChange={onScopeChange}
      />
      <Segmented
        ariaLabel="Date range"
        value={range}
        options={RANGE_OPTIONS}
        onChange={onRangeChange}
      />
    </PageTitleView>
  );

  if (isError) {
    return (
      <div className="flex w-full flex-col gap-4">
        {header}
        <LoadError
          message="Usage statistics could not be loaded."
          onRetry={onRetry}
        />
      </div>
    );
  }
  if (isLoading || !data) {
    return (
      <div className="flex w-full flex-col gap-4">
        {header}
        <div
          className="flex flex-col gap-3 border-t border-border pt-4"
          aria-busy="true"
        >
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  const { summary, breakdowns } = data;
  const totalSources = breakdowns
    ? SOURCE_ORDER.reduce((n, k) => n + breakdowns.bySource[k], 0)
    : 0;

  return (
    <div className="flex w-full flex-col gap-2 pb-8">
      {header}
      {!breakdowns ? (
        <p className="font-sans text-[13px] text-muted-foreground">
          Choose an organization to see its usage. These are your own tasks.
        </p>
      ) : null}

      <div className="mt-2">
        <Band title="Activity">
          <div className="flex flex-wrap gap-9">
            <Figure
              value={summary.totalThreadsCreated.toLocaleString("en-US")}
              label="tasks"
            />
            <Figure value={String(runningNow)} label="running now" />
            {breakdowns ? (
              <Figure
                value={String(breakdowns.byRepo.length)}
                label="active repos"
              />
            ) : null}
          </div>
          <UsageChart dailyStats={data.dailyStats} series="threads" />
          {breakdowns && totalSources > 0 ? (
            <div className="mt-3 max-w-xl">
              <div
                className="flex h-2 overflow-hidden rounded-[1px]"
                aria-hidden="true"
              >
                {SOURCE_ORDER.map((kind, i) =>
                  breakdowns.bySource[kind] > 0 ? (
                    <span
                      key={kind}
                      className={SOURCE_SHADES[i]}
                      style={{
                        width: `${(breakdowns.bySource[kind] / totalSources) * 100}%`,
                      }}
                    />
                  ) : null,
                )}
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {SOURCE_ORDER.filter((k) => breakdowns.bySource[k] > 0)
                  .map(
                    (k) =>
                      `${TRIGGER_LABELS[k]} ${formatPercent(breakdowns.bySource[k], totalSources)}`,
                  )
                  .join(" · ")}
              </p>
            </div>
          ) : null}
        </Band>

        <Band title="Outcomes">
          <div className="flex flex-wrap gap-9">
            <Figure
              value={summary.totalPRsMerged.toLocaleString("en-US")}
              label="PRs merged"
            />
            {breakdowns ? (
              <>
                <Figure
                  value={formatPercent(
                    breakdowns.funnel.completed,
                    breakdowns.funnel.started,
                  )}
                  label="completed"
                  className="text-state-done"
                />
                <Figure
                  value={formatPercent(
                    breakdowns.errored,
                    breakdowns.funnel.started,
                  )}
                  label="errored"
                  className="text-state-needs-you"
                />
              </>
            ) : null}
          </div>
          <UsageChart dailyStats={data.dailyStats} series="prs" />
        </Band>

        {breakdowns ? (
          <>
            <Band title="Where">
              <WhereTables breakdowns={breakdowns} />
            </Band>
            <Band title="From task to merged PR">
              <Funnel funnel={breakdowns.funnel} />
            </Band>
            <Band title="Not finished">
              <NotFinished causes={breakdowns.notFinished} />
            </Band>
          </>
        ) : null}
      </div>
    </div>
  );
}

function WhereTables({ breakdowns }: { breakdowns: UsageBreakdowns }) {
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border">
              <th className={th}>Repository</th>
              <th className={`${th} text-right`}>Tasks</th>
              <th className={`${th} text-right`}>Merged</th>
              <th className={`${th} text-right`}>Merge rate</th>
              <th className={`${th} text-right`}>Error rate</th>
              <th className={th}>Per day</th>
              <th className={th}>Last activity</th>
            </tr>
          </thead>
          <tbody>
            {breakdowns.byRepo.map((repo) => (
              <tr key={repo.repoFullName}>
                <td
                  className={`${td} max-w-[320px] truncate ${repo.hidden ? "text-muted-foreground" : ""}`}
                  title={
                    repo.hidden
                      ? "Repositories you cannot see on GitHub"
                      : repo.repoFullName
                  }
                >
                  {repo.repoFullName}
                </td>
                <td className={`${td} text-right`}>{repo.tasks}</td>
                <td className={`${td} text-right`}>{repo.merged}</td>
                <td className={`${td} text-right`}>
                  {formatPercent(repo.merged, repo.tasks)}
                </td>
                <td className={`${td} text-right`}>
                  {formatPercent(repo.errored, repo.tasks)}
                </td>
                <td className={td}>
                  <Sparkline values={repo.daily} />
                </td>
                <td className={`${td} text-muted-foreground`}>
                  {formatRelativeTime(repo.lastActivityAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {breakdowns.byRepo.length === 0 ? (
          <p className="py-3 font-sans text-[13px] text-muted-foreground">
            No tasks in this range.
          </p>
        ) : null}
      </div>
      {breakdowns.byMember.length > 0 ? (
        <div className="mt-6 overflow-x-auto">
          <h3 className="mb-1 text-xs text-muted-foreground">
            By member · counts only
          </h3>
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-border">
                <th className={th}>Member</th>
                <th className={`${th} text-right`}>Tasks</th>
                <th className={`${th} text-right`}>Merged</th>
                <th className={th}>Top source</th>
              </tr>
            </thead>
            <tbody>
              {breakdowns.byMember.map((member) => (
                <tr key={member.userId}>
                  <td className={`${td} w-full`}>
                    {member.name ?? "Unknown member"}
                  </td>
                  <td className={`${td} text-right`}>{member.tasks}</td>
                  <td className={`${td} text-right`}>{member.merged}</td>
                  <td className={`${td} text-muted-foreground`}>
                    {TRIGGER_LABELS[member.topSource]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}

function Funnel({ funnel }: { funnel: UsageBreakdowns["funnel"] }) {
  const steps = [
    { label: "Started", value: funnel.started },
    { label: "Completed", value: funnel.completed },
    { label: "Opened a PR", value: funnel.openedPR },
    { label: "Merged", value: funnel.merged },
  ];
  return (
    <table className="w-full border-collapse text-xs">
      <tbody>
        {steps.map((step) => {
          const share =
            funnel.started === 0 ? 0 : Math.min(1, step.value / funnel.started);
          return (
            <tr key={step.label}>
              <td className={`${td} w-32`}>{step.label}</td>
              <td className={`${td} w-14 text-right`}>{step.value}</td>
              <td className={`${td} w-full`}>
                <span
                  className="block h-3 bg-foreground/80"
                  style={{ width: `${Math.round(share * 100)}%` }}
                />
              </td>
              <td className={`${td} text-right text-muted-foreground`}>
                {formatPercent(step.value, funnel.started)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function NotFinished({ causes }: { causes: UsageBreakdowns["notFinished"] }) {
  if (causes.length === 0) {
    return (
      <p className="font-sans text-[13px] text-muted-foreground">
        Every run in this range finished.
      </p>
    );
  }
  const total = causes.reduce((n, c) => n + c.count, 0);
  return (
    <table className="w-full border-collapse text-xs">
      <thead>
        <tr className="border-b border-border">
          <th className={th}>Why runs did not finish · {total}</th>
          <th className={`${th} text-right`}>Runs</th>
        </tr>
      </thead>
      <tbody>
        {causes.map((cause) => (
          <tr key={cause.label}>
            <td className={`${td} w-full`}>{cause.label}</td>
            <td className={`${td} text-right`}>{cause.count}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
