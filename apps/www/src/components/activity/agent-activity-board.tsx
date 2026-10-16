"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AgentActivityRow } from "@terragon/shared/model/agent-activity";
import { TRIGGER_LABELS } from "@terragon/shared/model/run-state";

import { Button } from "@/components/ui/button";
import { RunStateGlyph, RunStateLabel } from "@/components/ui/run-state";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { OrgName } from "@/components/org-avatar";
import { useAgentActivity } from "@/queries/agent-activity-queries";
import { useActiveOrganization } from "@/queries/organization-queries";
import { readThread } from "@/server-actions/read-thread";
import { formatRelativeTime } from "@/lib/format-relative-time";
import { unwrapError, unwrapResult } from "@/lib/server-actions";
import { cn } from "@/lib/utils";

type Scope = "mine" | "everyone";
type Who = "people" | "all";

const SCOPE_OPTIONS = [
  { value: "mine", label: "Mine" },
  { value: "everyone", label: "Everyone" },
] as const;
const WHO_OPTIONS = [
  { value: "people", label: "People" },
  { value: "all", label: "All" },
] as const;

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function formatElapsed(fromMs: number, nowMs: number) {
  const total = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

function starterLabel(row: AgentActivityRow) {
  const trigger = TRIGGER_LABELS[row.trigger];
  if (row.starter.kind === "automation") {
    return row.automationName ? `${trigger} · ${row.automationName}` : trigger;
  }
  if (row.starter.kind === "you") {
    return `${trigger} · you`;
  }
  return row.starter.name ? `${trigger} · ${row.starter.name}` : trigger;
}

function RunTitle({
  row,
  className,
}: {
  row: AgentActivityRow;
  className?: string;
}) {
  if (!row.canOpen || row.title === null) {
    return (
      <span className={cn("text-muted-foreground", className)}>
        Private task
      </span>
    );
  }
  return (
    <Link
      href={`/task/${row.threadId}`}
      className={cn(
        "min-w-0 truncate hover:underline underline-offset-2",
        className,
      )}
      title={row.title}
    >
      {row.title}
    </Link>
  );
}

function SectionHeader({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-2 border-b border-border pb-1.5">
      <h2 className="text-[15px] leading-5 font-bold">{title}</h2>
      {meta ? (
        <span className="text-xs text-muted-foreground">{meta}</span>
      ) : null}
      {children ? (
        <div className="ml-auto flex items-center gap-2">{children}</div>
      ) : null}
    </div>
  );
}

function NeedsYouRow({ row }: { row: AgentActivityRow }) {
  const queryClient = useQueryClient();
  const [dismissing, setDismissing] = useState(false);
  const explanation = row.needsYou;
  const dismiss = async () => {
    setDismissing(true);
    try {
      unwrapResult(
        await readThread({ threadId: row.threadId, threadChatIdOrNull: null }),
      );
      await queryClient.invalidateQueries({ queryKey: ["agent-activity"] });
    } catch (error) {
      toast.error(unwrapError(error));
      setDismissing(false);
    }
  };
  return (
    <li className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 motion-safe:duration-200 grid grid-cols-1 gap-3 border-b border-line-soft py-3 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex items-center gap-2 font-bold">
          <RunStateGlyph kind="needs-you" />
          <span className="min-w-0 truncate">
            {explanation?.title ?? "Agent error"}
            {row.canOpen && row.title ? (
              <span className="font-normal text-muted-foreground">
                {" "}
                · {row.title}
              </span>
            ) : null}
          </span>
        </div>
        {explanation ? (
          <p className="ml-[17px] mt-1 font-sans text-[13px] leading-5">
            {explanation.reason}
          </p>
        ) : null}
        <p className="ml-[17px] mt-0.5 truncate text-xs text-muted-foreground">
          {[
            row.repoFullName,
            row.branchName,
            starterLabel(row),
            formatRelativeTime(row.updatedAt),
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
      <div className="ml-[17px] flex gap-2 sm:ml-0">
        {explanation?.action === "reconnect-credential" ? (
          <Button asChild size="sm">
            <Link href="/settings/agent">Reconnect credential</Link>
          </Button>
        ) : row.canOpen ? (
          <Button asChild size="sm">
            <Link href={`/task/${row.threadId}`}>Open task</Link>
          </Button>
        ) : null}
        {row.starter.kind === "you" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={dismissing}
            onClick={dismiss}
          >
            {dismissing ? "Dismissing…" : "Dismiss"}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function ActiveRow({ row, now }: { row: AgentActivityRow; now: number }) {
  return (
    <li className="grid grid-cols-[minmax(0,auto)_1fr] items-center gap-x-3 gap-y-0.5 border-b border-line-soft py-2 text-xs md:h-8 md:grid-cols-[140px_minmax(0,1fr)_160px_180px_72px_56px] md:py-0">
      <RunStateLabel state={row.state} showReason={false} />
      <span className="flex min-w-0 items-center gap-1.5">
        <RunTitle row={row} />
        {row.state.reason ? (
          <span className="hidden shrink-0 text-muted-foreground lg:inline">
            · {row.state.reason}
          </span>
        ) : null}
      </span>
      <span className="col-span-2 truncate text-muted-foreground md:col-span-1">
        <span className="md:hidden">{row.repoFullName} · </span>
        {row.branchName ?? "—"}
      </span>
      <span className="hidden truncate text-muted-foreground md:block">
        {starterLabel(row)}
      </span>
      <span className="hidden text-right text-muted-foreground md:block">
        {formatElapsed(new Date(row.startedAt).getTime(), now)}
      </span>
      <span className="hidden justify-self-end md:block">
        {row.prNumber ? (
          <span className="rounded-sm border border-border px-1 text-muted-foreground">
            #{row.prNumber}
          </span>
        ) : null}
      </span>
    </li>
  );
}

function RecentRow({ row }: { row: AgentActivityRow }) {
  return (
    <li className="grid grid-cols-[minmax(0,auto)_1fr] items-center gap-x-3 border-b border-line-soft py-2 text-xs md:h-8 md:grid-cols-[110px_minmax(0,1fr)_220px_200px_64px] md:py-0">
      <RunStateLabel state={row.state} showReason={false} />
      <RunTitle row={row} />
      <span className="hidden truncate text-muted-foreground md:block">
        {row.repoFullName}
      </span>
      <span className="hidden truncate text-muted-foreground md:block">
        {starterLabel(row)}
      </span>
      <span className="hidden text-right text-muted-foreground md:block">
        {formatRelativeTime(row.updatedAt)}
      </span>
    </li>
  );
}

function SkeletonRows() {
  return (
    <ul aria-busy="true" aria-label="Loading">
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="flex h-8 items-center gap-3 border-b border-line-soft"
        >
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-16" />
        </li>
      ))}
    </ul>
  );
}

/**
 * Home's answer to "what is every agent doing, where, and what needs me":
 * Needs you, then Running now grouped by repository, then Recent.
 */
export function AgentActivityBoard() {
  const [scope, setScope] = useState<Scope>("everyone");
  const [who, setWho] = useState<Who>("all");
  const { activeOrganization } = useActiveOrganization();
  const { data, isLoading, isError, refetch } = useAgentActivity({
    mineOnly: scope === "mine",
    peopleOnly: who === "people",
  });
  const now = useNow(1000);

  const byRepo = useMemo(() => {
    const groups = new Map<string, AgentActivityRow[]>();
    for (const row of data?.active ?? []) {
      groups.set(row.repoFullName, [
        ...(groups.get(row.repoFullName) ?? []),
        row,
      ]);
    }
    return [...groups];
  }, [data?.active]);

  const orgLabel = activeOrganization ? (
    <span className="inline-flex items-center gap-1.5 align-middle">
      in <OrgName organization={activeOrganization} size="xs" />
    </span>
  ) : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-baseline gap-2.5">
        <h1 className="text-xl font-bold leading-6">Home</h1>
        <span className="min-w-0 text-xs text-muted-foreground">
          {orgLabel}
        </span>
      </div>

      {isError ? (
        <div className="flex items-center gap-3 border-y border-border py-3 text-xs">
          <RunStateGlyph kind="needs-you" />
          <span className="font-sans text-[13px]">
            Agent activity could not be loaded.
          </span>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      ) : null}

      {data && data.needsYou.length > 0 ? (
        <section aria-label="Needs you">
          <SectionHeader title="Needs you" meta={data.needsYou.length} />
          <ul>
            {data.needsYou.map((row) => (
              <NeedsYouRow key={row.threadId} row={row} />
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="Running now">
        <SectionHeader
          title="Running now"
          meta={
            data
              ? `${data.counts.running} running · ${data.counts.waiting} waiting · ${data.counts.needsYou} need you`
              : null
          }
        >
          <Segmented
            ariaLabel="Whose runs"
            value={scope}
            options={SCOPE_OPTIONS}
            onChange={setScope}
          />
          <Segmented
            ariaLabel="Which runs"
            value={who}
            options={WHO_OPTIONS}
            onChange={setWho}
          />
        </SectionHeader>
        {isLoading ? (
          <SkeletonRows />
        ) : byRepo.length === 0 ? (
          <p className="py-4 font-sans text-[13px] text-muted-foreground">
            No agents running
            {activeOrganization ? ` in ${activeOrganization.name}` : ""}. Start
            a task below or{" "}
            <Link href="/automations" className="underline underline-offset-2">
              run an automation
            </Link>
            .
          </p>
        ) : (
          byRepo.map(([repo, rows]) => (
            <div key={repo}>
              <p className="px-0 pb-1 pt-3 text-xs text-muted-foreground md:px-2.5">
                <span className="font-medium text-foreground">{repo}</span> ·{" "}
                {rows.length}
              </p>
              <ul className="md:px-2.5">
                {rows.map((row) => (
                  <ActiveRow key={row.threadId} row={row} now={now} />
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      {data && data.recent.length > 0 ? (
        <section aria-label="Recent">
          <SectionHeader title="Recent" meta="last 24 hours" />
          <ul className="md:px-2.5">
            {data.recent.map((row) => (
              <RecentRow key={row.threadId} row={row} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
