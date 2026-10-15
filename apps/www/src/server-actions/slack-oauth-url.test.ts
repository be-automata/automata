import { describe, it, vi, beforeEach, expect } from "vitest";
import { db } from "@/lib/db";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import { mockLoggedInUser } from "@/test-helpers/mock-next";
import { unwrapResult } from "@/lib/server-actions";

vi.mock("@/server-lib/slack-config", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/server-lib/slack-config")>();
  return {
    ...actual,
    resolveSlackAppConfig: vi.fn(async () => ({
      source: "platform",
      clientId: "1.2",
      clientSecret: "secret",
      signingSecret: "signing",
    })),
  };
});

import { getSlackOAuthUrl } from "./slack";

describe("getSlackOAuthUrl workspace hint", () => {
  beforeEach(async () => {
    const { session } = await createTestUser({ db });
    await mockLoggedInUser(session);
  });

  it("keeps the OpenID endpoint when no workspace is named", async () => {
    const url = new URL(unwrapResult(await getSlackOAuthUrl()));
    expect(url.origin + url.pathname).toBe(
      "https://slack.com/openid/connect/authorize",
    );
    expect(url.searchParams.get("scope")).toBe("openid,profile,email");
    expect(url.searchParams.get("team")).toBeNull();
  });

  // Slack's /openid/connect/authorize drops `team` when it redirects to
  // /oauth/v2/authorize, so a named workspace must go there directly.
  it("goes straight to /oauth/v2/authorize with the team when one is named", async () => {
    const url = new URL(
      unwrapResult(await getSlackOAuthUrl({ teamId: "T09TEST123" })),
    );
    expect(url.origin + url.pathname).toBe(
      "https://slack.com/oauth/v2/authorize",
    );
    expect(url.searchParams.get("team")).toBe("T09TEST123");
    expect(url.searchParams.get("user_scope")).toBe("openid,profile,email");
    expect(url.searchParams.get("openid_connect")).toBe("1");
    expect(url.searchParams.get("scope")).toBeNull();
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBeTruthy();
  });
});
