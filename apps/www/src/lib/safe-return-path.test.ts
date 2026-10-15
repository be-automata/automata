import { describe, expect, it } from "vitest";

import { DEFAULT_RETURN_PATH, safeReturnPath } from "./safe-return-path";

describe("safeReturnPath", () => {
  it("keeps a same-origin path with its query and hash", () => {
    expect(safeReturnPath("/o/acme/settings?x=1")).toBe("/o/acme/settings?x=1");
    expect(safeReturnPath("/dashboard#top")).toBe("/dashboard#top");
    expect(safeReturnPath("/")).toBe("/");
  });

  it.each([
    ["an absolute URL", "https://evil.com"],
    ["an absolute URL to the app's own scheme", "http://evil.com/dashboard"],
    ["a scheme-relative URL", "//evil.com"],
    ["a scheme-relative URL with a path", "//evil.com/dashboard"],
    ["a backslash scheme-relative URL", "/\\evil.com"],
    ["a double backslash", "\\\\evil.com"],
    ["a still-encoded scheme-relative URL", "%2F%2Fevil.com"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a JavaScript: URL in mixed case", "JavaScript:alert(1)"],
    ["a data: URL", "data:text/html,<script>alert(1)</script>"],
    ["a tab that browsers drop", "/\t/evil.com"],
    ["a newline that browsers drop", "/\n/evil.com"],
    ["a dot segment that resolves to //", "/.//evil.com"],
    ["a relative path", "dashboard"],
    ["an empty string", ""],
  ])("rejects %s", (_label, raw) => {
    expect(safeReturnPath(raw)).toBeNull();
  });

  it("rejects a value that is not a single string", () => {
    expect(safeReturnPath(undefined)).toBeNull();
    expect(safeReturnPath(null)).toBeNull();
    expect(safeReturnPath(["/dashboard", "//evil.com"])).toBeNull();
  });

  it("keeps an encoded slash inside a path (it is not a separator)", () => {
    expect(safeReturnPath("/%2F%2Fevil.com")).toBe("/%2F%2Fevil.com");
  });

  it("resolves dot segments without leaving the origin", () => {
    expect(safeReturnPath("/a/../settings")).toBe("/settings");
    expect(safeReturnPath("/../../evil.com")).toBe("/evil.com");
  });

  it("falls back to the dashboard", () => {
    expect(DEFAULT_RETURN_PATH).toBe("/dashboard");
  });
});
