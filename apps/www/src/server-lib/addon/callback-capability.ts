import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The capability carried in an add-on's callback URL
 * (`/api/addon-callback/<capability>`). The control plane mints one per recorded
 * call; it names the call, its RAP group, its organization and an expiry, and is
 * signed with ADDON_CALLBACK_SECRET. A callback with a forged or expired
 * capability is refused with 401 (the RAP spec says tools SHOULD NOT retry a
 * 4xx), so the URL is the only authority an add-on holds.
 *
 * Format: base64url(JSON claims) "." base64url(HMAC-SHA256(secret, first part)).
 */

export interface CallbackClaims {
  /** The call id (RAP `id`; `tool_call_id` on subscription events). */
  callId: string;
  /** The RAP `group_id`. */
  groupId: string;
  organizationId: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

interface Wire {
  c: string;
  g: string;
  o: string;
  e: number;
}

const b64u = (buf: Buffer): string => buf.toString("base64url");
const mac = (secret: string, payload: string): Buffer =>
  createHmac("sha256", secret).update(payload).digest();

function isWire(v: unknown): v is Wire {
  const w = v as Wire;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof w.c === "string" &&
    typeof w.g === "string" &&
    typeof w.o === "string" &&
    typeof w.e === "number"
  );
}

export function signCallbackCapability(
  secret: string,
  claims: CallbackClaims,
): string {
  if (secret === "") {
    throw new Error(
      "ADDON_CALLBACK_SECRET is empty: callback URLs cannot be minted",
    );
  }
  const wire: Wire = {
    c: claims.callId,
    g: claims.groupId,
    o: claims.organizationId,
    e: claims.expiresAt,
  };
  const payload = b64u(Buffer.from(JSON.stringify(wire)));
  return `${payload}.${b64u(mac(secret, payload))}`;
}

/** The claims of a valid, unexpired capability; null for anything else. */
export function verifyCallbackCapability(
  secret: string,
  capability: string,
  now: number = Date.now(),
): CallbackClaims | null {
  if (secret === "") return null;
  const parts = capability.split(".");
  if (parts.length !== 2) return null;
  const [payload = "", signature = ""] = parts;
  const want = mac(secret, payload);
  const got = Buffer.from(signature, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let wire: unknown;
  try {
    wire = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isWire(wire) || wire.e <= now) return null;
  return {
    callId: wire.c,
    groupId: wire.g,
    organizationId: wire.o,
    expiresAt: wire.e,
  };
}
