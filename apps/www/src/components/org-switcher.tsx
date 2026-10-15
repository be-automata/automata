"use client";

import { Building2, Check, ChevronsUpDown, Link2 } from "lucide-react";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { buildOrgLink } from "@/lib/org-link";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  useActiveOrganization,
  useMyOrganizations,
  useSwitchActiveOrganization,
} from "@/queries/organization-queries";
import { OrgAvatar, OrgName } from "./org-avatar";

/** Past this many orgs the list gets a filter box. */
const SEARCH_THRESHOLD = 5;

/**
 * The org the user is acting in, always visible at the top of the sidebar,
 * and the one place to change it.
 */
export function OrgSwitcher() {
  const { data, isLoading } = useMyOrganizations();
  const { activeOrganization: active } = useActiveOrganization();
  const switchOrganization = useSwitchActiveOrganization();
  const { isMobile, setOpenMobile } = useSidebar();
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  const organizations = data?.organizations ?? [];
  if (!isLoading && organizations.length === 0) {
    // No membership at all: nothing to switch, and nothing org-scoped works.
    return null;
  }
  const activeSlug = active?.slug ?? null;

  const copyOrgLink = async (slug: string) => {
    setOpen(false);
    try {
      const url = buildOrgLink({
        origin: window.location.origin,
        slug,
        pathname: pathname ?? "/",
      });
      await navigator.clipboard.writeText(url);
      toast.success("Link to this organization copied");
    } catch (err) {
      console.error("Failed to copy organization link", err);
      toast.error("Failed to copy link");
    }
  };

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <SidebarMenuButton
              size="lg"
              tooltip={active ? `Organization: ${active.name}` : "Organization"}
              aria-label={
                active
                  ? `Acting in ${active.name}. Switch organization`
                  : "No organization selected. Choose an organization"
              }
              className="border border-sidebar-border data-[state=open]:bg-sidebar-accent"
              disabled={isLoading || switchOrganization.isPending}
            >
              {active ? (
                <OrgAvatar organization={active} />
              ) : (
                <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm border border-dashed border-muted-foreground/50">
                  <Building2 className="size-3.5 text-muted-foreground" />
                </span>
              )}
              <span className="flex min-w-0 flex-col text-left leading-tight group-data-[collapsible=icon]:hidden">
                <span className="text-[11px] text-muted-foreground">
                  {active?.isPersonal ? "Personal" : "Organization"}
                </span>
                <span className="truncate text-sm font-medium">
                  {isLoading
                    ? "Loading…"
                    : (active?.name ?? "Choose an organization")}
                </span>
              </span>
              <ChevronsUpDown className="ml-auto size-4 text-muted-foreground group-data-[collapsible=icon]:hidden" />
            </SidebarMenuButton>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-0">
            <Command>
              {organizations.length > SEARCH_THRESHOLD && (
                <CommandInput placeholder="Find an organization…" />
              )}
              <CommandList>
                <CommandEmpty>No organization matches.</CommandEmpty>
                <CommandGroup heading="Switch organization">
                  {organizations.map((org) => {
                    const isActive = org.id === active?.id;
                    return (
                      <CommandItem
                        key={org.id}
                        value={`${org.name} ${org.slug ?? ""} ${org.id}`}
                        onSelect={() => {
                          setOpen(false);
                          if (isMobile) {
                            setOpenMobile(false);
                          }
                          if (!isActive) {
                            switchOrganization.mutate({
                              organizationId: org.id,
                              organizationName: org.name,
                            });
                          }
                        }}
                        className="gap-2"
                      >
                        <OrgName
                          organization={org}
                          size="sm"
                          nameClassName="flex-1"
                        />
                        {org.isPersonal && (
                          <span className="text-[11px] text-muted-foreground">
                            Personal
                          </span>
                        )}
                        {isActive && (
                          <Check
                            className="size-4 text-primary"
                            aria-label="Current organization"
                          />
                        )}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
                {activeSlug && (
                  <>
                    <CommandSeparator />
                    <CommandGroup>
                      <CommandItem
                        value="copy link to this organization"
                        onSelect={() => {
                          void copyOrgLink(activeSlug);
                        }}
                        className="gap-2"
                      >
                        <Link2 className="size-4 text-muted-foreground" />
                        <span>Copy link to this org</span>
                      </CommandItem>
                    </CommandGroup>
                  </>
                )}
              </CommandList>
            </Command>
            <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
              Settings, environments, installs and new tasks apply to the
              selected organization.
            </p>
          </PopoverContent>
        </Popover>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
