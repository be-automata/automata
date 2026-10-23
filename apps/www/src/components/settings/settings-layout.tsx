"use client";

import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { ScopeBadge } from "@/components/ui/scope-badge";
import {
  Settings,
  GitBranch,
  Blocks,
  Bot,
  Package,
  CreditCard,
  ShieldCheck,
  BookCheck,
} from "lucide-react";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { useRealtimeUser } from "@/hooks/useRealtime";
import { useActiveOrganization } from "@/queries/organization-queries";
import { OrgName } from "../org-avatar";

interface NavItem {
  href: string;
  label: string;
  icon?: React.ReactNode;
  /**
   * Whose setting this is. "account" pages are yours in every org;
   * "organization" pages change with the org picked in the sidebar.
   */
  scope: "account" | "organization";
}

export function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { activeOrganization } = useActiveOrganization();
  const daytonaOptionsForSandboxProviderEnabled = useFeatureFlag(
    "daytonaOptionsForSandboxProvider",
  );
  useRealtimeUser({
    matches: (message) => !!message.data.userSettings,
    onMessage: () => router.refresh(),
  });
  const navItems: NavItem[] = [
    {
      href: "/settings",
      scope: "account",
      label: "General",
      icon: <Settings className="w-4 h-4" />,
    },
    {
      href: "/settings/github",
      scope: "account",
      label: "GitHub & Pull Requests",
      icon: <GitBranch className="w-4 h-4" />,
    },
    {
      href: "/settings/agent",
      scope: "organization",
      label: "Agent",
      icon: <Bot className="w-4 h-4" />,
    },
    {
      href: "/settings/review",
      scope: "organization",
      label: "PR Review",
      icon: <ShieldCheck className="w-4 h-4" />,
    },
    {
      href: "/settings/knowledge",
      scope: "organization",
      label: "Knowledge",
      icon: <BookCheck className="w-4 h-4" />,
    },
    {
      href: "/settings/integrations",
      scope: "organization",
      label: "Integrations",
      icon: <Blocks className="w-4 h-4" />,
    },
    {
      href: "/settings/billing",
      scope: "account",
      label: "Billing",
      icon: <CreditCard className="w-4 h-4" />,
    },
  ];
  if (daytonaOptionsForSandboxProviderEnabled) {
    navItems.push({
      href: "/settings/sandbox",
      scope: "account",
      label: "Sandbox",
      icon: <Package className="w-4 h-4" />,
    });
  }

  const groups: { scope: NavItem["scope"]; heading: React.ReactNode }[] = [
    {
      scope: "account",
      heading: (
        <span className="flex items-center gap-1.5">
          <ScopeBadge scope="account" />
          <span className="text-foreground">Account</span>
          <span>· you, in every org</span>
        </span>
      ),
    },
    {
      scope: "organization",
      heading: (
        <span className="flex min-w-0 items-center gap-1.5 normal-case">
          <ScopeBadge scope="org" />
          {activeOrganization ? (
            <OrgName
              organization={activeOrganization}
              size="xs"
              nameClassName="text-foreground"
            />
          ) : (
            <span className="text-foreground">Organization</span>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col lg:flex-row gap-4 lg:gap-8 relative">
      <nav className="lg:w-56 lg:flex-shrink-0" aria-label="Settings">
        <div className="lg:sticky lg:top-0 flex flex-col gap-3 pt-2">
          {groups.map((group) => (
            <div key={group.scope} className="flex flex-col gap-1">
              <div className="px-3 text-xs text-muted-foreground">
                {group.heading}
              </div>
              <div className="flex flex-wrap lg:flex-col gap-1 pb-2 lg:pb-0">
                {navItems
                  .filter((item) => item.scope === group.scope)
                  .map((item) => {
                    const isActive = pathname === item.href;
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={cn(
                          "flex items-center gap-2 px-3 h-8 text-sm rounded-md transition-colors",
                          "hover:bg-muted/50",
                          isActive
                            ? "bg-muted text-foreground font-medium"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {item.icon && <span className="flex">{item.icon}</span>}
                        <span>{item.label}</span>
                      </Link>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
      </nav>
      <div className="flex flex-col gap-4 justify-start w-full max-w-4xl pt-0 sm:pt-2 pb-12">
        {children}
      </div>
    </div>
  );
}
