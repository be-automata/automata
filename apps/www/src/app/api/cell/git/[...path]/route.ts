import { db } from "@/lib/db";
import { githubSideEffectsEnabled } from "@/lib/github-side-effects";
import { waitUntil } from "@/lib/wait-until";
import { cellBrokerEnabled } from "@/lib/cell-broker-enabled";
import { createGitBrokerHandler } from "@terragon/cell-broker/git";
import {
  getOrganizationReviewSetting,
  isCellWorkflowWriteEnabled,
} from "@terragon/shared/model/organization-review-settings";
import {
  getCellReadInstallationToken,
  getWriteInstallationToken,
} from "@terragon/shared/github-app";

/**
 * /api/cell/git/<owner>/<repo>.git/<endpoint>: the remote-cell git broker
 * (ADR-014, #606). Answers 404 unless CELL_BROKER_ENABLED.
 */
export const dynamic = "force-dynamic";

const handler = createGitBrokerHandler({
  db,
  fetchImpl: (input, init) => fetch(input, init),
  mintReadToken: getCellReadInstallationToken,
  mintWriteToken: (owner, repo, opts) =>
    getWriteInstallationToken(owner, repo, opts),
  // Errors propagate: the broker answers 500 rather than minting on a guess.
  allowWorkflowWrite: async (organizationId) =>
    isCellWorkflowWriteEnabled(
      await getOrganizationReviewSetting({ db, organizationId }),
    ),
  sideEffectsEnabled: githubSideEffectsEnabled,
  enabled: cellBrokerEnabled,
  waitUntil,
});

export const GET = (request: Request) => handler(request);
export const POST = (request: Request) => handler(request);
