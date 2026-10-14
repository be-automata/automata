import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildSlackAppManifest, SLACK_BOT_SCOPES } from "./slack-app-manifest";

const MANIFEST_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../deploy/slack-app-manifest.json",
);

describe("slack app manifest", () => {
  it("the checked-in platform manifest matches the code", () => {
    const checkedIn = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    const appUrl = new URL(checkedIn.oauth_config.redirect_urls[0]).origin;
    expect(checkedIn).toEqual(
      buildSlackAppManifest({ appUrl, requestPath: "/api/webhooks/slack" }),
    );
  });

  it("requests no scope the code does not call", () => {
    expect([...SLACK_BOT_SCOPES].sort()).toEqual(
      [
        "app_mentions:read",
        "channels:history",
        "channels:read",
        "chat:write",
        "groups:history",
        "groups:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "users:read",
      ].sort(),
    );
  });

  it("points an organization's own app at its own route", () => {
    const manifest = buildSlackAppManifest({
      appUrl: "https://example.test",
      requestPath: "/api/webhooks/slack/org-1",
    });
    expect(manifest.settings.event_subscriptions.request_url).toBe(
      "https://example.test/api/webhooks/slack/org-1",
    );
    expect(manifest.settings.interactivity.request_url).toBe(
      "https://example.test/api/webhooks/slack/org-1",
    );
  });
});
