import type { DB } from "@terragon/shared/db";
import type {
  SlackAccount,
  SlackInstallation,
} from "@terragon/shared/db/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  attributeSlackBlockAction,
  BLOCK_ACTION_ATTRIBUTION_LOG_PREFIX,
  logBlockActionAttribution,
  type BlockActionAttributionDeps,
} from "./block-action-attribution";
import { PLATFORM_SLACK_ROUTE, type SlackRequestRoute } from "./route-fence";

const db = {} as DB;
const ORG_ROUTE: SlackRequestRoute = {
  kind: "organization",
  organizationId: "org-route",
};

function payload(overrides: Record<string, unknown> = {}) {
  return {
    type: "block_actions",
    user: { id: "U1", team_id: "T1" },
    team: { id: "T1" },
    actions: [{ action_id: "some_action", value: "SENTINEL_VALUE" }],
    message: { text: "SENTINEL_MESSAGE" },
    response_url: "https://hooks.slack.test/SENTINEL_RESPONSE_URL",
    trigger_id: "SENTINEL_TRIGGER",
    ...overrides,
  };
}

function makeDeps(
  options: {
    installation?: Partial<SlackInstallation> | null;
    account?: Partial<SlackAccount> | null;
    member?: boolean;
  } = {},
) {
  const installation =
    options.installation === null
      ? null
      : ({
          organizationId: null,
          ...options.installation,
        } as SlackInstallation);
  const account =
    options.account === null
      ? null
      : ({ userId: "user-1", ...options.account } as SlackAccount);
  const deps = {
    getInstallationForRoute: vi.fn().mockResolvedValue(installation),
    getSlackAccount: vi.fn().mockResolvedValue(account),
    getMembership: vi
      .fn()
      .mockResolvedValue(options.member === false ? undefined : { id: "m" }),
  };
  return { deps, typed: deps as unknown as BlockActionAttributionDeps };
}

describe("attributeSlackBlockAction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("verifies a linked user on an unbound installation", async () => {
    const { typed } = makeDeps();
    expect(
      await attributeSlackBlockAction({
        db,
        payload: payload(),
        route: PLATFORM_SLACK_ROUTE,
        deps: typed,
      }),
    ).toEqual({
      verdict: "verified",
      teamId: "T1",
      slackUserId: "U1",
      userId: "user-1",
      organizationId: null,
    });
  });

  it("verifies an org member on an org-bound installation", async () => {
    const { deps, typed } = makeDeps({ installation: { organizationId: "X" } });
    const result = await attributeSlackBlockAction({
      db,
      payload: payload(),
      route: PLATFORM_SLACK_ROUTE,
      deps: typed,
    });
    expect(result).toMatchObject({ verdict: "verified", organizationId: "X" });
    expect(deps.getMembership).toHaveBeenCalledWith({
      db,
      organizationId: "X",
      userId: "user-1",
    });
  });

  it("is unverified for a non-member of the bound org", async () => {
    const { typed } = makeDeps({
      installation: { organizationId: "X" },
      member: false,
    });
    expect(
      await attributeSlackBlockAction({
        db,
        payload: payload(),
        route: PLATFORM_SLACK_ROUTE,
        deps: typed,
      }),
    ).toMatchObject({ verdict: "unverified", reason: "not_org_member" });
  });

  it("is unverified without an installation for the route", async () => {
    const { typed } = makeDeps({ installation: null });
    expect(
      await attributeSlackBlockAction({
        db,
        payload: payload(),
        route: PLATFORM_SLACK_ROUTE,
        deps: typed,
      }),
    ).toMatchObject({
      verdict: "unverified",
      reason: "no_installation_for_route",
    });
  });

  it("is unverified when the slack account is not linked", async () => {
    const { typed } = makeDeps({ account: null });
    expect(
      await attributeSlackBlockAction({
        db,
        payload: payload(),
        route: PLATFORM_SLACK_ROUTE,
        deps: typed,
      }),
    ).toMatchObject({
      verdict: "unverified",
      reason: "slack_account_not_linked",
    });
  });

  it.each([
    ["no user id", payload({ user: { team_id: "T1" } })],
    ["no team id", payload({ team: null, user: { id: "U1" } })],
    ["a non-object payload", "nope"],
  ])("is missing_identity with %s and calls no lookup", async (_n, body) => {
    const { deps, typed } = makeDeps();
    expect(
      await attributeSlackBlockAction({
        db,
        payload: body,
        route: PLATFORM_SLACK_ROUTE,
        deps: typed,
      }),
    ).toMatchObject({ verdict: "unverified", reason: "missing_identity" });
    expect(deps.getInstallationForRoute).not.toHaveBeenCalled();
    expect(deps.getSlackAccount).not.toHaveBeenCalled();
    expect(deps.getMembership).not.toHaveBeenCalled();
  });

  it("never verifies on an org route and calls no lookup", async () => {
    const { deps, typed } = makeDeps();
    expect(
      await attributeSlackBlockAction({
        db,
        payload: payload(),
        route: ORG_ROUTE,
        deps: typed,
      }),
    ).toMatchObject({
      verdict: "unverified",
      reason: "org_route_payload_forgeable",
    });
    expect(deps.getInstallationForRoute).not.toHaveBeenCalled();
    expect(deps.getSlackAccount).not.toHaveBeenCalled();
    expect(deps.getMembership).not.toHaveBeenCalled();
  });

  it("falls back to user.team_id when payload.team is null", async () => {
    const { deps, typed } = makeDeps();
    await attributeSlackBlockAction({
      db,
      payload: payload({ team: null, user: { id: "U1", team_id: "TGRID" } }),
      route: PLATFORM_SLACK_ROUTE,
      deps: typed,
    });
    expect(deps.getInstallationForRoute).toHaveBeenCalledWith({
      db,
      teamId: "TGRID",
      route: PLATFORM_SLACK_ROUTE,
    });
  });
});

describe("logBlockActionAttribution", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits one parseable line with only allow-listed fields", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { typed } = makeDeps();
    await logBlockActionAttribution({
      db,
      payload: payload(),
      route: PLATFORM_SLACK_ROUTE,
      deps: typed,
    });
    expect(log).toHaveBeenCalledTimes(1);
    const args = log.mock.calls[0] ?? [];
    expect(args).toHaveLength(1);
    const line = String(args[0]);
    expect(line.startsWith(BLOCK_ACTION_ATTRIBUTION_LOG_PREFIX)).toBe(true);
    expect(
      JSON.parse(line.slice(BLOCK_ACTION_ATTRIBUTION_LOG_PREFIX.length)),
    ).toEqual({
      actionId: "some_action",
      route: "platform",
      routeOrganizationId: null,
      teamId: "T1",
      slackUserId: "U1",
      verdict: "verified",
      reason: null,
      userId: "user-1",
    });
    expect(JSON.stringify(args)).not.toMatch(/SENTINEL/);
  });

  it("logs the org route as unverified without userId or sentinels", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { typed } = makeDeps();
    await logBlockActionAttribution({
      db,
      payload: payload(),
      route: ORG_ROUTE,
      deps: typed,
    });
    const line = String(log.mock.calls[0]?.[0]);
    const fields = JSON.parse(
      line.slice(BLOCK_ACTION_ATTRIBUTION_LOG_PREFIX.length),
    );
    expect(fields).toMatchObject({
      route: "organization",
      routeOrganizationId: "org-route",
      verdict: "unverified",
      reason: "org_route_payload_forgeable",
    });
    expect(fields).not.toHaveProperty("userId");
    expect(line).not.toMatch(/SENTINEL/);
  });
});
