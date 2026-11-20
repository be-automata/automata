import { AdminOrganizationsCells } from "@/components/admin/organizations-cells";
import { getAdminUserOrThrow } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { listOrganizationsForAdmin } from "@terragon/shared/model/organizations";

export default async function OrganizationsAdminPage() {
  await getAdminUserOrThrow();
  const organizations = await listOrganizationsForAdmin({ db });
  return <AdminOrganizationsCells organizations={organizations} />;
}
