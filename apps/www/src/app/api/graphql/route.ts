import { db } from "@/lib/db";
import { cellBrokerEnabled } from "@/server-lib/cell-broker/common";
import { createGhBrokerHandler } from "@/server-lib/cell-broker/gh";
import { getReadOnlyInstallationToken } from "@terragon/shared/github-app";

/**
 * /api/graphql: read-only GitHub GraphQL for a remote cell's `gh` (ADR-014,
 * #606). Mutations are refused. Answers 404 unless CELL_BROKER_ENABLED.
 */
export const dynamic = "force-dynamic";

const handler = createGhBrokerHandler({
  db,
  fetchImpl: (input, init) => fetch(input, init),
  mintReadToken: getReadOnlyInstallationToken,
  enabled: cellBrokerEnabled,
});

const serve = (request: Request) => handler(request, "graphql");

export const POST = serve;
export const GET = serve;
