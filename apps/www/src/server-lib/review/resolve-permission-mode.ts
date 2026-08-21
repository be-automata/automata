import type { DB } from "@terragon/shared/db";
import type { Automation, ThreadTrustContext } from "@terragon/shared/db/types";
import { getOrganizationReviewSetting } from "@terragon/shared/model/organization-review-settings";
import { getRepoReviewSetting } from "@terragon/shared/model/repo-review-settings";
import { resolveComposedTrustedAuthorThreshold } from "@terragon/review/settings/review-floor-resolver";
import {
  resolvePermissionMode,
  isPermissionMode,
  type PermissionMode,
  type PermissionContext,
} from "@terragon/review/settings/permission-floor";

/**
 * The ONE shared resolver (ADR-005 §3b) both dispatch seams —
 * `remote-daemon-message.ts` and `startAgentMessage.ts` — call to derive the
 * effective `permissionMode` for a dispatch. Enforcing the cap in only one
 * seam lets the other bypass it, so this module is the single source of
 * truth; neither seam is allowed its own tighten logic.
 *
 * Modeled on `resolve-approve-floor.ts`: reads the automation's trigger type
 * + configured `permissionMode`, composes the org/repo `trustedAuthorThreshold`
 * floor (`T_eff = max(T_org, T_repo)`, both-absent -> "MEMBER"), and folds the
 * thread's server-derived trust snapshot into {@link resolvePermissionMode}.
 *
 * `scopeCaps` is NOT exposed here — this ticket (#82) adds no org/repo
 * permission-mode CAP columns (only a per-trigger CONFIGURED value), so the
 * resolver always calls `resolvePermissionMode(configured, ctx)` with the
 * default empty `scopeCaps`.
 *
 * The trusted-internal relaxation (cap = "allowAll" for a trusted, non-fork
 * PR) is defined here but not yet enable-able for GitHub WRITE: it requires
 * the credential broker (#81, ADR-004's "Negative / watch"). Until #81 lands,
 * an UNCONFIGURED trusted-internal PR still resolves to "review" (the
 * default), which is what every test in this family asserts.
 */
export async function resolvePermissionModeForDispatch({
  db,
  organizationId,
  repoFullName,
  automation,
  thread,
  threadChatPermissionMode,
}: {
  db: DB;
  organizationId: string | null | undefined;
  /**
   * The repo this dispatch runs against — composes the repo-tier
   * `trustedAuthorThreshold` override (`T_eff = max(T_org, T_repo)`).
   * Org-less threads skip both reads (see below), so this may be omitted
   * then.
   */
  repoFullName?: string | null;
  /** The automation this dispatch runs, when already fetched by the caller — avoids a duplicate read. */
  automation: Pick<Automation, "triggerType" | "triggerConfig"> | null;
  /**
   * The minimal thread fields the resolver needs: the server-derived trust
   * snapshot (ADR-005 §3a). `trustContext: null | undefined` fails closed —
   * treated as "no trust", never as trusted.
   */
  thread: { trustContext?: ThreadTrustContext | null } | null;
  /**
   * The persisted per-threadChat `permissionMode` (`"allowAll" | "plan" | null`
   * — the column never stores `"review"`, ADR-005 §5). This is TODAY's
   * "configured" signal for a non-PR-family dispatch (`threadChat.permissionMode
   * || "allowAll"`) — used ONLY as the fallback when the automation's OWN
   * trigger-config `permissionMode` is absent AND the event is non-PR-family.
   *
   * Deliberately NOT consulted for a PR-family event: its column default
   * (`"allowAll"`, stamped at thread creation by `createNewThread` regardless
   * of the automation) would otherwise masquerade as a genuine "configured"
   * override and defeat ADR-005 §2's worked case ("trusted-internal PR
   * unconfigured -> review, the default holds") — the PR-family "configured"
   * signal is the automation's trigger config ONLY.
   */
  threadChatPermissionMode?: "allowAll" | "plan" | null;
}): Promise<PermissionMode> {
  const isPrFamily = automation?.triggerType === "pull_request";

  const automationConfiguredRaw =
    automation && "permissionMode" in automation.triggerConfig
      ? automation.triggerConfig.permissionMode
      : undefined;
  const automationConfigured: PermissionMode | undefined = isPermissionMode(
    automationConfiguredRaw,
  )
    ? automationConfiguredRaw
    : undefined;

  const configured: PermissionMode | undefined =
    automationConfigured ??
    (!isPrFamily && isPermissionMode(threadChatPermissionMode)
      ? threadChatPermissionMode
      : undefined);

  const trustedAuthorThreshold = await resolveTrustedAuthorThreshold({
    db,
    organizationId,
    repoFullName,
  });

  const trust = thread?.trustContext
    ? {
        isFork: thread.trustContext.isFork,
        authorAssociation: thread.trustContext.authorAssociation,
      }
    : null;

  const ctx: PermissionContext = {
    isPrFamily,
    trust,
    trustedAuthorThreshold,
  };

  return resolvePermissionMode(configured, ctx);
}

/**
 * `T_eff = max(T_org, T_repo)` (ADR-005 §4), fenced by the same
 * organizationId scope resolve-approve-floor.ts uses. An org-less thread
 * (pre-tenant-fence legacy thread) cannot carry either row, so it resolves to
 * the locked "MEMBER" default via
 * `resolveComposedTrustedAuthorThreshold(undefined, undefined)` — exactly
 * today's behavior for the review-severity axis.
 */
async function resolveTrustedAuthorThreshold({
  db,
  organizationId,
  repoFullName,
}: {
  db: DB;
  organizationId: string | null | undefined;
  repoFullName?: string | null;
}) {
  if (!organizationId) {
    return resolveComposedTrustedAuthorThreshold(undefined, undefined);
  }
  const [orgRow, repoRow] = await Promise.all([
    getOrganizationReviewSetting({ db, organizationId }),
    repoFullName
      ? getRepoReviewSetting({ db, organizationId, repoFullName })
      : Promise.resolve(undefined),
  ]);
  return resolveComposedTrustedAuthorThreshold(
    orgRow?.trustedAuthorThreshold
      ? { trustedAuthorThreshold: orgRow.trustedAuthorThreshold }
      : null,
    repoRow?.trustedAuthorThreshold
      ? { trustedAuthorThreshold: repoRow.trustedAuthorThreshold }
      : null,
  );
}
