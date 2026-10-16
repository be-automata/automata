/**
 * A Slack account is the user's sign-in to one workspace; it belongs to the
 * user, not to an organization. The installation is what an organization owns.
 * The integrations page lists the active org's workspaces first and tucks the
 * user's other sign-ins away, so a workspace of another org is never offered
 * as this org's.
 */
export interface SlackAccountGroups<T> {
  /** Installed in the active org: mentions there run in this org. */
  inOrganization: T[];
  /** Installed nowhere: can still be installed into the active org. */
  notInstalled: T[];
  /** Installed in another org: managed from that org. */
  otherOrganization: T[];
}

interface GroupableSlackAccount {
  installation: { organizationId: string | null } | null;
}

/**
 * Groups the user's Slack accounts against the active org. Without an active
 * org there is nothing to compare against, so every account is listed as
 * before. An installation with no org (a legacy personal install) counts as
 * this org's only when there is no active org.
 */
export function groupSlackAccounts<T extends GroupableSlackAccount>(
  accounts: readonly T[],
  activeOrganizationId: string | null,
): SlackAccountGroups<T> {
  if (!activeOrganizationId) {
    return {
      inOrganization: [...accounts],
      notInstalled: [],
      otherOrganization: [],
    };
  }
  const groups: SlackAccountGroups<T> = {
    inOrganization: [],
    notInstalled: [],
    otherOrganization: [],
  };
  for (const account of accounts) {
    if (!account.installation) {
      groups.notInstalled.push(account);
    } else if (account.installation.organizationId === activeOrganizationId) {
      groups.inOrganization.push(account);
    } else {
      groups.otherOrganization.push(account);
    }
  }
  return groups;
}
