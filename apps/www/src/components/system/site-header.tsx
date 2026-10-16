"use client";

import { useAtomValue } from "jotai";
import { userAtom, userSettingsAtom } from "@/atoms/user";
import React, { memo } from "react";
import { useSidebar, SidebarTrigger } from "@/components/ui/sidebar";
import { usePageHeader } from "@/contexts/page-header";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { cn } from "@/lib/utils";
import { usePathname } from "next/navigation";
import { Wordmark } from "../shared/wordmark";
import { Badge } from "@/components/ui/badge";
import { FlaskConical } from "lucide-react";
import Link from "next/link";
import { useBillingInfoQuery } from "@/queries/billing-queries";
import { headerClassName } from "../shared/header";
import { OrgName } from "../org-avatar";
import { useActiveOrganization } from "@/queries/organization-queries";

/** On mobile the switcher lives in the closed sheet, so the header names the org. */
function MobileActiveOrg() {
  const { activeOrganization } = useActiveOrganization();
  if (!activeOrganization) {
    return null;
  }
  return (
    <span className="flex min-w-0 max-w-40 items-center gap-1.5 text-xs">
      <OrgName organization={activeOrganization} size="xs" />
    </span>
  );
}

export const SiteHeader = memo(function SiteHeader() {
  const pathname = usePathname();
  const user = useAtomValue(userAtom);
  const { open: isSidebarOpen, isMobile } = useSidebar();
  const isConstrainedPage =
    pathname === "/automations" ||
    pathname.startsWith("/automations/") ||
    pathname === "/environments" ||
    pathname.startsWith("/environments/");

  if (!user) {
    return null;
  }
  return (
    <div className={cn("flex flex-col w-full px-4", headerClassName)}>
      <div
        className={cn(
          "flex w-full items-center justify-between h-full",
          isConstrainedPage && "max-w-4xl",
        )}
      >
        <div className="flex gap-2 items-center min-w-0">
          {isMobile && <SidebarTrigger className="px-0 size-auto w-fit" />}
          {isMobile && <MobileActiveOrg />}
          {(pathname === "/dashboard" || pathname === "/welcome") && (
            <div
              className={cn(
                "block md:hidden",
                isSidebarOpen && "!hidden",
                (!isSidebarOpen || isMobile) && "!block",
              )}
            >
              <Wordmark
                href="/dashboard"
                showLogo={isSidebarOpen || isMobile}
              />
            </div>
          )}
          <SiteHeaderBreadcrumbs />
        </div>
        <div className="ml-4">
          <SiteHeaderNav />
        </div>
      </div>
    </div>
  );
});

const SiteHeaderNav = memo(function SiteHeaderNav() {
  const { setHeaderActionContainer } = usePageHeader();
  const userSettings = useAtomValue(userSettingsAtom);
  const pathname = usePathname();
  const { data: billingInfo } = useBillingInfoQuery();

  const signupTrialDays = billingInfo?.signupTrial?.daysRemaining ?? 0;
  const isBadgeEligiblePage =
    pathname === "/dashboard" || pathname === "/settings";
  const shouldShowTrialBadge =
    isBadgeEligiblePage &&
    signupTrialDays > 0 &&
    !billingInfo?.hasActiveSubscription;
  const shouldShowEarlyAccess =
    !shouldShowTrialBadge &&
    userSettings?.previewFeaturesOptIn &&
    isBadgeEligiblePage;

  return (
    <div
      className="flex items-center gap-2 sm:gap-2.5"
      ref={(el) => setHeaderActionContainer(el)}
    >
      {shouldShowTrialBadge && (
        <Link href="/settings/billing" className="no-underline">
          <Badge variant="outline" className="gap-1 px-2 py-1 text-xs">
            Free Trial: {signupTrialDays} day{signupTrialDays === 1 ? "" : "s"}{" "}
            left
          </Badge>
        </Link>
      )}
      {shouldShowEarlyAccess && (
        <Link href="/settings#preview-features" className="no-underline">
          <Badge variant="outline" className="gap-1 px-2 py-1 text-xs">
            <FlaskConical className="h-3 w-3" />
            Early Access
          </Badge>
        </Link>
      )}
    </div>
  );
});

const SiteHeaderBreadcrumbs = memo(function SiteHeaderBreadcrumbs() {
  const pathname = usePathname();
  const { breadcrumbs } = usePageHeader();
  if (
    pathname === "/dashboard" ||
    pathname === "/welcome" ||
    breadcrumbs.length === 0
  ) {
    return null;
  }
  return (
    <Breadcrumb className="min-w-0 overflow-hidden">
      <BreadcrumbList className="text-lg text-foreground flex-nowrap">
        {breadcrumbs.map((item, index) => (
          <React.Fragment key={index}>
            {index > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem
              className={cn("truncate block", index === 0 && "font-bold")}
            >
              {item.href ? (
                <BreadcrumbLink href={item.href}>{item.label}</BreadcrumbLink>
              ) : (
                item.label
              )}
            </BreadcrumbItem>
          </React.Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
});
