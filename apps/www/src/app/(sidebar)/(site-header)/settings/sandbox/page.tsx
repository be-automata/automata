import { SandboxSettings } from "@/components/settings/tab/sandbox";
import { getUserIdOrRedirect } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Sandbox Settings | Terragon",
};

export default async function SandboxSettingsPage() {
  const userId = await getUserIdOrRedirect();
  // The page holds the sandbox size only: the provider is server-chosen
  // (ADR-014 / ADR-013 I7), so the size flag gates it.
  const largeSandboxSizeEnabled = await getFeatureFlagForUser({
    db,
    userId,
    flagName: "enableLargeSandboxSize",
  });
  if (!largeSandboxSizeEnabled) {
    redirect("/settings");
  }
  return <SandboxSettings />;
}
