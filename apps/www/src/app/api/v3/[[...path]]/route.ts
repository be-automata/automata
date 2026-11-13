import { db } from "@/lib/db";
import { cellBrokerEnabled } from "@/server-lib/cell-broker/common";
import { createGhBrokerHandler } from "@/server-lib/cell-broker/gh";
import { getReadOnlyInstallationToken } from "@terragon/shared/github-app";

/**
 * /api/v3/<path>: read-only GitHub REST for a remote cell's `gh` (it treats
 * GH_HOST=<this host> as an Enterprise Server host). ADR-014, #606. Answers 404
 * unless CELL_BROKER_ENABLED. Every method reaches the handler, which refuses
 * writes with a 403.
 */
export const dynamic = "force-dynamic";

const handler = createGhBrokerHandler({
  db,
  fetchImpl: (input, init) => fetch(input, init),
  mintReadToken: getReadOnlyInstallationToken,
  enabled: cellBrokerEnabled,
});

const serve = (request: Request) => handler(request, "rest");

export const GET = serve;
export const HEAD = serve;
export const POST = serve;
export const PUT = serve;
export const PATCH = serve;
export const DELETE = serve;
