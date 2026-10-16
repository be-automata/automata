import { getUserInfoOrRedirect } from "@/lib/auth-server";
import type { Metadata } from "next";
import { Stats } from "@/components/stats/main";
import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import { statsQueryOptions } from "@/queries/stats-queries";

export const metadata: Metadata = {
  title: "Stats | Terragon",
};

export default async function StatsPage() {
  const userInfo = await getUserInfoOrRedirect();
  // Prefetch the default data (last 7 days)
  const queryClient = new QueryClient();
  await queryClient.prefetchQuery(
    statsQueryOptions({
      numDays: 7,
      timezone: userInfo.userCookies.timeZone ?? "UTC",
    }),
  );
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <div className="flex flex-col justify-start h-full w-full max-w-6xl">
        <Stats />
      </div>
    </HydrationBoundary>
  );
}
