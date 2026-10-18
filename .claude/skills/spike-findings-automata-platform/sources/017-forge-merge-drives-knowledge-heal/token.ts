// Per-run push credential, same format as spike 003: base64url(claims).base64url(hmac-sha256). Short TTL, revocable by jti.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const KEY = process.env.GATE_KEY ?? "spike-017-local-key-not-a-secret";
const b64 = (b: string | Buffer) => Buffer.from(b).toString("base64url");

export interface PushClaims { runId: string; repo: string; refPrefix: string; paths: string[]; exp: number; jti: string }

export function mint(c: Omit<PushClaims, "exp" | "jti">, ttlSec = 600): string {
  const claims: PushClaims = { ...c, exp: Math.floor(Date.now() / 1000) + ttlSec, jti: randomBytes(8).toString("hex") };
  const body = b64(JSON.stringify(claims));
  return `${body}.${b64(createHmac("sha256", KEY).update(body).digest())}`;
}

export function verify(token: string, repo: string, revoked: Set<string>): PushClaims {
  const [body, sig] = token.split(".");
  if (!body || !sig) throw new Error("malformed token");
  const want = createHmac("sha256", KEY).update(body).digest(), got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error("bad signature");
  const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as PushClaims;
  if (claims.exp < Date.now() / 1000) throw new Error(`token expired at ${new Date(claims.exp * 1000).toISOString()}`);
  if (revoked.has(claims.jti)) throw new Error(`token revoked (run ${claims.runId} ended)`);
  if (claims.repo !== repo) throw new Error(`token is for ${claims.repo}, not ${repo}`);
  return claims;
}
export const jtiOf = (token: string) => (JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString()) as PushClaims).jti;
