import { PostHog } from "posthog-node";
import { env } from "@terragon/env/apps-www";
import { after } from "next/server";

let posthogInstance: PostHog | null = null;

export function getPostHogServer() {
  if (!posthogInstance) {
    posthogInstance = new PostHog(env.NEXT_PUBLIC_POSTHOG_KEY || "disabled", {
      host: env.NEXT_PUBLIC_POSTHOG_HOST!,
      disabled:
        !env.NEXT_PUBLIC_POSTHOG_KEY ||
        process.env.NODE_ENV !== "production" ||
        !!process.env.CI,
      flushAt: 1,
      flushInterval: 0, // Server-side functions in Next.js can be short-lived we flush regularly
    });

    if (process.env.NODE_ENV === "production") {
      try {
        after(async () => {
          if (posthogInstance) {
            await posthogInstance.flush();
          }
        });
      } catch (e) {
        console.error("Unable to schedule posthog flush", e);
      }
    }
  }
  return posthogInstance;
}
