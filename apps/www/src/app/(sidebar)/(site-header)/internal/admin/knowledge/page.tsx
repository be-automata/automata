import { getAdminUserOrThrow } from "@/lib/auth-server";
import { KnowledgeCeilingAdmin } from "@/components/admin/knowledge-ceiling";

export default async function KnowledgeCeilingAdminPage() {
  await getAdminUserOrThrow();
  return <KnowledgeCeilingAdmin />;
}
