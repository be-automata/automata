import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DB } from "@terragon/shared/db";
import type { Automation } from "@terragon/shared/db/types";

import { AUDIT_FIX_SKILL_NAME } from "../review/review-skill";
import {
  clearOwnerLoginCache,
  OWNER_LOGIN_CACHE_MS,
  resolveFixTriggerLogins,
  type FixTriggerLoginDeps,
} from "./fix-trigger-logins";

const ORG = "org-1";
const REPO = "acme/widgets";
const db = {} as DB;

function automation(overrides: Partial<Automation> = {}): Automation {
  // The lookup reads only these fields of the row.
  return {
    id: "auto-1",
    organizationId: ORG,
    userId: "user-1",
    triggerType: "issue",
    action: {
      type: "skill_message",
      config: { skillName: AUDIT_FIX_SKILL_NAME },
    },
    ...overrides,
  } as unknown as Automation;
}

function deps(
  overrides: Partial<FixTriggerLoginDeps> = {},
): FixTriggerLoginDeps & { lookupLogin: ReturnType<typeof vi.fn> } {
  const lookupLogin = vi.fn(async () => "Repo-Owner");
  return {
    botLogin: () => "automata-app[bot]",
    listIssueAutomations: vi.fn(async () => [automation()]),
    getGitHubAccountId: vi.fn(async () => "4242"),
    lookupLogin,
    error: vi.fn(),
    now: () => 1_000,
    ...overrides,
  } as FixTriggerLoginDeps & { lookupLogin: ReturnType<typeof vi.fn> };
}

describe("resolveFixTriggerLogins", () => {
  beforeEach(() => {
    clearOwnerLoginCache();
  });

  it("returns the bot and the audit-fix automation owner's login", async () => {
    const d = deps();
    expect(
      await resolveFixTriggerLogins({
        db,
        organizationId: ORG,
        repoFullName: REPO,
        deps: d,
      }),
    ).toEqual(["automata-app[bot]", "Repo-Owner"]);
    expect(d.lookupLogin).toHaveBeenCalledWith({
      repoFullName: REPO,
      accountId: "4242",
    });
  });

  it("ignores another org's automation and non-fix automations", async () => {
    const d = deps({
      listIssueAutomations: vi.fn(async () => [
        automation({ organizationId: "other-org" }),
        automation({
          action: {
            type: "skill_message",
            config: { skillName: "something-else" },
          },
        } as Partial<Automation>),
      ]),
    });
    expect(
      await resolveFixTriggerLogins({
        db,
        organizationId: ORG,
        repoFullName: REPO,
        deps: d,
      }),
    ).toEqual(["automata-app[bot]"]);
    expect(d.lookupLogin).not.toHaveBeenCalled();
  });

  it("omits the owner when no GitHub account is linked", async () => {
    const d = deps({ getGitHubAccountId: vi.fn(async () => undefined) });
    expect(
      await resolveFixTriggerLogins({
        db,
        organizationId: ORG,
        repoFullName: REPO,
        deps: d,
      }),
    ).toEqual(["automata-app[bot]"]);
  });

  it("a failed lookup is logged, omits the owner and never throws", async () => {
    const d = deps({
      lookupLogin: vi.fn(async () => {
        throw new Error("timeout");
      }),
    });
    expect(
      await resolveFixTriggerLogins({
        db,
        organizationId: ORG,
        repoFullName: REPO,
        deps: d,
      }),
    ).toEqual(["automata-app[bot]"]);
    expect(d.error).toHaveBeenCalledTimes(1);
  });

  it("caches a found login for an hour", async () => {
    let now = 1_000;
    const d = deps({ now: () => now });
    const run = () =>
      resolveFixTriggerLogins({
        db,
        organizationId: ORG,
        repoFullName: REPO,
        deps: d,
      });
    await run();
    await run();
    expect(d.lookupLogin).toHaveBeenCalledTimes(1);
    now += OWNER_LOGIN_CACHE_MS + 1;
    await run();
    expect(d.lookupLogin).toHaveBeenCalledTimes(2);
  });
});
