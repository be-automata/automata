import { describe, it, vi, beforeEach, expect } from "vitest";
import { NextRequest } from "next/server";
import { PUT } from "./route";
import { getUserIdOrNull } from "@/lib/auth-server";
import { r2Public, r2Private } from "@/server-lib/r2";

vi.mock("@/lib/auth-server", () => ({
  getUserIdOrNull: vi.fn(),
}));

vi.mock("@/server-lib/r2", () => ({
  r2Public: { putObject: vi.fn().mockResolvedValue(undefined) },
  r2Private: { putObject: vi.fn().mockResolvedValue(undefined) },
}));

// Matches vite.config test.env.
const PUBLIC_BUCKET = "R2_BUCKET_NAME_TEST";
const PRIVATE_BUCKET = "R2_PRIVATE_BUCKET_NAME_TEST";

function req(key: string, bucket: string, body = "data") {
  const url = `http://localhost/api/r2-upload?key=${encodeURIComponent(
    key,
  )}&bucket=${encodeURIComponent(bucket)}`;
  return new NextRequest(url, {
    method: "PUT",
    body,
    headers: { "content-type": "image/png" },
  });
}

describe("PUT /api/r2-upload (native R2 upload proxy)", () => {
  const userId = "user_123";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUserIdOrNull).mockResolvedValue(userId);
  });

  it("401 when unauthenticated", async () => {
    vi.mocked(getUserIdOrNull).mockResolvedValue(null);
    const res = await PUT(req(`uploads/${userId}/f.png`, PUBLIC_BUCKET));
    expect(res.status).toBe(401);
    expect(r2Public.putObject).not.toHaveBeenCalled();
  });

  it("403 when the key is not scoped to the acting user", async () => {
    const res = await PUT(req("uploads/other_user/f.png", PUBLIC_BUCKET));
    expect(res.status).toBe(403);
    expect(r2Public.putObject).not.toHaveBeenCalled();
  });

  it("403 on path traversal", async () => {
    const res = await PUT(req(`uploads/${userId}/../../etc/passwd`, PUBLIC_BUCKET));
    expect(res.status).toBe(403);
  });

  it("400 on unknown bucket", async () => {
    const res = await PUT(req(`uploads/${userId}/f.png`, "some-other-bucket"));
    expect(res.status).toBe(400);
  });

  it("writes to the public client and returns 200 for a valid request", async () => {
    const res = await PUT(req(`uploads/${userId}/f.png`, PUBLIC_BUCKET));
    expect(res.status).toBe(200);
    expect(r2Public.putObject).toHaveBeenCalledWith(
      `uploads/${userId}/f.png`,
      expect.anything(),
      "image/png",
    );
    expect(r2Private.putObject).not.toHaveBeenCalled();
  });

  it("routes to the private client for the private bucket", async () => {
    const res = await PUT(req(`attachments/${userId}/f.png`, PRIVATE_BUCKET));
    expect(res.status).toBe(200);
    expect(r2Private.putObject).toHaveBeenCalledTimes(1);
    expect(r2Public.putObject).not.toHaveBeenCalled();
  });
});
