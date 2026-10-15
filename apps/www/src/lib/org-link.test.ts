import { describe, expect, it } from "vitest";

import { buildOrgLink, buildOrgLinkTarget } from "./org-link";

describe("buildOrgLinkTarget", () => {
  it("defaults to the dashboard when there is no path", () => {
    expect(buildOrgLinkTarget(undefined, "")).toBe("/dashboard");
    expect(buildOrgLinkTarget([], "")).toBe("/dashboard");
    expect(buildOrgLinkTarget([], "?tab=all")).toBe("/dashboard?tab=all");
  });

  it("joins the segments into a relative path and keeps the query", () => {
    expect(buildOrgLinkTarget(["settings"], "")).toBe("/settings");
    expect(
      buildOrgLinkTarget(["repos", "acme", "widgets"], "?view=runs&x=1"),
    ).toBe("/repos/acme/widgets?view=runs&x=1");
    expect(buildOrgLinkTarget(["task", "abc"], "?")).toBe("/task/abc");
  });

  it("re-encodes characters that are safe inside a segment", () => {
    expect(buildOrgLinkTarget(["search", "a b?c#d"], "")).toBe(
      "/search/a%20b%3Fc%23d",
    );
  });

  it.each([
    ["an empty segment (a // target)", ["", "evil.example"]],
    ["an empty trailing segment", ["settings", ""]],
    ["a decoded slash inside a segment", ["/evil.example"]],
    ["a decoded double slash", ["", "", "evil.example"]],
    ["a backslash", ["\\evil.example"]],
    ["a backslash mid-segment", ["foo\\bar"]],
    ["a scheme", ["https:", "evil.example"]],
    ["a javascript: scheme", ["javascript:alert(1)"]],
    ["a data: scheme", ["data:text"]],
    ["a dot segment", ["."]],
    ["a dot-dot segment", ["..", "..", "etc"]],
    ["a control character", ["foo\nbar"]],
    ["a tab", ["\tsettings"]],
    ["a null byte", ["foo\u0000"]],
    ["another org link (loop)", ["o", "acme"]],
  ])("rejects %s", (_label, segments) => {
    expect(buildOrgLinkTarget(segments, "")).toBeNull();
  });

  it("allows an org link segment that is not the first one", () => {
    expect(buildOrgLinkTarget(["docs", "o"], "")).toBe("/docs/o");
  });

  it("keeps a query that looks like a URL inside the same origin", () => {
    const target = buildOrgLinkTarget(["settings"], "?next=//evil.example");
    expect(target).toBe("/settings?next=//evil.example");
    expect(new URL(target!, "https://app.example").origin).toBe(
      "https://app.example",
    );
  });
});

describe("buildOrgLink", () => {
  const origin = "https://app.example";

  it("prefixes the current path with the org slug", () => {
    expect(
      buildOrgLink({ origin, slug: "acme", pathname: "/settings/repos" }),
    ).toBe("https://app.example/o/acme/settings/repos");
  });

  it("drops the root path", () => {
    expect(buildOrgLink({ origin, slug: "acme", pathname: "/" })).toBe(
      "https://app.example/o/acme",
    );
  });

  it("never nests an org link", () => {
    expect(
      buildOrgLink({ origin, slug: "acme", pathname: "/o/other/settings" }),
    ).toBe("https://app.example/o/acme");
  });

  it("encodes the slug", () => {
    expect(buildOrgLink({ origin, slug: "a/b", pathname: "/x" })).toBe(
      "https://app.example/o/a%2Fb/x",
    );
  });
});
