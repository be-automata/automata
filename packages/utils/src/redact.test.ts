import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact";

describe("redactSecrets", () => {
  it("scrubs a git extraHeader basic credential, bearer tokens, GitHub tokens and URL-embedded tokens", () => {
    const b64 = Buffer.from(
      "x-access-token:ghs_3211193_abcdefghijklmnop",
    ).toString("base64");
    const text = [
      `Command failed: git -c http.extraHeader=AUTHORIZATION: basic ${b64} clone --depth 1`,
      "Bearer eyJhbGciOiJFUzI1NiJ9.payload.sig",
      "token ghs_3211193_abcdefghijklmnop and ghp_ABCDEFGHIJKLMNOP1234 and github_pat_11ABCDEFG_xyz",
      "https://x-access-token:ghs_secretsecret@github.com/o/r.git",
    ].join("\n");
    const out = redactSecrets(text);
    expect(out).not.toContain(b64);
    expect(out).not.toMatch(/ghs_|ghp_|github_pat_/);
    expect(out).not.toContain("eyJhbGciOiJFUzI1NiJ9");
    expect(out).toContain("basic <redacted>");
    expect(out).toContain("Bearer <redacted>");
    expect(out).toContain("x-access-token:<redacted>@github.com");
    // Non-secret text survives.
    expect(out).toContain("clone --depth 1");
  });

  it("masks the password in any URL's userinfo, keeping scheme, user and host", () => {
    const text = [
      "connect failed: postgresql://automata_test:0a1b2c3d4e5f60718293a4b5c6d7e8f9@127.0.0.1:25432/postgres",
      "redis://default:p%40ss-w0rd@cache.internal:6379/0",
    ].join("\n");
    const out = redactSecrets(text);
    expect(out).not.toContain("0a1b2c3d4e5f60718293a4b5c6d7e8f9");
    expect(out).not.toContain("p%40ss-w0rd");
    expect(out).toContain(
      "postgresql://automata_test:<redacted>@127.0.0.1:25432/postgres",
    );
    expect(out).toContain("redis://default:<redacted>@cache.internal:6379/0");
  });

  it("leaves a URL without a password (and a host:port path) untouched", () => {
    const s =
      "see https://example.com:8443/a@b and postgresql://user@db/postgres";
    expect(redactSecrets(s)).toBe(s);
  });

  it("leaves ordinary text untouched", () => {
    const s = "fatal: could not read from remote repository (exit 128)";
    expect(redactSecrets(s)).toBe(s);
  });
});
