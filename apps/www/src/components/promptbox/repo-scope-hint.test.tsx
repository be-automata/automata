import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href }, children),
}));

const { RepoScopeHintView } = await import("./repo-scope-hint");

describe("RepoScopeHintView", () => {
  it("points at Settings → Integrations when the org has no GitHub account bound", () => {
    const html = renderToStaticMarkup(
      <RepoScopeHintView scope="unassigned" organizationName="Acme" />,
    );
    expect(html).toContain("No GitHub account is bound to Acme yet");
    expect(html).toContain('href="/settings/integrations"');
  });

  it("renders nothing for an org-scoped list or without an org", () => {
    expect(
      renderToStaticMarkup(
        <RepoScopeHintView scope="organization" organizationName="Acme" />,
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        <RepoScopeHintView scope="unassigned" organizationName={null} />,
      ),
    ).toBe("");
  });
});
