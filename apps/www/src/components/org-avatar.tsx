import React from "react";

import { orgHue, orgInitials } from "@/lib/org-identity";
import { cn } from "@/lib/utils";

/**
 * An org's square avatar: its logo, or its initials on the org's stable hue.
 * Square on purpose — people are round (user avatars), orgs are not.
 */
export function OrgAvatar({
  organization,
  className,
}: {
  organization: { id: string; name: string; logo?: string | null };
  className?: string;
}) {
  const hue = orgHue(organization.id);
  if (organization.logo) {
    return (
      <img
        src={organization.logo}
        alt=""
        className={cn("size-6 shrink-0 rounded-sm object-cover", className)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={
        {
          "--org-bg": hue.bg,
          "--org-fg": hue.fg,
          "--org-dark-bg": hue.darkBg,
          "--org-dark-fg": hue.darkFg,
        } as React.CSSProperties
      }
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-[10px] font-semibold leading-none",
        "bg-(--org-bg) text-(--org-fg) dark:bg-(--org-dark-bg) dark:text-(--org-dark-fg)",
        className,
      )}
    >
      {orgInitials(organization.name)}
    </span>
  );
}

const ORG_NAME_AVATAR_SIZES = {
  /** Inline with 12px text (settings rows, the promptbox cue). */
  xs: "size-4 text-[8px]",
  /** Inline with 14px text (receipts, the switcher list). */
  sm: "size-5",
} as const;

/**
 * An org's avatar followed by its truncated name. A fragment, so the parent's
 * flex row sets the gap and alignment.
 */
export function OrgName({
  organization,
  size,
  nameClassName,
}: {
  organization: { id: string; name: string; logo?: string | null };
  size: keyof typeof ORG_NAME_AVATAR_SIZES;
  nameClassName?: string;
}) {
  return (
    <>
      <OrgAvatar
        organization={organization}
        className={ORG_NAME_AVATAR_SIZES[size]}
      />
      <span className={cn("min-w-0 truncate", nameClassName)}>
        {organization.name}
      </span>
    </>
  );
}
