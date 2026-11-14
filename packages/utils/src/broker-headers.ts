/**
 * Header sets shared by the credential brokers (the worker's loopback brokers
 * and the www remote-cell broker). Only the invariants every broker must agree
 * on live here; fence policy stays per-broker.
 */

// Hop-by-hop / body-framing headers neither direction may copy verbatim — Node
// (response) and fetch (request) re-frame the body, so a stale
// length/encoding/connection header corrupts it.
export const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
  "upgrade",
]);

// Request headers the broker OWNS — everything else is forwarded VERBATIM
// (a denylist, symmetric with HOP_BY_HOP on the response side). `authorization`
// is replaced with the injected credential (never the client's bearer); `host`
// is set by fetch to the upstream. A denylist forwards future git/gh headers by
// default — the allowlist trap already bit us once: `git-protocol` was
// load-bearing and its omission silently downgraded protocol v2→v0.
export const REQUEST_OWNED = new Set([...HOP_BY_HOP, "authorization", "host"]);
