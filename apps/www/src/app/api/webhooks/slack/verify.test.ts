import crypto from "crypto";

import { describe, expect, it } from "vitest";

import { verifySlackSignature } from "./verify";

const SECRET = "test-signing-secret";
const NOW = 1_760_000_000;
const BODY = '{"type":"event_callback"}';

function sign(body: string, timestamp: number, secret = SECRET): string {
  return `v0=${crypto
    .createHmac("sha256", secret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
}

describe("verifySlackSignature", () => {
  it("accepts a fresh request signed with the secret", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: String(NOW),
        signature: sign(BODY, NOW),
        body: BODY,
        nowSeconds: NOW,
      }),
    ).toBe(true);
  });

  it("rejects a request signed with another app's secret", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: String(NOW),
        signature: sign(BODY, NOW, "another-app"),
        body: BODY,
        nowSeconds: NOW,
      }),
    ).toBe(false);
  });

  it("rejects a tampered body", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: String(NOW),
        signature: sign(BODY, NOW),
        body: `${BODY} `,
        nowSeconds: NOW,
      }),
    ).toBe(false);
  });

  it("rejects a replay older than five minutes", () => {
    const old = NOW - 301;
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: String(old),
        signature: sign(BODY, old),
        body: BODY,
        nowSeconds: NOW,
      }),
    ).toBe(false);
  });

  it("rejects missing headers and a non-numeric timestamp", () => {
    const base = { signingSecret: SECRET, body: BODY, nowSeconds: NOW };
    expect(
      verifySlackSignature({ ...base, timestamp: null, signature: "v0=x" }),
    ).toBe(false);
    expect(
      verifySlackSignature({
        ...base,
        timestamp: String(NOW),
        signature: null,
      }),
    ).toBe(false);
    expect(
      verifySlackSignature({
        ...base,
        timestamp: "soon",
        signature: sign(BODY, NOW),
      }),
    ).toBe(false);
  });
});
