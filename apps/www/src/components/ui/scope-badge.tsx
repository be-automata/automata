import React from "react";

import { cn } from "@/lib/utils";

export type ConfigScope = "account" | "org" | "repo";

/**
 * Which layer a value or setting belongs to. Each scope has its own ink AND
 * its own line (account solid, org double, repo dashed), so the badge reads
 * without color (DESIGN.md "ScopeBadge").
 */
const SCOPE_CLASS: Record<ConfigScope, string> = {
  account: "border border-scope-account text-scope-account px-1.5",
  org: "border-[3px] border-double border-scope-org text-scope-org px-[5px]",
  repo: "border border-dashed border-scope-repo text-scope-repo px-1.5",
};

export const SCOPE_LABEL: Record<ConfigScope, string> = {
  account: "account",
  org: "org",
  repo: "repo",
};

export function ScopeBadge({
  scope,
  children,
  className,
}: {
  scope: ConfigScope;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-sm text-[11px] leading-[14px]",
        SCOPE_CLASS[scope],
        className,
      )}
    >
      {children ?? SCOPE_LABEL[scope]}
    </span>
  );
}
