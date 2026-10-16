"use client";

import React from "react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  AgentActivityRow,
  OrgAgentActivity,
} from "@terragon/shared/model/agent-activity";
import { TRIGGER_LABELS } from "@terragon/shared/model/run-state";

import { Button } from "@/components/ui/button";
import { RunStateGlyph, RunStateLabel } from "@/components/ui/run-state";
import { Segmented } from "@/components/ui/segmented";
import {
  LoadError,
  PageTitleView,
  SectionHeader,
} from "@/components/ui/register";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgentActivity } from "@/queries/agent-activity-queries";
import { useActiveOrganization } from "@/queries/organization-queries";
import { readThread } from "@/server-actions/read-thread";
import { formatRelativeTime } from "@/lib/format-relative-time";
import { unwrapError, unwrapResult } from "@/lib/server-actions";
import { cn } from "@/lib/utils";

type Scope = "mine" | "everyone";

/** Shown for repos the viewer can neither open nor see on GitHub. */
const HIDDEN_REPOS = "Other repositories";
type Who = "people" | "all";

const SCOPE_OPTIONS = [
  { value: "mine", label: "Mine" },
  { value: "everyone", label: "Everyone" },
] as const;
const WHO_OPTIONS = [
  { value: "people", label: "People" },
  { value: "all", label: "All" },
] as const;

function useNow(intervalMs: number, enabled: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}

/** Ticks on its own, so only the timer re-renders each second. */
function Elapsed({ from, now }: { from: Date | string; now?: number }) {
  const tick = useNow(1000, now === undefined);
  return <>{formatElapsed(new Date(from).getTime(), now ?? tick)}</>;
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

function NeedsYouRow({
  row,
  onDismiss,
}: {
  row: AgentActivityRow;
  onDismiss: (threadId: string) => Promise<boolean>;
}) {
  const [dismissing, setDismissing] = useState(false);
  const explanation = row.needsYou;
  const dismiss = async () => {
    setDismissing(true);
    if (!(await onDismiss(row.threadId))) {
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
            row.repoFullName ?? HIDDEN_REPOS,
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

function ActiveRow({ row, now }: { row: AgentActivityRow; now?: number }) {
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
        <span className="md:hidden">{row.repoFullName ?? HIDDEN_REPOS} · </span>
        {row.branchName ?? "—"}
      </span>
      <span className="hidden truncate text-muted-foreground md:block">
        {starterLabel(row)}
      </span>
      <span className="hidden whitespace-nowrap text-right text-muted-foreground md:block">
        <Elapsed from={row.startedAt} now={now} />
      </span>
      <span className="hidden justify-self-end md:block">
        {row.prNumber ? (
          <span className="rounded-sm border border-border px-1 text-muted-foreground">
            #{row.prNumber}
            {row.prStatus ? ` ${row.prStatus}` : null}
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
        {row.repoFullName ?? HIDDEN_REPOS}
      </span>
      <span className="hidden truncate text-muted-foreground md:block">
        {starterLabel(row)}
      </span>
      <span className="hidden whitespace-nowrap text-right text-muted-foreground md:block">
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
  const queryClient = useQueryClient();
  const onDismiss = async (threadId: string) => {
    try {
      unwrapResult(await readThread({ threadId, threadChatIdOrNull: null }));
      await queryClient.invalidateQueries({ queryKey: ["agent-activity"] });
      return true;
    } catch (error) {
      toast.error(unwrapError(error));
      return false;
    }
  };
  return (
    <AgentActivityBoardView
      organization={activeOrganization}
      data={data}
      isLoading={isLoading}
      isError={isError}
      onRetry={() => refetch()}
      onDismiss={onDismiss}
      scope={scope}
      onScopeChange={setScope}
      who={who}
      onWhoChange={setWho}
    />
  );
}

/** The board without data fetching, so its states can be rendered in tests. */
export function AgentActivityBoardView({
  organization: activeOrganization,
  data,
  isLoading,
  isError,
  onRetry,
  onDismiss,
  now,
  scope,
  onScopeChange: setScope,
  who,
  onWhoChange: setWho,
}: {
  organization: { id: string; name: string; logo?: string | null } | null;
  data: OrgAgentActivity | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onDismiss: (threadId: string) => Promise<boolean>;
  /** Fixed clock for tests; omitted, each timer ticks on its own. */
  now?: number;
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  who: Who;
  onWhoChange: (who: Who) => void;
}) {
  const byRepo = useMemo(() => {
    const groups = new Map<string, AgentActivityRow[]>();
    for (const row of data?.active ?? []) {
      const repo = row.repoFullName ?? HIDDEN_REPOS;
      groups.set(repo, [...(groups.get(repo) ?? []), row]);
    }
    return [...groups];
  }, [data?.active]);

  return (
    <div className="flex flex-col gap-6">
      <PageTitleView title="Home" organization={activeOrganization} />

      {isError ? (
        <LoadError
          message="Agent activity could not be loaded."
          onRetry={onRetry}
        />
      ) : null}

      {data && data.needsYou.length > 0 ? (
        <section aria-label="Needs you">
          <SectionHeader title="Needs you" meta={data.needsYou.length} />
          <ul>
            {data.needsYou.map((row) => (
              <NeedsYouRow key={row.threadId} row={row} onDismiss={onDismiss} />
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
