import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import { postOpsAlert } from "@/server-lib/knowledge/ops-alert";
import { env } from "@terragon/env/apps-www";
import {
  DRIVER_B_PROFILE_ID,
  PROFILE_EVIDENCE_TOKEN_HEADER,
} from "@terragon/shared/model/box-evidence";
import {
  getCurrentProfileEvidence,
  upsertExecutionProfile,
} from "@terragon/shared/model/execution-profiles";

import { POST } from "./route";

vi.mock("@/server-lib/knowledge/ops-alert", () => ({
  postOpsAlert: vi.fn(async () => ({ sent: true })),
}));

const SECRET = "profile-evidence-test-secret";
const DIGEST = `sha256:${"c".repeat(64)}`;

const PASS_ALL = [
  "PASS 2 engine-unreachable   ok",
  "PASS 3 userns-mapping       ok",
  "PASS 4 no-capabilities      ok",
  "PASS 5 readonly-rootfs      ok",
  "PASS 6 review-no-write      ok",
  "PASS 7 run-isolation        ok",
].join("\n");

function body(overrides: Record<string, unknown> = {}) {
  return {
    host: "automata-exec-1",
    measuredAt: new Date(Date.now() - 60_000).toISOString(),
    platformSha: "0fa5e90",
    imageDigest: DIGEST,
    containers: [PASS_ALL, PASS_ALL],
    ...overrides,
  };
}

function post(
  payload: unknown,
  headers: Record<string, string> = { [PROFILE_EVIDENCE_TOKEN_HEADER]: SECRET },
): NextRequest {
  return new NextRequest("http://localhost/api/internal/profile-evidence/box", {
    method: "POST",
    headers,
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  (env as { PROFILE_EVIDENCE_SECRET: string }).PROFILE_EVIDENCE_SECRET = SECRET;
  await upsertExecutionProfile({
    db,
    id: DRIVER_B_PROFILE_ID,
    provider: "automata-box",
    tier: "customer_box",
    configuration: { egress_mode: "observe" },
  });
});

describe("POST /api/internal/profile-evidence/box", () => {
  it("refuses a missing, wrong or disabled secret with one 401", async () => {
    const attempts: Record<string, string>[] = [
      {},
      { [PROFILE_EVIDENCE_TOKEN_HEADER]: "nope" },
    ];
    for (const headers of attempts) {
      const res = await POST(post(body(), headers));
      expect(res.status).toBe(401);
    }
    (env as { PROFILE_EVIDENCE_SECRET: string }).PROFILE_EVIDENCE_SECRET = "";
    expect((await POST(post(body()))).status).toBe(401);
  });

  it("renews the observe evidence on a full pass", async () => {
    const measuredAt = new Date(Date.now() - 60_000);
    const res = await POST(
      post(body({ measuredAt: measuredAt.toISOString() })),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      recorded: true,
      profileId: DRIVER_B_PROFILE_ID,
      rows: 5,
    });
    expect(new Date(json.expiresAt).getTime()).toBe(
      measuredAt.getTime() + 30 * 86_400_000,
    );
    const current = await getCurrentProfileEvidence({
      db,
      profileId: DRIVER_B_PROFILE_ID,
    });
    const renewed = current.filter(
      (row) => row.measuredAt.getTime() === measuredAt.getTime(),
    );
    expect(renewed.map((row) => row.capability).sort()).toEqual([
      "metadata_blocked",
      "peer_isolated",
      "provider_creds_in_guest",
      "secret_brokering",
      "teardown_verified",
    ]);
    expect(renewed.every((row) => row.artifactDigest === DIGEST)).toBe(true);
    expect(postOpsAlert).not.toHaveBeenCalled();
  });

  it("records nothing and alerts on a failing probe", async () => {
    const before = await getCurrentProfileEvidence({
      db,
      profileId: DRIVER_B_PROFILE_ID,
    });
    const res = await POST(
      post(
        body({
          containers: [PASS_ALL, PASS_ALL.replace("PASS 7", "FAIL 7")],
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      recorded: false,
      reason: "probe_failed",
    });
    expect(
      await getCurrentProfileEvidence({ db, profileId: DRIVER_B_PROFILE_ID }),
    ).toEqual(before);
    expect(postOpsAlert).toHaveBeenCalledTimes(1);
    const text = vi.mocked(postOpsAlert).mock.calls[0]![0].text;
    expect(text).toContain("probe_failed");
    expect(text).toContain("container=1 probe=7");
    expect(text).not.toContain("PASS");
  });

  it("refuses a backdated or future-dated report", async () => {
    for (const offset of [-3 * 3600_000, 30 * 60_000]) {
      const res = await POST(
        post(body({ measuredAt: new Date(Date.now() + offset).toISOString() })),
      );
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "measured_at_out_of_window" });
    }
  });

  it("refuses bodies outside the schema", async () => {
    expect((await POST(post("{not json"))).status).toBe(400);
    for (const bad of [
      body({ profileId: "automata-box/enforce" }),
      body({ imageDigest: "latest" }),
      body({ host: "bad host; rm -rf" }),
    ]) {
      expect((await POST(post(bad))).status).toBe(400);
    }
    expect(
      (await POST(post(body({ containers: ["x".repeat(70_000)] })))).status,
    ).toBe(413);
  });
});
