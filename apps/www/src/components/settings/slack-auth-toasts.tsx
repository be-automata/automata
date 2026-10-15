"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";

export function SlackAuthToasts() {
  const searchParams = useSearchParams();

  useEffect(() => {
    const integration = searchParams.get("integration");
    if (integration !== "slack") {
      return;
    }
    const status = searchParams.get("status");
    const code = searchParams.get("code");
    if (!status || !code) {
      return;
    }
    // Default messages for each code
    const defaultMessages: Record<string, string> = {
      invalid_params: "Authentication failed. Please try again.",
      invalid_state: "Authentication failed. Please try again.",
      invalid_payload: "Authentication failed. Please try again.",
      auth_error: "Authentication failed. Please try again.",
      auth_cancelled: "Slack authorization was cancelled. Please try again.",
      not_configured:
        "Slack is not configured for this organization. Set the SLACK_* variables first.",
      not_org_admin:
        "Only organization owners and admins can install the Slack app.",
      workspace_bound_elsewhere:
        "This Slack workspace is already installed for another organization.",
      wrong_workspace:
        "Slack opened a different workspace than the one you asked for, so nothing was saved. If the Slack app is not publicly distributed, Slack only allows its own workspace: turn on Public Distribution in the app's settings, then try again.",
      // Success codes
      app_installed: "Successfully installed to your workspace",
      account_connected: "Successfully connected to Slack workspace",
    };
    const displayMessage =
      defaultMessages[code] ||
      "An unexpected error occurred. Please try again.";
    // Show toast based on status
    if (status === "error") {
      toast.error(displayMessage, {
        duration: 10000,
      });
    } else if (status === "success") {
      toast.success(displayMessage, {
        duration: 10000,
      });
    }
    // Clean up URL by removing query params
    const url = new URL(window.location.href);
    url.searchParams.delete("status");
    url.searchParams.delete("code");
    url.searchParams.delete("integration");
    url.searchParams.delete("message");
    window.history.replaceState({}, "", url.toString());
  }, [searchParams]);

  return null;
}
