"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import {
  TRIGGER_LABELS,
  type TriggerKind,
} from "@terragon/shared/model/run-state";

import { timeZoneAtom } from "@/atoms/user-cookies";
import { Button } from "@/components/ui/button";
import { RunStateGlyph } from "@/components/ui/run-state";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { OrgName } from "@/components/org-avatar";
import { useAgentActivity } from "@/queries/agent-activity-queries";
import { useActiveOrganization } from "@/queries/organization-queries";
import { statsQueryOptions } from "@/queries/stats-queries";
import { formatRelativeTime } from "@/lib/format-relative-time";
import { UsageChart } from "./usage-chart";

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

function percent(part: number, whole: number) {
  return whole === 0 ? "—" : `${Math.round((part / whole) * 100)}%`;
}

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

const th =
  "h-7 px-2.5 text-left text-[11px] font-normal text-muted-foreground whitespace-nowrap";
const td = "h-8 px-2.5 border-b border-line-soft whitespace-nowrap";

export function Stats() {
  const [timeZone] = useAtom(timeZoneAtom);
  const [range, setRange] = useState<"7" | "30">("7");
  const [scope, setScope] = useState<"mine" | "everyone">("everyone");
  const { activeOrganization } = useActiveOrganization();
  const mineOnly = scope === "mine";
  const { data, isLoading, error, refetch } = useQuery(
    statsQueryOptions({ numDays: Number(range), timezone: timeZone, mineOnly }),
  );
  const { data: activity } = useAgentActivity({ mineOnly, peopleOnly: false });

  const header = (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
      <h1 className="text-xl font-bold leading-6">Usage</h1>
      {activeOrganization ? (
        <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          in <OrgName organization={activeOrganization} size="xs" />
        </span>
      ) : null}
      <div className="ml-auto flex gap-2">
        <Segmented
          ariaLabel="Whose usage"
          value={scope}
          options={SCOPE_OPTIONS}
          onChange={setScope}
        />
        <Segmented
          ariaLabel="Date range"
          value={range}
          options={RANGE_OPTIONS}
          onChange={setRange}
        />
      </div>
    </div>
  );

  if (error) {
    return (
      <div className="flex w-full flex-col gap-4">
        {header}
        <div className="flex items-center gap-3 border-y border-border py-3 text-xs">
          <RunStateGlyph kind="needs-you" />
          <span className="font-sans text-[13px]">
            Usage statistics could not be loaded.
          </span>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
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
  const totalSources = SOURCE_ORDER.reduce(
    (n, k) => n + breakdowns.bySource[k],
    0,
  );
  const funnelSteps = [
    { label: "Started", value: breakdowns.funnel.started },
    { label: "Completed", value: breakdowns.funnel.completed },
    { label: "Opened a PR", value: breakdowns.funnel.openedPR },
    { label: "Merged", value: breakdowns.funnel.merged },
  ];
  const notFinishedTotal = breakdowns.notFinished.reduce(
    (n, c) => n + c.count,
    0,
  );

  return (
    <div className="flex w-full flex-col gap-2 pb-8">
      {header}
      {!breakdowns.orgScoped ? (
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
            <Figure
              value={String(activity?.counts.running ?? 0)}
              label="running now"
            />
            <Figure
              value={String(breakdowns.byRepo.length)}
              label="active repos"
            />
          </div>
          <UsageChart dailyStats={data.dailyStats} series="threads" />
          {totalSources > 0 ? (
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
                      `${TRIGGER_LABELS[k]} ${percent(breakdowns.bySource[k], totalSources)}`,
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
            <Figure
              value={percent(summary.completed, summary.totalThreadsCreated)}
              label="completed"
              className="text-state-done"
            />
            <Figure
              value={percent(summary.errored, summary.totalThreadsCreated)}
              label="errored"
              className="text-state-needs-you"
            />
          </div>
          <UsageChart dailyStats={data.dailyStats} series="prs" />
        </Band>

        {breakdowns.orgScoped ? (
          <Band title="Where">
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
                        className={`${td} max-w-[320px] truncate`}
                        title={repo.repoFullName}
                      >
                        {repo.repoFullName}
                      </td>
                      <td className={`${td} text-right`}>{repo.tasks}</td>
                      <td className={`${td} text-right`}>{repo.merged}</td>
                      <td className={`${td} text-right`}>
                        {percent(repo.merged, repo.tasks)}
                      </td>
                      <td className={`${td} text-right`}>
                        {percent(repo.errored, repo.tasks)}
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
          </Band>
        ) : null}

        {breakdowns.orgScoped ? (
          <Band title="From task to merged PR">
            <table className="w-full border-collapse text-xs">
              <tbody>
                {funnelSteps.map((step) => {
                  const share =
                    breakdowns.funnel.started === 0
                      ? 0
                      : step.value / breakdowns.funnel.started;
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
                        {percent(step.value, breakdowns.funnel.started)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Band>
        ) : null}

        {breakdowns.orgScoped ? (
          <Band title="Not finished">
            {breakdowns.notFinished.length === 0 ? (
              <p className="font-sans text-[13px] text-muted-foreground">
                Every run in this range finished.
              </p>
            ) : (
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-border">
                    <th className={th}>
                      Why runs did not finish · {notFinishedTotal}
                    </th>
                    <th className={`${th} text-right`}>Runs</th>
                  </tr>
                </thead>
                <tbody>
                  {breakdowns.notFinished.map((cause) => (
                    <tr key={cause.label}>
                      <td className={`${td} w-full`}>{cause.label}</td>
                      <td className={`${td} text-right`}>{cause.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Band>
        ) : null}
      </div>
    </div>
  );
}
