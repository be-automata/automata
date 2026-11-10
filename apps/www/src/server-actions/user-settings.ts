"use server";

import { db } from "@/lib/db";
import { UserSettings } from "@terragon/shared";
import {
  getUserSettings,
  updateUserSettings,
} from "@terragon/shared/model/user";
import { userOnlyAction } from "@/lib/auth-server";
import { getPostHogServer } from "@/lib/posthog-server";

export const updateUserSettingsAction = userOnlyAction(
  async function updateUserSettingsAction(
    userId: string,
    updates: Partial<Omit<UserSettings, "id" | "userId" | "sandboxProvider">>,
  ) {
    // ADR-014 amends ADR-013 I7: no setting or client input selects an
    // execution path. The type above omits the field; this drops it at runtime
    // too, so a stale client (or a hand-crafted call) can never write a
    // user-chosen provider. The column stays for existing rows (dropped later).
    if ("sandboxProvider" in updates) {
      const { sandboxProvider: _ignored, ...rest } =
        updates as typeof updates & {
          sandboxProvider?: unknown;
        };
      updates = rest;
      if (Object.keys(updates).length === 0) {
        return;
      }
    }
    console.log("updateUserSettingsAction", updates);
    getPostHogServer().capture({
      distinctId: userId,
      event: "update_user_settings",
      properties: {
        ...updates,
      },
    });
    await updateUserSettings({ db, userId, updates });
  },
  { defaultErrorMessage: "Failed to update settings" },
);

export const getUserSettingsAction = userOnlyAction(
  async function getUserSettingsAction(
    userId: string,
  ): Promise<UserSettings | null> {
    console.log("getUserSettingsAction");
    return getUserSettings({ db, userId });
  },
  { defaultErrorMessage: "Failed to get settings" },
);
