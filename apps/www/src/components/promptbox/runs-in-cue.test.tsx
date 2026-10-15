import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The avatar is rendered by its own module; only its presence matters here.
vi.mock("@/components/org-avatar", () => ({
  OrgAvatar: ({ organization }: { organization: { name: string } }) =>
    React.createElement("span", { "data-org-avatar": organization.name }),
}));

const { RunsInCueView } = await import("./runs-in-cue");

const acme = { id: "org_acme", name: "Acme", logo: null };

describe("RunsInCueView", () => {
  it("names the org and the repository before work starts", () => {
    const html = renderToStaticMarkup(
      <RunsInCueView organization={acme} repoFullName="acme/api" />,
    );
    expect(html).toContain("Runs in");
    expect(html).toContain('data-org-avatar="Acme"');
    expect(html).toContain("Acme");
    expect(html).toContain("acme/api");
    expect(html).toContain('title="Runs in Acme · acme/api"');
  });

  it("renders nothing without an org or a repository", () => {
    expect(
      renderToStaticMarkup(
        <RunsInCueView organization={null} repoFullName="acme/api" />,
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        <RunsInCueView organization={acme} repoFullName={null} />,
      ),
    ).toBe("");
  });
});
