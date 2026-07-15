import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import { getUserSettings } from "@terragon/shared/model/user";
import type { AccessTier } from "@terragon/shared/db/types";
import { getAccessInfoForUser } from "./subscription";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import type { SandboxSize } from "@terragon/types/sandbox";

const proMaxConcurrentTasks = 10;

export const DEFAULT_SANDBOX_SIZE: SandboxSize = "small";

// Maximum number of automations allowed per user (without unlimited feature flag).
// Env-overridable neutral default so a self-hosted operator can raise it without a
// paid tier (with Stripe off every user is the baseline "core" tier).
export const DEFAULT_MAX_AUTOMATIONS = env.MAX_AUTOMATIONS_PER_USER;

// Per-user concurrency cap for the baseline tier. Env-overridable neutral default;
// no paid tier required to raise it.
const DEFAULT_MAX_CONCURRENT_TASK_COUNT = env.MAX_CONCURRENT_TASKS_PER_USER;

function getSandboxSizeForTier({
  tier,
  sandboxSize,
}: {
  tier: AccessTier;
  sandboxSize: SandboxSize;
}): SandboxSize {
  switch (sandboxSize) {
    case "small": {
      return "small";
    }
    case "large": {
      if (tier === "pro") {
        return "large";
      }
      console.warn(
        `Large sandbox size is not available for tier: ${tier}. Falling back to small.`,
      );
      return "small";
    }
    default: {
      const _exhaustiveCheck: never = sandboxSize;
      console.error(
        `Invalid sandbox size: ${_exhaustiveCheck}. Tier: ${tier}.`,
      );
      return DEFAULT_SANDBOX_SIZE;
    }
  }
}

function getMaxConcurrentTaskCountForTier(tier: AccessTier): number {
  return tier === "pro"
    ? proMaxConcurrentTasks
    : DEFAULT_MAX_CONCURRENT_TASK_COUNT;
}

function getMaxAutomationsForTier(
  tier: AccessTier,
  options?: { hasUnlimitedAddon?: boolean },
): number | null {
  if (options?.hasUnlimitedAddon) {
    return null;
  }
  if (tier === "pro") {
    return null;
  }
  return DEFAULT_MAX_AUTOMATIONS;
}

export const maxConcurrentTasksPerUser = DEFAULT_MAX_CONCURRENT_TASK_COUNT;

export async function getSandboxSizeForUser(
  userId: string,
): Promise<SandboxSize> {
  const [{ tier }, userSettings, largeSandboxSizeEnabled] = await Promise.all([
    getAccessInfoForUser(userId),
    getUserSettings({ db, userId }),
    getFeatureFlagForUser({
      db,
      userId,
      flagName: "enableLargeSandboxSize",
    }),
  ]);
  if (!largeSandboxSizeEnabled) {
    return DEFAULT_SANDBOX_SIZE;
  }
  return getSandboxSizeForTier({
    tier,
    sandboxSize: userSettings.sandboxSize ?? DEFAULT_SANDBOX_SIZE,
  });
}

export async function getMaxConcurrentTaskCountForUser(
  userId: string,
): Promise<number> {
  const { tier } = await getAccessInfoForUser(userId);
  return getMaxConcurrentTaskCountForTier(tier);
}

export async function getMaxAutomationsForUser(
  userId: string,
): Promise<number | null> {
  const [accessInfo, hasUnlimitedFlag] = await Promise.all([
    getAccessInfoForUser(userId),
    getFeatureFlagForUser({
      db,
      userId,
      flagName: "allowUnlimitedAutomations",
    }),
  ]);
  return getMaxAutomationsForTier(accessInfo.tier, {
    hasUnlimitedAddon: hasUnlimitedFlag,
  });
}
