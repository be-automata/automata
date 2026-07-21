import { ReviewSettings } from "@/components/settings/tab/review";
import { getUserIdOrRedirect } from "@/lib/auth-server";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Review Settings | Terragon",
};

export default async function ReviewSettingsPage() {
  await getUserIdOrRedirect();
  return <ReviewSettings />;
}
