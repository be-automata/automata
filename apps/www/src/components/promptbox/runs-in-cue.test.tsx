import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { RunsInCueView } from "./runs-in-cue";

const acme = { id: "org_acme", name: "Acme", logo: null };

describe("RunsInCueView", () => {
  it("names the org and the repository before work starts", () => {
    const html = renderToStaticMarkup(
      <RunsInCueView organization={acme} repoFullName="acme/api" />,
    );
    expect(html).toContain("Runs in");
    // The org's avatar (its initials), then its name.
    expect(html).toContain(">AC</span>");
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
