import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { EffectiveConfiguration } from "./effective-configuration";

describe("EffectiveConfiguration", () => {
  it("masks values, strikes overridden layers and marks server-only keys", () => {
    const html = renderToStaticMarkup(
      <EffectiveConfiguration
        entries={[
          {
            key: "API_URL",
            audience: "agent",
            winningSource: "repository",
            shadowedSources: ["global", "organization"],
            serverOnlySources: [],
          },
          {
            key: "YOUTRACK_TOKEN",
            audience: "server",
            winningSource: "organization",
            shadowedSources: [],
            serverOnlySources: ["organization"],
          },
        ]}
      />,
    );
    expect(html).toContain("API_URL");
    expect(html).toContain("••••");
    expect(html).toContain("Global, Organization overridden by Repo");
    expect(html.match(/line-through/g)).toHaveLength(2);
    expect(html).toContain("Server only");
    // Only the agent-bound key is counted.
    expect(html).toContain("1 variable reaches the agent.");
  });

  it("explains the next step when nothing is set", () => {
    const html = renderToStaticMarkup(<EffectiveConfiguration entries={[]} />);
    expect(html).toContain("No variables yet.");
    expect(html).toContain("0 variables reach the agent.");
  });
});
