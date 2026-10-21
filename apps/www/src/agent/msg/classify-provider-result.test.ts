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

function rateLimitEvent(
  info: { status: string; rateLimitType?: string; resetsAt?: number },
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
