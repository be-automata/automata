import { db } from "@/lib/db";
import { githubSideEffectsEnabled } from "@/lib/github-side-effects";
import { cellBrokerEnabled } from "@/server-lib/cell-broker/common";
import { createGitBrokerHandler } from "@/server-lib/cell-broker/git";
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
  mintWriteToken: getWriteInstallationToken,
  sideEffectsEnabled: githubSideEffectsEnabled,
  enabled: cellBrokerEnabled,
});

export const GET = (request: Request) => handler(request);
export const POST = (request: Request) => handler(request);
