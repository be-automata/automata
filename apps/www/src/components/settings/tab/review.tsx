"use client";

import { useMemo, useState } from "react";
import type { BlockTolerance } from "@terragon/review/severity-policy";
import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsSection } from "@/components/settings/settings-row";
import { useUserReposQuery } from "@/queries/user-repo-queries";
import {
  useClearReviewToleranceMutation,
  useReviewSettingsQuery,
  useSetReviewSettingMutation,
} from "@/queries/review-settings-queries";
import { ToleranceMatrix } from "@/components/settings/review-tolerance/tolerance-matrix";
import { OrgFloorCard } from "@/components/settings/review-tolerance/org-floor-card";
import { OrgDraftDefaultCard } from "@/components/settings/review-tolerance/org-draft-default-card";
import { useSupersedeDefaultQuery } from "@/queries/supersede-policy-queries";
import { SupersedePolicySection } from "@/components/settings/review-supersede/supersede-policy-section";
import { RepoRow } from "@/components/settings/review-tolerance/repo-row";
import {
  ConfirmLoosenDialog,
  type PendingLoosen,
} from "@/components/settings/review-tolerance/confirm-loosen-dialog";
import {
  DEFAULT_TOLERANCE,
  isLooser,
} from "@/components/settings/review-tolerance/constants";

interface RepoRowData {
  /** Display name (`owner/name`) — real casing when known, else the stored slug. */
  repoFullName: string;
  /** Lowercased dedup/state key. */
  key: string;
  /** Persisted tolerance in effect (override or the locked default). */
  tolerance: BlockTolerance;
  /** Whether Automata engages this repo's draft PRs (override or the `true` default). */
  reviewDraftPrs: boolean;
  hasOverride: boolean;
  /** Version of the stored row (ISO) — sent with writes as the CAS token. */
  updatedAt?: string;
}

export function ReviewSettings() {
  const settingsQuery = useReviewSettingsQuery();
  const orgDefaultQuery = useSupersedeDefaultQuery();
  const reposQuery = useUserReposQuery();
  const setMutation = useSetReviewSettingMutation();
  const clearMutation = useClearReviewToleranceMutation();

  const [drafts, setDrafts] = useState<Record<string, BlockTolerance>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [saveErrors, setSaveErrors] = useState<Record<string, string | null>>(
    {},
  );
  const [pending, setPending] = useState<PendingLoosen | null>(null);
  const [savingDraft, setSavingDraft] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState("");

  const rows = useMemo<RepoRowData[]>(() => {
    const settings = settingsQuery.data ?? [];
    const realRepos = reposQuery.data?.repos ?? [];
    const overrideByKey = new Map(
      settings.map((s) => [s.repoFullName.toLowerCase(), s] as const),
    );
    const rowMap = new Map<string, RepoRowData>();
    for (const repo of realRepos) {
      const key = repo.full_name.toLowerCase();
      const override = overrideByKey.get(key);
      rowMap.set(key, {
        repoFullName: repo.full_name,
        key,
        tolerance: override?.blockTolerance ?? DEFAULT_TOLERANCE,
        reviewDraftPrs:
          override?.reviewDraftPrs ??
          orgDefaultQuery.data?.reviewDraftPrs ??
          true,
        hasOverride: Boolean(override),
        updatedAt: override?.updatedAt,
      });
    }
    // Include overrides for repos not in the user's installable list (e.g. set
    // by another org member, or access has since changed) so nothing is orphaned.
    for (const s of settings) {
      const key = s.repoFullName.toLowerCase();
      if (!rowMap.has(key)) {
        rowMap.set(key, {
          repoFullName: s.repoFullName,
          updatedAt: s.updatedAt,
          key,
          tolerance: s.blockTolerance,
          reviewDraftPrs: s.reviewDraftPrs,
          hasOverride: true,
        });
      }
    }
    return [...rowMap.values()].sort((a, b) => a.key.localeCompare(b.key));
  }, [settingsQuery.data, reposQuery.data, orgDefaultQuery.data]);

  const visibleRows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => r.key.includes(needle));
  }, [rows, filter]);

  const draftFor = (row: RepoRowData): BlockTolerance =>
    drafts[row.key] ?? row.tolerance;
  const isDirty = (row: RepoRowData): boolean => {
    const draft = drafts[row.key];
    return draft !== undefined && draft !== row.tolerance;
  };

  const expandedRow = rows.find((r) => r.key === expanded);
  const highlightColumn = expandedRow ? draftFor(expandedRow) : undefined;

  function select(row: RepoRowData, tolerance: BlockTolerance): void {
    setDrafts((d) => ({ ...d, [row.key]: tolerance }));
    setSaved((s) => (s === row.key ? null : s));
    setSaveErrors((e) => ({ ...e, [row.key]: null }));
  }

  function clearDraft(key: string): void {
    setDrafts((d) => {
      const next = { ...d };
      delete next[key];
      return next;
    });
  }

  function discard(row: RepoRowData): void {
    clearDraft(row.key);
    setSaveErrors((e) => ({ ...e, [row.key]: null }));
  }

  /** Shared PUT/DELETE flow: spinner + error banner + draft clear + saved marker. */
  async function runMutation(
    row: RepoRowData,
    action: () => Promise<unknown>,
  ): Promise<void> {
    setSaving((s) => ({ ...s, [row.key]: true }));
    setSaveErrors((e) => ({ ...e, [row.key]: null }));
    try {
      await action();
      clearDraft(row.key);
      setSaved(row.key);
    } catch (err) {
      setSaveErrors((e) => ({
        ...e,
        [row.key]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setSaving((s) => ({ ...s, [row.key]: false }));
    }
  }

  // Every writer on a row carries the row's version: a stale Save gets the
  // same 409 as a stale Reset instead of silently last-write-winning over a
  // concurrent admin (the row's updatedAt is on every RepoRowData).
  const doSave = (row: RepoRowData, target: BlockTolerance): Promise<void> =>
    runMutation(row, () =>
      setMutation.mutateAsync({
        repoFullName: row.repoFullName,
        patch: { blockTolerance: target, expectedUpdatedAt: row.updatedAt },
      }),
    );

  const doReset = (row: RepoRowData): Promise<void> =>
    runMutation(row, () =>
      clearMutation.mutateAsync({
        repoFullName: row.repoFullName,
        expectedUpdatedAt: row.updatedAt,
      }),
    );

  /** The draft-PR toggle saves immediately (partial patch) — no explicit Save. */
  async function toggleDraft(
    row: RepoRowData,
    reviewDraftPrs: boolean,
  ): Promise<void> {
    setSavingDraft((s) => ({ ...s, [row.key]: true }));
    try {
      await setMutation.mutateAsync({
        repoFullName: row.repoFullName,
        patch: { reviewDraftPrs, expectedUpdatedAt: row.updatedAt },
      });
    } catch {
      // useSetReviewSettingMutation toasts the error; the switch reverts on refetch.
    } finally {
      setSavingDraft((s) => ({ ...s, [row.key]: false }));
    }
  }

  function requestSave(row: RepoRowData): void {
    const target = drafts[row.key];
    if (target === undefined || target === row.tolerance) return;
    if (isLooser(target, row.tolerance)) {
      setPending({
        repoFullName: row.repoFullName,
        from: row.tolerance,
        to: target,
        run: () => void doSave(row, target),
      });
      return;
    }
    void doSave(row, target);
  }

  function requestReset(row: RepoRowData): void {
    if (isLooser(DEFAULT_TOLERANCE, row.tolerance)) {
      setPending({
        repoFullName: row.repoFullName,
        from: row.tolerance,
        to: DEFAULT_TOLERANCE,
        run: () => void doReset(row),
      });
      return;
    }
    void doReset(row);
  }

  const isLoading = settingsQuery.isLoading;

  return (
    <div className="flex flex-col gap-8">
      <OrgFloorCard />
      <OrgDraftDefaultCard />
      <SupersedePolicySection />

      <SettingsSection
        label="Review Tolerance"
        description="Per-repository floor for when PR review findings force a Request changes verdict. Repositories with no override run on the warning default."
      >
        <div className="rounded-md border bg-card p-4">
          <h4 className="mb-3 text-sm font-semibold">How tolerance works</h4>
          <ToleranceMatrix highlightColumn={highlightColumn} />
        </div>
      </SettingsSection>

      <SettingsSection
        label="Repositories"
        description="Expand a repository to change the severity floor at which its PR reviews block. Changes apply to the next review run."
      >
        {settingsQuery.isError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Couldn&apos;t load review settings</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-2">
              <span>
                {settingsQuery.error instanceof Error
                  ? settingsQuery.error.message
                  : "Unknown error"}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void settingsQuery.refetch()}
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {isLoading && (
          <div className="divide-y rounded-md border">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-5 w-28 rounded-full" />
              </div>
            ))}
          </div>
        )}

        {!isLoading && !settingsQuery.isError && rows.length === 0 && (
          <div className="rounded-md border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
            No repositories connected yet. Install the GitHub App and grant
            repository access to configure per-repo review tolerance.
          </div>
        )}

        {!isLoading && !settingsQuery.isError && rows.length > 0 && (
          <div className="flex flex-col gap-3">
            {rows.length > 6 && (
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter repositories…"
                className="max-w-sm"
              />
            )}
            {visibleRows.length === 0 ? (
              <div className="rounded-md border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
                No repositories match &ldquo;{filter}&rdquo;.
              </div>
            ) : (
              <div className="divide-y rounded-md border">
                {visibleRows.map((row) => (
                  <RepoRow
                    key={row.key}
                    repoFullName={row.repoFullName}
                    tolerance={row.tolerance}
                    reviewDraftPrs={row.reviewDraftPrs}
                    hasOverride={row.hasOverride}
                    draft={draftFor(row)}
                    expanded={expanded === row.key}
                    dirty={isDirty(row)}
                    saving={Boolean(saving[row.key])}
                    saved={saved === row.key}
                    saveError={saveErrors[row.key] ?? null}
                    draftSaving={Boolean(savingDraft[row.key])}
                    onToggle={() =>
                      setExpanded((e) => (e === row.key ? null : row.key))
                    }
                    onSelect={(t) => select(row, t)}
                    onSave={() => requestSave(row)}
                    onDiscard={() => discard(row)}
                    onReset={() => requestReset(row)}
                    onToggleDraft={(v) => void toggleDraft(row, v)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Applies to the LLM reviewer&apos;s approve floor. The deterministic
          review gate is configured separately.
        </p>
      </SettingsSection>

      <ConfirmLoosenDialog
        pending={pending}
        onConfirm={() => {
          pending?.run();
          setPending(null);
        }}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
