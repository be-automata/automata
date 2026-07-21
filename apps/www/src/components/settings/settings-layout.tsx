"use client";

import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { cn } from "@/lib/utils";
import {
  Settings,
  GitBranch,
  Blocks,
  Bot,
  Package,
  CreditCard,
  ShieldCheck,
} from "lucide-react";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { useRealtimeUser } from "@/hooks/useRealtime";

interface NavItem {
  href: string;
  label: string;
  icon?: React.ReactNode;
}

export function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
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
      label: "General",
      icon: <Settings className="w-4 h-4" />,
    },
    {
      href: "/settings/github",
      label: "GitHub & Pull Requests",
      icon: <GitBranch className="w-4 h-4" />,
    },
    {
      href: "/settings/agent",
      label: "Agent",
      icon: <Bot className="w-4 h-4" />,
    },
    {
      href: "/settings/review",
      label: "PR Review",
      icon: <ShieldCheck className="w-4 h-4" />,
    },
    {
      href: "/settings/integrations",
      label: "Integrations",
      icon: <Blocks className="w-4 h-4" />,
    },
    {
      href: "/settings/billing",
      label: "Billing",
      icon: <CreditCard className="w-4 h-4" />,
    },
  ];
  if (daytonaOptionsForSandboxProviderEnabled) {
    navItems.push({
      href: "/settings/sandbox",
      label: "Sandbox",
      icon: <Package className="w-4 h-4" />,
    });
  }

  return (
    <div className="flex flex-col lg:flex-row gap-4 lg:gap-8 relative">
      <nav className="lg:w-56 lg:flex-shrink-0">
        <div className="lg:sticky lg:top-0">
          <div className="flex flex-wrap lg:flex-col gap-1 pb-2 lg:pb-0 pt-2">
            {navItems.map((item) => {
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
      </nav>
      <div className="flex flex-col gap-4 justify-start w-full max-w-4xl pt-0 sm:pt-2 pb-12">
        {children}
      </div>
    </div>
  );
}
