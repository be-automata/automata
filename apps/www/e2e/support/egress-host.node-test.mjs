// node --test apps/www/e2e/support/egress-host.node-test.mjs
// Named *.node-test.mjs so vitest's default *.test.* include skips it.
import assert from "node:assert/strict";
import { test } from "node:test";

import { isLocalHost, normalizeHost } from "./egress-host.mjs";

test("normalizeHost strips a port only where it is one", () => {
  assert.equal(normalizeHost("localhost:3100"), "localhost");
  assert.equal(normalizeHost("127.0.0.1:3100"), "127.0.0.1");
  assert.equal(normalizeHost("::1"), "::1");
  assert.equal(normalizeHost("[::1]"), "::1");
  assert.equal(normalizeHost("[::1]:3100"), "::1");
  assert.equal(normalizeHost("api.github.com:443"), "api.github.com");
});

test("isLocalHost accepts loopback forms and nothing else", () => {
  for (const host of [
    "localhost",
    "localhost:3100",
    "127.0.0.1:3100",
    "::1",
    "[::1]",
    "[::1]:3100",
  ]) {
    assert.equal(isLocalHost(host), true, host);
  }
  for (const host of [
    "api.github.com:443",
    "slack.com",
    "2001:db8::1",
    "[2001:db8::1]:443",
  ]) {
    assert.equal(isLocalHost(host), false, host);
  }
});
