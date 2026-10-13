"use client";

import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { CodeClickToCopy } from "@/components/ui/code";
import { SLACK_APP_ENV_KEYS, type SlackAppEnvKey } from "@/lib/slack-app-keys";
import type { SlackAppConfigStatus } from "@/server-lib/slack-config";

export interface SlackAppSetup {
  status: SlackAppConfigStatus;
  organizationName: string | null;
  canEditOrganization: boolean;
  /** Event Subscriptions + Interactivity request URL for this Slack app. */
  requestUrl: string;
  /** OAuth redirect URL to register on the Slack app. */
  redirectUrl: string;
}

const KEY_PURPOSE: Record<SlackAppEnvKey, string> = {
  SLACK_CLIENT_ID: "Starts the install and account-connect flows",
  SLACK_CLIENT_SECRET: "Exchanges Slack's OAuth code for tokens",
  SLACK_SIGNING_SECRET: "Verifies every request Slack sends",
};

function levelLabel(setup: SlackAppSetup): string {
  return setup.status.source === "organization"
    ? `Organization${setup.organizationName ? ` (${setup.organizationName})` : ""}`
    : "Platform";
}

function UrlRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <CodeClickToCopy
        text={value}
        className="text-xs font-normal break-all rounded bg-muted px-2 py-1 cursor-pointer"
      />
    </div>
  );
}

/**
 * Where this org's Slack app comes from, key by key. Shows key names and the
 * level that supplies them — never a value.
 */
export function SlackAppSetupCard({ setup }: { setup: SlackAppSetup }) {
  const { status } = setup;
  const level = levelLabel(setup);
  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold">Slack app</span>
          <Badge variant={status.ready ? "default" : "secondary"}>
            {status.ready ? `Configured · ${level}` : "Not configured"}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {status.source === "organization"
            ? "This organization uses its own Slack app, configured on the organization environment."
            : setup.organizationName
              ? "This organization has no Slack app of its own, so the platform app is used. Setting any SLACK_* variable on the organization environment switches it to the organization's own app."
              : "No active organization: the platform app is used."}
        </p>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="font-normal pb-1">Variable</th>
            <th className="font-normal pb-1">Set at</th>
          </tr>
        </thead>
        <tbody>
          {SLACK_APP_ENV_KEYS.map((key) => (
            <tr key={key} className="border-t">
              <td className="py-1.5 pr-2">
                <code className="text-xs">{key}</code>
                <p className="text-xs text-muted-foreground">
                  {KEY_PURPOSE[key]}
                </p>
              </td>
              <td className="py-1.5">
                {status.keys[key] ? (
                  <Badge variant="outline">{level}</Badge>
                ) : (
                  <Badge variant="destructive">Missing</Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {!status.ready &&
        (setup.canEditOrganization ? (
          <p className="text-sm">
            Create a Slack app, then set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET
            and SLACK_SIGNING_SECRET (Slack app → Basic Information) in{" "}
            <Link className="underline" href="/environments/organization">
              Environments → Organization
            </Link>
            . These values stay on the control plane and are never delivered to
            agents.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {setup.organizationName
              ? "Ask an owner or admin of this organization to set the SLACK_* variables on the organization environment."
              : "Switch to an organization to configure its own Slack app."}
          </p>
        ))}

      <div className="flex flex-col gap-2">
        <p className="text-sm">Register these URLs on the Slack app:</p>
        <UrlRow
          label="Event Subscriptions and Interactivity → Request URL"
          value={setup.requestUrl}
        />
        <UrlRow
          label="OAuth & Permissions → Redirect URL"
          value={setup.redirectUrl}
        />
        {status.source === "organization" && (
          <p className="text-xs text-muted-foreground">
            A workspace installed through the platform app stops answering as
            soon as this organization sets a SLACK_* variable. Reinstall it with
            this organization's app once all three are set.
          </p>
        )}
      </div>
    </div>
  );
}
