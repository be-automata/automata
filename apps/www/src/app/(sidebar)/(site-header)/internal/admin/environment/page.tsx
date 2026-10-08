import { db } from "@/lib/db";
import { getAdminUserOrThrow } from "@/lib/auth-server";
import { getThreadForAdmin } from "@/server-actions/admin/thread";
import { getEnvironmentForAdmin } from "@/server-actions/admin/environment";
import { AdminEnvironmentIdOrThreadIdInput } from "@/components/admin/environment-content";
import { TrackerConfigCheck } from "@/components/admin/tracker-config-check";
import { getEnvironmentForUserRepo } from "@terragon/shared/model/environments";
import { redirect } from "next/navigation";

export default async function AdminEnvironmentListPage({
  searchParams,
}: {
  searchParams: Promise<{ id: string }>;
}) {
  await getAdminUserOrThrow();
  const { id } = await searchParams;
  if (id) {
    const thread = await getThreadForAdmin(id);
    if (thread) {
      const environment = await getEnvironmentForUserRepo({
        db,
        userId: thread.userId,
        repoFullName: thread.githubRepoFullName,
      });
      redirect(`/internal/admin/environment/${environment!.id}`);
    }
    // Maybe it is an environmentId
    const environment = await getEnvironmentForAdmin(id);
    if (environment) {
      redirect(`/internal/admin/environment/${environment.id}`);
    }
  }
  return (
    <div className="space-y-6">
      <p className="text-muted-foreground">
        Enter an environment ID or thread ID to view its details
      </p>
      <AdminEnvironmentIdOrThreadIdInput />
      <TrackerConfigCheck />
    </div>
  );
}
