import { getUserIdOrRedirect } from "@/lib/auth-server";
import type { Metadata } from "next";
import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import { Automations } from "@/components/automations/main";
import {
  automationQueryOptions,
  automationLimitQueryOptions,
} from "@/queries/automation-queries";

export const metadata: Metadata = {
  title: "Automations | Terragon",
};

export default async function AutomationsPage() {
  await getUserIdOrRedirect();
  const queryClient = new QueryClient();
  await Promise.all([
    queryClient.prefetchQuery(automationQueryOptions()),
    queryClient.prefetchQuery(automationLimitQueryOptions()),
  ]);
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <div className="flex flex-col justify-start h-full w-full max-w-6xl">
        <Automations />
      </div>
    </HydrationBoundary>
  );
}
