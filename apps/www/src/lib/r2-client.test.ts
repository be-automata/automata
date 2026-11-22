import { S3Client } from "@aws-sdk/client-s3";
import {
  describe,
  it,
  vi,
  beforeEach,
  afterEach,
  expect,
  type MockInstance,
} from "vitest";
import { R2Client, type R2BucketLike } from "@terragon/r2";

const baseConfig = {
  accessKeyId: "AKIA_TEST",
  secretAccessKey: "SECRET_TEST",
  accountId: "acct_test",
  bucketName: "automata",
  publicUrl: "https://pub.example.com",
};

function mockBinding() {
  return {
    put: vi.fn().mockResolvedValue({}),
    get: vi.fn(),
    head: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn(),
  } satisfies R2BucketLike & Record<string, ReturnType<typeof vi.fn>>;
}

describe("R2Client dual driver", () => {
  describe("native binding mode", () => {
    let bucket: ReturnType<typeof mockBinding>;
    let client: R2Client;

    beforeEach(() => {
      bucket = mockBinding();
      client = new R2Client({
        ...baseConfig,
        resolveBinding: () => bucket,
        uploadProxyPath: "/api/r2-upload",
      });
    });

    it("putObject writes through the binding with the content type", async () => {
      await client.putObject(
        "uploads/u1/file.png",
        Buffer.from("x"),
        "image/png",
      );
      expect(bucket.put).toHaveBeenCalledWith(
        "uploads/u1/file.png",
        expect.anything(),
        { httpMetadata: { contentType: "image/png" } },
      );
    });

    it("putObjectIfAbsent sends If-None-Match: * and maps a stored object to 201", async () => {
      expect(await client.putObjectIfAbsent("k", "x", "text/plain")).toEqual({
        status: 201,
      });
      const [, , options] = bucket.put.mock.calls[0] as [
        string,
        unknown,
        { onlyIf: Headers; httpMetadata: { contentType: string } },
      ];
      expect(options.onlyIf.get("If-None-Match")).toBe("*");
      expect(options.httpMetadata).toEqual({ contentType: "text/plain" });
    });

    it("putObjectIfAbsent maps a null binding put to 412 without throwing", async () => {
      bucket.put.mockResolvedValue(null);
      expect(await client.putObjectIfAbsent("k", "x")).toEqual({ status: 412 });
    });

    it("putObjectIfAbsent lets a binding error propagate", async () => {
      bucket.put.mockRejectedValue(new Error("boom"));
      await expect(client.putObjectIfAbsent("k", "x")).rejects.toThrow("boom");
    });

    it("getObjectOrNull returns null for a missing key and the bytes otherwise", async () => {
      bucket.get.mockResolvedValueOnce(null);
      expect(await client.getObjectOrNull("k")).toBeNull();
      bucket.get.mockResolvedValueOnce({
        arrayBuffer: async () => new TextEncoder().encode("hi").buffer,
      });
      expect((await client.getObjectOrNull("k"))?.toString()).toBe("hi");
      bucket.get.mockRejectedValueOnce(new Error("boom"));
      await expect(client.getObjectOrNull("k")).rejects.toThrow("boom");
    });

    it("downloadData reads the object body from the binding as a Buffer", async () => {
      bucket.get.mockResolvedValue({
        arrayBuffer: async () => new TextEncoder().encode("hello").buffer,
      });
      const buf = await client.downloadData("k");
      expect(bucket.get).toHaveBeenCalledWith("k");
      expect(buf.toString()).toBe("hello");
    });

    it("deleteObject and getContentType and listObjects route to the binding", async () => {
      bucket.head.mockResolvedValue({
        httpMetadata: { contentType: "text/plain" },
      });
      bucket.list.mockResolvedValue({
        objects: [
          { key: "a", size: 3, uploaded: new Date(0), httpEtag: '"e"' },
        ],
        truncated: false,
        cursor: undefined,
      });

      await client.deleteObject("k");
      expect(bucket.delete).toHaveBeenCalledWith("k");

      expect(await client.getContentType("k")).toBe("text/plain");

      const list = await client.listObjects("a/");
      expect(bucket.list).toHaveBeenCalledWith({
        prefix: "a/",
        limit: 1000,
        cursor: undefined,
      });
      expect(list.objects[0]).toEqual({
        key: "a",
        size: 3,
        lastModified: new Date(0),
        etag: '"e"',
      });
      expect(list.isTruncated).toBe(false);
    });

    it("generatePresignedUploadUrl returns the same-origin proxy URL (no S3 presign)", async () => {
      const { presignedUrl, r2Key } = await client.generatePresignedUploadUrl(
        "uploads/u1/pic.png",
        "image/png",
        undefined,
        { skipPrefix: true },
      );
      expect(r2Key).toBe("uploads/u1/pic.png");
      expect(presignedUrl).toBe(
        "/api/r2-upload?key=uploads%2Fu1%2Fpic.png&bucket=automata",
      );
      // Native presign must NOT call the binding (it only mints the proxy URL).
      expect(bucket.put).not.toHaveBeenCalled();
    });

    it("throws if native mode has no uploadProxyPath configured", async () => {
      const noProxy = new R2Client({
        ...baseConfig,
        resolveBinding: () => bucket,
      });
      await expect(
        noProxy.generatePresignedUploadUrl("f.png", "image/png"),
      ).rejects.toThrow(/uploadProxyPath/);
    });
  });

  describe("S3 mode (no binding — self-host / tests)", () => {
    it("generatePresignedUploadUrl returns an S3 presigned URL string", async () => {
      const client = new R2Client(baseConfig); // no resolveBinding → S3
      const { presignedUrl, r2Key } = await client.generatePresignedUploadUrl(
        "file.png",
        "image/png",
      );
      expect(r2Key).toMatch(/^uploads\//);
      expect(presignedUrl).toMatch(/^https:\/\//);
      expect(presignedUrl).toContain("X-Amz-Signature");
    });

    it("getPublicR2Url builds a URL from publicUrl (pure, both modes)", () => {
      const client = new R2Client(baseConfig);
      expect(client.getPublicR2Url("a/b.png")).toBe(
        "https://pub.example.com/a/b.png",
      );
      expect(client.getPublicR2Url(null)).toBeNull();
    });
  });
  describe("create-only and nullable read over S3", () => {
    const s3Error = (status: number, name = "Error") =>
      Object.assign(new Error(name), {
        name,
        $metadata: { httpStatusCode: status },
      });
    let send: MockInstance;

    beforeEach(() => {
      send = vi.spyOn(S3Client.prototype, "send");
    });
    afterEach(() => {
      send.mockRestore();
    });

    it("maps 412 to 412 and sends IfNoneMatch", async () => {
      send.mockRejectedValueOnce(s3Error(412));
      const client = new R2Client(baseConfig);
      expect(await client.putObjectIfAbsent("k", "x")).toEqual({ status: 412 });
      expect(send.mock.calls[0]?.[0]).toMatchObject({
        input: { IfNoneMatch: "*", Key: "k" },
      });
    });

    it("retries a 409 once: 409 then 201 is created", async () => {
      send.mockRejectedValueOnce(s3Error(409)).mockResolvedValueOnce({});
      const client = new R2Client(baseConfig);
      expect(await client.putObjectIfAbsent("k", "x", "text/plain")).toEqual({
        status: 201,
      });
      expect(send).toHaveBeenCalledTimes(2);
    });

    it("turns a second 409 into 412 and throws on any other error", async () => {
      send.mockRejectedValue(s3Error(409));
      const client = new R2Client(baseConfig);
      expect(await client.putObjectIfAbsent("k", "x")).toEqual({ status: 412 });
      expect(send).toHaveBeenCalledTimes(2);
      send.mockReset();
      send.mockRejectedValueOnce(s3Error(500));
      await expect(client.putObjectIfAbsent("k", "x")).rejects.toThrow();
    });

    it("getObjectOrNull: missing key is null, a body is bytes, other errors throw", async () => {
      const client = new R2Client(baseConfig);
      send.mockRejectedValueOnce(s3Error(404, "NoSuchKey"));
      expect(await client.getObjectOrNull("k")).toBeNull();
      send.mockResolvedValueOnce({
        Body: {
          transformToByteArray: async () => new TextEncoder().encode("ab"),
        },
      });
      expect((await client.getObjectOrNull("k"))?.toString()).toBe("ab");
      send.mockResolvedValueOnce({});
      await expect(client.getObjectOrNull("k")).rejects.toThrow();
      send.mockRejectedValueOnce(s3Error(500));
      await expect(client.getObjectOrNull("k")).rejects.toThrow();
    });
  });
});
