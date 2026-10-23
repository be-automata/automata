import type { Metadata } from "next";

import { KnowledgeSection } from "@/components/settings/knowledge/knowledge-section";
import { getUserIdOrRedirect } from "@/lib/auth-server";

export const metadata: Metadata = {
  title: "Knowledge Settings | Terragon",
};

export default async function KnowledgeSettingsPage() {
  await getUserIdOrRedirect();
  return <KnowledgeSection />;
}
