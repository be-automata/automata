"use client";

import { Loader2, AlertCircle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import {
  automationQueryOptions,
  automationLimitQueryOptions,
} from "@/queries/automation-queries";
import { Automation } from "@terragon/shared";
import { useState } from "react";
import {
  CreateAutomationButton,
  CreateAutomationInitialValues,
} from "./create-button";
import { useRealtimeUser } from "@/hooks/useRealtime";
import { AutomationItem } from "./item";
import { EditAutomationDialog } from "./edit-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
  useRealtimeUser({
    matches: (message) => !!message.data.automationId,
    onMessage: () => {
      refetch();
      refetchAutomationLimit();
    },
  });
  const [automationToEdit, setAutomationToEdit] = useState<Automation | null>(
    null,
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
      {automationLimit?.reached && (
        <Alert className="mb-4 bg-muted border-none">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {automationLimitMessage(automationLimit)}
          </AlertDescription>
        </Alert>
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
      <div className="flex flex-col gap-2">
        {automations?.map((automation) => (
          <AutomationItem
            key={automation.id}
            automation={automation}
            onEdit={() => setAutomationToEdit(automation)}
            onDuplicate={onDuplicate}
            verbose={false}
          />
        ))}
      </div>
      <EditAutomationDialog
        automation={automationToEdit}
        onClose={() => setAutomationToEdit(null)}
      />
    </>
  );
}
