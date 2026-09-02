import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SUPERSEDE_POLICIES } from "@terragon/shared/model/repo-review-settings";
import { PolicyRadioGroup, POLICY_CONSEQUENCE } from "./policy-radio-group";

const noop = () => {};

describe("PolicyRadioGroup (#125 C6)", () => {
  it("renders a WAI radio group with all three policies in consequence language, Default badge on newest-wins", () => {
    const html = renderToStaticMarkup(
      <PolicyRadioGroup
        value={null}
        recheckOnComplete={false}
        onSelect={noop}
        onRecheckChange={noop}
      />,
    );
    expect(html).toContain('role="radiogroup"');
    expect((html.match(/role="radio"/g) ?? []).length).toBe(3);
    for (const policy of SUPERSEDE_POLICIES) {
      // renderToStaticMarkup HTML-escapes apostrophes etc.
      const escaped = POLICY_CONSEQUENCE[policy]
        .replace(/&/g, "&amp;")
        .replace(/'/g, "&#x27;");
      expect(html).toContain(escaped);
    }
    expect(html).toContain(">Default<");
    // No policy stored → newest-wins is the selected default.
    expect(html).toContain('aria-checked="true"');
    // Discard not selected → warning region exists (aria-live) but is empty.
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("no feedback");
  });

  it("selecting discard shows the amber warning + the nested re-verify toggle inside the live region (AC5)", () => {
    const html = renderToStaticMarkup(
      <PolicyRadioGroup
        value="complete-run-discard"
        recheckOnComplete={true}
        onSelect={noop}
        onRecheckChange={noop}
      />,
    );
    expect(html).toContain("no feedback");
    expect(html).toContain("Re-verify the newest commit");
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
  });
});
