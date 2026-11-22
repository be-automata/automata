import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { R2Client, type R2BucketLike } from "@terragon/r2";

/**
 * R2 create-only conformance (spec 743, P1 / AC-6). Opt-in:
 *   R2_CONFORMANCE=local   wrangler's local proxy (miniflare) bucket
 *   R2_CONFORMANCE=remote  a throwaway real bucket over a remote binding
 * Unset, the suite is skipped. Both modes bind the `R2_BUCKET` entry of
 * wrangler.jsonc; the remote run is the authority on `onlyIf` semantics.
 */
const MODE = process.env.R2_CONFORMANCE;
const RACERS = 10;

/** The slice of the Workers `R2Bucket` this test drives beyond `R2BucketLike`. */
interface ConformanceBucket extends R2BucketLike {
  put(
    key: string,
    value: string,
    options?: { onlyIf?: Headers | { etagMatches?: string } },
  ): Promise<{ etag: string } | null>;
}

describe.skipIf(MODE !== "local" && MODE !== "remote")(
  "R2 create-only conformance",
  () => {
    const prefix = `conformance/${crypto.randomUUID()}/`;
    let bucket: ConformanceBucket;
    let client: R2Client;
    let dispose: (() => Promise<void>) | undefined;

    beforeAll(async () => {
      const { getPlatformProxy } = await import("wrangler");
      const proxy = await getPlatformProxy<{ R2_BUCKET: ConformanceBucket }>({
        configPath: new URL("../../wrangler.jsonc", import.meta.url).pathname,
        persist: false,
        remoteBindings: MODE === "remote",
      });
      bucket = proxy.env.R2_BUCKET;
      dispose = () => proxy.dispose();
      client = new R2Client({
        accessKeyId: "unused",
        secretAccessKey: "unused",
        accountId: "unused",
        bucketName: "unused",
        resolveBinding: () => bucket,
      });
    });

    afterAll(async () => {
      if (bucket) {
        const listed = await bucket.list({ prefix });
        await Promise.all(listed.objects.map((o) => bucket.delete(o.key)));
      }
      await dispose?.();
    });

    it("a second create of the same key is 412 and keeps the first bytes", async () => {
      const key = `${prefix}second-create`;
      expect(await client.putObjectIfAbsent(key, "first")).toEqual({
        status: 201,
      });
      expect(await client.putObjectIfAbsent(key, "second")).toEqual({
        status: 412,
      });
      expect((await client.getObjectOrNull(key))?.toString()).toBe("first");
    });

    it("a stale If-Match is refused by the binding (null)", async () => {
      const key = `${prefix}stale-etag`;
      await client.putObjectIfAbsent(key, "v1");
      const stale = await bucket.put(key, "v2", {
        onlyIf: { etagMatches: "00000000000000000000000000000000" },
      });
      expect(stale).toBeNull();
      expect((await client.getObjectOrNull(key))?.toString()).toBe("v1");
    });

    it("10 racing creates yield exactly one 201", async () => {
      const key = `${prefix}race`;
      const results = await Promise.all(
        Array.from({ length: RACERS }, (_, i) =>
          client.putObjectIfAbsent(key, `racer-${i}`),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 412)).toHaveLength(RACERS - 1);
    });

    it("a missing key reads null, and a written key reads back", async () => {
      expect(await client.getObjectOrNull(`${prefix}absent`)).toBeNull();
      const key = `${prefix}read-after-write`;
      await client.putObjectIfAbsent(key, "payload");
      expect((await client.getObjectOrNull(key))?.toString()).toBe("payload");
    });
  },
);
