import { env } from "@terragon/env/apps-www";
import type { DB } from "@terragon/shared/db";
import {
  deadCellAttempts,
  revokeAttempt,
} from "@terragon/shared/model/cell-authority";
import { reconcileExpiredCells } from "@terragon/sandbox/cell-reconcile";
import type { ReconcileResult } from "@terragon/sandbox/cell-reconcile";
import {
  CellProviderError,
  createOpenSandboxCellProvider,
} from "@terragon/sandbox/opensandbox-cell";
import { CELL_LEASE_STALE_MS, type ICellProvider } from "@terragon/types/cell";

import { cellBrokerHost, resolveOpenSandboxEnv } from "./cell-gate";

/**
 * Cell control plane (#634 S4): the provider handle and the reconciler wiring.
 * www lists, revokes and tears down for the reconciler only; the worker creates
 * cells and tears them down at run end (OD-3). The box answers only behind a
 * Cloudflare Access service token (#656 PR-C).
 */

/**
 * The lease rule is ON (#656 PR-E): an attempt unseen for `CELL_LEASE_STALE_MS`
 * (5 min) is dead, besides revoked, fenced and done ones. It is safe now that
 * PR-E's worker stamps the lease (the setup heartbeat every 60 s, then the poll
 * every 7 s) and PR-D retires a finished attempt's token. Deploy www first: no
 * cell exists before a PR-E worker runs one, so either order is safe.
 */
const CELL_RECONCILE_STALE_MS: number | null = CELL_LEASE_STALE_MS;

const ACCESS_HEADER_ID = "CF-Access-Client-Id";
const ACCESS_HEADER_SECRET = "CF-Access-Client-Secret";

let warnedAccessMisconfig = false;

/**
 * A fetch that sends the Access service token to `origin` only. A request for
 * any other origin is refused (the message names no URL), and redirects are not
 * followed: an Access 302 becomes a non-ok response instead of carrying the
 * headers to the login page. Calls the global `fetch` unbound (workerd).
 */
/** Exported for the origin-fence test only; callers use `cellProvider`. */
export function accessFetch({
  origin,
  clientId,
  clientSecret,
}: {
  origin: string;
  clientId: string;
  clientSecret: string;
}): typeof fetch {
  return (input, init) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (new URL(href).origin !== origin) {
      throw new CellProviderError("origin_refused", "fetch");
    }
    const headers = new Headers(init?.headers);
    headers.set(ACCESS_HEADER_ID, clientId);
    headers.set(ACCESS_HEADER_SECRET, clientSecret);
    return fetch(input, { ...init, headers, redirect: "manual" });
  };
}

/** Used only by `create`, which www never calls. */
const GUEST_ENTRYPOINT: readonly string[] = ["sleep", "infinity"];
const SELF_CHECK_ARGV: readonly string[] = ["true"];

/** Logs the message only: field values (ids, tags) stay out of the provider's own lines. */
function prefixedLogger(prefix: string, withFields: boolean) {
  return {
    info: (msg: string, fields?: Record<string, unknown>) =>
      console.log(
        `[${prefix}] ${msg}`,
        ...(withFields && fields ? [fields] : []),
      ),
    warn: (msg: string, fields?: Record<string, unknown>) =>
      console.warn(
        `[${prefix}] ${msg}`,
        ...(withFields && fields ? [fields] : []),
      ),
  };
}

export function cellProvider(): ICellProvider | null {
  const resolved = resolveOpenSandboxEnv();
  if (resolved.state === "off") return null;
  if (resolved.state === "invalid") {
    // Half-set, or Access headers over a non-https URL: stay off, say so once.
    if (!warnedAccessMisconfig) {
      warnedAccessMisconfig = true;
      console.warn(
        "[cell] OpenSandbox Access config is incomplete or the URL is not https; the cell control plane is off",
      );
    }
    return null;
  }
  const { url, apiKey, access } = resolved;
  const doFetch: typeof fetch = access
    ? accessFetch(access)
    : (input, init) => fetch(input, init);
  return createOpenSandboxCellProvider(
    {
      baseUrl: url,
      apiKey,
      image: env.OPENSANDBOX_GUEST_IMAGE,
      entrypoint: GUEST_ENTRYPOINT,
      selfCheck: { argv: SELF_CHECK_ARGV },
    },
    {
      fetch: doFetch,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now,
      logger: prefixedLogger("cell", false),
    },
  );
}

export async function runCellReconciler({
  db,
  provider,
  now = Date.now,
}: {
  db: DB;
  provider: Pick<ICellProvider, "listByTags" | "teardown">;
  now?: () => number;
}): Promise<ReconcileResult> {
  return reconcileExpiredCells({
    provider,
    deployment: cellBrokerHost(),
    // false for an unknown step is fine: nothing to revoke
    revoke: async (stepKey, attempt) => {
      await revokeAttempt({ db, stepKey, attempt });
    },
    isDead: (keys) =>
      deadCellAttempts({ db, keys, staleMs: CELL_RECONCILE_STALE_MS }),
    now,
    logger: prefixedLogger("cell:reconcile", true),
  });
}
