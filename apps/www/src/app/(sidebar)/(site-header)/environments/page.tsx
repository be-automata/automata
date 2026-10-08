import { Environments } from "@/components/environments/main";
import { getTenantContextOrNull, getUserIdOrRedirect } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { getEnvironments } from "@terragon/shared/model/environments";
import {
  getMembership,
  getOrganizationById,
} from "@terragon/shared/model/organizations";
import React from "react";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Environments | Terragon",
};

export default async function EnvironmentsPage() {
  const userId = await getUserIdOrRedirect();
  const tenant = await getTenantContextOrNull();
  const organizationId = tenant?.organizationId ?? null;
  const [environments, organizationName] = await Promise.all([
    getEnvironments({
      db,
      userId,
      organizationId,
      includeGlobal: false,
    }),
    (async () => {
      if (!organizationId) return null;
      const [membership, organization] = await Promise.all([
        getMembership({ db, organizationId, userId }),
        getOrganizationById({ db, organizationId }),
      ]);
      return membership && organization ? organization.name : null;
    })(),
  ]);
  return (
    <Environments
      environments={environments}
      organizationName={organizationName}
    />
  );
}
