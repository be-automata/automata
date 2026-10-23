"use client";

import React, { useState } from "react";
import { AlertCircle, AlertTriangle } from "lucide-react";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScopeBadge } from "@/components/ui/scope-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ConflictBanner } from "@/components/settings/review-settings-parts";
import { SettingsSection } from "@/components/settings/settings-row";
import { ConflictError } from "@/queries/error-from-response";
import {
  BudgetAboveCeilingError,
  ConfirmationMismatchError,
  KnowledgeOffboardedError,
  useKnowledgeOffboard,
  useKnowledgeSettings,
  useUpdateKnowledgeSettings,
} from "@/queries/knowledge-settings-queries";
import {
  KNOWLEDGE_KILL_SWITCH_NOTE,
  KNOWLEDGE_OFFBOARD_NOTE,
  draftFromControls,
  draftToPatch,
  knowledgeActionDetail,
  knowledgeActionLabel,
  microUsdToDollars,
  purgeCountdown,
  spendView,
  type KnowledgeDraft,
  type KnowledgePatch,
  type KnowledgeSettingsResponse,
} from "./knowledge-form";

/**
 * Settings > Knowledge (phase 12, OPS-02/03/04): the org kill switch, the
 * monthly budget with current spend, the cap-hit banner and offboarding.
 * A PURE view (every state is a prop, testable with renderToStaticMarkup) and
 * a thin container wiring the query hooks. UI gating is a convenience only:
 * every write is authorized by the 12-06 routes.
 */

export const MEMBER_READONLY_NOTE =
  "Only org owners and admins can change this.";

export type KnowledgeServerError =
  | { kind: "conflict" }
  | { kind: "above_ceiling"; ceilingMicroUsd: number | null }
  | { kind: "offboarded" }
  | { kind: "confirmation_mismatch" }
  | { kind: "other"; message: string };

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

function formatMonth(iso: string): string {
  return iso.slice(0, 7);
}

function dollars(micro: number): string {
  return `$${microUsdToDollars(micro)}`;
}

/** Typed-slug confirmation. The button stays off until the text matches exactly. */
export function OffboardConfirmForm({
  orgSlug,
  typed,
  onTypedChange,
  pending,
  mismatch,
  onConfirm,
}: {
  orgSlug: string;
  typed: string;
  onTypedChange: (text: string) => void;
  pending: boolean;
  mismatch: boolean;
  onConfirm: () => void;
}) {
  const matches = typed === orgSlug;
  return (
    <div className="grid gap-3" data-testid="knowledge-offboard-confirm">
      <p className="text-sm">
        Type <span className="font-mono font-semibold">{orgSlug}</span> to
        confirm.
      </p>
      <Label htmlFor="knowledge-offboard-slug" className="sr-only">
        Organization slug
      </Label>
      <Input
        id="knowledge-offboard-slug"
        className="min-h-11"
        value={typed}
        autoComplete="off"
        onChange={(e) => onTypedChange(e.target.value)}
      />
      {mismatch && (
        <p
          className="text-xs text-destructive"
          data-testid="knowledge-offboard-error"
        >
          The typed text did not match the organization slug.
        </p>
      )}
      <Button
        variant="destructive"
        className="min-h-11"
        data-testid="knowledge-offboard-confirm-button"
        disabled={!matches || pending}
        onClick={onConfirm}
      >
        Offboard knowledge
      </Button>
    </div>
  );
}

export interface KnowledgeSectionViewProps {
  status: "loading" | "error" | "ready";
  errorMessage?: string;
  data: KnowledgeSettingsResponse | null;
  draft: KnowledgeDraft;
  onDraftChange: (draft: KnowledgeDraft) => void;
  serverError: KnowledgeServerError | null;
  saving: boolean;
  offboardPending: boolean;
  now: Date;
  offboardOpen: boolean;
  onOffboardOpenChange: (open: boolean) => void;
  offboardTyped: string;
  onOffboardTypedChange: (text: string) => void;
  onSave: (patch: KnowledgePatch) => void;
  onReload: () => void;
  onOffboard: (confirm: string) => void;
  onUndo: () => void;
}

export function KnowledgeSectionView(props: KnowledgeSectionViewProps) {
  const { status, data } = props;
  return (
    <SettingsSection
      label="Knowledge"
      description="Grounded knowledge for this organization. The engine is Off by default."
      cta={<ScopeBadge scope="org" />}
    >
      {status === "loading" ? (
        <div className="grid gap-2" data-testid="knowledge-skeleton">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : status === "error" ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Couldn&apos;t load the knowledge settings</AlertTitle>
          <AlertDescription>
            {props.errorMessage ?? "Reload the page to try again."}
          </AlertDescription>
        </Alert>
      ) : data === null || data.controls === null ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="knowledge-no-org"
        >
          Select an organization to manage its knowledge settings.
        </p>
      ) : (
        <KnowledgeReady {...props} data={data} />
      )}
    </SettingsSection>
  );
}

function KnowledgeReady(
  props: KnowledgeSectionViewProps & { data: KnowledgeSettingsResponse },
) {
  const { data, draft, serverError, saving, now } = props;
  const controls = data.controls;
  if (controls === null) return null;
  const { viewer, spend, actions, orgSlug } = data;

  const offboarded = controls.offboardedAt !== null;
  const purged = controls.purgedAt !== null;
  // Org admins edit everything; a non-member platform admin edits the budget only.
  const canEditBudget = viewer.isOrgAdmin || viewer.isPlatformAdmin;
  const canEditEngine = viewer.isOrgAdmin && !offboarded;
  const result = draftToPatch(draft, controls, viewer);
  const clientError = "error" in result ? result.error : undefined;
  const patch = "patch" in result ? result.patch : {};
  const canSave =
    canEditBudget &&
    !saving &&
    clientError === undefined &&
    Object.keys(patch).length > 0;
  const view = spend === null ? null : spendView(spend);

  return (
    <>
      {serverError?.kind === "conflict" && (
        <ConflictBanner testId="knowledge-conflict" onReload={props.onReload} />
      )}
      {serverError?.kind === "above_ceiling" && (
        <Alert variant="destructive" data-testid="knowledge-ceiling-error">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Above the platform ceiling</AlertTitle>
          <AlertDescription>
            {serverError.ceilingMicroUsd === null
              ? "That budget is above the platform ceiling."
              : `The platform ceiling is ${dollars(serverError.ceilingMicroUsd)}. Choose a lower budget or ask a platform admin.`}
          </AlertDescription>
        </Alert>
      )}
      {serverError?.kind === "offboarded" && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Offboarded</AlertTitle>
          <AlertDescription>
            This organization is offboarded. Undo the offboarding to turn the
            engine on.
          </AlertDescription>
        </Alert>
      )}
      {serverError?.kind === "other" && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{serverError.message}</AlertDescription>
        </Alert>
      )}

      {view?.paused === true && (
        <div
          role="status"
          data-testid="knowledge-paused-banner"
          className="flex items-start gap-2 rounded-md border border-state-needs-you p-3 text-sm text-state-needs-you"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            <span className="font-semibold">Needs you.</span> The monthly budget
            was reached: model-spending knowledge work is paused until the next
            month or a higher budget.
          </span>
        </div>
      )}

      {offboarded && (
        <div
          className="rounded-md border p-3 text-sm"
          data-testid="knowledge-offboarded-banner"
        >
          {purged ? (
            <p>
              Knowledge data was deleted on{" "}
              {formatDate(controls.purgedAt ?? "")}.
            </p>
          ) : (
            <p>
              Offboarded on {formatDate(controls.offboardedAt ?? "")}; data is
              deleted on {formatDate(controls.purgeAfter ?? "")} (
              {controls.purgeAfter === null
                ? 0
                : purgeCountdown(controls.purgeAfter, now)}{" "}
              days).
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            className="mt-2 min-h-11"
            data-testid="knowledge-undo"
            disabled={!viewer.isOrgAdmin || props.offboardPending}
            onClick={props.onUndo}
          >
            {purged ? "Re-enable onboarding" : "Undo offboarding"}
          </Button>
        </div>
      )}

      {!viewer.isOrgAdmin && (
        <p
          className="text-xs text-muted-foreground"
          data-testid="knowledge-readonly-note"
        >
          {MEMBER_READONLY_NOTE}
        </p>
      )}

      <div className="flex items-start justify-between gap-4">
        <div className="grid gap-1">
          <Label htmlFor="knowledge-engine">Engine</Label>
          <p className="text-xs text-muted-foreground">
            {KNOWLEDGE_KILL_SWITCH_NOTE}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm">{draft.engine ? "On" : "Off"}</span>
          <Switch
            id="knowledge-engine"
            checked={draft.engine}
            disabled={!canEditEngine || saving}
            onCheckedChange={(engine) =>
              props.onDraftChange({ ...draft, engine })
            }
          />
        </div>
      </div>

      <div className="grid gap-1">
        <Label htmlFor="knowledge-budget">Monthly budget (USD)</Label>
        <Input
          id="knowledge-budget"
          className="min-h-11"
          value={draft.budget}
          placeholder={microUsdToDollars(controls.effectiveBudgetMicroUsd)}
          disabled={!canEditBudget || saving}
          aria-invalid={clientError !== undefined}
          onChange={(e) =>
            props.onDraftChange({ ...draft, budget: e.target.value })
          }
        />
        <p className="text-xs text-muted-foreground">
          Effective budget: {dollars(controls.effectiveBudgetMicroUsd)}. Leave
          empty to use the platform default.
        </p>
        <p
          className="text-xs text-muted-foreground"
          data-testid="knowledge-platform-ceiling"
        >
          Platform ceiling: {dollars(controls.ceilingMicroUsd)}, set by platform
          admins
        </p>
        {clientError !== undefined && (
          <p
            className="text-xs text-destructive"
            data-testid="knowledge-budget-error"
          >
            {clientError.message}
          </p>
        )}
      </div>

      <div>
        <Button
          size="sm"
          className="min-h-11"
          data-testid="knowledge-save"
          disabled={!canSave}
          onClick={() => props.onSave(patch)}
        >
          Save
        </Button>
      </div>

      <div className="grid gap-2" data-testid="knowledge-spend">
        <h4 className="text-sm font-medium">
          Spend{" "}
          {spend !== null && (
            <span className="font-mono text-xs text-muted-foreground">
              {formatMonth(spend.windowStart)} (UTC)
            </span>
          )}
        </h4>
        {spend !== null && view !== null && (
          <>
            <div
              className="h-2 w-full overflow-hidden rounded-sm bg-muted"
              role="progressbar"
              aria-valuenow={view.percentUsed}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Budget used"
            >
              <div
                className="h-full bg-foreground"
                style={{ width: `${view.percentUsed}%` }}
              />
            </div>
            <dl className="grid grid-cols-2 gap-2 font-mono text-xs sm:grid-cols-4">
              <div>
                <dt className="text-muted-foreground">Spent</dt>
                <dd>{dollars(spend.spentMicroUsd)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Reserved</dt>
                <dd>{dollars(spend.reservedMicroUsd)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Remaining</dt>
                <dd>{dollars(spend.remainingMicroUsd)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Cap</dt>
                <dd>{dollars(spend.capMicroUsd)}</dd>
              </div>
            </dl>
            <p className="text-xs text-muted-foreground">
              {view.percentUsed}% used
            </p>
          </>
        )}
      </div>

      {!offboarded && (
        <div className="grid gap-2 rounded-md border p-3">
          <h4 className="text-sm font-medium">Offboarding</h4>
          <p className="text-xs text-muted-foreground">
            {KNOWLEDGE_OFFBOARD_NOTE}
          </p>
          <div>
            <Button
              variant="outline"
              size="sm"
              className="min-h-11"
              data-testid="knowledge-offboard-open"
              disabled={!viewer.isOrgAdmin || orgSlug === null}
              onClick={() => props.onOffboardOpenChange(true)}
            >
              Offboard knowledge
            </Button>
          </div>
        </div>
      )}
      {orgSlug !== null && (
        <Dialog
          open={props.offboardOpen}
          onOpenChange={props.onOffboardOpenChange}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Offboard knowledge</DialogTitle>
              <DialogDescription>{KNOWLEDGE_OFFBOARD_NOTE}</DialogDescription>
            </DialogHeader>
            <OffboardConfirmForm
              orgSlug={orgSlug}
              typed={props.offboardTyped}
              onTypedChange={props.onOffboardTypedChange}
              pending={props.offboardPending}
              mismatch={serverError?.kind === "confirmation_mismatch"}
              onConfirm={() => props.onOffboard(props.offboardTyped)}
            />
            <DialogFooter />
          </DialogContent>
        </Dialog>
      )}

      <div className="grid gap-2">
        <h4 className="text-sm font-medium">Recent admin actions</h4>
        {actions.length === 0 ? (
          <p className="text-xs text-muted-foreground">No admin actions yet.</p>
        ) : (
          <ul className="grid gap-1" data-testid="knowledge-actions">
            {actions.map((a) => {
              const detail = knowledgeActionDetail(a.action, a.target);
              return (
                <li key={a.id} className="font-mono text-xs">
                  {knowledgeActionLabel(a.action)}
                  {detail !== null && ` (${detail})`} ·{" "}
                  {formatDate(a.createdAt)}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

function toServerError(error: unknown): KnowledgeServerError | null {
  if (error === null || error === undefined) return null;
  if (error instanceof ConflictError) return { kind: "conflict" };
  if (error instanceof BudgetAboveCeilingError) {
    return { kind: "above_ceiling", ceilingMicroUsd: error.ceilingMicroUsd };
  }
  if (error instanceof KnowledgeOffboardedError) return { kind: "offboarded" };
  if (error instanceof ConfirmationMismatchError) {
    return { kind: "confirmation_mismatch" };
  }
  return null; // other errors are toasted by the mutation
}

/** Thin container: binds the query hooks and local draft state to the view. */
export function KnowledgeSection() {
  const query = useKnowledgeSettings();
  const update = useUpdateKnowledgeSettings();
  const offboard = useKnowledgeOffboard();
  const data = query.data ?? null;
  // Remount the editor state when another write changes the stored row.
  const version = data?.controls?.updatedAt ?? "none";
  return (
    <KnowledgeSectionBody
      key={version}
      query={query}
      update={update}
      offboard={offboard}
      data={data}
    />
  );
}

function KnowledgeSectionBody({
  query,
  update,
  offboard,
  data,
}: {
  query: ReturnType<typeof useKnowledgeSettings>;
  update: ReturnType<typeof useUpdateKnowledgeSettings>;
  offboard: ReturnType<typeof useKnowledgeOffboard>;
  data: KnowledgeSettingsResponse | null;
}) {
  const [draft, setDraft] = useState(() =>
    draftFromControls(data?.controls ?? null),
  );
  const [offboardOpen, setOffboardOpen] = useState(false);
  const [offboardTyped, setOffboardTyped] = useState("");

  const serverError =
    toServerError(update.error) ?? toServerError(offboard.error);

  return (
    <KnowledgeSectionView
      status={query.isLoading ? "loading" : query.isError ? "error" : "ready"}
      errorMessage={
        query.error instanceof Error ? query.error.message : undefined
      }
      data={data}
      draft={draft}
      onDraftChange={setDraft}
      serverError={serverError}
      saving={update.isPending}
      offboardPending={offboard.isPending}
      now={new Date()}
      offboardOpen={offboardOpen}
      onOffboardOpenChange={(open) => {
        setOffboardOpen(open);
        if (!open) setOffboardTyped("");
      }}
      offboardTyped={offboardTyped}
      onOffboardTypedChange={setOffboardTyped}
      onSave={(patch) => {
        offboard.reset();
        update.mutate(patch);
      }}
      onReload={() => {
        update.reset();
        void query.refetch();
      }}
      onOffboard={(confirm) => {
        update.reset();
        offboard.mutate(
          { action: "offboard", confirm },
          {
            onSuccess: () => {
              setOffboardOpen(false);
              setOffboardTyped("");
            },
          },
        );
      }}
      onUndo={() => {
        update.reset();
        offboard.mutate({ action: "undo" });
      }}
    />
  );
}
