import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import { postOpsAlert } from "@/server-lib/knowledge/ops-alert";
import { env } from "@terragon/env/apps-www";
import { passingRuncChecks } from "@terragon/sandbox/conformance-evidence";
import { PROFILE_EVIDENCE_TOKEN_HEADER } from "@terragon/shared/model/box-evidence";
import { assertCellEgressEnforced } from "@terragon/shared/model/cell-egress-guard";
import {
  getCurrentProfileEvidence,
  getExecutionProfile,
  profileRecordForPolicy,
  upsertExecutionProfile,
} from "@terragon/shared/model/execution-profiles";

import { POST } from "./route";

const missing = vi.hoisted(() => ({ profile: false }));

vi.mock("@terragon/shared/model/execution-profiles", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@terragon/shared/model/execution-profiles")
    >();
  return {
    ...actual,
    // Rows cannot be deleted, and sibling test files share the database.
    getExecutionProfile: (
      args: Parameters<typeof actual.getExecutionProfile>[0],
    ) =>
      missing.profile
        ? Promise.resolve(undefined)
        : actual.getExecutionProfile(args),
  };
});
vi.mock("@/server-lib/knowledge/ops-alert", () => ({
  postOpsAlert: vi.fn(async () => ({ sent: true })),
}));

const SECRET = "profile-evidence-test-secret";
const PROFILE_ID = "opensandbox/runc";
const SHA = "a".repeat(40);
const DIGEST = `sha256:${"d".repeat(64)}`;

function checks() {
  return passingRuncChecks() as unknown as Record<
    string,
    Array<{ name: string; ok: boolean }>
  >;
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    measuredAt: new Date(Date.now() - 60_000).toISOString(),
    platformSha: SHA,
    artifactDigest: DIGEST,
    checks: checks(),
    ...overrides,
  };
}

function post(
  payload: unknown,
  headers: Record<string, string> = { [PROFILE_EVIDENCE_TOKEN_HEADER]: SECRET },
): NextRequest {
  return new NextRequest(
    "http://localhost/api/internal/profile-evidence/opensandbox",
    {
      method: "POST",
      headers,
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    },
  );
}

async function evidenceCount(): Promise<number> {
  return (await getCurrentProfileEvidence({ db, profileId: PROFILE_ID }))
    .length;
}

beforeEach(async () => {
  vi.clearAllMocks();
  missing.profile = false;
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";
  (env as { PROFILE_EVIDENCE_SECRET: string }).PROFILE_EVIDENCE_SECRET = SECRET;
});

async function ensureProfile(): Promise<void> {
  await upsertExecutionProfile({
    db,
    id: PROFILE_ID,
    provider: "opensandbox",
    tier: "customer_box",
    configuration: { egress_mode: "enforce" },
  });
}

describe("POST /api/internal/profile-evidence/opensandbox", () => {
  it("409 unknown_profile when the profile row is missing, recording nothing", async () => {
    await ensureProfile();
    const before = await evidenceCount();
    missing.profile = true;
    try {
      const res = await POST(post(body()));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "unknown_profile" });
    } finally {
      missing.profile = false;
    }
    expect(await evidenceCount()).toBe(before);
  });

  describe("with the profile seeded", () => {
    beforeEach(ensureProfile);
    it("refuses a missing, wrong or empty secret with a 401", async () => {
      const before = await evidenceCount();
      const attempts: Record<string, string>[] = [
        {},
        { [PROFILE_EVIDENCE_TOKEN_HEADER]: "nope" },
      ];
      for (const headers of attempts) {
        expect((await POST(post(body(), headers))).status).toBe(401);
      }
      (env as { PROFILE_EVIDENCE_SECRET: string }).PROFILE_EVIDENCE_SECRET = "";
      expect((await POST(post(body()))).status).toBe(401);
      expect(await evidenceCount()).toBe(before);
    });

    it("records 9 rows on a correct report, allowlist computed server-side", async () => {
      const measuredAt = new Date(Date.now() - 60_000);
      const res = await POST(
        post(body({ measuredAt: measuredAt.toISOString() })),
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toMatchObject({ recorded: true, rows: 9 });
      expect(new Date(json.expiresAt).getTime()).toBe(
        measuredAt.getTime() + 30 * 86_400_000,
      );
      const current = await getCurrentProfileEvidence({
        db,
        profileId: PROFILE_ID,
      });
      const allowlist = current.find(
        (r) => r.capability === "egress_allowlist",
      );
      expect(allowlist?.result).toMatchObject({
        value: ["app.example.test", "api.anthropic.com"],
      });
      expect(postOpsAlert).not.toHaveBeenCalled();

      // After ingest the cell egress guard accepts the profile.
      const row = await getExecutionProfile({ db, id: PROFILE_ID });
      const { profile } = profileRecordForPolicy(row!, current);
      expect(() =>
        assertCellEgressEnforced({ profile, now: new Date() }),
      ).not.toThrow();
    });

    it("refuses a missing required check with 422, an alert and no rows", async () => {
      const before = await evidenceCount();
      const c = checks();
      c.metadata_blocked = [{ name: "something_else", ok: true }];
      const res = await POST(post(body({ checks: c })));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        recorded: false,
        reason: "check_missing",
      });
      expect(postOpsAlert).toHaveBeenCalledTimes(1);
      expect(await evidenceCount()).toBe(before);
    });

    it("refuses a failed check with 422 and never echoes the check name", async () => {
      const before = await evidenceCount();
      const c = checks();
      c.peer_isolated = [
        { name: "peer_execd_blocked", ok: false },
        { name: "peer_80_blocked", ok: true },
      ];
      const res = await POST(post(body({ checks: c })));
      expect(res.status).toBe(422);
      const text = JSON.stringify(await res.json());
      expect(text).toContain("check_failed");
      expect(text).not.toContain("peer_execd_blocked");
      const alertText = vi.mocked(postOpsAlert).mock.calls[0]![0].text;
      expect(alertText).not.toContain("peer_execd_blocked");
      expect(await evidenceCount()).toBe(before);
    });

    it("refuses a -dirty or short sha, a bad digest and extra fields", async () => {
      for (const bad of [
        body({ platformSha: `${SHA}-dirty` }),
        body({ platformSha: "abc1234" }),
        body({ artifactDigest: "latest" }),
        body({ profileId: "automata-box/enforce" }),
        body({ checks: { ...checks(), extra: [] } }),
      ]) {
        expect((await POST(post(bad))).status).toBe(400);
      }
      expect((await POST(post("{not json"))).status).toBe(400);
    });

    it("refuses an out-of-window measuredAt", async () => {
      for (const offset of [-25 * 3600_000, 10 * 60_000]) {
        const res = await POST(
          post(
            body({ measuredAt: new Date(Date.now() + offset).toISOString() }),
          ),
        );
        expect(res.status).toBe(422);
        expect(await res.json()).toEqual({
          error: "measured_at_out_of_window",
        });
      }
    });

    it("refuses a body over 64 KiB", async () => {
      const big = body({ pad: "x".repeat(70_000) });
      expect((await POST(post(big))).status).toBe(413);
      // Declared length alone is enough: refused before the body is read.
      const declared = new NextRequest(
        "http://localhost/api/internal/profile-evidence/opensandbox",
        {
          method: "POST",
          headers: {
            [PROFILE_EVIDENCE_TOKEN_HEADER]: SECRET,
            "content-length": String(70_000),
          },
          body: JSON.stringify(body()),
        },
      );
      expect((await POST(declared)).status).toBe(413);
    });
  });
});
