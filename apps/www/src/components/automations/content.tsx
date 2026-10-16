"use client";

import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import { useQuery } from "@tanstack/react-query";
import { BreadcrumbItem } from "@/contexts/page-header";
import {
  automationDetailQueryOptions,
  automationHealthQueryOptions,
} from "@/queries/automation-queries";
import { AutomationHealthPanel } from "./health";
import { Loader2 } from "lucide-react";
import { AutomationItem } from "./item";
import { useState } from "react";
import { EditAutomationDialog } from "./edit-dialog";
import { useRealtimeUser } from "@/hooks/useRealtime";
import { ThreadListMain } from "../thread-list/main";

export function AutomationContent({ automationId }: { automationId: string }) {
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const {
    data: automation,
    isLoading,
    error,
    refetch,
  } = useQuery(automationDetailQueryOptions(automationId));
  const { data: health } = useQuery(automationHealthQueryOptions());
  usePageBreadcrumbs(
    [
      { label: "Automations", href: "/automations" },
      automation && {
        label: automation.name,
        href: `/automations/${automation.id}`,
      },
    ].filter(Boolean) as BreadcrumbItem[],
  );
  useRealtimeUser({
    matches: (message) => message.data.automationId === automationId,
    onMessage: () => {
      refetch();
    },
  });
  if (isLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }
  if (error || !automation) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <p className="text-sm text-muted-foreground">
          Error loading automation. Please try again.
        </p>
      </div>
    );
  }
  return (
    <>
      <div className="flex flex-col gap-4">
        <AutomationItem
          automation={automation}
          onEdit={() => setIsEditDialogOpen(true)}
        />
        <AutomationHealthPanel
          health={health?.find((h) => h.automationId === automationId)}
        />
        <h3 className="text-[15px] font-bold leading-5">All runs</h3>
        <ThreadListMain
          viewFilter="all"
          allowGroupBy={false}
          queryFilters={{ automationId }}
          showSuggestedTasks={false}
          setPromptText={() => {}}
        />
      </div>
      <EditAutomationDialog
        automation={isEditDialogOpen ? automation : null}
        onClose={() => setIsEditDialogOpen(false)}
      />
    </>
  );
}
