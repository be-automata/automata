import {
  getOrCreateGlobalEnvironment,
  getEnvironment,
  getDecryptedMcpConfig,
} from "@terragon/shared/model/environments";
import {
  getTenantContextOrNull,
  getUserIdOrNull,
  getUserIdOrRedirect,
} from "@/lib/auth-server";
import { notFound } from "next/navigation";
import { getOrganizationEnvironmentKeys } from "@terragon/shared/model/organization-environment";
import { getMembership } from "@terragon/shared/model/organizations";
import { db } from "@/lib/db";
import { getControlPlaneEnvironmentVariables } from "@/server-lib/env-audience";
import { EnvironmentUI } from "@/components/environments/main";
import type { Metadata } from "next";
import { env } from "@terragon/env/apps-www";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const userId = await getUserIdOrNull();
  if (!userId) {
    return { title: "Environment | Terragon" };
  }
  const { id } = await params;
  const tenant = await getTenantContextOrNull();
  const environment = await getEnvironment({
    db,
    environmentId: id,
    userId,
    organizationId: tenant?.organizationId ?? null,
  });
  if (!environment) {
    return { title: "Environment | Terragon" };
  }
  return {
    title: `${environment.repoFullName} Environment | Terragon`,
  };
}

export default async function EnvironmentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const userId = await getUserIdOrRedirect();
  const { id } = await params;
  const tenant = await getTenantContextOrNull();
  const organizationId = tenant?.organizationId ?? null;
  const environment = await getEnvironment({
    db,
    environmentId: id,
    userId,
    organizationId,
  });
  if (!environment) {
    return notFound();
  }
  const [
    environmentVariables,
    mcpConfig,
    globalEnvironmentVariableKeys,
    organizationEnvironmentVariableKeys,
  ] = await Promise.all([
    // The owner's own settings page: the raw set, tracker token included.
    getControlPlaneEnvironmentVariables({
      db,
      userId,
      environmentId: id,
    }),
    getDecryptedMcpConfig({
      db,
      userId,
      environmentId: id,
      encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
    }),
    (async () => {
      const globalEnvironment = await getOrCreateGlobalEnvironment({
        db,
        userId,
      });
      return (
        globalEnvironment.environmentVariables?.map(
          (variable) => variable.key,
        ) ?? []
      );
    })(),
    // Key names only (no decryption): any member may see which org keys a
    // repository variable overrides.
    (async () => {
      if (!organizationId) return [];
      const membership = await getMembership({ db, organizationId, userId });
      return membership
        ? await getOrganizationEnvironmentKeys({ db, organizationId })
        : [];
    })(),
  ]);
  return (
    <EnvironmentUI
      environmentId={id}
      environment={environment}
      environmentVariables={environmentVariables}
      inheritedKeys={[
        ...organizationEnvironmentVariableKeys.map((key) => ({
          key,
          source: "organization" as const,
        })),
        ...globalEnvironmentVariableKeys.map((key) => ({
          key,
          source: "global" as const,
        })),
      ]}
      mcpConfig={mcpConfig || undefined}
    />
  );
}
