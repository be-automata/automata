/**
 * Production smoke: read-only HTTP probes against a deployed www.
 *
 * WHY THIS EXISTS. The org-hierarchy release was verified by a hand-run shell
 * script of signed-out curl checks. A check that only runs when someone
 * remembers it does not catch the deploy that silently breaks the login
 * redirect, re-opens an open redirect, or ships a stale build. This turns that
 * script into a module the deploy step and a 15-minute synthetic both run.
 *
 *   Usage:  node deploy/smoke.ts --base-url <url> [--expect-build-id <id>]
 *                                [--org-slug <slug>] [--json]
 *   Exit:   0 = every probe passed (skips allowed); 1 = any probe failed or
 *           the arguments were invalid.
 *
 * Every signed-out probe is a GET, except one unsigned POST to the Slack
 * webhook that must answer 401 before anything is read. Nothing here writes.
 *
 * SIGNED-IN PROBES run only when SMOKE_SESSION_COOKIE is set (the whole
 * Cookie header, e.g. `__Secure-better-auth.session_token=...`), together with
 * SMOKE_USER_ID and SMOKE_ORG_SLUG. They are NOT read-only: GET /o/<slug>
 * makes <slug> the active org of that session. Use a dedicated synthetic user
 * whose only org is SMOKE_ORG_SLUG, never a person's session.
 *
 * Zero dependencies on purpose: deploy/ has no package.json, and this runs on
 * plain Node 24 via type stripping, so only erasable TypeScript syntax is used.
 */

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export type ProbeStatus = "pass" | "fail" | "skip";

export interface ProbeResult {
  id: string;
  name: string;
  status: ProbeStatus;
  detail: string;
  attempts: number;
  durationMs: number;
}

export interface SignedInConfig {
  /** The whole Cookie header value for the synthetic user's session. */
  cookie: string;
  userId: string;
  orgSlug: string;
}

export interface SmokeOptions {
  baseUrl: string;
  expectBuildId?: string;
  orgSlug?: string;
  /** Extra attempts for a transient failure (network error, 429, 5xx). */
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  signedIn?: SignedInConfig;
}

/**
 * Path segments appended to /o/<slug>/ that try to turn the org link into an
 * open redirect. Each must end in a same-origin 404; any hop that leaves the
 * origin fails. Next.js collapses "//" with a 308, so hops are followed.
 */
export const OPEN_REDIRECT_PROBES: readonly string[] = [
  "%2F%2Fevil.com",
  "%2F%2F%2Fevil.com",
  "https:%2F%2Fevil.com",
  "%5C%5Cevil.com",
  "..%2F..%2Fevil",
  "o%2Facme",
  "o/acme/x",
  "%0d%0aLocation:%20https://evil.com",
];

const MAX_HOPS = 5;

interface Attempt {
  ok: boolean;
  /** Worth retrying: the server or the network failed, not the assertion. */
  transient: boolean;
  detail: string;
}

class TransientError extends Error {}

export async function runSmoke(options: SmokeOptions): Promise<ProbeResult[]> {
  const base = new URL(options.baseUrl);
  const origin = base.origin;
  const orgSlug = options.orgSlug ?? "acme";
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 15_000;

  const request = async (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = new URL(path, origin);
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        ...init,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TransientError(`${init.method ?? "GET"} ${path}: ${message}`);
    }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      throw new TransientError(
        `${init.method ?? "GET"} ${path}: HTTP ${response.status}`,
      );
    }
    return response;
  };

  const probe = async (
    id: string,
    name: string,
    check: () => Promise<Attempt>,
  ): Promise<ProbeResult> => {
    const started = Date.now();
    let attempts = 0;
    let last: Attempt = { ok: false, transient: false, detail: "not run" };
    while (attempts <= retries) {
      attempts += 1;
      try {
        last = await check();
      } catch (error: unknown) {
        if (!(error instanceof TransientError)) {
          throw error;
        }
        last = { ok: false, transient: true, detail: error.message };
      }
      if (last.ok || !last.transient || attempts > retries) {
        break;
      }
      await delay(retryDelayMs);
    }
    return {
      id,
      name,
      status: last.ok ? "pass" : "fail",
      detail: last.detail,
      attempts,
      durationMs: Date.now() - started,
    };
  };

  const expectLoginRedirect = async (path: string): Promise<Attempt> => {
    const response = await request(path);
    await response.body?.cancel();
    const location = response.headers.get("location") ?? "";
    const want = `/login?returnUrl=${encodeURIComponent(path)}`;
    const ok = response.status === 307 && location.includes(want);
    return {
      ok,
      transient: false,
      detail: `${response.status} ${location || "(no location)"}${ok ? "" : ` — want 307 containing ${want}`}`,
    };
  };

  const followSameOrigin = async (path: string): Promise<Attempt> => {
    let current = new URL(path, origin);
    const hops: string[] = [];
    for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
      const response = await request(current.pathname + current.search);
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || !location) {
        const ok = response.status === 404;
        hops.push(String(response.status));
        return {
          ok,
          transient: false,
          detail: `${hops.join(" -> ")}${ok ? "" : " — want a final 404"}`,
        };
      }
      const next = new URL(location, current);
      hops.push(`${response.status} ${next.href}`);
      if (next.origin !== origin) {
        return {
          ok: false,
          transient: false,
          detail: `left origin: ${hops.join(" -> ")}`,
        };
      }
      current = next;
    }
    return {
      ok: false,
      transient: false,
      detail: `more than ${MAX_HOPS} redirects: ${hops.join(" -> ")}`,
    };
  };

  const results: ProbeResult[] = [];

  results.push(
    await probe("C16", "unsigned Slack webhook POST is rejected", async () => {
      const response = await request("/api/webhooks/slack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      await response.body?.cancel();
      return {
        ok: response.status === 401,
        transient: false,
        detail: `${response.status}${response.status === 401 ? "" : " — want 401"}`,
      };
    }),
  );

  const orgSettings = `/o/${orgSlug}/settings?tab=1`;
  results.push(
    await probe("C7", `signed-out ${orgSettings} goes to login`, () =>
      expectLoginRedirect(orgSettings),
    ),
  );
  const orgRoot = `/o/${orgSlug}`;
  results.push(
    await probe("C7b", `signed-out ${orgRoot} goes to login`, () =>
      expectLoginRedirect(orgRoot),
    ),
  );

  for (const [index, suffix] of OPEN_REDIRECT_PROBES.entries()) {
    const path = `/o/${orgSlug}/${suffix}`;
    results.push(
      await probe(`C8.${index + 1}`, `open-redirect probe ${path}`, () =>
        followSameOrigin(path),
      ),
    );
  }

  results.push(
    await probe("C17", "home page serves the expected build", async () => {
      const response = await request("/");
      const html = await response.text();
      if (response.status !== 200) {
        return {
          ok: false,
          transient: false,
          detail: `${response.status} — want 200`,
        };
      }
      const served = extractBuildId(html);
      if (options.expectBuildId) {
        const ok = html.includes(options.expectBuildId);
        return {
          ok,
          transient: false,
          detail: ok
            ? `build ${options.expectBuildId} served`
            : `build ${options.expectBuildId} not served (found ${served ?? "none"})`,
        };
      }
      return {
        ok: served !== null,
        transient: false,
        detail: served ? `build ${served} served` : "no build id in the page",
      };
    }),
  );

  const signedIn = options.signedIn;
  if (!signedIn) {
    results.push({
      id: "S",
      name: "signed-in probes",
      status: "skip",
      detail: "SMOKE_SESSION_COOKIE not set",
      attempts: 0,
      durationMs: 0,
    });
    return results;
  }

  const headers = { cookie: signedIn.cookie };
  results.push(
    await probe("S1", "session resolves to the synthetic user", async () => {
      const response = await request("/api/auth/get-session", { headers });
      const body: unknown = await response.json().catch(() => null);
      const userId = readUserId(body);
      const ok = response.status === 200 && userId === signedIn.userId;
      return {
        ok,
        transient: false,
        detail: ok
          ? `${response.status} user ${userId}`
          : `${response.status} user ${userId ?? "none"} — want ${signedIn.userId}`,
      };
    }),
  );
  results.push(
    await probe(
      "S2",
      `/o/${signedIn.orgSlug} lands on /dashboard`,
      async () => {
        const response = await request(`/o/${signedIn.orgSlug}`, { headers });
        await response.body?.cancel();
        const location = response.headers.get("location") ?? "";
        const target = location ? new URL(location, origin) : null;
        const ok =
          response.status === 307 &&
          target?.origin === origin &&
          target.pathname === "/dashboard";
        return {
          ok,
          transient: false,
          detail: `${response.status} ${location || "(no location)"}${ok ? "" : " — want 307 /dashboard"}`,
        };
      },
    ),
  );
  results.push(
    await probe("S3", "/dashboard renders signed in", async () => {
      const response = await request("/dashboard", { headers });
      await response.body?.cancel();
      return {
        ok: response.status === 200,
        transient: false,
        detail: `${response.status}${response.status === 200 ? "" : ` ${response.headers.get("location") ?? ""} — want 200`}`,
      };
    }),
  );
  return results;
}

/** The Next.js build id as the App Router (`"b":"…"`) or Pages Router embeds it. */
export function extractBuildId(html: string): string | null {
  const match =
    /\\?"b\\?":\\?"([A-Za-z0-9_-]{6,})/.exec(html) ??
    /"buildId":"([A-Za-z0-9_-]{6,})"/.exec(html);
  return match?.[1] ?? null;
}

function readUserId(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("user" in body)) {
    return null;
  }
  const user: unknown = body.user;
  if (typeof user !== "object" || user === null || !("id" in user)) {
    return null;
  }
  return typeof user.id === "string" ? user.id : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatMarkdown(
  baseUrl: string,
  results: readonly ProbeResult[],
): string {
  const failed = results.filter((r) => r.status === "fail").length;
  const lines = [
    `## Production smoke: ${failed === 0 ? "PASS" : `FAIL (${failed})`}`,
    "",
    `Target: ${baseUrl}`,
    "",
    "| result | id | probe | detail | attempts |",
    "|:--|:--|:--|:--|--:|",
    ...results.map(
      (r) =>
        `| ${r.status.toUpperCase()} | ${r.id} | ${escapeCell(r.name)} | ${escapeCell(r.detail)} | ${r.attempts} |`,
    ),
    "",
  ];
  return lines.join("\n");
}

function escapeCell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatLine(result: ProbeResult): string {
  return `${result.status.toUpperCase()} ${result.id} ${result.name} -> ${result.detail} (${result.durationMs}ms, ${result.attempts} attempt${result.attempts === 1 ? "" : "s"})`;
}

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "base-url": { type: "string" },
      "expect-build-id": { type: "string" },
      "org-slug": { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const baseUrl = values["base-url"];
  if (!baseUrl) {
    console.error(
      "usage: node deploy/smoke.ts --base-url <url> [--expect-build-id <id>] [--org-slug <slug>] [--json]",
    );
    return 1;
  }

  const cookie = process.env.SMOKE_SESSION_COOKIE;
  let signedIn: SignedInConfig | undefined;
  if (cookie) {
    const userId = process.env.SMOKE_USER_ID;
    const orgSlug = process.env.SMOKE_ORG_SLUG;
    if (!userId || !orgSlug) {
      console.error(
        "SMOKE_SESSION_COOKIE is set but SMOKE_USER_ID or SMOKE_ORG_SLUG is not",
      );
      return 1;
    }
    signedIn = { cookie, userId, orgSlug };
  }

  const results = await runSmoke({
    baseUrl,
    expectBuildId: values["expect-build-id"] || undefined,
    orgSlug: values["org-slug"],
    signedIn,
  });

  if (values.json) {
    console.log(JSON.stringify({ baseUrl, results }, null, 2));
  } else {
    for (const result of results) {
      console.log(formatLine(result));
    }
  }
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    appendFileSync(summaryFile, formatMarkdown(baseUrl, results));
  }
  return results.some((r) => r.status === "fail") ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main(process.argv.slice(2));
}
