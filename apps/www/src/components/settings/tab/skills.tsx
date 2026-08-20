"use client";

import { useMemo, useState } from "react";
import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { SettingsSection } from "@/components/settings/settings-row";
import { unwrapError } from "@/lib/server-actions";
import {
  useRepoSkillDetailQuery,
  useRepoSkillsQuery,
  useRepoSkillVersionBodyQuery,
  useRevertRepoSkillMutation,
  useSaveRepoSkillMutation,
} from "@/queries/repo-skills-queries";
import { cn } from "@/lib/utils";
import { diffLines, diffStat } from "@/lib/line-diff";

/**
 * Skills panel (issue #54 C4) — the dashboard edit surface for live repo
 * skills, beside the review settings it structurally mirrors. Selecting a
 * skill loads its CURRENT body into an editor; Save appends a version through
 * the org-fenced server actions (the shared per-skill validator rejects a
 * broken body at save time and its message is surfaced inline); the history
 * list reverts by moving the live pointer to an older version. Every accepted
 * change is live on the NEXT automation run — the resolver reads the store
 * live, no redeploy.
 */

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

function formatWhen(value: Date | string): string {
  return new Date(value).toLocaleString();
}

export function SkillsSettings() {
  const listQuery = useRepoSkillsQuery();
  const saveMutation = useSaveRepoSkillMutation();
  const revertMutation = useRevertRepoSkillMutation();

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Editor draft, keyed to the version it was seeded from so a background
  // refetch never clobbers in-progress edits (and a save/revert reseeds it).
  const [draft, setDraft] = useState<{ seed: string; body: string } | null>(
    null,
  );
  // A historical version being diffed against the current body (#64 slice 2).
  const [diffVersionId, setDiffVersionId] = useState<string | null>(null);

  const skills = useMemo(
    () =>
      [...(listQuery.data ?? [])].sort((a, b) =>
        `${a.repoFullName}/${a.skillName}`.localeCompare(
          `${b.repoFullName}/${b.skillName}`,
        ),
      ),
    [listQuery.data],
  );

  const selected =
    skills.find(
      (s) => `${s.repoFullName}\u0000${s.skillName}` === selectedKey,
    ) ?? null;
  const detailQuery = useRepoSkillDetailQuery({
    repoFullName: selected?.repoFullName ?? null,
    skillName: selected?.skillName ?? null,
  });
  const detail = detailQuery.data ?? null;

  const currentSeed = detail?.current?.versionId ?? "none";
  const editorBody =
    draft && draft.seed === currentSeed
      ? draft.body
      : (detail?.current?.body ?? "");
  const dirty = editorBody !== (detail?.current?.body ?? "");

  const diffBodyQuery = useRepoSkillVersionBodyQuery({
    repoFullName: selected?.repoFullName ?? null,
    skillName: selected?.skillName ?? null,
    versionId: diffVersionId,
  });
  // Diff the picked historical version (a) against the current body (b): dels
  // are what the old version had, adds are what the current version added.
  const diffRows =
    diffVersionId && diffBodyQuery.data != null && detail?.current
      ? diffLines(diffBodyQuery.data, detail.current.body)
      : null;

  function select(repoFullName: string, skillName: string): void {
    setSelectedKey(`${repoFullName}\u0000${skillName}`);
    setDraft(null);
    setDiffVersionId(null);
    saveMutation.reset();
    revertMutation.reset();
  }

  async function save(): Promise<void> {
    if (!selected || !dirty) return;
    try {
      await saveMutation.mutateAsync({
        repoFullName: selected.repoFullName,
        skillName: selected.skillName,
        body: editorBody,
      });
      setDraft(null);
    } catch {
      // Surfaced inline below (and toasted by the mutation helper); the draft
      // stays so the user can fix the body instead of losing it.
    }
  }

  async function revert(versionId: string): Promise<void> {
    if (!selected) return;
    try {
      await revertMutation.mutateAsync({
        repoFullName: selected.repoFullName,
        skillName: selected.skillName,
        versionId,
      });
      setDraft(null);
    } catch {
      // Toasted by the mutation helper.
    }
  }

  return (
    <div id="skills" className="scroll-mt-16">
      <SettingsSection
        label="Skills"
        description="The live instruction bodies your automations run with (e.g. the PR-review methodology). Edits are versioned and take effect on the next run — no redeploy."
      >
        {listQuery.isError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Couldn&apos;t load skills</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-2">
              <span>{unwrapError(listQuery.error)}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void listQuery.refetch()}
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {listQuery.isLoading && (
          <div className="divide-y rounded-md border">
            {[0, 1].map((i) => (
              <div
                key={i}
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <Skeleton className="h-4 w-64" />
                <Skeleton className="h-4 w-24" />
              </div>
            ))}
          </div>
        )}

        {!listQuery.isLoading && !listQuery.isError && skills.length === 0 && (
          <div className="rounded-md border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
            No skills yet. Skills appear here once a repository&apos;s
            automations are wired to skill references.
          </div>
        )}

        {!listQuery.isLoading && !listQuery.isError && skills.length > 0 && (
          <div className="divide-y rounded-md border">
            {skills.map((skill) => {
              const key = `${skill.repoFullName}\u0000${skill.skillName}`;
              const isSelected = key === selectedKey;
              return (
                <div key={key} className="flex flex-col">
                  <button
                    type="button"
                    onClick={() =>
                      isSelected
                        ? setSelectedKey(null)
                        : select(skill.repoFullName, skill.skillName)
                    }
                    className={cn(
                      "flex items-center justify-between gap-4 px-4 py-3 text-left text-sm hover:bg-muted/50",
                      isSelected && "bg-muted/50",
                    )}
                  >
                    <span className="min-w-0 truncate">
                      <span className="font-medium">{skill.skillName}</span>
                      <span className="mx-2 text-muted-foreground">·</span>
                      <span className="text-muted-foreground">
                        {skill.repoFullName}
                      </span>
                    </span>
                    <span className="flex-shrink-0 font-mono text-xs text-muted-foreground">
                      {skill.current
                        ? shortSha(skill.current.contentSha)
                        : "no version"}
                    </span>
                  </button>

                  {isSelected && (
                    <div className="flex flex-col gap-4 border-t bg-card px-4 py-4">
                      {detailQuery.isLoading && (
                        <Skeleton className="h-48 w-full" />
                      )}
                      {detailQuery.isError && (
                        <Alert variant="destructive">
                          <AlertCircle className="h-4 w-4" />
                          <AlertTitle>Couldn&apos;t load this skill</AlertTitle>
                          <AlertDescription>
                            {unwrapError(detailQuery.error)}
                          </AlertDescription>
                        </Alert>
                      )}
                      {detail && (
                        <>
                          <div className="flex flex-col gap-2">
                            <Textarea
                              value={editorBody}
                              onChange={(e) =>
                                setDraft({
                                  seed: currentSeed,
                                  body: e.target.value,
                                })
                              }
                              spellCheck={false}
                              className="min-h-[280px] font-mono text-xs"
                              placeholder="Skill body (markdown)"
                            />
                            {saveMutation.isError && (
                              <p className="text-xs text-destructive">
                                {unwrapError(saveMutation.error)}
                              </p>
                            )}
                            <div className="flex items-center gap-3">
                              <Button
                                type="button"
                                size="sm"
                                disabled={!dirty || saveMutation.isPending}
                                onClick={() => void save()}
                              >
                                {saveMutation.isPending ? "Saving…" : "Save"}
                              </Button>
                              {dirty && !saveMutation.isPending && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setDraft(null)}
                                >
                                  Discard
                                </Button>
                              )}
                              {detail.current && (
                                <span className="font-mono text-xs text-muted-foreground">
                                  current {shortSha(detail.current.contentSha)}{" "}
                                  · {detail.current.source}
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="flex flex-col gap-1">
                            <h4 className="text-xs font-semibold text-muted-foreground">
                              Version history
                            </h4>
                            <div className="divide-y rounded-md border">
                              {detail.versions.map((v) => {
                                const isCurrent =
                                  v.id === detail.current?.versionId;
                                return (
                                  <div
                                    key={v.id}
                                    className="flex items-center justify-between gap-4 px-3 py-2 text-xs"
                                  >
                                    <span className="min-w-0 truncate font-mono text-muted-foreground">
                                      {shortSha(v.contentSha)}
                                      <span className="mx-2">·</span>
                                      {v.source}
                                      <span className="mx-2">·</span>
                                      {formatWhen(v.createdAt)}
                                    </span>
                                    <span className="flex flex-shrink-0 items-center gap-2">
                                      {isCurrent ? (
                                        <span className="rounded-full bg-muted px-2 py-0.5 font-medium">
                                          Current
                                        </span>
                                      ) : (
                                        <>
                                          <Button
                                            type="button"
                                            size="sm"
                                            variant="ghost"
                                            className="h-6 px-2 text-xs"
                                            onClick={() =>
                                              setDiffVersionId(
                                                diffVersionId === v.id
                                                  ? null
                                                  : v.id,
                                              )
                                            }
                                          >
                                            {diffVersionId === v.id
                                              ? "Hide diff"
                                              : "Diff"}
                                          </Button>
                                          <Button
                                            type="button"
                                            size="sm"
                                            variant="outline"
                                            className="h-6 px-2 text-xs"
                                            disabled={revertMutation.isPending}
                                            onClick={() => void revert(v.id)}
                                          >
                                            Revert
                                          </Button>
                                        </>
                                      )}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>

                          {diffVersionId && (
                            <div className="flex flex-col gap-1">
                              <h4 className="text-xs font-semibold text-muted-foreground">
                                {(() => {
                                  const stat = diffRows
                                    ? diffStat(diffRows)
                                    : null;
                                  return `Diff vs current${
                                    stat
                                      ? ` · +${stat.added} −${stat.removed}`
                                      : ""
                                  }`;
                                })()}
                              </h4>
                              {diffBodyQuery.isLoading && (
                                <Skeleton className="h-24 w-full" />
                              )}
                              {diffBodyQuery.isError && (
                                <p className="text-xs text-destructive">
                                  {unwrapError(diffBodyQuery.error)}
                                </p>
                              )}
                              {diffRows && (
                                <pre className="max-h-[320px] overflow-auto rounded-md border font-mono text-xs leading-relaxed">
                                  {diffRows.map((row, i) => (
                                    <div
                                      key={i}
                                      className={cn(
                                        "px-3 py-0.5 whitespace-pre-wrap",
                                        row.kind === "add" &&
                                          "bg-green-500/10 text-green-700 dark:text-green-400",
                                        row.kind === "del" &&
                                          "bg-red-500/10 text-red-700 dark:text-red-400",
                                      )}
                                    >
                                      {row.kind === "add"
                                        ? "+ "
                                        : row.kind === "del"
                                          ? "- "
                                          : "  "}
                                      {row.text}
                                    </div>
                                  ))}
                                </pre>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Saves are validated against the skill&apos;s output contract before
          they are stored; every version is kept, so reverting is always a
          pointer move away.
        </p>
      </SettingsSection>
    </div>
  );
}
