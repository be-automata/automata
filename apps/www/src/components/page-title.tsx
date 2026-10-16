"use client";

import React from "react";

import { PageTitleView } from "@/components/ui/register";
import { useActiveOrganization } from "@/queries/organization-queries";

/** PageTitleView for the session's active org. */
export function PageTitle({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  const { activeOrganization } = useActiveOrganization();
  return (
    <PageTitleView title={title} organization={activeOrganization}>
      {children}
    </PageTitleView>
  );
}
