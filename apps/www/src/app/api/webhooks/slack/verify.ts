import crypto from "crypto";

/** Slack rejects replays older than five minutes; so do we. */
const MAX_REQUEST_AGE_SECONDS = 60 * 5;

/**
 * Slack's v0 request signature (HMAC-SHA256 over `v0:<timestamp>:<body>`).
 * Pure: `nowSeconds` is injected. A missing header, a stale timestamp or a
 * length mismatch is simply "not verified".
 */
export function verifySlackSignature({
  signingSecret,
  timestamp,
  signature,
  body,
  nowSeconds,
}: {
  signingSecret: string;
  timestamp: string | null;
  signature: string | null;
  body: string;
  nowSeconds: number;
}): boolean {
  if (!timestamp || !signature) {
    return false;
  }
  const requestSeconds = Number(timestamp);
  if (
    !Number.isFinite(requestSeconds) ||
    Math.abs(nowSeconds - requestSeconds) > MAX_REQUEST_AGE_SECONDS
  ) {
    return false;
  }
  const expected = `v0=${crypto
    .createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  // timingSafeEqual requires equal lengths
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}
