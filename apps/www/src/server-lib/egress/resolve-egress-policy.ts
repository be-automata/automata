import type { DB } from "@terragon/shared/db";
import { getRepoReviewSetting } from "@terragon/shared/model/repo-review-settings";
import {
  buildEgressPolicyShape,
  type EgressPolicyShape,
} from "@terragon/shared/model/egress-policy";
import { nonLocalhostPublicAppUrl } from "@/lib/server-utils";

/**
 * The hosts every run must reach regardless of operator policy (#66 spec §3.2):
 * the daemon callback host (events + next-message), `github.com` until #81
 * removes direct git from non-review lanes, `api.github.com` (the worker's gh
 * preflight calls it — enforcement without it bricks runs), and
 * `api.anthropic.com` for box-key runs. Merged into the shape
 * control-plane-side so planes receive a FINAL allowlist and never compute
 * system entries themselves.
 *
 * FOLLOW-UP: this flat list over-grants — e.g. a Gemini-harness run does not
 * need `api.anthropic.com`. The right shape is a harness-keyed system-host map
 * (per-agent/per-lane entries resolved from the run's harness at dispatch);
 * deliberately deferred until the harness identity is available here.
 */
function systemEgressHosts(): string[] {
  const callbackHost = new URL(nonLocalhostPublicAppUrl()).host;
  return [callbackHost, "github.com", "api.github.com", "api.anthropic.com"];
}

/**
 * Resolve the ONE egress-policy shape for a single run (#66, mirroring
 * `resolveApproveFloor`): read the (org, repo) settings row LIVE — a dashboard
 * write applies on the next dispatch with no restart — and build the final
 * shape (level + fully-resolved allowlist incl. system hosts).
 *
 * Returns null (= NO enforcement, today's behavior) when the thread has no
 * organization (a pre-tenant-fence legacy thread cannot carry a per-repo
 * policy — never another org's), when no row exists, or when the row has no
 * `egressPolicy` set. An INVALID stored policy/allowlist throws — a run must
 * fail loudly at dispatch rather than start with a silently-wrong policy.
 */
export async function resolveEgressPolicy({
  db,
  organizationId,
  repoFullName,
}: {
  db: DB;
  organizationId: string | null | undefined;
  repoFullName: string;
}): Promise<EgressPolicyShape | null> {
  if (!organizationId) {
    return null;
  }
  const row = await getRepoReviewSetting({ db, organizationId, repoFullName });
  if (!row) {
    return null;
  }
  return buildEgressPolicyShape(
    { egressPolicy: row.egressPolicy, egressAllowlist: row.egressAllowlist },
    { systemHosts: systemEgressHosts() },
  );
}
