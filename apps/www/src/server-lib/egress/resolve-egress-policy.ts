import type { DB } from "@terragon/shared/db";
import { getRepoReviewSetting } from "@terragon/shared/model/repo-review-settings";
import {
  buildEgressPolicyShape,
  type EgressPolicyShape,
} from "@terragon/shared/model/egress-policy";
import { nonLocalhostPublicAppUrl } from "@/lib/server-utils";

/**
 * The plane a resolved policy will be enforced on. The distinction matters for
 * the github hosts (#81): on the WORKER plane the credential brokers run in the
 * worker process, whose outbound traffic is NOT subject to the agent's egress
 * fence — so `github.com`/`api.github.com` are dropped from the worker's system
 * list (#66 AC4). In a SANDBOX the provider allowlist fences the whole box,
 * brokers included, so those hosts must stay.
 */
export type EgressPlane = "worker" | "sandbox";

/**
 * The hosts every run must reach regardless of operator policy (#66 spec §3.2):
 * the daemon callback host (events + next-message), `github.com` /
 * `api.github.com` (see below), and `api.anthropic.com` for box-key runs.
 * Merged into the shape control-plane-side so planes receive a FINAL allowlist
 * and never compute system entries themselves.
 *
 * #66 AC4: the worker plane is now brokered (#81 delivered), so it DROPS the
 * github hosts — the agent reaches GitHub only through loopback brokers, which
 * NO_PROXY exempts from the egress proxy. The sandbox plane keeps them (#114).
 * Deployment precondition: every worker box must be on the brokered #113 build
 * before this takes effect under enforcement — a pre-#113 box still uses direct
 * github.com egress and would have its pushes bricked by the tighter allowlist
 * (control plane and worker boxes deploy independently; version skew is real).
 *
 * FOLLOW-UP: this flat list over-grants — e.g. a Gemini-harness run does not
 * need `api.anthropic.com`. The right shape is a harness-keyed system-host map
 * (per-agent/per-lane entries resolved from the run's harness at dispatch);
 * deliberately deferred until the harness identity is available here.
 */
function systemEgressHosts(plane: EgressPlane): string[] {
  const callbackHost = new URL(nonLocalhostPublicAppUrl()).host;
  // Worker plane (#66 AC4): the credential brokers (#81) are DELIVERED, so the
  // agent reaches GitHub only through loopback — git via the git broker
  // (`http://127.0.0.1:<port>`) and gh via the broker's unix socket — both
  // exempted from the egress proxy by NO_PROXY. It therefore needs no direct
  // egress to github.com / api.github.com, so they are dropped from the
  // allowlist. The sandbox plane still holds the resident token and pushes to
  // GitHub directly (#114), so it keeps both hosts.
  if (plane === "worker") {
    return [callbackHost, "api.anthropic.com"];
  }
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
  plane,
}: {
  db: DB;
  organizationId: string | null | undefined;
  repoFullName: string;
  /** Which plane enforces the result — drives the system-host set (#81). */
  plane: EgressPlane;
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
    { systemHosts: systemEgressHosts(plane) },
  );
}
