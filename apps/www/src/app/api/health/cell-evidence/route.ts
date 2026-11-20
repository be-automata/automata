import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import {
  readCellEvidenceStatus,
  type CellEvidenceStatus,
} from "@/server-lib/compute/cell-evidence-status";
import { opensandboxConfigured } from "@/server-lib/compute/cell-gate";

/**
 * GET /api/health/cell-evidence (#709)
 *
 * Public and read-only: whether the opensandbox/runc conformance evidence lets
 * cell-plan run cells, and until when. The synthetic workflow polls it and
 * opens one `cell-evidence` issue when the status is `expiring` or `refused`.
 * The body carries only the status, an enum reason, the expiry instant and the
 * days left: no secret, no evidence row, no org or user.
 */
export const dynamic = "force-dynamic";

/** Public, so a caller hammering it costs two queries a minute per isolate at most. */
const MEMO_MS = 60_000;
let memo: { at: number; status: CellEvidenceStatus } | null = null;

export async function GET(): Promise<NextResponse> {
  const nowMs = Date.now();
  if (memo === null || nowMs - memo.at >= MEMO_MS) {
    memo = {
      at: nowMs,
      status: await readCellEvidenceStatus({
        db,
        now: new Date(nowMs),
        configured: opensandboxConfigured(),
      }),
    };
  }
  return NextResponse.json(memo.status, {
    headers: { "Cache-Control": "no-store" },
  });
}
