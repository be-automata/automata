import posthog from "posthog-js";

if (process.env.NEXT_PUBLIC_POSTHOG_KEY) {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: "/relay-WkjS",
    ui_host: "https://us.posthog.com",
    capture_pageview: "history_change",
    capture_pageleave: true, // Enable pageleave capture
    capture_exceptions: true, // Enable exception tracking
    autocapture: false, // Disable autocapture events
    debug: process.env.NODE_ENV === "development",
  });
}
