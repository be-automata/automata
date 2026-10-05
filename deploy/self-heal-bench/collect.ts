/**
 * Save one self-heal export of a fixture repo for the benchmark (R6, phase 9).
 *
 * Usage:
 *   BENCH_WWW_URL=https://<www host> BENCH_SESSION_COOKIE='<cookie header>' \
 *     pnpm exec tsx deploy/self-heal-bench/collect.ts --repo <owner/repo> --out <file> [--force]
 *
 * Reads GET /api/self-heal/<owner>/<repo>?format=export (org-admin only; read
 * only) with the operator's admin session and writes the JSON unchanged to
 * <file>. The export carries runs (with decisions), findings, effects, fix
 * attempts and the production metrics; it never contains token hashes.
 *
 * BENCH_SESSION_COOKIE is the full Cookie header value of a signed-in admin
 * session whose ACTIVE organization owns the fixture repo (copy it from the
 * browser's devtools). It is read from the environment only and is never
 * printed, logged or written to disk. The URL must be https (http is allowed
 * only for localhost). An existing <file> is kept unless --force is given.
 */
import { parseExportSnapshot } from "../../packages/shared/src/self-heal/bench/score";
import {
  assertRepo,
  fail,
  parseCli,
  refuseOverwrite,
  runMain,
  writeJson,
} from "./cli";

const USAGE =
  "Usage: BENCH_WWW_URL=... BENCH_SESSION_COOKIE=... pnpm exec tsx deploy/self-heal-bench/collect.ts --repo <owner/repo> --out <file> [--force]";
const TIMEOUT_MS = 30_000;

function exportUrl(base: string, repo: string): URL {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return fail("BENCH_WWW_URL is not a valid URL");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    fail("BENCH_WWW_URL must be https (http only for localhost)");
  }
  const [owner = "", name = ""] = repo.split("/");
  url.pathname = `/api/self-heal/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  url.search = "?format=export";
  return url;
}

async function main(): Promise<void> {
  const { values } = parseCli(
    {
      options: {
        repo: { type: "string" },
        out: { type: "string" },
        force: { type: "boolean", default: false },
      },
    },
    USAGE,
  );
  const { repo, out, force } = values;
  if (!repo || !out) fail(USAGE);
  assertRepo(repo);
  const base = process.env.BENCH_WWW_URL;
  const cookie = process.env.BENCH_SESSION_COOKIE;
  if (!base) fail("BENCH_WWW_URL is not set");
  if (!cookie) fail("BENCH_SESSION_COOKIE is not set");
  refuseOverwrite(out, force);

  const url = exportUrl(base, repo);
  const response = await fetch(url, {
    headers: { cookie, accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status !== 200) {
    // Only the status and the route's own error field: never headers.
    let detail = "";
    try {
      const body: unknown = await response.json();
      if (typeof body === "object" && body !== null && "error" in body) {
        detail = `: ${String((body as { error: unknown }).error)}`;
      }
    } catch {
      detail = " (non-JSON body)";
    }
    fail(`export request failed with HTTP ${response.status}${detail}`);
  }

  const raw: unknown = await response.json();
  const snapshot = parseExportSnapshot(raw);
  writeJson(out, raw);
  console.log(
    `saved export of ${snapshot.repoFullName} at ${snapshot.exportedAt}: ` +
      `${snapshot.runs.length} runs, ${snapshot.findings.length} findings, ` +
      `${snapshot.attempts.length} attempts -> ${out}`,
  );
}

runMain("collect", main);
