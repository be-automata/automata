import {
  getTenantContextOrNull,
  getUserIdOrNull,
  getUserIdOrRedirect,
} from "@/lib/auth-server";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getEnvironment } from "@terragon/shared/model/environments";
import type { Metadata } from "next";
import { SetupScriptEditor } from "@/components/environments/setup-script-editor";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const userId = await getUserIdOrNull();
  if (!userId) {
    return { title: "Setup Script | Terragon" };
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
    return { title: "Setup Script | Terragon" };
  }
  return {
    title: `${environment.repoFullName} Setup Script | Terragon`,
  };
}

export default async function SetupScriptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const userId = await getUserIdOrRedirect();
  const { id } = await params;
  const tenant = await getTenantContextOrNull();
  const environment = await getEnvironment({
    db,
    environmentId: id,
    userId,
    organizationId: tenant?.organizationId ?? null,
  });
  if (!environment) {
    return notFound();
  }

  return <SetupScriptEditor environmentId={id} environment={environment} />;
}
