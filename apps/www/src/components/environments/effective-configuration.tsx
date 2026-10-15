import React from "react";

import type {
  EffectiveEnvironmentEntry,
  EnvSource,
} from "@/server-lib/env-audience";
import { cn } from "@/lib/utils";

/**
 * Scope inks (DESIGN.md): the ink colors the text, the tint fills the badge.
 * Dark pairs reuse the org-hue dark values, so they read on #1a1a1a.
 */
const SCOPE_BADGES: Record<EnvSource, { label: string; className: string }> = {
  global: {
    label: "Global",
    className:
      "bg-[#e4e9ee] text-[#56687a] dark:bg-[#a3b4c4]/15 dark:text-[#a3b4c4]",
  },
  organization: {
    label: "Organization",
    className:
      "bg-[#f2e2c2] text-[#9a6410] dark:bg-[#e2aa4e]/15 dark:text-[#e2aa4e]",
  },
  repository: {
    label: "Repo",
    className:
      "bg-[#c8e6c9] text-[#2e7d32] dark:bg-[#4caf50]/15 dark:text-[#4caf50]",
  },
};

function ScopeBadge({
  source,
  struck = false,
}: {
  source: EnvSource;
  struck?: boolean;
}) {
  const badge = SCOPE_BADGES[source];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm px-1.5 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap",
        badge.className,
        struck && "line-through opacity-60",
      )}
    >
      {badge.label}
    </span>
  );
}

function SourceCell({ entry }: { entry: EffectiveEnvironmentEntry }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1">
        <ScopeBadge source={entry.winningSource} />
        {entry.shadowedSources.map((source) => (
          <ScopeBadge key={source} source={source} struck />
        ))}
      </div>
      {entry.shadowedSources.length > 0 && (
        <span className="text-xs text-muted-foreground">
          {entry.shadowedSources
            .map((source) => SCOPE_BADGES[source].label)
            .join(", ")}{" "}
          overridden by {SCOPE_BADGES[entry.winningSource].label}
        </span>
      )}
      {entry.audience === "agent" && entry.serverOnlySources.length > 0 && (
        <span className="text-xs text-muted-foreground">
          {entry.serverOnlySources
            .map((source) => SCOPE_BADGES[source].label)
            .join(", ")}{" "}
          value stays on the server
        </span>
      )}
    </div>
  );
}

/**
 * Read-only view of what the agent receives for this repository in the
 * active org: personal Global → Organization → Repo, a later layer winning.
 * Built from key names only — every value is a secret, so none is shown.
 */
export function EffectiveConfiguration({
  entries,
}: {
  entries: EffectiveEnvironmentEntry[];
}) {
  const agentCount = entries.filter(
    (entry) => entry.audience === "agent",
  ).length;
  return (
    <div className="flex flex-col gap-2 mt-6">
      <h2 className="text-base font-medium text-muted-foreground">
        Effective configuration
      </h2>
      <span className="text-xs text-muted-foreground">
        What the agent receives for this repository: personal Global, then
        Organization, then Repo; a later layer wins.{" "}
        {agentCount === 1
          ? "1 variable reaches the agent."
          : `${agentCount} variables reach the agent.`}
      </span>
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground p-3 rounded-md border">
          No variables yet. Add one below, or in your Global or Organization
          environment.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-[11px] text-muted-foreground">
                <th className="px-3 py-2 font-medium">Key</th>
                <th className="px-3 py-2 font-medium">Value</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Audience</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr
                  key={entry.key}
                  className={cn(
                    "border-b last:border-b-0 align-top",
                    entry.audience === "server" && "text-muted-foreground",
                  )}
                >
                  <td className="px-3 py-2 font-[var(--font-geist-mono)] break-all">
                    {entry.key}
                  </td>
                  <td
                    className="px-3 py-2 font-[var(--font-geist-mono)]"
                    aria-label="Hidden value"
                  >
                    ••••
                  </td>
                  <td className="px-3 py-2">
                    <SourceCell entry={entry} />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-xs">
                    {entry.audience === "agent" ? "Agent" : "Server only"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
