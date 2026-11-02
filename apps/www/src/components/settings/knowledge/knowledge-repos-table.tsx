"use client";

import React, { useState } from "react";
import { AlertCircle } from "lucide-react";
import type { RunState } from "@terragon/shared/model/run-state";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { RunStateLabel } from "@/components/ui/run-state";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsSection } from "@/components/settings/settings-row";
import {
  useKnowledgeDiagnose,
  useKnowledgeRetry,
  useKnowledgeSettings,
  type KnowledgeDeliveryDto,
} from "@/queries/knowledge-settings-queries";
import type { KnowledgeRepoDto, KnowledgeViewer } from "./knowledge-form";
import { MEMBER_READONLY_NOTE } from "./knowledge-section";

/**
 * Settings > Knowledge > Repositories (phase 13, D-17..D-20): one register row
 * per onboarded repo with webhook liveness, reconcile state, attempts and
 * cursor. Members read; Retry (failed rows) and Diagnose render for org and
 * platform admins only, and the 13-11 routes enforce the same on the server.
 * A PURE view plus a thin container, like the section above it.
 */

/** Mirrors KNOWLEDGE_INTENT_MAX_ATTEMPTS in @terragon/shared (not importable client-side). */
const MAX_ATTEMPTS = 8;

const REPO_GRID =
  "grid min-h-8 grid-cols-3 items-center gap-x-3 gap-y-1 px-3 py-1 text-xs tabular-nums sm:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1.6fr)_4rem_5rem_auto]";

export interface DiagnoseState {
  repoFullName: string;
  status: "pending" | "error" | "success";
  deliveries: KnowledgeDeliveryDto[];
}

export interface KnowledgeReposTableViewProps {
  status: "loading" | "error" | "ready";
  errorMessage?: string;
  repos: KnowledgeRepoDto[];
  viewer: KnowledgeViewer;
  now: Date;
  onRetry: (intentId: string) => void;
  onDiagnose: (repoFullName: string) => void;
  onReload: () => void;
  diagnose: DiagnoseState | null;
}

/** "3m ago", "5h ago", "2d ago". */
export function relativeTime(iso: string, now: Date): string {
  const seconds = Math.max(
    0,
    Math.floor((now.getTime() - new Date(iso).getTime()) / 1000),
  );
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** The state comes from the server row; this only maps it to the shared vocabulary. */
export function reconcileState(repo: KnowledgeRepoDto): RunState {
  const intent = repo.latestIntent;
  if (intent === null) {
    return { kind: "unverified", word: "no reconcile yet", reason: null };
  }
  switch (intent.state) {
    case "pending":
      return { kind: "waiting", word: "queued", reason: null };
    case "processing":
      return { kind: "running", word: "reconciling", reason: null };
    case "processed":
      return { kind: "done", word: "reconciled", reason: null };
    case "superseded":
      return { kind: "done", word: "superseded", reason: null };
    case "failed":
      return { kind: "needs-you", word: "failed", reason: null };
  }
}

function webhookState(repo: KnowledgeRepoDto, now: Date): RunState {
  if (repo.lastPushAt === null) {
    return { kind: "unverified", word: "never seen a push", reason: null };
  }
  return {
    kind: "done",
    word: `push ${relativeTime(repo.lastPushAt, now)}`,
    reason: null,
  };
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * PD-25 / PD-21 / PD-24: which evidence the reconcile does and does not check.
 * Empty when nothing is excluded and the repo has no ticket claims.
 */
export function evidenceCoverage(repo: KnowledgeRepoDto): string[] {
  const parts: string[] = [];
  if (repo.excludedDocClaims > 0) {
    parts.push(
      `${plural(repo.excludedDocClaims, "claim", "claims")} not checked: doc source not connected`,
    );
  }
  if (repo.excludedInvalidClaims > 0) {
    parts.push(
      `${plural(repo.excludedInvalidClaims, "claim", "claims")} not checked: invalid evidence path`,
    );
  }
  if (repo.ticketClaimCount > 0 && repo.ticketSource !== null) {
    const tickets = plural(
      repo.ticketClaimCount,
      "ticket claim",
      "ticket claims",
    );
    parts.push(
      repo.ticketSource === "configured"
        ? `${tickets} checked against the tracker`
        : `${tickets}: no tracker configured`,
    );
  }
  return parts;
}

function RepoRow({
  repo,
  canAct,
  now,
  onRetry,
  onDiagnose,
  diagnose,
}: {
  repo: KnowledgeRepoDto;
  canAct: boolean;
  now: Date;
  onRetry: (intentId: string) => void;
  onDiagnose: (repoFullName: string) => void;
  diagnose: DiagnoseState | null;
}) {
  const intent = repo.latestIntent;
  const sha = intent?.targetSha ?? repo.lastSha;
  const failed = intent?.state === "failed";
  const open = diagnose?.repoFullName === repo.repoFullName ? diagnose : null;
  const coverage = evidenceCoverage(repo);
  return (
    <li
      className="border-b border-line-soft last:border-b-0"
      data-testid="knowledge-repo-row"
    >
      <div className={REPO_GRID}>
        <span
          className="min-w-0 truncate font-mono max-sm:order-2 max-sm:col-span-2"
          title={repo.repoFullName}
        >
          {repo.repoFullName}
        </span>
        <span
          className="min-w-0 truncate max-sm:order-3"
          data-testid="knowledge-repo-webhook"
        >
          <RunStateLabel state={webhookState(repo, now)} />
        </span>
        <span
          className="min-w-0 truncate max-sm:order-1"
          data-testid="knowledge-repo-reconcile"
        >
          <RunStateLabel state={reconcileState(repo)} />
          {failed && intent.lastErrorCode !== null && (
            <span
              className="ml-1.5 font-mono text-muted-foreground"
              title={intent.lastErrorCode}
            >
              {intent.lastErrorCode}
            </span>
          )}
        </span>
        <span className="text-muted-foreground max-sm:order-4">
          {intent === null ? "-" : `${intent.attempts}/${MAX_ATTEMPTS}`}
        </span>
        <span
          className="truncate font-mono text-muted-foreground max-sm:order-5"
          title={sha ?? undefined}
        >
          {sha === null ? "-" : sha.slice(0, 7)}
        </span>
        {canAct && (
          <span className="flex gap-1 max-sm:order-6 max-sm:col-span-3">
            {failed && intent !== null && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-xs"
                data-testid="knowledge-repo-retry"
                onClick={() => onRetry(intent.id)}
              >
                Retry
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-xs"
              data-testid="knowledge-repo-diagnose"
              disabled={open?.status === "pending"}
              onClick={() => onDiagnose(repo.repoFullName)}
            >
              Diagnose
            </Button>
          </span>
        )}
      </div>
      {repo.pending && repo.pendingSince !== null && (
        <p
          className="px-3 pb-1 text-xs text-muted-foreground"
          data-testid="knowledge-repo-pending"
        >
          pending validation since {relativeTime(repo.pendingSince, now)} ·{" "}
          {repo.affectedClaimCount}{" "}
          {repo.affectedClaimCount === 1 ? "claim" : "claims"}
        </p>
      )}
      {coverage.length > 0 && (
        <p
          className="px-3 pb-1 text-xs tabular-nums text-muted-foreground"
          data-testid="knowledge-repo-evidence"
        >
          {coverage.join(" · ")}
        </p>
      )}
      {open !== null && <DeliveriesRegister state={open} />}
    </li>
  );
}

function DeliveriesRegister({ state }: { state: DiagnoseState }) {
  return (
    <div
      className="mx-3 mb-2 border border-line-soft text-xs"
      data-testid="knowledge-repo-deliveries"
    >
      {state.status === "pending" ? (
        <p className="px-3 py-1 text-muted-foreground">
          Checking recent deliveries.
        </p>
      ) : state.status === "error" ? (
        <p className="px-3 py-1 text-state-needs-you">
          Couldn&apos;t read deliveries from GitHub. Try Diagnose again.
        </p>
      ) : state.deliveries.length === 0 ? (
        <p className="px-3 py-1 text-muted-foreground">
          GitHub lists no recent deliveries for this repository.
        </p>
      ) : (
        <ul>
          {state.deliveries.map((d) => (
            <li
              key={d.guid}
              className="flex min-h-8 items-center gap-3 border-b border-line-soft px-3 py-1 tabular-nums last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate font-mono">
                {d.action === null ? d.event : `${d.event}.${d.action}`}
              </span>
              <span className="w-10">{d.statusCode}</span>
              <span className="text-muted-foreground">
                {d.deliveredAt.slice(0, 16).replace("T", " ")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function KnowledgeReposTableView(props: KnowledgeReposTableViewProps) {
  const { status, repos, viewer } = props;
  const canAct = viewer.isOrgAdmin || viewer.isPlatformAdmin;
  return (
    <SettingsSection
      label="Repositories"
      description="Webhook liveness and reconcile state per onboarded repository."
    >
      {status === "loading" ? (
        <div data-testid="knowledge-repos-skeleton" className="grid gap-px">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : status === "error" ? (
        <Alert variant="destructive" data-testid="knowledge-repos-error">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Couldn&apos;t load the repositories</AlertTitle>
          <AlertDescription className="grid gap-2">
            <span>{props.errorMessage ?? "Try again."}</span>
            <span>
              <Button variant="outline" size="sm" onClick={props.onReload}>
                Retry
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      ) : repos.length === 0 ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="knowledge-repos-empty"
        >
          No repositories are onboarded yet. Install the GitHub App on a
          repository to start.
        </p>
      ) : (
        <>
          {!canAct && (
            <p
              className="text-xs text-muted-foreground"
              data-testid="knowledge-repos-readonly-note"
            >
              {MEMBER_READONLY_NOTE}
            </p>
          )}
          <ul className="border border-line-soft" data-testid="knowledge-repos">
            {repos.map((repo) => (
              <RepoRow
                key={repo.repoFullName}
                repo={repo}
                canAct={canAct}
                now={props.now}
                onRetry={props.onRetry}
                onDiagnose={props.onDiagnose}
                diagnose={props.diagnose}
              />
            ))}
          </ul>
        </>
      )}
    </SettingsSection>
  );
}

/** Thin container: the repos come from the shared Knowledge settings query. */
export function KnowledgeReposTable() {
  const query = useKnowledgeSettings();
  const retry = useKnowledgeRetry();
  const diagnoseMutation = useKnowledgeDiagnose();
  const [diagnosed, setDiagnosed] = useState<string | null>(null);
  const data = query.data ?? null;

  const diagnose: DiagnoseState | null =
    diagnosed === null
      ? null
      : {
          repoFullName: diagnosed,
          status: diagnoseMutation.isPending
            ? "pending"
            : diagnoseMutation.isError
              ? "error"
              : "success",
          deliveries: diagnoseMutation.data ?? [],
        };

  return (
    <KnowledgeReposTableView
      status={query.isLoading ? "loading" : query.isError ? "error" : "ready"}
      errorMessage={
        query.error instanceof Error ? query.error.message : undefined
      }
      repos={data?.repos ?? []}
      viewer={data?.viewer ?? { isOrgAdmin: false, isPlatformAdmin: false }}
      now={new Date()}
      onRetry={(intentId) => retry.mutate({ intentId })}
      onDiagnose={(repoFullName) => {
        setDiagnosed(repoFullName);
        diagnoseMutation.mutate({ repoFullName });
      }}
      onReload={() => void query.refetch()}
      diagnose={diagnose}
    />
  );
}
