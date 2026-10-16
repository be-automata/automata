"use client";

import { Loader2, AlertCircle } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";

import {
  automationQueryOptions,
  automationLimitQueryOptions,
  automationHealthQueryOptions,
  automationQueryKeys,
} from "@/queries/automation-queries";
import { PageTitle } from "@/components/page-title";
import { AutomationsRegister } from "./register";
import { Automation } from "@terragon/shared";
import { useMemo, useState } from "react";
import {
  CreateAutomationButton,
  CreateAutomationInitialValues,
} from "./create-button";
import { useRealtimeUser } from "@/hooks/useRealtime";
import { EditAutomationDialog } from "./edit-dialog";
import { usePageHeader } from "@/contexts/page-header";
import { Portal } from "@radix-ui/react-portal";
import { RecommendedAutomations } from "./recommended-automations";
import { type RecommendedAutomation } from "./recommended-automation-templates";
import { AutomationTrigger } from "@terragon/shared/automations";
import { useAtomValue } from "jotai";
import {
  selectedModelAtom,
  selectedRepoAtom,
  selectedBranchAtom,
} from "@/atoms/user-flags";
import { publicDocsUrl } from "@terragon/env/next-public";
import { automationLimitMessage } from "@/lib/automation-limit";

export function Automations() {
  const { headerActionContainer } = usePageHeader();
  const [isOpen, setIsOpen] = useState(false);
  const [initialValues, setInitialValues] =
    useState<CreateAutomationInitialValues | null>(null);
  const selectedModel = useAtomValue(selectedModelAtom);
  const selectedRepo = useAtomValue(selectedRepoAtom);
  const selectedBranch = useAtomValue(selectedBranchAtom);
  return (
    <>
      <Portal container={headerActionContainer}>
        <CreateAutomationButton
          isOpen={isOpen}
          setIsOpen={setIsOpen}
          initialValues={initialValues}
          setInitialValues={setInitialValues}
        />
      </Portal>
      <AutomationsList
        onRecommendedAutomationSelected={(recommendedAutomation) => {
          const initialValues: CreateAutomationInitialValues = {
            name: recommendedAutomation.label,
            repoFullName: selectedRepo || "",
            branchName: selectedBranch || "",
            trigger: {
              type: recommendedAutomation.triggerType,
              config: recommendedAutomation.triggerConfig,
            } as AutomationTrigger,
            action: {
              type: "user_message",
              config: {
                message: {
                  type: "user",
                  model: selectedModel,
                  parts: [{ type: "text", text: recommendedAutomation.prompt }],
                },
              },
            },
          };
          setInitialValues(initialValues);
          setIsOpen(true);
        }}
        onDuplicate={(automation) => {
          const initialValues: CreateAutomationInitialValues = {
            name: `${automation.name} (Copy)`,
            repoFullName: automation.repoFullName,
            branchName: automation.branchName,
            disableGitCheckpointing: automation.disableGitCheckpointing,
            skipSetup: automation.skipSetup,
            trigger: {
              type: automation.triggerType,
              config: automation.triggerConfig,
            } as AutomationTrigger,
            action: automation.action,
          };
          setInitialValues(initialValues);
          setIsOpen(true);
        }}
      />
    </>
  );
}

function AutomationsList({
  onRecommendedAutomationSelected,
  onDuplicate,
}: {
  onRecommendedAutomationSelected: (
    recommendedAutomation: RecommendedAutomation,
  ) => void;
  onDuplicate: (automation: Automation) => void;
}) {
  const {
    data: automations,
    isLoading,
    error,
    refetch,
  } = useQuery(automationQueryOptions());
  const { data: automationLimit, refetch: refetchAutomationLimit } = useQuery(
    automationLimitQueryOptions(),
  );
  const queryClient = useQueryClient();
  useRealtimeUser({
    matches: (message) => !!message.data.automationId,
    onMessage: () => {
      refetch();
      refetchAutomationLimit();
      queryClient.invalidateQueries({ queryKey: automationQueryKeys.health() });
    },
  });
  const [automationToEdit, setAutomationToEdit] = useState<Automation | null>(
    null,
  );
  const { data: health } = useQuery(automationHealthQueryOptions());
  const healthById = useMemo(
    () => new Map((health ?? []).map((h) => [h.automationId, h])),
    [health],
  );
  if (isLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <p className="text-sm text-muted-foreground">
          Error loading automations. Please try again.
        </p>
      </div>
    );
  }
  return (
    <>
      <div className="mb-4">
        <PageTitle title="Automations" />
      </div>
      {automationLimit?.reached && (
        <p className="mb-4 flex items-start gap-2 border-y border-border py-2 font-sans text-[13px]">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-state-waiting" />
          {automationLimitMessage(automationLimit)}
        </p>
      )}
      {automations?.length === 0 && (
        <div className="flex flex-col gap-4">
          <div className="p-4 bg-muted/50 rounded-lg border">
            <h3 className="text-sm font-medium text-muted-foreground mb-2">
              About Automations
            </h3>
            <p className="text-sm text-muted-foreground">
              Automations are saved prompts that run automatically in response
              to a trigger. You can create automations that run on a schedule or
              in response to events like GitHub pull requests.
              <br />
              <br />
              <Link
                href={`${publicDocsUrl()}/docs/automations`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:no-underline"
              >
                Learn more about automations
              </Link>
            </p>
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-muted-foreground/70 sticky top-[36px] bg-background z-9 py-1">
              Suggested automations
            </h3>
            <RecommendedAutomations
              onSelect={onRecommendedAutomationSelected}
            />
          </div>
        </div>
      )}
      {automations && automations.length > 0 ? (
        <AutomationsRegister
          automations={automations}
          healthById={healthById}
          onEdit={setAutomationToEdit}
          onDuplicate={onDuplicate}
        />
      ) : null}
      <EditAutomationDialog
        automation={automationToEdit}
        onClose={() => setAutomationToEdit(null)}
      />
    </>
  );
}
