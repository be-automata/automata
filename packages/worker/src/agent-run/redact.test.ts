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

  it("leaves ordinary text untouched", () => {
    const s = "fatal: could not read from remote repository (exit 128)";
    expect(redactSecrets(s)).toBe(s);
  });
});
