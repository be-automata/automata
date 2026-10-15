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
