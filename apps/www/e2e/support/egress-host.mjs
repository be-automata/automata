/**
 * Host parsing for the egress guard, kept free of side effects so it can be
 * checked on its own (egress-host.node-test.mjs).
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * The bare host of an http(s) `host`/`hostname` option, without a port:
 * "localhost:3100" → "localhost", "[::1]:3100" → "::1", "::1" → "::1".
 * Only a single colon is a port separator; a bare IPv6 address (more than
 * one colon) is returned as is.
 */
export function normalizeHost(value) {
  const host = String(value).trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
  if (bracketed) {
    return bracketed[1].toLowerCase();
  }
  const colons = host.split(":").length - 1;
  if (colons === 1) {
    return host.replace(/:\d*$/, "").toLowerCase();
  }
  return host.toLowerCase();
}

/** True for loopback hosts, in any of the forms normalizeHost accepts. */
export function isLocalHost(value) {
  return LOCAL_HOSTS.has(normalizeHost(value));
}
