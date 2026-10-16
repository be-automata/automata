"use client";

import { useRealtimeUser } from "@/hooks/useRealtime";
import Link from "next/link";
import { Environment } from "@terragon/shared";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import {
  EnvironmentVariablesEditor,
  type InheritedEnvironmentKey,
} from "@/components/environments/environment-variables-editor";
import { McpConfigEditor } from "@/components/environments/mcp-config-editor";
import { EffectiveConfiguration } from "@/components/environments/effective-configuration";
import type { EffectiveEnvironmentEntry } from "@/server-lib/env-audience";
import { updateEnvironmentVariables } from "@/server-actions/environment-variables";
import { updateOrganizationEnvironmentVariables } from "@/server-actions/organization-environment-variables";
import { updateMcpConfig } from "@/server-actions/mcp-config";
import { toast } from "sonner";
import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import { McpConfig } from "@terragon/sandbox/mcp-config";
import { Button } from "@/components/ui/button";
import { ChevronRight, FileCog } from "lucide-react";
import { ScopeBadge, type ConfigScope } from "@/components/ui/scope-badge";
import { OrgName } from "@/components/org-avatar";
import { RunsInCue } from "@/components/promptbox/runs-in-cue";
import { useActiveOrganization } from "@/queries/organization-queries";
import { CreateEnvironmentButton } from "@/components/environments/create-environment-button";
import { DeleteEnvironmentButton } from "@/components/environments/delete-environment-button";
import { useUnsavedChangesWarning } from "@/hooks/useUnsavedChangesWarning";
import { publicDocsUrl } from "@terragon/env/next-public";
import { usePageHeader } from "@/contexts/page-header";
import { Portal } from "@radix-ui/react-portal";
import { useServerActionMutation } from "@/queries/server-action-helpers";

/** One layer of the resolution ladder, in its scope ink and line. */
function LayerRow({
  href,
  scope,
  title,
  description,
}: {
  href: string;
  scope: ConfigScope;
  title: string;
  description: string;
}) {
  return (
    <li className="border-b border-line-soft">
      <Link
        href={href}
        className="flex items-center gap-2.5 py-3 hover:bg-accent/60"
      >
        <ScopeBadge scope={scope} />
        <span className="min-w-0 flex-1">
          <span className="block font-bold">{title}</span>
          <span className="block font-sans text-[13px] text-muted-foreground">
            {description}
          </span>
        </span>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}

function EnvironmentBreadcrumb({ label }: { label: string | null }) {
  usePageBreadcrumbs([
    { label: "Environments", href: "/environments" },
    ...(label ? [{ label }] : []),
  ]);
  return null;
}

export function Environments({
  environments,
  organizationName,
}: {
  environments: Environment[];
  /** The active org's name; null when no org is active. */
  organizationName: string | null;
}) {
  const router = useRouter();
  const { headerActionContainer } = usePageHeader();
  usePageBreadcrumbs([{ label: "Environments" }]);
  const { activeOrganization } = useActiveOrganization();
  useRealtimeUser({
    matches: (message) => !!message.data.environmentId,
    onMessage: () => router.refresh(),
  });

  return (
    <>
      <Portal container={headerActionContainer}>
        <CreateEnvironmentButton />
      </Portal>
      <div className="flex h-full w-full max-w-4xl flex-col justify-start gap-6">
        <div>
          <div className="flex items-baseline gap-2.5">
            <h1 className="text-xl font-bold leading-6">Environments</h1>
            {activeOrganization && organizationName !== null ? (
              <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                in <OrgName organization={activeOrganization} size="xs" />
              </span>
            ) : null}
          </div>
          <p className="mt-2 font-sans text-[13px] text-muted-foreground">
            A task reads Global, then Organization, then Repository; the later
            layer wins.{" "}
            <Link
              href={`${publicDocsUrl()}/docs/configuration/environment-setup/sandbox`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              About sandboxes
            </Link>
          </p>
        </div>
        <ol className="border-t border-border">
          <LayerRow
            href="/environments/global"
            scope="account"
            title="Global · you"
            description="Your own tasks in every organization. Organization automations such as the post-merge audit do not read it."
          />
          {organizationName !== null ? (
            <LayerRow
              href="/environments/organization"
              scope="org"
              title={`Organization · ${organizationName}`}
              description="Shared by every repository and member of this organization. Owners and admins edit it."
            />
          ) : null}
          <li className="border-b border-line-soft py-3">
            <div className="flex items-center gap-2.5">
              <ScopeBadge scope="repo" />
              <span className="font-bold">Repositories</span>
              <span className="text-xs text-muted-foreground">
                {environments?.length ?? 0}
              </span>
            </div>
            {environments?.length === 0 ? (
              <p className="ml-[52px] mt-1 font-sans text-[13px] text-muted-foreground">
                No repository environments yet. Use Create Environment to add
                one.
              </p>
            ) : (
              <ul className="ml-[52px] mt-1">
                {environments?.map((environment) => (
                  <li key={environment.id}>
                    <Link
                      href={`/environments/${environment.id}`}
                      className="flex h-8 items-center justify-between gap-3 border-b border-line-soft text-xs last:border-b-0 hover:bg-accent/60"
                    >
                      <span className="min-w-0 truncate">
                        {environment.repoFullName}
                      </span>
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </li>
        </ol>
      </div>
    </>
  );
}

type EnvironmentVariablesTarget =
  | { scope: "repository" | "global"; environmentId: string }
  | { scope: "organization" };

function EnvironmentVariablesSection({
  target,
  environmentVariables,
  inheritedKeys,
  onDirtyChange,
}: {
  target: EnvironmentVariablesTarget;
  environmentVariables: Array<{ key: string; value: string }>;
  inheritedKeys: InheritedEnvironmentKey[];
  onDirtyChange: (isDirty: boolean) => void;
}) {
  const router = useRouter();
  const [envVars, setEnvVars] = useState(environmentVariables);
  const onSaved = (variables: Array<{ key: string; value: string }>) => {
    setEnvVars(variables);
    onDirtyChange(false); // Reset dirty state after successful save
    toast.success("Environment variables saved successfully");
    router.refresh();
  };
  const updateEnvironmentVariablesMutation = useServerActionMutation({
    mutationFn: updateEnvironmentVariables,
    onSuccess: (_, { variables }) => onSaved(variables),
  });
  const updateOrganizationVariablesMutation = useServerActionMutation({
    mutationFn: updateOrganizationEnvironmentVariables,
    onSuccess: (_, { variables }) => onSaved(variables),
  });
  return (
    <div className="flex flex-col gap-2 mt-6">
      <h2 className="text-base font-medium text-muted-foreground">
        Environment Variables
      </h2>
      <div className="flex flex-col gap-2">
        <span className="text-xs text-muted-foreground">
          Configure environment variables that will be available in your sandbox
          environments. All environment variables are encrypted at rest and in
          transit for optimal security.{" "}
          <Link
            href={`${publicDocsUrl()}/docs/configuration/environment-setup/environment-variables`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:no-underline"
          >
            Learn more about environment variables
          </Link>
          .
        </span>
        <EnvironmentVariablesEditor
          variables={envVars}
          inheritedKeys={inheritedKeys}
          scope={target.scope}
          onChange={async (variables) => {
            if (target.scope === "organization") {
              await updateOrganizationVariablesMutation.mutateAsync({
                variables,
              });
              return;
            }
            await updateEnvironmentVariablesMutation.mutateAsync({
              environmentId: target.environmentId,
              variables,
            });
          }}
          onDirtyChange={onDirtyChange}
          disabled={
            updateEnvironmentVariablesMutation.isPending ||
            updateOrganizationVariablesMutation.isPending
          }
        />
      </div>
    </div>
  );
}

export function EnvironmentUI({
  environmentId,
  environment,
  environmentVariables,
  effectiveEnvironment,
  inheritedKeys,
  mcpConfig,
}: {
  environmentId: string;
  environment: Pick<Environment, "repoFullName">;
  environmentVariables: Array<{ key: string; value: string }>;
  effectiveEnvironment: EffectiveEnvironmentEntry[];
  inheritedKeys: InheritedEnvironmentKey[];
  mcpConfig?: McpConfig;
}) {
  const router = useRouter();
  const [mcpConfigState, setMcpConfigState] = useState(
    mcpConfig || { mcpServers: {} },
  );
  const [envVarsDirty, setEnvVarsDirty] = useState(false);
  const [mcpConfigDirty, setMcpConfigDirty] = useState(false);
  const { headerActionContainer } = usePageHeader();

  const hasUnsavedChanges = envVarsDirty || mcpConfigDirty;

  // Use custom hook for navigation warnings
  useUnsavedChangesWarning(hasUnsavedChanges);

  useRealtimeUser({
    matches: useCallback(
      (args) => {
        return (
          args.type === "user" && args.data.environmentId === environmentId
        );
      },
      [environmentId],
    ),
    onMessage: useCallback(() => {
      router.refresh();
    }, [router]),
  });

  const updateMcpConfigMutation = useServerActionMutation({
    mutationFn: updateMcpConfig,
    onSuccess: (_, { mcpConfig }) => {
      setMcpConfigState(mcpConfig);
      setMcpConfigDirty(false); // Reset dirty state after successful save
      toast.success("MCP configuration saved successfully");
      router.refresh();
    },
  });

  if (!environment) {
    return null;
  }
  return (
    <div className="flex flex-col justify-start h-full w-full max-w-4xl">
      <Portal container={headerActionContainer}>
        <DeleteEnvironmentButton
          environmentId={environmentId}
          repoFullName={environment.repoFullName}
        />
      </Portal>
      <EnvironmentBreadcrumb label={environment.repoFullName} />
      <div className="flex flex-col gap-4 w-full pb-4">
        <div className="flex flex-col gap-1">
          <h1 className="min-w-0 truncate text-xl font-bold leading-6">
            {environment.repoFullName}
          </h1>
          <RunsInCue repoFullName={environment.repoFullName} />
        </div>
        <EffectiveConfiguration entries={effectiveEnvironment} />
        <EnvironmentVariablesSection
          target={{ scope: "repository", environmentId }}
          environmentVariables={environmentVariables}
          inheritedKeys={inheritedKeys}
          onDirtyChange={setEnvVarsDirty}
        />
        <div className="flex flex-col gap-2 mt-10">
          <h2 className="text-base font-medium text-muted-foreground">
            MCP Server Configuration
          </h2>
          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground">
              Configure custom Model Context Protocol ("MCP") servers that will
              be available to Terragon. Learn more about which formats are
              supported with each agent{" "}
              <Link
                href={`${publicDocsUrl()}/docs/configuration/mcp-setup`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:no-underline"
              >
                in our documentation
              </Link>
              .
            </span>
            <McpConfigEditor
              value={mcpConfigState}
              onChange={async (config) => {
                await updateMcpConfigMutation.mutateAsync({
                  environmentId,
                  mcpConfig: config,
                });
              }}
              onDirtyChange={setMcpConfigDirty}
              disabled={updateMcpConfigMutation.isPending}
            />
          </div>
        </div>

        <div className="flex flex-col gap-2 mt-10 mb-8">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-medium text-muted-foreground">
              Environment Setup
            </h2>
            <Link href={`/environments/${environmentId}/setup`}>
              <Button variant="outline" size="sm" className="text-xs">
                <FileCog className="h-4 w-4 mr-1" />
                Edit Setup Script
              </Button>
            </Link>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground">
              Configure custom setup commands that run when your environment
              starts. You can either configure an environment-specific script in
              the settings or add a{" "}
              <code className="bg-muted px-1 py-0.5 rounded text-xs">
                terragon-setup.sh
              </code>{" "}
              file to your repository. Environment scripts take precedence over
              repository scripts.{" "}
              <Link
                href={`${publicDocsUrl()}/docs/configuration/environment-setup/setup-scripts`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:no-underline"
              >
                Learn more about setup scripts
              </Link>
              .
            </span>
          </div>
          <div className="bg-muted/50 p-3 rounded-md">
            <p className="text-xs text-muted-foreground mb-2">Example:</p>
            <code className="text-xs text-foreground block">
              #!/bin/bash
              <br />
              npm install
              <br />
              pip install -r requirements.txt
              <br />
              ./my-custom-setup.sh
            </code>
          </div>
        </div>
      </div>
    </div>
  );
}

export function GlobalEnvironmentUI({
  environmentId,
  environmentVariables,
}: {
  environmentId: string;
  environmentVariables: Array<{ key: string; value: string }>;
}) {
  const [envVarsDirty, setEnvVarsDirty] = useState(false);
  const hasUnsavedChanges = envVarsDirty;
  useUnsavedChangesWarning(hasUnsavedChanges);

  return (
    <div className="flex flex-col justify-start h-full w-full max-w-4xl">
      <EnvironmentBreadcrumb label="Global (personal)" />
      <p>
        Your personal global environment applies to your own tasks in every
        organization. Organization automations such as the post-merge audit do
        not read it: set shared settings on the organization environment.
      </p>
      <EnvironmentVariablesSection
        target={{ scope: "global", environmentId }}
        environmentVariables={environmentVariables}
        inheritedKeys={[]}
        onDirtyChange={setEnvVarsDirty}
      />
    </div>
  );
}

export interface OrganizationEnvironmentEventView {
  id: string;
  actorName: string | null;
  addedKeys: string[];
  removedKeys: string[];
  changedKeys: string[];
  createdAt: Date;
}

function describeEvent(event: OrganizationEnvironmentEventView): string {
  const parts = [
    event.addedKeys.length ? `added ${event.addedKeys.join(", ")}` : null,
    event.changedKeys.length ? `changed ${event.changedKeys.join(", ")}` : null,
    event.removedKeys.length ? `removed ${event.removedKeys.join(", ")}` : null,
  ].filter(Boolean);
  return parts.join("; ");
}

/**
 * Org owners/admins get the editor and the change history; members get the
 * key names only — the page never sends them a value.
 */
export function OrganizationEnvironmentUI(
  props: { organizationName: string } & (
    | {
        canEdit: true;
        environmentVariables: Array<{ key: string; value: string }>;
        events: OrganizationEnvironmentEventView[];
      }
    | { canEdit: false; keys: string[] }
  ),
) {
  const [envVarsDirty, setEnvVarsDirty] = useState(false);
  useUnsavedChangesWarning(envVarsDirty);

  return (
    <div className="flex flex-col justify-start h-full w-full max-w-4xl">
      <EnvironmentBreadcrumb
        label={`Organization (${props.organizationName})`}
      />
      <p>
        Shared by every repository and member of {props.organizationName}.
        Applied between your personal global variables and a repository&apos;s
        own (a repository variable with the same key wins). Org automations,
        such as the post-merge audit, read tracker settings from here.
      </p>
      <p className="text-sm text-muted-foreground mt-2">
        Values are delivered to agent sandboxes of every member&apos;s tasks in
        this organization, except control-plane keys such as{" "}
        <code className="bg-muted px-1 py-0.5 rounded text-xs">
          YOUTRACK_TOKEN
        </code>
        , which never reach an agent.
      </p>
      {props.canEdit ? (
        <>
          <EnvironmentVariablesSection
            target={{ scope: "organization" }}
            environmentVariables={props.environmentVariables}
            inheritedKeys={[]}
            onDirtyChange={setEnvVarsDirty}
          />
          <div className="flex flex-col gap-2 mt-10 mb-8">
            <h2 className="text-base font-medium text-muted-foreground">
              Recent changes
            </h2>
            {props.events.length === 0 ? (
              <p className="text-xs text-muted-foreground">No changes yet.</p>
            ) : (
              <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                {props.events.map((event) => (
                  <li key={event.id}>
                    {new Date(event.createdAt).toLocaleString()} ·{" "}
                    {event.actorName ?? "Unknown user"} · {describeEvent(event)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-2 mt-6">
          <h2 className="text-base font-medium text-muted-foreground">
            Environment Variables
          </h2>
          <p className="text-xs text-muted-foreground">
            Only organization owners and admins can view values or edit these
            variables.
          </p>
          {props.keys.length === 0 ? (
            <p className="text-xs text-muted-foreground">No variables set.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {props.keys.map((key) => (
                <li
                  key={key}
                  className="font-mono text-sm p-2 rounded-md border"
                >
                  {key}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
