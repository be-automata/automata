import { NextRequest } from "next/server";
import { waitUntil } from "@/lib/wait-until";

export const dynamic = "force-dynamic";

/**
 * TEMPORARY diagnostic (boot-coder, C8 bug #1): isolate why the agent-run dispatch's
 * outbound fetch dies with "Network connection lost" while a same-context DB write
 * succeeds. Probes two fetches — the Hatchet tunnel (Cloudflare-hosted trycloudflare
 * endpoint) and a known NON-Cloudflare URL (api.github.com) — in BOTH the request
 * context and a waitUntil() background context (where the real dispatch runs).
 *
 * Reading it:
 *  - tunnel fails + non-CF succeeds (esp. in -bg)  → Worker→CF-tunnel intra-CF class
 *    (echoes the broadcast worker-to-worker problem) → fix = named-zone tunnel.
 *  - both tunnel + non-CF fail in -bg only         → general background-fetch issue → STOP, report.
 *  - all succeed                                    → the dispatch failure is elsewhere.
 *
 * Gated on CRON_SECRET. Remove after bug #1 is resolved.
 */
async function probe(label: string, url: string) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    return { label, ok: r.ok, status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    return {
      label,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      ms: Date.now() - t0,
    };
  }
}

export async function GET(req: NextRequest) {
  const key = new URL(req.url).searchParams.get("key");
  const secret = process.env.CRON_SECRET;
  if (!secret || key !== secret) {
    return new Response("not found", { status: 404 });
  }

  const apiUrl = process.env.HATCHET_API_URL;
  const tunnel = apiUrl ? `${apiUrl.replace(/\/$/, "")}/api/v1/meta` : null;
  const nonCf = "https://api.github.com/";

  const main = await Promise.all([
    tunnel
      ? probe("tunnel-main", tunnel)
      : Promise.resolve({ label: "tunnel-main", skipped: true }),
    probe("noncf-main", nonCf),
  ]);

  // Same two fetches in a background task — the context the real dispatch runs in.
  waitUntil(
    (async () => {
      const bg = await Promise.all([
        tunnel
          ? probe("tunnel-bg", tunnel)
          : Promise.resolve({ label: "tunnel-bg", skipped: true }),
        probe("noncf-bg", nonCf),
      ]);
      console.log("[fetch-probe] background results", JSON.stringify(bg));
    })(),
  );

  return Response.json({ hatchetApiUrlSet: Boolean(apiUrl), main });
}
