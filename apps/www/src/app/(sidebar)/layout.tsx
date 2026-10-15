import {
  dehydrate,
  HydrationBoundary,
  QueryClient,
} from "@tanstack/react-query";

import { AppSidebar } from "@/components/app-sidebar";
import { NotificationProvider } from "@/components/system/notification-provider";
import { getUserIdOrNull } from "@/lib/auth-server";
import { myOrganizationsQueryOptions } from "@/queries/my-organizations-query-options";

export default async function SidebarLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const userId = await getUserIdOrNull();
  const queryClient = new QueryClient();
  if (userId) {
    // The active org keys the org-scoped lists (repo picker, GitHub
    // accounts). Rendering it into the page lets those lists start fetching
    // on first paint instead of waiting for a client-side server action.
    await queryClient.prefetchQuery(myOrganizationsQueryOptions());
  }
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <div
        className="group/sidebar-wrapper flex min-h-svh w-full"
        style={
          {
            "--sidebar-width": "18rem",
            "--sidebar-width-mobile": "18rem",
          } as React.CSSProperties
        }
      >
        {userId ? (
          <>
            <NotificationProvider />
            <AppSidebar />
          </>
        ) : null}
        {children}
      </div>
    </HydrationBoundary>
  );
}
