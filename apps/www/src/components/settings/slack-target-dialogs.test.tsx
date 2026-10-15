import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { SlackInstallConfirmation } from "./slack-target-dialogs";

const customer = {
  id: "org_customer",
  name: "Customer",
  slug: "customer",
  logo: null,
  isPersonal: false,
};

describe("SlackInstallConfirmation", () => {
  it("asks the user to confirm the workspace by name and ID", () => {
    const html = renderToStaticMarkup(
      <SlackInstallConfirmation
        workspaceName="Vendor HQ"
        workspaceId="T0VENDOR1"
        organization={customer}
        confirmed={false}
        onConfirmedChange={() => {}}
      />,
    );
    expect(html).toContain(
      'Vendor HQ (<span class="font-mono">T0VENDOR1</span>) is',
    );
    expect(html).toContain("Customer&#x27;s Slack workspace");
    expect(html).toContain("Connect another workspace");
    // Unchecked until the user says so.
    expect(html).toContain('data-state="unchecked"');
  });

  it("shows the confirmation as checked once given", () => {
    const html = renderToStaticMarkup(
      <SlackInstallConfirmation
        workspaceName="Customer Slack"
        workspaceId="T0CUSTOM1"
        organization={customer}
        confirmed
        onConfirmedChange={() => {}}
      />,
    );
    expect(html).toContain('data-state="checked"');
  });
});
