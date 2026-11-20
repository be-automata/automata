"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { ColumnDef } from "@tanstack/react-table";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { Switch } from "@/components/ui/switch";
import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import { setOrganizationCellsEnabledAction } from "@/server-actions/admin/organization";
import type { AdminOrganizationRow } from "@terragon/shared/model/organizations";

function CellsToggle({ org }: { org: AdminOrganizationRow }) {
  const router = useRouter();
  // One transition covers the save and the refresh: the switch stays disabled
  // until the refreshed row arrives, so a second click never toggles from the
  // stale value.
  const [pending, startTransition] = useTransition();

  const onChange = (enabled: boolean) =>
    startTransition(async () => {
      try {
        const result = await setOrganizationCellsEnabledAction({
          organizationId: org.id,
          enabled,
        });
        if (!result.ok) {
          toast.error(`Failed to update ${org.name}: ${result.error}`);
          return;
        }
        toast.success(`Cells ${enabled ? "on" : "off"} for ${org.name}`);
        router.refresh();
      } catch (error) {
        console.error(error);
        toast.error(`Failed to update ${org.name}`);
      }
    });

  return (
    <Switch
      checked={org.cellsEnabled}
      disabled={pending}
      onCheckedChange={onChange}
      aria-label={`Cells for ${org.name}`}
    />
  );
}

const columns: ColumnDef<AdminOrganizationRow>[] = [
  {
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <span className="font-medium">{row.original.name}</span>
        {row.original.isPersonal && <Badge variant="secondary">personal</Badge>}
      </div>
    ),
  },
  {
    accessorKey: "slug",
    header: "Slug",
    cell: ({ row }) => (
      <span className="font-mono text-sm">{row.original.slug}</span>
    ),
  },
  {
    accessorKey: "cellsEnabled",
    header: "Cells",
    cell: ({ row }) => <CellsToggle org={row.original} />,
  },
];

/**
 * #708: the per-org OpenSandbox cells gate. A run uses a cell only when the
 * deployment is configured, the owner's `opensandboxCells` flag is on and the
 * run's org is on here. A switch applies on the next dispatch, no deploy.
 */
export function AdminOrganizationsCells({
  organizations,
}: {
  organizations: AdminOrganizationRow[];
}) {
  usePageBreadcrumbs([
    { label: "Admin", href: "/internal/admin" },
    { label: "Organizations" },
  ]);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Cells run for an org&apos;s runs only when OpenSandbox is configured,
        the run owner&apos;s <code>opensandboxCells</code> flag is on, and the
        org is switched on here. Switching an org off fails its runs already
        marked for a cell (no box fallback); new runs go to the box.
      </p>
      <DataTable columns={columns} data={organizations} />
    </div>
  );
}
