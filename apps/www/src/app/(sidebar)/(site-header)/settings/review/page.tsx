import { ReviewSettings } from "@/components/settings/tab/review";
import { SkillsSettings } from "@/components/settings/tab/skills";
import { getUserIdOrRedirect } from "@/lib/auth-server";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Review Settings | Terragon",
};

export default async function ReviewSettingsPage() {
  await getUserIdOrRedirect();
  return (
    <>
      <ReviewSettings />
      {/* The Skills panel lives on the review page (issue #54 C4): the
          github-ops review methodology is the flagship skill, and the
          automations' skill chips deep-link here via #skills. */}
      <SkillsSettings />
    </>
  );
}
