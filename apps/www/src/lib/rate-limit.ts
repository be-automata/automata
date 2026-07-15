import { redis } from "./redis";
import { Ratelimit } from "@upstash/ratelimit";
import { db } from "@/lib/db";
import { getUser } from "@terragon/shared/model/user";
const PREFIX = "@upstash/ratelimit";

const productionRefillRate = 20;
const productionWindow = "1h";
const productionMaxTokens = 20;
// In development, we want to be able to test the rate limit more easily.
const developmentRefillRate = 100;
const developmentWindow = "1h";
const developmentMaxTokens = 100;

export const sandboxCreationRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.tokenBucket(
    process.env.NODE_ENV === "production"
      ? productionRefillRate
      : developmentRefillRate,
    process.env.NODE_ENV === "production"
      ? productionWindow
      : developmentWindow,
    process.env.NODE_ENV === "production"
      ? productionMaxTokens
      : developmentMaxTokens,
  ),
  prefix: `${PREFIX}:sandbox-creation`,
});

/**
 * Fail-open read of the sandbox-creation limiter's remaining tokens. This runs inside
 * queue-admission / task-start on the core path, so if the limiter backend (Redis) is
 * unconfigured or unreachable we treat the user as not rate-limited rather than letting
 * the error stall the queue. Behavior is unchanged when Redis is healthy.
 */
export async function getSandboxCreationRemaining(
  userId: string,
): Promise<{ remaining: number; reset: number }> {
  try {
    return await sandboxCreationRateLimit.getRemaining(userId);
  } catch (e) {
    console.error(
      "sandboxCreationRateLimit.getRemaining failed; treating user as not rate-limited",
      e,
    );
    return { remaining: Number.MAX_SAFE_INTEGER, reset: 0 };
  }
}

export async function trackSandboxCreation(userId: string) {
  const result = await sandboxCreationRateLimit.limit(userId);
  // Don't throw an error here, just log a warning because there might be a race condition
  // between the rate limit check and the sandbox creation and its okay if we go over.
  if (!result.success) {
    console.log(
      `Going over sandbox creation rate limit: ${result.remaining} remaining, reset in ${result.reset}`,
    );
  }
}

// Waitlist submission rate limiting (by IP address)
export const waitlistSubmissionRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(
    5, // 5 requests
    "15m", // per 15 minutes
  ),
  prefix: `${PREFIX}:waitlist-submission`,
});

// Onboarding questionnaire update rate limiting (by IP address)
export const onboardingUpdateRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(
    20, // 20 requests (allow multiple form steps)
    "5m", // per 5 minutes
  ),
  prefix: `${PREFIX}:onboarding-update`,
});

export async function checkWaitlistRateLimit(ip: string) {
  const result = await waitlistSubmissionRateLimit.limit(ip);
  if (!result.success) {
    throw new Error(
      `Too many waitlist submissions. Try again in ${Math.ceil(result.reset / 1000 / 60)} minutes.`,
    );
  }
  return result;
}

export async function checkOnboardingRateLimit(ip: string) {
  const result = await onboardingUpdateRateLimit.limit(ip);
  if (!result.success) {
    throw new Error(
      `Too many form updates. Try again in ${Math.ceil(result.reset / 1000 / 60)} minutes.`,
    );
  }
  return result;
}

// CLI task creation rate limiting (by user ID)
export const cliTaskCreationRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(
    50, // 50 tasks
    "1d", // per day
  ),
  prefix: `${PREFIX}:cli-task-creation`,
});

export async function checkCliTaskCreationRateLimit(userId: string) {
  const result = await cliTaskCreationRateLimit.limit(userId);
  if (!result.success) {
    const hoursUntilReset = Math.ceil(
      (result.reset - Date.now()) / 1000 / 60 / 60,
    );
    throw new Error(
      `Daily task creation limit reached (50 tasks per day). Try again in ${hoursUntilReset} hours.`,
    );
  }
  return result;
}

// Shadow-banned users: 3 tasks per hour (applies across sources)
export const shadowBanTaskCreationRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(3, "1h"),
  prefix: `${PREFIX}:shadowban-task-creation`,
});

// No-op for non-shadow-banned users; used by web and internal paths
export async function checkShadowBanTaskCreationRateLimit(userId: string) {
  const user = await getUser({ db, userId });
  if (!user?.shadowBanned) return { success: true } as const;
  const result = await shadowBanTaskCreationRateLimit.limit(userId);
  if (!result.success) {
    const minutesUntilReset = Math.ceil(
      (result.reset - Date.now()) / 1000 / 60,
    );
    // Generic message (do not expose shadow ban state)
    throw new Error(
      `Task creation limit reached. Try again in ${minutesUntilReset} minutes.`,
    );
  }
  return result;
}
