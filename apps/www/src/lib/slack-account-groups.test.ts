import { describe, expect, it } from "vitest";

import { groupSlackAccounts } from "./slack-account-groups";

const inOrg = { id: "a", installation: { organizationId: "org-a" } };
const elsewhere = { id: "b", installation: { organizationId: "org-b" } };
const unbound = { id: "c", installation: null };
const legacy = { id: "d", installation: { organizationId: null } };

describe("groupSlackAccounts", () => {
  it("keeps another org's workspace out of the active org's list", () => {
    const groups = groupSlackAccounts([inOrg, elsewhere, unbound], "org-a");
    expect(groups.inOrganization).toEqual([inOrg]);
    expect(groups.notInstalled).toEqual([unbound]);
    expect(groups.otherOrganization).toEqual([elsewhere]);
  });

  it("does not count a legacy org-less install as the active org's", () => {
    const groups = groupSlackAccounts([legacy], "org-a");
    expect(groups.inOrganization).toEqual([]);
    expect(groups.otherOrganization).toEqual([legacy]);
  });

  it("lists every account when no org is active", () => {
    const groups = groupSlackAccounts([inOrg, elsewhere, unbound], null);
    expect(groups.inOrganization).toEqual([inOrg, elsewhere, unbound]);
    expect(groups.notInstalled).toEqual([]);
    expect(groups.otherOrganization).toEqual([]);
  });
});
