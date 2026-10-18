// Per-run push credential: HMAC-signed claims, short TTL, revocable.
// Format: base64url(json claims).base64url(hmac-sha256)
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const KEY = process.env.GATE_KEY ?? "spike-003-local-key-not-a-secret";
const b64 = (b) => Buffer.from(b).toString("base64url");

export function mint({ runId, repo, refPrefix, paths, ttlSec = 600 }) {
  const claims = { runId, repo, refPrefix, paths, exp: Math.floor(Date.now() / 1000) + ttlSec, jti: randomBytes(8).toString("hex") };
  const body = b64(JSON.stringify(claims));
  return `${body}.${b64(createHmac("sha256", KEY).update(body).digest())}`;
}

// Returns claims or throws with a reason the agent can read.
export function verify(token, { repo, revoked }) {
  const [body, sig] = String(token).split(".");
  if (!body || !sig) throw new Error("malformed token");
  const want = createHmac("sha256", KEY).update(body).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error("bad signature");
  const claims = JSON.parse(Buffer.from(body, "base64url").toString());
  if (claims.exp < Date.now() / 1000) throw new Error(`token expired at ${new Date(claims.exp * 1000).toISOString()}`);
  if (revoked.has(claims.jti)) throw new Error(`token revoked (run ${claims.runId} ended)`);
  if (claims.repo !== repo) throw new Error(`token is for ${claims.repo}, not ${repo}`);
  return claims;
}
