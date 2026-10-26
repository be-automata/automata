import { redactSecrets } from "@terragon/utils/redact";

import { decodeJwtClaims } from "../agent-run/assert-auth";
import { GuardedFileError, readGuardedFile } from "../agent-run/guarded-file";

/**
 * Engine-side tenant provisioning (#374 part B): create a tenant on the box's
 * hatchet-lite and mint an API token scoped to it, for
 * `deploy/bind-hatchet-tenant.ts` (www) and #375's worker enrollment.
 *
 * The surface is loopback + ssh only, by construction: the engine URL must be
 * a loopback literal, the admin password comes from a file only its owner can
 * read, and nothing here listens on a socket. The engine's tenant-create route
 * refuses API tokens (403), so it runs on an admin session; the token itself is
 * minted by the image's own `hatchet-admin`, which has no tenant-create command.
 *
 * Never logs or embeds the password, the session cookie or the token: errors
 * carry a fixed phrase plus at most a status code and the engine's validation
 * descriptions.
 */

export class ProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisionError";
  }
}

// IP literals only: `localhost` would hang the guarantee on /etc/hosts and DNS.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

/** The engine URL with any trailing slash removed; refuses anything not loopback. */
export function assertLoopbackEngineUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProvisionError("engine URL is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProvisionError("engine URL must be http(s)");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new ProvisionError(
      "engine URL must be the loopback literal 127.0.0.1 or [::1]; provisioning never leaves the box",
    );
  }
  if (url.username || url.password) {
    throw new ProvisionError("engine URL must not carry credentials");
  }
  return url.origin;
}

/**
 * The admin password, from a regular file owned by `uid` with no group or other
 * permission bits, opened without following symlinks (`readGuardedFile`).
 */
export function readAdminPassword(path: string, uid: number): string {
  let raw: string;
  try {
    raw = readGuardedFile(path, { ownerOnly: true, ownerUid: uid });
  } catch (e) {
    if (e instanceof GuardedFileError) {
      throw new ProvisionError(`admin credential ${e.message}`);
    }
    throw e;
  }
  const password = raw.trim();
  if (password.length === 0) {
    throw new ProvisionError(`admin credential ${path} is empty`);
  }
  return password;
}

/** `hatchet=<value>` from a login response's Set-Cookie headers, or null. */
export function extractSessionCookie(setCookies: string[]): string | null {
  for (const header of setCookies) {
    const pair = header.split(";", 1)[0]?.trim() ?? "";
    if (pair.startsWith("hatchet=") && pair.length > "hatchet=".length) {
      return pair;
    }
  }
  return null;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 15_000;

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : {};
}

function postJson(
  fetch: FetchLike,
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
    // A redirect would re-send the body (the password, on login) to wherever it points.
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

export async function engineLogin(args: {
  apiUrl: string;
  email: string;
  password: string;
  fetch: FetchLike;
}): Promise<string> {
  const res = await postJson(args.fetch, `${args.apiUrl}/api/v1/users/login`, {
    email: args.email,
    password: args.password,
  });
  if (res.status !== 200) {
    throw new ProvisionError(
      `engine login failed (HTTP ${res.status}); check HATCHET_ADMIN_EMAIL and the credential file`,
    );
  }
  const cookie = extractSessionCookie(res.headers.getSetCookie());
  if (cookie === null) {
    throw new ProvisionError("engine login returned no session cookie");
  }
  return cookie;
}

const TENANT_SLUG = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** The engine's validation descriptions from an error body, if it has any. */
function validationDetail(body: unknown): string {
  const errors = asRecord(body).errors;
  if (!Array.isArray(errors)) return "";
  const descriptions = errors
    .map((e) => asRecord(e).description)
    .filter((d): d is string => typeof d === "string");
  return descriptions.length > 0 ? `: ${descriptions.join("; ")}` : "";
}

export async function createTenant(args: {
  apiUrl: string;
  cookie: string;
  name: string;
  slug: string;
  fetch: FetchLike;
}): Promise<string> {
  if (!TENANT_SLUG.test(args.slug)) {
    throw new ProvisionError(
      `tenant slug ${JSON.stringify(args.slug)} must be 3-63 lowercase letters, digits or dashes`,
    );
  }
  if (args.name.trim().length === 0) {
    throw new ProvisionError("tenant name must not be empty");
  }
  const res = await postJson(
    args.fetch,
    `${args.apiUrl}/api/v1/tenants`,
    // The API's own default is V0; every route this box uses is V1.
    { name: args.name, slug: args.slug, engineVersion: "V1" },
    { cookie: args.cookie },
  );
  const body: unknown = await res.json().catch(() => null);
  if (res.status !== 200) {
    throw new ProvisionError(
      `tenant create failed (HTTP ${res.status})${validationDetail(body)}`,
    );
  }
  const tenant = asRecord(body);
  const id = asRecord(tenant.metadata).id;
  if (typeof id !== "string" || id.length === 0) {
    throw new ProvisionError("tenant create returned no tenant id");
  }
  if (tenant.version !== "V1") {
    throw new ProvisionError(
      `tenant ${id} was created on engine version ${String(tenant.version)}, not V1`,
    );
  }
  return id;
}

/** The `/hatchet-admin token create` argv itself, for any way of exec-ing into the engine. */
export function hatchetAdminTokenArgs(args: {
  tenantId: string;
  name: string;
  expiresIn: string;
}): string[] {
  return [
    "/hatchet-admin",
    "token",
    "create",
    "--config",
    "/config",
    "--tenant-id",
    args.tenantId,
    "--name",
    args.name,
    "--expiresIn",
    args.expiresIn,
  ];
}

/** The JWT `hatchet-admin token create` prints as its last line. Never echoes stdout. */
export function parseMintedToken(stdout: string): string {
  const last = stdout.trim().split("\n").pop()?.trim() ?? "";
  if (last.split(".").length !== 3 || /\s/.test(last)) {
    throw new ProvisionError("hatchet-admin did not print a token");
  }
  return last;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The token's own `exp` claim as an ISO time, or null (no signature check: it is ours). */
export function tokenExpiry(token: string): string | null {
  const exp = asRecord(decodeJwtClaims(token)).exp;
  return typeof exp === "number" && Number.isFinite(exp)
    ? new Date(exp * 1000).toISOString()
    : null;
}

/**
 * A failed `docker exec … hatchet-admin` as a ProvisionError. execFile's own
 * message echoes the argv and the full stderr, and hatchet-admin's stderr can
 * carry `/config` values (the engine's database URL); keep the exit code and a
 * short, redacted stderr tail only.
 */
export function describeAdminFailure(e: unknown): ProvisionError {
  const err = asRecord(e);
  if (err.killed === true) {
    return new ProvisionError("hatchet-admin timed out");
  }
  const stderr = typeof err.stderr === "string" ? err.stderr.trim() : "";
  // Redact the whole stream, then cut: a cut first could split a secret
  // past the point a pattern can recognise it.
  const tail = redactSecrets(stderr).slice(-300);
  return new ProvisionError(
    `hatchet-admin failed (exit ${String(err.code ?? "unknown")})${tail ? `: ${tail}` : ""}`,
  );
}

/** Go duration in hours (`8760h`): the only shape the CLI accepts for --expires-in. */
const TOKEN_EXPIRY = /^[1-9][0-9]{0,5}h$/;

export interface ProvisionOptions {
  apiUrl: string;
  adminEmail: string;
  passwordFile: string;
  tokenName: string;
  expiresIn: string;
  /** Create this tenant, or mint into an existing one (`tenantId`). */
  tenant: { name: string; slug: string } | { tenantId: string };
}

export interface ProvisionDeps {
  fetch: FetchLike;
  /** The running uid: the admin credential file must be owned by it. */
  uid: number;
  /** Runs this `/hatchet-admin …` argv inside the engine container; returns stdout. */
  runAdmin: (adminArgv: string[]) => Promise<string>;
  now: () => Date;
  /** Told the new tenant's id as soon as it exists, before the mint. */
  onTenantCreated?: (tenantId: string) => void;
}

export interface ProvisionResult {
  tenantId: string;
  token: string;
  /** When the token stops working: re-mint and re-bind before then. */
  expiresAt: string;
}

export async function provisionTenant(
  opts: ProvisionOptions,
  deps: ProvisionDeps,
): Promise<ProvisionResult> {
  const apiUrl = assertLoopbackEngineUrl(opts.apiUrl);
  if (!TOKEN_EXPIRY.test(opts.expiresIn)) {
    throw new ProvisionError(
      `token expiry ${JSON.stringify(opts.expiresIn)} must be whole hours, e.g. 8760h`,
    );
  }
  if (opts.tokenName.trim().length === 0) {
    throw new ProvisionError("token name must not be empty");
  }
  const created = !("tenantId" in opts.tenant);
  let tenantId: string;
  if ("tenantId" in opts.tenant) {
    if (!UUID.test(opts.tenant.tenantId)) {
      throw new ProvisionError("tenant id must be a UUID");
    }
    tenantId = opts.tenant.tenantId.toLowerCase();
  } else {
    const password = readAdminPassword(opts.passwordFile, deps.uid);
    const cookie = await engineLogin({
      apiUrl,
      email: opts.adminEmail,
      password,
      fetch: deps.fetch,
    });
    tenantId = await createTenant({
      apiUrl,
      cookie,
      name: opts.tenant.name,
      slug: opts.tenant.slug,
      fetch: deps.fetch,
    });
    deps.onTenantCreated?.(tenantId);
  }
  const mintedAt = deps.now();
  let token: string;
  try {
    token = parseMintedToken(
      await deps.runAdmin(
        hatchetAdminTokenArgs({
          tenantId,
          name: opts.tokenName,
          expiresIn: opts.expiresIn,
        }),
      ),
    );
  } catch (e) {
    if (created) {
      // The slug is taken now, so a plain re-run fails; say how to finish.
      const message = e instanceof Error ? e.message : String(e);
      throw new ProvisionError(
        `tenant ${tenantId} was created but the token mint failed (${message}); re-run with --tenant-id ${tenantId} --token-name ${opts.tokenName}`,
      );
    }
    throw e;
  }
  const hours = Number(opts.expiresIn.slice(0, -1));
  return {
    tenantId,
    token,
    expiresAt:
      tokenExpiry(token) ??
      new Date(mintedAt.getTime() + hours * 3_600_000).toISOString(),
  };
}
