import { describe, expect, it, vi } from "vitest";
import { serveTx02Font, TX02_R2_PREFIX } from "./tx02-font";

function bucketWith(bytes: Uint8Array | null) {
  return {
    get: vi.fn(async () =>
      bytes ? { arrayBuffer: async () => bytes.buffer as ArrayBuffer } : null,
    ),
  };
}

describe("serveTx02Font", () => {
  it("serves an allowlisted file from the private bucket with immutable caching", async () => {
    const bucket = bucketWith(new Uint8Array([1, 2, 3]));
    const res = await serveTx02Font({ file: "TX-02-Regular.woff2", bucket });
    expect(res.status).toBe(200);
    expect(bucket.get).toHaveBeenCalledWith(
      `${TX02_R2_PREFIX}TX-02-Regular.woff2`,
    );
    expect(res.headers.get("Content-Type")).toBe("font/woff2");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("refuses names outside the allowlist without touching the bucket", async () => {
    const bucket = bucketWith(new Uint8Array([1]));
    for (const file of ["../secret.json", "TX-02-Regular.ttf", "x.woff2"]) {
      const res = await serveTx02Font({ file, bucket });
      expect(res.status).toBe(404);
    }
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it("404s when the object is missing or no bucket is bound", async () => {
    expect(
      (
        await serveTx02Font({
          file: "TX-02-Bold.woff2",
          bucket: bucketWith(null),
        })
      ).status,
    ).toBe(404);
    expect(
      (await serveTx02Font({ file: "TX-02-Bold.woff2", bucket: null })).status,
    ).toBe(404);
  });
});
