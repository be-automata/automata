import { TZDate } from "@date-fns/tz";
import type { DBMessage, DBResultMetaMessage } from "@terragon/shared";

/**
 * #441 (epic #440 C1): recognise a run the PROVIDER refused — the connected
 * Claude subscription hit a usage limit, its organization disabled Claude
 * Code, the API key ran out of credit, or (#472) the provider rejected the
 * credential itself — so every lane can say so instead of "no JSON intent
 * block found".
 *
 * Rules (epic decisions 3 and 4):
 *  - Input is the CURRENT attempt's message batch (the daemon event that
 *    carries the final result), never the thread's stored history.
 *  - Never reads assistant text. Only the structured `rate_limit_event`
 *    (status `rejected`) or the final `result` with `is_error: true`, at most
 *    one turn and zero cost, matched start-anchored against the known texts.
 *  - A classified run stays TERMINAL: this never feeds
 *    `parseClaudeRateLimitMessageStr`, whose `queued-agent-rate-limit` route
 *    keeps worker-plane runs "working" until they time out.
 */

/** The `errorMessage` a thread chat carries when this classifier fired. */
export const PROVIDER_UNAVAILABLE_ERROR = "provider-unavailable";

export type ProviderUnavailableKind =
  | "usage_limit"
  | "subscription_disabled"
  | "credit_exhausted"
  /** #472: the provider refused the credential (revoked, expired, invalid). */
  | "auth_rejected";

export type ProviderLimitWindow = "five_hour" | "weekly";

export interface ProviderUnavailable {
  kind: ProviderUnavailableKind;
  window?: ProviderLimitWindow;
  /** Epoch ms. Undefined when the reset is unknown or unparseable. */
  resetsAt?: number;
}

const SEPARATOR = "[·∙•]";

/**
 * #472: the CLI's text for an API 401. Matched on text because it is the only
 * signal that reaches us: the CLI ends the run with a synthetic assistant
 * message plus a `result` (`is_error: true`, one turn, zero cost) whose
 * `result` repeats it, e.g. "Failed to authenticate. API Error: 401 OAuth
 * access token has been revoked." The assistant message's own error tag is
 * neither typed by the daemon nor stored, and the 401's JSON body is not
 * always present. So, per epic #440 decision 3, the match stays narrow: the
 * result field only (never the agent text part), anchored at the start on
 * the CLI's "Failed to authenticate." prefix, or on a bare "API Error: 401"
 * that also carries an authentication signature from the API body. A 401
 * is never folded into the legacy rate-limit parser (decision 4).
 */
const AUTH_REJECTED_HEAD =
  /^(?:Failed to authenticate\. API Error: 401\b|API Error: 401\b(?=.*(?:authentication_error|OAuth (?:access )?token|x-api-key)))/s;

/** `· resets <text>` up to the next separator or the end. */
const RESETS_CLAUSE = new RegExp(
  `^\\s*${SEPARATOR}\\s*resets\\s+(.+?)\\s*(?:${SEPARATOR}.*)?$`,
  "s",
);

interface TextRule {
  head: RegExp;
  classify: (
    match: RegExpExecArray,
    rest: string,
    now: number,
  ) => ProviderUnavailable;
}

function usageLimit(window: ProviderLimitWindow): TextRule["classify"] {
  return (_match, rest, now) => {
    const resetText = RESETS_CLAUSE.exec(rest)?.[1];
    const resetsAt =
      resetText === undefined ? undefined : resolveResetText(resetText, now);
    return {
      kind: "usage_limit",
      window,
      ...(resetsAt === undefined ? {} : { resetsAt }),
    };
  };
}

/** Start-anchored; checked in order, first match wins. */
const TEXT_RULES: readonly TextRule[] = [
  // Current CLI texts.
  {
    head: /^You(?:'|’)ve hit your (?:(?:Opus|Sonnet) )?weekly limit/,
    classify: usageLimit("weekly"),
  },
  {
    head: /^You(?:'|’)ve hit your session limit/,
    classify: usageLimit("five_hour"),
  },
  {
    head: /^Your organization has disabled Claude subscription access for Claude Code/,
    classify: () => ({ kind: "subscription_disabled" }),
  },
  {
    head: /^Credit balance is too low/,
    classify: () => ({ kind: "credit_exhausted" }),
  },
  {
    head: AUTH_REJECTED_HEAD,
    classify: () => ({ kind: "auth_rejected" }),
  },
  // Legacy banners.
  {
    head: /^(?:(?:Opus|Sonnet) )?[Ww]eekly limit reached/,
    classify: usageLimit("weekly"),
  },
  {
    head: /^(?:Session limit reached|\d+-hour limit reached)/,
    classify: usageLimit("five_hour"),
  },
  {
    head: /^Claude AI usage limit reached\|(\d{9,12})\s*$/,
    classify: (match) => ({
      kind: "usage_limit",
      resetsAt: Number(match[1]) * 1000,
    }),
  },
];

function isResultMeta(message: DBMessage): message is DBResultMetaMessage {
  return (
    message.type === "meta" &&
    (message.subtype === "result-success" ||
      message.subtype === "result-error" ||
      message.subtype === "result-error-max-turns")
  );
}

/**
 * The SDK's `rateLimitType` enum: `five_hour`, the weekly family
 * (`seven_day`, `seven_day_opus`, `seven_day_sonnet`,
 * `seven_day_overage_included`) and `overage` (no window of its own).
 */
function windowOfRateLimitType(
  rateLimitType: string | null,
): ProviderLimitWindow | undefined {
  if (rateLimitType === "five_hour") return "five_hour";
  if (rateLimitType?.startsWith("seven_day")) return "weekly";
  return undefined;
}

/**
 * Classify the current attempt. `now` is the server clock when the result
 * arrived (stored messages carry no timestamp); a date-less reset resolves
 * to its next occurrence after it.
 */
export function classifyProviderResult(
  messages: readonly DBMessage[],
  { now }: { now: number },
): ProviderUnavailable | null {
  let result: DBResultMetaMessage | null = null;
  for (const message of messages) {
    if (isResultMeta(message)) result = message;
  }
  // No result in this batch: the run has not ended here. A successful
  // result: whatever a rate-limit event said earlier, the run was served.
  if (result === null || result.is_error !== true) return null;

  // (1) The structured signal: a rejected rate-limit event from this run.
  let rejected: {
    rateLimitType: string | null;
    resetsAt: number | null;
  } | null = null;
  for (const message of messages) {
    if (
      message.type === "meta" &&
      message.subtype === "rate-limit" &&
      message.status === "rejected" &&
      // Paid overage took the overflow: the run was not refused here.
      message.overageCovered !== true &&
      (message.session_id === null ||
        !result.session_id ||
        message.session_id === result.session_id)
    ) {
      rejected = message;
    }
  }
  if (rejected !== null) {
    const window = windowOfRateLimitType(rejected.rateLimitType);
    return {
      kind: "usage_limit",
      ...(window ? { window } : {}),
      ...(rejected.resetsAt !== null && rejected.resetsAt > 0
        ? { resetsAt: rejected.resetsAt * 1000 }
        : {}),
    };
  }

  // (2) The result text, only for a run the provider refused outright.
  if (result.num_turns > 1 || result.cost_usd !== 0) return null;
  const text = result.result?.trimStart();
  if (!text) return null;
  for (const rule of TEXT_RULES) {
    const match = rule.head.exec(text);
    if (match) {
      return rule.classify(match, text.slice(match[0].length), now);
    }
  }
  return null;
}

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
] as const;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** How far past a date-less reset the clock may be and still mean it. */
const RESET_SKEW_MS = 15 * 60 * 1000;
const HALF_YEAR_MS = 183 * 24 * 60 * 60 * 1000;

const RESET_PATTERN =
  /^(?:(?<mon>jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(?<day>\d{1,2})(?:st|nd|rd|th)?,?\s+|(?<wd>sun|mon|tue|wed|thu|fri|sat)[a-z]*,?\s+)?(?:at\s+)?(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<ampm>am|pm)?$/i;

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * A CLI reset text ("5pm", "5pm (UTC)", "Oct 22, 5pm (UTC)", "17:30",
 * "Mon 10am (Europe/Berlin)") as epoch ms. An explicit zone wins; no zone is
 * UTC. A date-less time is its next occurrence after `now` (minus a small
 * skew allowance); a dated one without a year takes the year nearest `now`,
 * so a date just behind the clock stays in the past. DST needs no handling:
 * the default zone is UTC and an explicit zone is resolved by `TZDate`.
 * Unparseable → undefined.
 */
export function resolveResetText(
  text: string,
  now: number,
): number | undefined {
  let rest = text.trim();
  let zone = "UTC";
  const zoneMatch = /\(([^()]+)\)$/.exec(rest);
  if (zoneMatch) {
    zone = zoneMatch[1]!.trim();
    rest = rest.slice(0, zoneMatch.index).trim();
  }
  if (!isValidTimeZone(zone)) return undefined;

  const match = RESET_PATTERN.exec(rest);
  const groups = match?.groups;
  if (!groups) return undefined;
  const rawHour = Number(groups.hour);
  const minute = groups.minute === undefined ? 0 : Number(groups.minute);
  if (minute > 59) return undefined;
  let hour: number;
  if (groups.ampm) {
    if (rawHour < 1 || rawHour > 12) return undefined;
    const pm = groups.ampm.toLowerCase() === "pm";
    hour = (rawHour % 12) + (pm ? 12 : 0);
  } else {
    // A bare number ("resets 5") is not a time.
    if (groups.minute === undefined || rawHour > 23) return undefined;
    hour = rawHour;
  }

  const candidate = new TZDate(now, zone);
  if (groups.mon) {
    const month = MONTHS.indexOf(
      groups.mon.toLowerCase() as (typeof MONTHS)[number],
    );
    const day = Number(groups.day);
    candidate.setMonth(month, day);
    if (candidate.getMonth() !== month || candidate.getDate() !== day) {
      return undefined;
    }
    candidate.setHours(hour, minute, 0, 0);
    // The year is the one that puts the date nearest the reference time: a
    // "Jan 2" read on Dec 30 is next year, but a date just behind the clock
    // (skew, a late delivery) stays in the past, i.e. already reset, rather
    // than jumping a whole year ahead.
    const offset = candidate.getTime() - now;
    if (Math.abs(offset) > HALF_YEAR_MS) {
      candidate.setFullYear(
        candidate.getFullYear() + (offset < 0 ? 1 : -1),
        month,
        day,
      );
      // Feb 29 has no twin in the neighbouring year.
      if (candidate.getMonth() !== month) return undefined;
      candidate.setHours(hour, minute, 0, 0);
    }
    return candidate.getTime();
  }
  candidate.setHours(hour, minute, 0, 0);
  // A date-less time is its next occurrence, allowing the clock to be a
  // little past it: "resets 5pm" received at 17:00:20 is today's 17:00, not
  // tomorrow's.
  const earliest = now - RESET_SKEW_MS;
  if (groups.wd) {
    const weekday = WEEKDAYS.indexOf(
      groups.wd.toLowerCase() as (typeof WEEKDAYS)[number],
    );
    const ahead = (weekday - candidate.getDay() + 7) % 7;
    candidate.setDate(candidate.getDate() + ahead);
    if (candidate.getTime() <= earliest) {
      candidate.setDate(candidate.getDate() + 7);
    }
    return candidate.getTime();
  }
  if (candidate.getTime() <= earliest) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.getTime();
}

const KINDS: readonly ProviderUnavailableKind[] = [
  "usage_limit",
  "subscription_disabled",
  "credit_exhausted",
  "auth_rejected",
];

/** The classification stored in `errorMessageInfo`, or null if malformed. */
export function parseProviderUnavailableInfo(
  info: string | null | undefined,
): ProviderUnavailable | null {
  if (!info) return null;
  let value: unknown;
  try {
    value = JSON.parse(info);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const kind = KINDS.find((candidate) => candidate === record.kind);
  if (!kind) return null;
  const window =
    record.window === "five_hour" || record.window === "weekly"
      ? record.window
      : undefined;
  const resetsAt =
    typeof record.resetsAt === "number" && Number.isFinite(record.resetsAt)
      ? record.resetsAt
      : undefined;
  return {
    kind,
    ...(window ? { window } : {}),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

/** The classification of a finished thread chat, or null for any other end. */
export function providerUnavailableOfChat(
  chat:
    | { errorMessage?: string | null; errorMessageInfo?: string | null }
    | null
    | undefined,
): ProviderUnavailable | null {
  if (chat?.errorMessage !== PROVIDER_UNAVAILABLE_ERROR) return null;
  return parseProviderUnavailableInfo(chat.errorMessageInfo);
}

const MONTH_LABELS = MONTHS.map(
  (month) => month.charAt(0).toUpperCase() + month.slice(1),
);

/** `17:00 UTC on 22 Oct`. */
export function formatResetUtc(epochMs: number): string {
  const date = new Date(epochMs);
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC on ${date.getUTCDate()} ${MONTH_LABELS[date.getUTCMonth()]}`;
}

/**
 * True when the cause does not end on its own: only a person (an org admin
 * reconnecting the credential, a Claude org admin re-enabling access, or
 * someone adding credit) clears it. The hook #442 (mark the delivered
 * credential unavailable with no `until`) and #444 (alert the operator)
 * read; a usage limit is the only cause with a reset.
 */
export function providerUnavailableIsIndefinite(
  provider: ProviderUnavailable,
): boolean {
  return provider.kind !== "usage_limit";
}

/**
 * One sentence naming the cause, for every lane's public notice. It never
 * names the account (epic decision 5): no email, no organization name.
 */
export function describeProviderUnavailable(
  provider: ProviderUnavailable,
): string {
  switch (provider.kind) {
    case "usage_limit": {
      const limit =
        provider.window === "weekly"
          ? "weekly usage limit"
          : provider.window === "five_hour"
            ? "five-hour usage limit"
            : "usage limit";
      return provider.resetsAt === undefined
        ? `The connected Claude subscription hit its ${limit} and is unavailable until the limit resets.`
        : `The connected Claude subscription hit its ${limit}; it resets at ${formatResetUtc(provider.resetsAt)}.`;
    }
    case "subscription_disabled":
      return "The connected Claude subscription is unavailable: an admin of the connected Claude organization disabled Claude Code access; it will not reset on its own.";
    case "credit_exhausted":
      return "The Claude API credit balance is too low to run the agent.";
    case "auth_rejected":
      return "Automata's Claude credential for this organization was rejected by the provider, so the agent could not start; an org admin must reconnect it.";
  }
}

/** When a retry can work: "after the reset", "once …". */
export function providerUnavailableRetryWhen(
  provider: ProviderUnavailable,
): string {
  switch (provider.kind) {
    case "usage_limit":
      return "after the reset";
    case "subscription_disabled":
      return "once Claude Code access is restored or another subscription is connected";
    case "credit_exhausted":
      return "once credit is added";
    case "auth_rejected":
      return "once an org admin reconnects the Claude credential";
  }
}
