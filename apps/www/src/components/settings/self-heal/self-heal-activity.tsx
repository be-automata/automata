"use client";

import React, { useState } from "react";
import { AlertCircle, OctagonAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useSelfHealActionMutation,
  useSelfHealActivityQuery,
  type SelfHealActivityDto,
  type SelfHealAttemptTimelineDto,
  type SelfHealBreakerDto,
  type SelfHealMetricsDto,
  type SelfHealDrainResultDto,
  type SelfHealRunDecisionDto,
  type SelfHealRunDto,
} from "@/queries/self-heal-queries";

/**
 * Phase 8 — admin activity card for one repo (OBS-01): what the loop decided
 * (dry-run decisions are shown verbatim with their would_ prefix), the ledger,
 * the outbox backlog, churn, breaker banners with Reset (BRK-01) and, at org
 * scope, the Drain control (KILL-01). Every control is also gated server-side.
 * Phase 9 adds the production metrics (R5/R6) and the fix-attempt timeline
 * with each attempt's CI gate source (SC6).
 *
 * Same shape as the other settings cards: a PURE view (all state is a prop,
 * except the drain-confirm dialog's open flag), a model hook binding the
 * queries and mutation, and a thin container.
 */

export const NO_RUNS_MESSAGE = "No audit runs yet for this repo.";
export const MISSING_PERMISSION_MESSAGE =
  "GitHub App lacks issues: write on this repo";
export const KILLED_MESSAGE = "Stopped (kill switch or selfHealLoop flag off)";
export const PAUSED_MESSAGE = "Paused until an admin resets it";
/** Churn above this fraction is highlighted (the dry-run exit gate). */
export const CHURN_HIGHLIGHT_ABOVE = 0.1;

const MAX_SKIPPED_REASONS = 3;

export type SelfHealActivityScope = "org" | "repo";

export interface SelfHealActivityViewProps {
  /** Null while there is nothing to show (no repo yet); org scope still shows Drain. */
  data: SelfHealActivityDto | null;
  repoFullName: string | null;
  scope: SelfHealActivityScope;
  onDrain?: () => void;
  onReset: (breaker: SelfHealBreakerDto) => void;
  busy?: boolean;
  drainResult?: SelfHealDrainResultDto | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decisions stored on a run, tolerant of the jsonb being anything. */
export function parseRunDecisions(value: unknown): SelfHealRunDecisionDto[] {
  if (!Array.isArray(value)) return [];
  const out: SelfHealRunDecisionDto[] = [];
  for (const entry of value) {
    if (
      isRecord(entry) &&
      typeof entry.fingerprint === "string" &&
      typeof entry.decision === "string" &&
      typeof entry.reason === "string"
    ) {
      out.push({
        fingerprint: entry.fingerprint,
        decision: entry.decision,
        reason: entry.reason,
      });
    }
  }
  return out;
}

/** The most frequent skip reasons of a run, as "reason ×n". */
export function topSkippedReasons(skipped: unknown): string[] {
  if (!isRecord(skipped)) return [];
  return Object.entries(skipped)
    .filter((e): e is [string, number] => typeof e[1] === "number")
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SKIPPED_REASONS)
    .map(([reason, count]) => `${reason} ×${count}`);
}

export function outcomeLabel(outcome: string | null): string {
  if (outcome === "missing-permission") return MISSING_PERMISSION_MESSAGE;
  if (outcome === "killed") return KILLED_MESSAGE;
  return outcome ?? "-";
}

export function issueUrl(repoFullName: string, issueNumber: number): string {
  return `https://github.com/${repoFullName}/issues/${issueNumber}`;
}

export function churnPercent(churn: number): string {
  return `${Math.round(churn * 100)}%`;
}

/** A 0..1 rate as a whole percentage; "n/a" when there is no denominator. */
export function formatRate(rate: number | null): string {
  return rate === null ? "n/a" : `${Math.round(rate * 100)}%`;
}

const TIMELINE_STEPS: Array<{
  key: keyof SelfHealAttemptTimelineDto["steps"];
  label: string;
}> = [
  { key: "claim", label: "claimed" },
  { key: "dispatch", label: "dispatched" },
  { key: "check", label: "checked" },
  { key: "draft", label: "draft" },
  { key: "ci", label: "CI" },
  { key: "ready", label: "ready" },
  { key: "merged", label: "merged" },
  { key: "closed", label: "closed" },
];

function MetricsRow({ metrics }: { metrics: SelfHealMetricsDto }) {
  const items: Array<[string, string]> = [
    ["PRs opened", String(metrics.prsOpened)],
    ["Ready for review", String(metrics.ready)],
    [
      "Merged by a person",
      `${metrics.mergedByNonTrigger} of ${metrics.merged} merged`,
    ],
    ["Merge rate", formatRate(metrics.mergeRate)],
    ["Edited by a person", formatRate(metrics.humanEditRatio)],
    ["Reopened (30 days)", formatRate(metrics.reopenRate)],
    ["Regressed (30 days)", formatRate(metrics.regressionRate30d)],
    [
      "Attempts per closed finding",
      metrics.meanAttemptsToClose === null
        ? "n/a"
        : String(Math.round(metrics.meanAttemptsToClose * 10) / 10),
    ],
    ["Expired unreviewed", formatRate(metrics.expiredRate)],
    ["Attempts", `${metrics.counted} counted, ${metrics.refunded} refunded`],
    ["Runs postponed (30 days)", String(metrics.admissionDeferrals)],
  ];
  return (
    <section data-testid="self-heal-metrics">
      <h5 className="text-sm font-medium">Fix results</h5>
      <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
        {items.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-2">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-1 text-xs text-muted-foreground">
        {metrics.mergeRateBasis === "bot-and-owner"
          ? "Merges by the bot or the fix automation's owner do not count as merged by a person."
          : "Only merges by the bot are excluded because the fix automation owner's login is unknown, so the merge rate may read high."}
      </p>
    </section>
  );
}

function AttemptRow({ entry }: { entry: SelfHealAttemptTimelineDto }) {
  const steps = TIMELINE_STEPS.filter(({ key }) => entry.steps[key] !== null);
  const result =
    entry.outcome === null
      ? (entry.prState ?? entry.phase)
      : `${entry.outcome}${entry.infraRefunded ? " (refunded)" : ""}`;
  return (
    <tr className="border-t align-top" data-testid="self-heal-attempt">
      <td className="py-1 pr-2">{entry.attemptNo}</td>
      <td className="py-1 pr-2">
        {entry.prUrl === null || entry.prNumber === null ? (
          "-"
        ) : (
          <a
            className="underline"
            href={entry.prUrl}
            target="_blank"
            rel="noreferrer"
          >
            #{entry.prNumber}
          </a>
        )}
      </td>
      <td className="py-1 pr-2">{entry.gateSource ?? "undecided"}</td>
      <td className="py-1 pr-2">{result}</td>
      <td className="py-1">
        {steps.map(({ key, label }) => (
          <div key={key} className="font-mono text-xs">
            {label} {entry.steps[key]}
          </div>
        ))}
      </td>
    </tr>
  );
}

function AttemptTimeline({
  attempts,
}: {
  attempts: SelfHealAttemptTimelineDto[];
}) {
  return (
    <section data-testid="self-heal-attempt-timeline">
      <h5 className="text-sm font-medium">Fix attempts</h5>
      {attempts.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">
          No fix attempts yet.
        </p>
      ) : (
        <div className="mt-1 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr>
                <th className="pr-2">Attempt</th>
                <th className="pr-2">PR</th>
                <th className="pr-2">CI gate</th>
                <th className="pr-2">Result</th>
                <th>Path</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((entry) => (
                <AttemptRow key={entry.attemptId} entry={entry} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function isTripped(b: SelfHealBreakerDto): boolean {
  return b.state === "open" || b.state === "paused_manual";
}

/** Breakers that need the operator: tripped ones, repo loops first. */
export function trippedBreakers(
  data: SelfHealActivityDto,
): SelfHealBreakerDto[] {
  return [
    data.breakers.repo.loopAudit,
    data.breakers.repo.loopFix,
    ...data.breakers.installation,
  ].filter(isTripped);
}

function breakerLabel(b: SelfHealBreakerDto): string {
  if (b.scopeKind === "permission") return MISSING_PERMISSION_MESSAGE;
  return `${b.scopeKind} breaker`;
}

function BreakerBanners({
  breakers,
  busy,
  onReset,
}: {
  breakers: SelfHealBreakerDto[];
  busy: boolean;
  onReset: (b: SelfHealBreakerDto) => void;
}) {
  if (breakers.length === 0) return null;
  return (
    <div className="grid gap-2" data-testid="self-heal-breaker-banners">
      {breakers.map((b) => (
        <Alert
          variant="destructive"
          key={`${b.scopeKind}:${b.scopeKey}`}
          data-testid="self-heal-breaker-banner"
        >
          <OctagonAlert className="h-4 w-4" aria-hidden />
          <AlertTitle>{breakerLabel(b)}</AlertTitle>
          <AlertDescription>
            <div className="grid gap-2">
              <p>
                {b.state === "paused_manual"
                  ? PAUSED_MESSAGE
                  : `Open${b.openUntil ? ` until ${b.openUntil}` : ""}`}
                {b.lastTripReason ? ` (reason: ${b.lastTripReason})` : ""}
              </p>
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  className="min-h-11"
                  disabled={busy}
                  onClick={() => onReset(b)}
                >
                  Reset breaker
                </Button>
              </div>
            </div>
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );
}

function RunRow({ run }: { run: SelfHealRunDto }) {
  const decisions = parseRunDecisions(run.decisions);
  const skipped = topSkippedReasons(run.skipped);
  return (
    <tr className="border-t align-top" data-testid="self-heal-run">
      <td className="py-1 pr-2">{run.createdAt}</td>
      <td className="py-1 pr-2">{run.mode ?? "-"}</td>
      <td className="py-1 pr-2">{outcomeLabel(run.outcome)}</td>
      <td className="py-1 pr-2">
        {run.createdCount}/{run.updatedCount}/{run.closedCount}
      </td>
      <td className="py-1 pr-2">{skipped.join(", ")}</td>
      <td className="py-1">
        {decisions.map((d, i) => (
          <div key={`${d.fingerprint}:${i}`} className="font-mono text-xs">
            {d.fingerprint.slice(0, 8)} {d.decision}: {d.reason}
          </div>
        ))}
      </td>
    </tr>
  );
}

export function SelfHealActivityView({
  data,
  repoFullName,
  scope,
  onDrain,
  onReset,
  busy = false,
  drainResult = null,
}: SelfHealActivityViewProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <div className="grid gap-4" data-testid="self-heal-activity">
      {scope === "org" && onDrain !== undefined && (
        <div className="grid gap-2" data-testid="self-heal-drain">
          <div>
            <Button
              variant="destructive"
              size="sm"
              className="min-h-11"
              disabled={busy}
              onClick={() => setConfirmOpen(true)}
            >
              Drain
            </Button>
          </div>
          <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Drain self-heal?</DialogTitle>
                <DialogDescription>
                  Turns the org kill switch on and cancels every in-flight
                  self-heal run. Turn the kill switch off in the settings above
                  to resume.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirmOpen(false)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => {
                    setConfirmOpen(false);
                    onDrain();
                  }}
                >
                  Drain now
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          {drainResult !== null && (
            <p className="text-sm" data-testid="self-heal-drain-result">
              {drainResult.nothingInFlight
                ? "Kill switch set. Nothing was in flight."
                : `Kill switch set. Cancelled ${drainResult.cancelled.length} thread(s).`}
              {drainResult.lookupFailed.length > 0 &&
                ` Lookup failed for ${drainResult.lookupFailed.length} thread(s); their runs were not cancelled.`}
              {drainResult.cancelFailed.length > 0 &&
                ` Cancel failed for ${drainResult.cancelFailed.length} thread(s).`}
            </p>
          )}
        </div>
      )}

      {data !== null && repoFullName !== null && (
        <>
          <BreakerBanners
            breakers={trippedBreakers(data)}
            busy={busy}
            onReset={onReset}
          />

          <p className="text-sm" data-testid="self-heal-effective">
            Effective mode: <strong>{data.effective.mode}</strong> (
            {data.effective.reason})
          </p>

          <section>
            <h5 className="text-sm font-medium">Runs</h5>
            {data.runs.length === 0 ? (
              <p
                className="mt-1 text-sm text-muted-foreground"
                data-testid="self-heal-runs-empty"
              >
                {NO_RUNS_MESSAGE}
              </p>
            ) : (
              <div className="mt-1 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr>
                      <th className="pr-2">Time</th>
                      <th className="pr-2">Mode</th>
                      <th className="pr-2">Outcome</th>
                      <th className="pr-2">Created/updated/closed</th>
                      <th className="pr-2">Skipped</th>
                      <th>Decisions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.runs.map((run) => (
                      <RunRow key={run.id} run={run} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <h5 className="text-sm font-medium">Findings</h5>
            {data.findings.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">
                No findings yet.
              </p>
            ) : (
              <div className="mt-1 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr>
                      <th className="pr-2">Rule</th>
                      <th className="pr-2">Severity</th>
                      <th className="pr-2">Status</th>
                      <th className="pr-2">Issue</th>
                      <th className="pr-2">Attempts</th>
                      <th className="pr-2">Check streak</th>
                      <th>Last decision</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.findings.map((f) => (
                      <tr
                        key={f.id}
                        className="border-t"
                        data-testid="self-heal-finding"
                      >
                        <td className="py-1 pr-2">{f.ruleId}</td>
                        <td className="py-1 pr-2">{f.severity}</td>
                        <td className="py-1 pr-2">{f.status}</td>
                        <td className="py-1 pr-2">
                          {f.issueNumber === null ? (
                            "-"
                          ) : (
                            <a
                              className="underline"
                              href={issueUrl(repoFullName, f.issueNumber)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              #{f.issueNumber}
                            </a>
                          )}
                        </td>
                        <td className="py-1 pr-2">{f.attempts}</td>
                        <td className="py-1 pr-2">
                          {f.consecutiveCheckPasses}
                        </td>
                        <td className="py-1">
                          {f.lastDecision ?? "-"}
                          {f.lastDecisionReason
                            ? `: ${f.lastDecisionReason}`
                            : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {data.metrics !== undefined && <MetricsRow metrics={data.metrics} />}

          {data.attemptTimeline !== undefined && (
            <AttemptTimeline attempts={data.attemptTimeline} />
          )}

          <p className="text-sm" data-testid="self-heal-outbox">
            Outbox backlog: {data.outbox.pending} pending, {data.outbox.failed}{" "}
            failed
            {data.outbox.oldestPendingAt
              ? ` (oldest pending ${data.outbox.oldestPendingAt})`
              : ""}
          </p>

          <section data-testid="self-heal-churn">
            <h5 className="text-sm font-medium">Churn between complete runs</h5>
            {data.churn.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">
                Needs two complete runs.
              </p>
            ) : (
              <ul className="mt-1 flex flex-wrap gap-2 text-xs">
                {data.churn.map((c) => (
                  <li
                    key={`${c.fromRunId}:${c.toRunId}`}
                    data-testid="self-heal-churn-item"
                    data-highlight={c.churn > CHURN_HIGHLIGHT_ABOVE}
                    className={
                      c.churn > CHURN_HIGHLIGHT_ABOVE
                        ? "rounded bg-destructive/15 px-1 font-semibold text-destructive"
                        : "rounded bg-muted px-1"
                    }
                  >
                    {churnPercent(c.churn)}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h5 className="text-sm font-medium">Admin log</h5>
            {data.adminLog.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">
                No admin actions yet.
              </p>
            ) : (
              <ul className="mt-1 text-xs">
                {data.adminLog.map((entry) => (
                  <li key={entry.id}>
                    {entry.createdAt} {entry.action} by {entry.actorUserId}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/** Binds the queries and the action mutation; returns the view's props. */
export function useSelfHealActivityModel({
  repoFullName,
  scope,
}: {
  repoFullName: string | null;
  scope: SelfHealActivityScope;
}) {
  const query = useSelfHealActivityQuery(repoFullName);
  const mutation = useSelfHealActionMutation();
  const [drainResult, setDrainResult] = useState<SelfHealDrainResultDto | null>(
    null,
  );

  const onDrain = () => {
    mutation.mutate(
      { action: "drain" },
      {
        onSuccess: (result) => {
          if ("killSwitchSet" in result) setDrainResult(result);
        },
      },
    );
  };
  const onReset = (breaker: SelfHealBreakerDto) => {
    mutation.mutate({
      action: "reset_breaker",
      scopeKind: breaker.scopeKind,
      scopeKey: breaker.scopeKey,
    });
  };

  return {
    query,
    viewProps: {
      data: query.data ?? null,
      repoFullName,
      scope,
      onDrain: scope === "org" ? onDrain : undefined,
      onReset,
      busy: mutation.isPending,
      drainResult,
    } satisfies SelfHealActivityViewProps,
  };
}

/** Thin container: loading and error states around the pure view. */
export function SelfHealActivity({
  repoFullName,
  scope,
}: {
  repoFullName: string | null;
  scope: SelfHealActivityScope;
}) {
  const { query, viewProps } = useSelfHealActivityModel({
    repoFullName,
    scope,
  });
  if (repoFullName !== null && query.isLoading) {
    return (
      <div className="grid gap-2" data-testid="self-heal-activity-skeleton">
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (repoFullName !== null && query.isError) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Couldn&apos;t load the self-heal activity</AlertTitle>
        <AlertDescription>
          {query.error instanceof Error
            ? query.error.message
            : "Something went wrong. Reload the page to try again."}
        </AlertDescription>
      </Alert>
    );
  }
  return <SelfHealActivityView {...viewProps} />;
}
