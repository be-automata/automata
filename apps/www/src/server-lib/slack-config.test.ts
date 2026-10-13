import { describe, expect, it } from "vitest";

import {
  describeSlackAppConfig,
  pickSlackAppConfig,
  slackRequestUrlPath,
} from "./slack-config";

const PLATFORM = {
  SLACK_CLIENT_ID: "platform-client",
  SLACK_CLIENT_SECRET: "platform-secret",
  SLACK_SIGNING_SECRET: "platform-signing",
};

const vars = (record: Record<string, string>) =>
  Object.entries(record).map(([key, value]) => ({ key, value }));

describe("pickSlackAppConfig", () => {
  it("uses the platform app when the org sets no SLACK_* key", () => {
    const config = pickSlackAppConfig({
      organizationId: "org-1",
      organizationVariables: vars({ YOUTRACK_URL: "https://yt.example.com" }),
      platform: PLATFORM,
    });
    expect(config).toEqual({
      source: "platform",
      organizationId: null,
      clientId: "platform-client",
      clientSecret: "platform-secret",
      signingSecret: "platform-signing",
    });
  });

  it("uses the org's own app when the org sets its keys", () => {
    const config = pickSlackAppConfig({
      organizationId: "org-1",
      organizationVariables: vars({
        SLACK_CLIENT_ID: "org-client",
        SLACK_CLIENT_SECRET: "org-secret",
        SLACK_SIGNING_SECRET: "org-signing",
      }),
      platform: PLATFORM,
    });
    expect(config).toEqual({
      source: "organization",
      organizationId: "org-1",
      clientId: "org-client",
      clientSecret: "org-secret",
      signingSecret: "org-signing",
    });
    expect(describeSlackAppConfig(config).ready).toBe(true);
  });

  it("never fills an org's missing key from the platform app", () => {
    const config = pickSlackAppConfig({
      organizationId: "org-1",
      organizationVariables: vars({ SLACK_CLIENT_ID: "org-client" }),
      platform: PLATFORM,
    });
    expect(config.source).toBe("organization");
    expect(config.signingSecret).toBeNull();
    expect(config.clientSecret).toBeNull();
    expect(describeSlackAppConfig(config)).toEqual({
      source: "organization",
      keys: {
        SLACK_CLIENT_ID: true,
        SLACK_CLIENT_SECRET: false,
        SLACK_SIGNING_SECRET: false,
      },
      ready: false,
    });
  });

  it("treats blank values as unset", () => {
    const config = pickSlackAppConfig({
      organizationId: null,
      organizationVariables: [],
      platform: { ...PLATFORM, SLACK_SIGNING_SECRET: "  " },
    });
    expect(config.signingSecret).toBeNull();
    expect(describeSlackAppConfig(config).ready).toBe(false);
  });

  it("ignores org variables without an org id", () => {
    const config = pickSlackAppConfig({
      organizationId: null,
      organizationVariables: vars({ SLACK_CLIENT_ID: "stray" }),
      platform: PLATFORM,
    });
    expect(config.source).toBe("platform");
  });
});

describe("slackRequestUrlPath", () => {
  it("points an org's own app at its own route", () => {
    const config = pickSlackAppConfig({
      organizationId: "org-1",
      organizationVariables: vars({ SLACK_SIGNING_SECRET: "s" }),
      platform: PLATFORM,
    });
    expect(slackRequestUrlPath(config)).toBe("/api/webhooks/slack/org-1");
  });

  it("points the platform app at the shared route", () => {
    const config = pickSlackAppConfig({
      organizationId: "org-1",
      organizationVariables: [],
      platform: PLATFORM,
    });
    expect(slackRequestUrlPath(config)).toBe("/api/webhooks/slack");
  });
});
