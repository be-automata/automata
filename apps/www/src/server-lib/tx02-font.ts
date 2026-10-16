import type { R2BucketLike } from "@terragon/r2";

/** The only TX-02 files the route serves; anything else is a 404. */
export const TX02_FONT_FILES = [
  "TX-02-Regular.woff2",
  "TX-02-Medium.woff2",
  "TX-02-Bold.woff2",
  "TX-02-Oblique.woff2",
] as const;

export const TX02_R2_PREFIX = "fonts/tx-02/";

type FontBucket = Pick<R2BucketLike, "get">;

function isTx02FontFile(
  file: string,
): file is (typeof TX02_FONT_FILES)[number] {
  return (TX02_FONT_FILES as readonly string[]).includes(file);
}

/**
 * No CORS header on purpose: the licence covers first-party webfont hosting,
 * so other origins must not be able to load the file.
 */
export async function serveTx02Font({
  file,
  bucket,
}: {
  file: string;
  bucket: FontBucket | null;
}): Promise<Response> {
  if (!isTx02FontFile(file) || !bucket) {
    return new Response("Not found", { status: 404 });
  }
  const object = await bucket.get(`${TX02_R2_PREFIX}${file}`);
  if (!object) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(await object.arrayBuffer(), {
    status: 200,
    headers: {
      "Content-Type": "font/woff2",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
