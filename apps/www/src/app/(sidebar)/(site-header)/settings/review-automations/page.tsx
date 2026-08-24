import { redirect } from "next/navigation";

/**
 * #125 C6: the epic's canonical URL for the Review & Automations family (the
 * thread-view chips link here). The family's home is the review settings tab.
 */
export default function ReviewAutomationsPage() {
  redirect("/settings/review");
}
