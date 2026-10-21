import { describe, expect, it } from "vitest";
import type { DBMessage } from "@terragon/shared";
import type { ClaudeMessage } from "@terragon/daemon/shared";
import {
  classifyProviderResult,
  describeProviderUnavailable,
  formatResetUtc,
  parseProviderUnavailableInfo,
  resolveResetText,
} from "./classify-provider-result";
import { toDBMessage } from "./toDBMessage";
import { toUIMessages } from "@/components/chat/toUIMessages";
import { extractTerminalAgentText } from "@/server-lib/review/review-single-writer-finish";

// The server clock when the result arrived: 2026-10-21 13:24 UTC (a Wednesday).
const NOW = Date.UTC(2026, 9, 21, 13, 24);
const SESSION = "session-synthetic-1";

/** The final `result` exactly as a refused run emits it: 1 turn, zero cost. */
function refusedResult(
  text: string,
  overrides: Partial<{
    is_error: boolean;
    num_turns: number;
    total_cost_usd: number;
    session_id: string;
  }> = {},
): ClaudeMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: true,
    num_turns: 1,
    total_cost_usd: 0,
    duration_ms: 400,
    duration_api_ms: 0,
    result: text,
    session_id: SESSION,
    ...overrides,
  };
}

/**
 * The Agent SDK's `SDKRateLimitEvent` shape (sdk.d.ts): the fields nest under
 * `rate_limit_info`, `resetsAt` is epoch seconds.
 */
function rateLimitEvent(
  info: {
    status: string;
    rateLimitType?: string;
    resetsAt?: number;
    overageStatus?: string;
    isUsingOverage?: boolean;
  },
  sessionId = SESSION,
): ClaudeMessage {
  return {
    type: "rate_limit_event",
    rate_limit_info: { ...info, utilization: 1 },
    session_id: sessionId,
  };
}

function classify(messages: ClaudeMessage[], now = NOW) {
  return classifyProviderResult(messages.flatMap(toDBMessage), { now });
}

describe("classifyProviderResult — current CLI texts", () => {
  // Card: protects=the weekly-cap text classifies with its UTC reset;
  // fails_when=the text is unmatched (today's "no JSON intent block") or the
  // reset is read in another zone; no_claim=the notice wording.
  it("weekly limit with an explicit (UTC) reset", () => {
    expect(
      classify([
        refusedResult("You've hit your weekly limit · resets 5pm (UTC)"),
      ]),
    ).toEqual({
      kind: "usage_limit",
      window: "weekly",
      resetsAt: Date.UTC(2026, 9, 21, 17, 0),
    });
  });

  // Card: protects=a zone-less HH:MM reset is UTC; fails_when=it is read in
  // the server's or the user's zone; no_claim=am/pm forms (next test).
  it("session limit with a zone-less HH:MM reset is UTC", () => {
    expect(
      classify([refusedResult("You've hit your session limit · resets 15:30")]),
    ).toEqual({
      kind: "usage_limit",
      window: "five_hour",
      resetsAt: Date.UTC(2026, 9, 21, 15, 30),
    });
  });

  // Card: protects=subscription-disabled is its own kind with no reset;
  // fails_when=it reads as a usage limit or as nothing; no_claim=how long it
  // lasts (only an admin knows).
  it("organization disabled Claude Code access", () => {
    expect(
      classify([
        refusedResult(
          "Your organization has disabled Claude subscription access for Claude Code · Ask an admin to re-enable it",
        ),
      ]),
    ).toEqual({ kind: "subscription_disabled" });
  });

  // Card: protects=the built-in-key credit path classifies; fails_when=it is
  // unmatched; no_claim=which key ran out.
  it("credit balance too low", () => {
    expect(classify([refusedResult("Credit balance is too low")])).toEqual({
      kind: "credit_exhausted",
    });
  });
});

describe("classifyProviderResult — legacy banners", () => {
  // Card: protects=the three pre-2026 banners still classify; fails_when=a
  // banner the old parser knew is dropped; no_claim=the legacy
  // queued-agent-rate-limit route (handle-daemon-event suite).
  it("Weekly limit reached (zone-less am/pm reset is UTC)", () => {
    expect(
      classify([refusedResult("Weekly limit reached ∙ resets 6pm")]),
    ).toEqual({
      kind: "usage_limit",
      window: "weekly",
      resetsAt: Date.UTC(2026, 9, 21, 18, 0),
    });
  });

  it("Session limit reached", () => {
    expect(
      classify([refusedResult("Session limit reached ∙ resets 3pm (UTC)")]),
    ).toEqual({
      kind: "usage_limit",
      window: "five_hour",
      resetsAt: Date.UTC(2026, 9, 21, 15, 0),
    });
  });

  it("Claude AI usage limit reached|<epoch seconds>", () => {
    expect(
      classify([refusedResult("Claude AI usage limit reached|1761152400")]),
    ).toEqual({ kind: "usage_limit", resetsAt: 1761152400 * 1000 });
  });
});

describe("classifyProviderResult — negatives", () => {
  // Card: protects=decision 3, assistant prose is never classified;
  // fails_when=a review that DISCUSSES limits is labelled a provider failure;
  // no_claim=what the review lane then posts.
  it("never reads assistant text, nor a result that only mentions a limit", () => {
    const prose: ClaudeMessage = {
      type: "assistant",
      message: {
        role: "assistant",
        content: "You've hit your weekly limit · resets 5pm (UTC)",
      },
      parent_tool_use_id: null,
      session_id: SESSION,
    };
    expect(
      classify([
        prose,
        refusedResult("done", { is_error: false, total_cost_usd: 0.4 }),
      ]),
    ).toBeNull();
    expect(
      classify([
        refusedResult(
          "The patch raises the weekly limit. You've hit your weekly limit is a string in this diff.",
        ),
      ]),
    ).toBeNull();
  });

  // Card: protects=only a run refused on turn one at zero cost is read from
  // text; fails_when=a long or billed run whose result happens to start with
  // the banner is classified; no_claim=the structured path (it has no gate).
  it("ignores the banner on a run that did work (turns > 1 or cost > 0) or did not error", () => {
    const text = "You've hit your weekly limit · resets 5pm (UTC)";
    expect(classify([refusedResult(text, { num_turns: 4 })])).toBeNull();
    expect(
      classify([refusedResult(text, { total_cost_usd: 0.02 })]),
    ).toBeNull();
    expect(classify([refusedResult(text, { is_error: false })])).toBeNull();
    // No result in this batch: the run has not ended here.
    expect(classify([])).toBeNull();
  });
});

describe("classifyProviderResult — rate_limit_event", () => {
  // Card: protects=the structured signal wins and its epoch SECONDS become ms;
  // fails_when=resetsAt is taken as ms or the window is lost; no_claim=CLI
  // field names beyond status/rateLimitType/resetsAt.
  it("a rejected event in the same run with an error result is a usage limit", () => {
    expect(
      classify([
        rateLimitEvent({
          status: "rejected",
          rateLimitType: "seven_day",
          resetsAt: 1761152400,
        }),
        refusedResult("API Error: 429", { num_turns: 3, total_cost_usd: 0.1 }),
      ]),
    ).toEqual({
      kind: "usage_limit",
      window: "weekly",
      resetsAt: 1761152400 * 1000,
    });
  });

  // Card: protects=a served run is never classified; fails_when=a rejected
  // event followed by a successful result, or an event from another session,
  // marks the run; no_claim=none.
  it("rejected then success is null; another session's event does not count", () => {
    expect(
      classify([
        rateLimitEvent({ status: "rejected", rateLimitType: "five_hour" }),
        refusedResult("ok", { is_error: false, total_cost_usd: 0.3 }),
      ]),
    ).toBeNull();
    expect(
      classify([
        rateLimitEvent(
          { status: "rejected", rateLimitType: "five_hour" },
          "session-other",
        ),
        refusedResult("API Error: 500"),
      ]),
    ).toBeNull();
  });
});

describe("resolveResetText", () => {
  // Card: protects=reset resolution: next occurrence after the server clock,
  // dated and zoned forms, unparseable → undefined; fails_when=a past time
  // resolves to today, a dated reset ignores its date, or junk yields a
  // number; no_claim=DST edge minutes.
  it("resolves date-less, dated, zoned and unparseable resets", () => {
    // 11am already passed at 13:24 UTC → tomorrow.
    expect(resolveResetText("11am", NOW)).toBe(Date.UTC(2026, 9, 22, 11, 0));
    expect(resolveResetText("5pm (UTC)", NOW)).toBe(
      Date.UTC(2026, 9, 21, 17, 0),
    );
    expect(resolveResetText("Oct 22, 5pm (UTC)", NOW)).toBe(
      Date.UTC(2026, 9, 22, 17, 0),
    );
    // An explicit zone wins: 5pm New York (EDT, UTC-4) is 21:00 UTC.
    expect(resolveResetText("5pm (America/New_York)", NOW)).toBe(
      Date.UTC(2026, 9, 21, 21, 0),
    );
    expect(resolveResetText("soon", NOW)).toBeUndefined();
    expect(resolveResetText("5pm (Not/AZone)", NOW)).toBeUndefined();
    expect(resolveResetText("5", NOW)).toBeUndefined();
    // Unparseable inside a banner keeps the kind, drops the time.
    expect(
      classify([refusedResult("You've hit your weekly limit · resets later")]),
    ).toEqual({ kind: "usage_limit", window: "weekly" });
  });
});

describe("rate_limit_event persistence", () => {
  // Card: protects=the event is kept as a meta row that renders as nothing and
  // is never terminal agent text; fails_when=it is dropped, shown in the chat,
  // or read as the review's output; no_claim=other UI surfaces.
  it("maps to a meta rate-limit row that the UI and the terminal-text reader ignore", () => {
    const rows = toDBMessage(
      rateLimitEvent({
        status: "rejected",
        rateLimitType: "five_hour",
        resetsAt: 1761152400,
      }),
    );
    expect(rows).toEqual([
      {
        type: "meta",
        subtype: "rate-limit",
        status: "rejected",
        rateLimitType: "five_hour",
        resetsAt: 1761152400,
        utilization: 1,
        overageCovered: false,
        session_id: SESSION,
      },
    ]);
    const messages: DBMessage[] = rows;
    expect(toUIMessages({ dbMessages: messages, agent: "claudeCode" })).toEqual(
      [],
    );
    expect(extractTerminalAgentText(messages)).toBe("");
  });

  // Card: protects=the stored classification round-trips and renders without
  // account identity; fails_when=a malformed info parses or the text names an
  // email/org; no_claim=the lanes' framing (notice suites).
  it("errorMessageInfo round-trips; the cause sentence formats the reset as HH:MM UTC on D Mon", () => {
    const stored = JSON.stringify({
      kind: "usage_limit",
      window: "weekly",
      resetsAt: Date.UTC(2026, 9, 22, 17, 0),
    });
    const parsed = parseProviderUnavailableInfo(stored);
    expect(parsed).toEqual({
      kind: "usage_limit",
      window: "weekly",
      resetsAt: Date.UTC(2026, 9, 22, 17, 0),
    });
    expect(parseProviderUnavailableInfo("{nope")).toBeNull();
    expect(parseProviderUnavailableInfo('{"kind":"other"}')).toBeNull();
    expect(formatResetUtc(Date.UTC(2026, 9, 22, 17, 0))).toBe(
      "17:00 UTC on 22 Oct",
    );
    expect(describeProviderUnavailable(parsed!)).toBe(
      "The connected Claude subscription hit its weekly usage limit; it resets at 17:00 UTC on 22 Oct.",
    );
  });
});

describe("classifyProviderResult — the SDK's real rate_limit_info (#441 refinement)", () => {
  // Card: protects=every weekly member of the SDK's rateLimitType enum maps
  // to `weekly`, `five_hour` to five_hour, and `overage` to no window;
  // fails_when=seven_day_opus/sonnet/overage_included lose their window or
  // `overage` is called weekly; no_claim=the notice wording.
  it("maps the SDK rateLimitType enum", () => {
    const windowOf = (rateLimitType: string) =>
      classify([
        rateLimitEvent({ status: "rejected", rateLimitType, resetsAt: 1 }),
        refusedResult("API Error: 429"),
      ])?.window;
    for (const weekly of [
      "seven_day",
      "seven_day_opus",
      "seven_day_sonnet",
      "seven_day_overage_included",
    ]) {
      expect(windowOf(weekly)).toBe("weekly");
    }
    expect(windowOf("five_hour")).toBe("five_hour");
    expect(windowOf("overage")).toBeUndefined();
  });

  // Card: protects=a `rejected` status that paid overage covered (the CLI's
  // own isUsingOverage / overageStatus allowed reading) is not a refusal, so
  // an unrelated failure of that run keeps its own cause; fails_when=such a
  // run is labelled a usage limit; no_claim=the text path, which still
  // applies to the result on its own merits.
  it("a rejected event covered by overage does not classify the run", () => {
    for (const covered of [
      { isUsingOverage: true },
      { overageStatus: "allowed" },
      { overageStatus: "allowed_warning" },
    ]) {
      expect(
        classify([
          rateLimitEvent({
            status: "rejected",
            rateLimitType: "five_hour",
            resetsAt: 1761152400,
            ...covered,
          }),
          refusedResult("API Error: 500 upstream", {
            num_turns: 6,
            total_cost_usd: 0.8,
          }),
        ]),
      ).toBeNull();
    }
    // overageStatus rejected: the overflow was NOT covered.
    expect(
      classify([
        rateLimitEvent({
          status: "rejected",
          rateLimitType: "five_hour",
          overageStatus: "rejected",
        }),
        refusedResult("API Error: 429"),
      ]),
    ).toEqual({ kind: "usage_limit", window: "five_hour" });
  });

  // Card: protects=a row stored before `overageCovered` existed still counts
  // as a refusal; fails_when=the optional field's absence disables the
  // structured path; no_claim=none.
  it("a stored row without overageCovered is read as not covered", () => {
    const rows: DBMessage[] = [
      {
        type: "meta",
        subtype: "rate-limit",
        status: "rejected",
        rateLimitType: "seven_day",
        resetsAt: 1761152400,
        utilization: 1,
        session_id: SESSION,
      },
      ...toDBMessage(refusedResult("API Error: 429")),
    ];
    expect(classifyProviderResult(rows, { now: NOW })).toEqual({
      kind: "usage_limit",
      window: "weekly",
      resetsAt: 1761152400 * 1000,
    });
  });
});

describe("resolveResetText — clock edges (#441 refinement)", () => {
  // Card: protects=a date-less reset the clock is barely past (delivery lag,
  // skew) is today's, not tomorrow's; a genuinely passed one is tomorrow's;
  // fails_when="resets 5pm" received at 17:00:20 resolves 24 h out;
  // no_claim=the exact skew allowance beyond 15 minutes.
  it("allows a little skew past a date-less reset", () => {
    const at = (h: number, m: number, sec = 0) =>
      Date.UTC(2026, 9, 21, h, m, sec);
    expect(resolveResetText("5pm", at(17, 0, 20))).toBe(at(17, 0));
    expect(resolveResetText("5pm", at(17, 14))).toBe(at(17, 0));
    expect(resolveResetText("5pm", at(17, 16))).toBe(
      Date.UTC(2026, 9, 22, 17, 0),
    );
    // The weekday form honours the same allowance.
    expect(resolveResetText("Wed 5pm", at(17, 0, 20))).toBe(at(17, 0));
    expect(resolveResetText("Wed 5pm", at(18, 0))).toBe(
      Date.UTC(2026, 9, 28, 17, 0),
    );
  });

  // Card: protects=a dated reset takes the year nearest the clock: a date
  // just behind it stays in the past (already reset) and a January date read
  // in late December is next year; fails_when="Oct 21, 5pm" read at 17:01
  // resolves to next October, or "Jan 2" read on Dec 30 to this January;
  // no_claim=dates more than six months out (the CLI never prints them).
  it("resolves a dated reset to the nearest year, never a year ahead by skew", () => {
    expect(
      resolveResetText("Oct 21, 5pm (UTC)", Date.UTC(2026, 9, 21, 17, 1)),
    ).toBe(Date.UTC(2026, 9, 21, 17, 0));
    expect(
      resolveResetText("Oct 20, 5pm (UTC)", Date.UTC(2026, 9, 21, 13, 24)),
    ).toBe(Date.UTC(2026, 9, 20, 17, 0));
    expect(resolveResetText("Jan 2, 9am", Date.UTC(2026, 11, 30, 12, 0))).toBe(
      Date.UTC(2027, 0, 2, 9, 0),
    );
    expect(resolveResetText("Dec 30, 9am", Date.UTC(2027, 0, 2, 12, 0))).toBe(
      Date.UTC(2026, 11, 30, 9, 0),
    );
    expect(resolveResetText("Feb 30, 9am", NOW)).toBeUndefined();
  });

  // Card: protects=an explicit zone's wall clock is honoured across a DST
  // change and the UTC default never shifts; fails_when=the zone's offset on
  // the reference day is applied to a reset after the change; no_claim=zones
  // the runtime's ICU does not ship.
  it("an explicit zone is resolved on the reset's own date (DST)", () => {
    // Europe/Berlin leaves CEST on Sun 25 Oct 2026: 9am CET is 08:00 UTC.
    expect(
      resolveResetText("Oct 26, 9am (Europe/Berlin)", NOW),
    ).toBe(Date.UTC(2026, 9, 26, 8, 0));
    // Same date, no zone: UTC, no DST.
    expect(resolveResetText("Oct 26, 9am", NOW)).toBe(
      Date.UTC(2026, 9, 26, 9, 0),
    );
    // Garbage around a valid zone.
    expect(resolveResetText("whenever (UTC)", NOW)).toBeUndefined();
    expect(resolveResetText("", NOW)).toBeUndefined();
    expect(resolveResetText("13pm", NOW)).toBeUndefined();
    expect(resolveResetText("17:75", NOW)).toBeUndefined();
  });
});
