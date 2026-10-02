import { getOrCreateGlobalEnvironment } from "@terragon/shared/model/environments";
import { getControlPlaneEnvironmentVariables } from "@/server-lib/env-audience";
import { getUserIdOrRedirect } from "@/lib/auth-server";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { GlobalEnvironmentUI } from "@/components/environments/main";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: `Global Environment | Terragon`,
  };
}

export default async function EnvironmentPage() {
  const userId = await getUserIdOrRedirect();
  const environment = await getOrCreateGlobalEnvironment({ db, userId });
  if (!environment) {
    return notFound();
  }
  const environmentVariables = await getControlPlaneEnvironmentVariables({
    db,
    userId,
    environmentId: environment.id,
  });
  return (
    <GlobalEnvironmentUI
      environmentId={environment.id}
      environmentVariables={environmentVariables}
    />
  );
}
