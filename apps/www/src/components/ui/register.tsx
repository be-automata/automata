import React from "react";

import { Button } from "@/components/ui/button";
import { RunStateGlyph } from "@/components/ui/run-state";
import { OrgName } from "@/components/org-avatar";

/** A register section's header: title, muted meta, optional right-side controls. */
export function SectionHeader({
  title,
  meta,
  children,
  level = 2,
}: {
  title: string;
  meta?: React.ReactNode;
  children?: React.ReactNode;
  level?: 2 | 3;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-2 border-b border-border pb-1.5">
      <Heading className="text-[15px] leading-5 font-bold">{title}</Heading>
      {meta !== undefined && meta !== null ? (
        <span className="text-xs text-muted-foreground">{meta}</span>
      ) : null}
      {children ? (
        <div className="ml-auto flex items-center gap-2">{children}</div>
      ) : null}
    </div>
  );
}

/** The page title, named for the org it is scoped to ("Usage in <org>"). */
export function PageTitleView({
  title,
  organization,
  children,
}: {
  title: string;
  organization: { id: string; name: string; logo?: string | null } | null;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-2">
      <h1 className="min-w-0 truncate text-xl font-bold leading-6">{title}</h1>
      {organization ? (
        <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          in <OrgName organization={organization} size="xs" />
        </span>
      ) : null}
      {children ? (
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** A load failure with its retry, in the needs-you ink. */
export function LoadError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex items-center gap-3 border-y border-border py-3 text-xs">
      <RunStateGlyph kind="needs-you" />
      <span className="font-sans text-[13px]">{message}</span>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/** "62%", or an em dash when there is nothing to divide by. */
export function formatPercent(part: number, whole: number): string {
  return whole === 0 ? "—" : `${Math.round((part / whole) * 100)}%`;
}
