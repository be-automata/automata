import { inArray } from "drizzle-orm";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import React from "react";
import { user as userTable } from "@terragon/shared/db/schema";
import {
  getOrganizationEnvironmentKeys,
  listOrganizationEnvironmentEvents,
} from "@terragon/shared/model/organization-environment";
import {
  getMembership,
  getOrganizationById,
} from "@terragon/shared/model/organizations";

import { OrganizationEnvironmentUI } from "@/components/environments/main";
import { getTenantContextOrNull, getUserIdOrRedirect } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { ORG_ADMIN_ROLES } from "@/lib/org-role";
import { getControlPlaneOrganizationEnvironmentVariables } from "@/server-lib/env-audience";

export const metadata: Metadata = {
  title: "Organization Environment | Terragon",
};

/**
 * The active org's shared variables. The org comes from the session only.
 * Owners/admins get values (control plane: their own org's dashboard) and
 * the change history; members get key names read without decryption, so a
 * value never reaches a member's browser.
 */
export default async function OrganizationEnvironmentPage() {
  const userId = await getUserIdOrRedirect();
  const tenant = await getTenantContextOrNull();
  const organizationId = tenant?.organizationId ?? null;
  if (!organizationId) {
    return (
      <div className="flex flex-col justify-start h-full w-full max-w-4xl">
        <p>
          Select an organization to manage its shared environment variables.
        </p>
      </div>
    );
  }
  const [membership, organization] = await Promise.all([
    getMembership({ db, organizationId, userId }),
    getOrganizationById({ db, organizationId }),
  ]);
  if (!membership || !organization) {
    return notFound();
  }
  if (!ORG_ADMIN_ROLES.has(membership.role)) {
    return (
      <OrganizationEnvironmentUI
        organizationName={organization.name}
        canEdit={false}
        keys={await getOrganizationEnvironmentKeys({ db, organizationId })}
      />
    );
  }
  const [environmentVariables, events] = await Promise.all([
    getControlPlaneOrganizationEnvironmentVariables({ db, organizationId }),
    listOrganizationEnvironmentEvents({ db, organizationId, limit: 10 }),
  ]);
  const actorIds = [...new Set(events.map((event) => event.actorUserId))];
  const actors = actorIds.length
    ? await db
        .select({ id: userTable.id, name: userTable.name })
        .from(userTable)
        .where(inArray(userTable.id, actorIds))
    : [];
  const actorNames = new Map(actors.map((actor) => [actor.id, actor.name]));
  return (
    <OrganizationEnvironmentUI
      organizationName={organization.name}
      canEdit={true}
      environmentVariables={environmentVariables}
      events={events.map((event) => ({
        id: event.id,
        actorName: actorNames.get(event.actorUserId) ?? null,
        addedKeys: event.addedKeys,
        removedKeys: event.removedKeys,
        changedKeys: event.changedKeys,
        createdAt: event.createdAt,
      }))}
    />
  );
}
