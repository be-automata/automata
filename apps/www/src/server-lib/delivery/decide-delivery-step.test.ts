import { describe, expect, it } from "vitest";

import {
  decideDeliveryStep,
  DELIVERY_REVIEW_WAIT_MS,
  type DeliveryLatestCycle,
  type DeliveryPrSnapshot,
  type DeliveryStep,
} from "./decide-delivery-step";
import type { DeliveryHeadCi } from "./head-ci";

const NOW = new Date("2026-10-26T12:00:00Z");
const EARLIER = new Date(NOW.getTime() - 5 * 60_000);
const LONG_AGO = new Date(NOW.getTime() - DELIVERY_REVIEW_WAIT_MS - 1);

type Row = Parameters<typeof decideDeliveryStep>[0]["row"];

function row(over: Partial<Row> = {}): Row {
  return {
    phase: "awaiting_ci",
    headSha: "H",
    headSeenAt: EARLIER,
    cyclesUsed: 0,
    readyMarkedHeadSha: null,
    readyMarkedAt: null,
    mergeReadyHeadSha: null,
    ...over,
  };
}

const GREEN: DeliveryHeadCi = {
  state: "success",
  gateSource: "all-checks",
  failing: [],
  noCi: false,
};
const RED: DeliveryHeadCi = {
  state: "failure",
  gateSource: "all-checks",
  failing: ["test"],
  noCi: false,
};

function pr(over: Partial<DeliveryPrSnapshot> = {}): DeliveryPrSnapshot {
  return {
    state: "open",
    merged: false,
    draft: true,
    headSha: "H",
    authorIsBot: false,
    ci: GREEN,
    botReviewAtHead: null,
    humanChangesRequested: false,
    ...over,
  };
}

function decide(
  r: Row,
  p: DeliveryPrSnapshot,
  latestCycle: DeliveryLatestCycle | null = null,
): DeliveryStep {
  return decideDeliveryStep({ row: r, pr: p, latestCycle, now: NOW });
}

describe("#509 decideDeliveryStep", () => {
  describe("lifecycle", () => {
    it("a merged or closed PR closes the row; a terminal row never moves", () => {
      expect(decide(row(), pr({ state: "closed", merged: true }))).toEqual({
        kind: "close",
        phase: "merged",
      });
      expect(decide(row(), pr({ state: "closed" }))).toEqual({
        kind: "close",
        phase: "closed",
      });
      expect(decide(row({ phase: "merged" }), pr({ headSha: "X" })).kind).toBe(
        "noop",
      );
    });

    it("a new head is observed first, from any open phase, into the phase its draft state implies", () => {
      for (const phase of [
        "awaiting_ci",
        "awaiting_review",
        "fixing",
        "merge_ready",
        "needs_human",
        "paused",
      ] as const) {
        expect(decide(row({ phase }), pr({ headSha: "H2" }))).toEqual({
          kind: "observe_head",
          headSha: "H2",
          phase: "awaiting_ci",
        });
        expect(
          decide(row({ phase }), pr({ headSha: "H2", draft: false })),
        ).toEqual({
          kind: "observe_head",
          headSha: "H2",
          phase: "awaiting_review",
        });
      }
    });

    it("needs_human waits for a new head; paused waits while it stays a draft", () => {
      expect(decide(row({ phase: "needs_human" }), pr({ ci: RED })).kind).toBe(
        "noop",
      );
      expect(
        decide(row({ phase: "needs_human" }), pr({ ci: RED, draft: false }))
          .kind,
      ).toBe("noop");
      expect(decide(row({ phase: "paused" }), pr({ ci: RED })).kind).toBe(
        "noop",
      );
    });

    it("a paused PR made ready again resumes at this head and starts the review clock", () => {
      expect(decide(row({ phase: "paused" }), pr({ draft: false }))).toEqual({
        kind: "set_phase",
        phase: "awaiting_review",
        reason: "marked ready again by a person",
        recordReadyAt: true,
      });
    });

    it("an App-authored PR goes to a human: the bot cannot review its own PR", () => {
      expect(decide(row(), pr({ authorIsBot: true }))).toEqual({
        kind: "needs_human",
        reason: "app_authored_pr",
      });
    });
  });

  describe("draft (awaiting_ci)", () => {
    it("waits while CI is pending or infra-failed", () => {
      expect(
        decide(row(), pr({ ci: { state: "pending", gateSource: null } })).kind,
      ).toBe("noop");
      expect(
        decide(
          row(),
          pr({
            ci: {
              state: "infra",
              gateSource: "all-checks",
              failing: ["e2e"],
              noCi: false,
            },
          }),
        ).kind,
      ).toBe("noop");
    });

    it("green marks ready once per head", () => {
      expect(decide(row(), pr())).toEqual({ kind: "mark_ready", noCi: false });
      expect(decide(row({ readyMarkedHeadSha: "H" }), pr()).kind).toBe("noop");
    });

    it("a repo with no CI is marked ready with the no-CI note", () => {
      expect(
        decide(
          row(),
          pr({
            ci: {
              state: "success",
              gateSource: "finding-check-only",
              failing: [],
              noCi: true,
            },
          }),
        ),
      ).toEqual({ kind: "mark_ready", noCi: true });
    });

    it("red starts a ci cycle with the failing checks", () => {
      expect(decide(row(), pr({ ci: RED }))).toEqual({
        kind: "start_cycle",
        trigger: "ci",
        reviewId: null,
        failingChecks: ["test"],
      });
    });

    it("red past the cap goes to a human", () => {
      expect(decide(row({ cyclesUsed: 3 }), pr({ ci: RED }))).toEqual({
        kind: "needs_human",
        reason: "fix_cap_reached",
      });
    });

    it("a person marking it ready moves it to awaiting_review", () => {
      expect(decide(row(), pr({ draft: false }))).toMatchObject({
        kind: "set_phase",
        phase: "awaiting_review",
      });
    });
  });

  describe("ready (awaiting_review)", () => {
    const ready = (over: Partial<Row> = {}) =>
      row({
        phase: "awaiting_review",
        readyMarkedHeadSha: "H",
        readyMarkedAt: EARLIER,
        ...over,
      });
    const open = (over: Partial<DeliveryPrSnapshot> = {}) =>
      pr({ draft: false, ...over });

    it("waits for CI first", () => {
      expect(
        decide(
          ready(),
          open({
            ci: { state: "pending", gateSource: "all-checks" },
            botReviewAtHead: { id: 1, state: "CHANGES_REQUESTED" },
          }),
        ).kind,
      ).toBe("noop");
    });

    it("the bot's changes requested starts a review cycle; with red CI too, one review+ci cycle", () => {
      expect(
        decide(
          ready(),
          open({ botReviewAtHead: { id: 7, state: "CHANGES_REQUESTED" } }),
        ),
      ).toEqual({
        kind: "start_cycle",
        trigger: "review",
        reviewId: 7,
        failingChecks: [],
      });
      expect(
        decide(
          ready(),
          open({
            ci: RED,
            botReviewAtHead: { id: 7, state: "CHANGES_REQUESTED" },
          }),
        ),
      ).toEqual({
        kind: "start_cycle",
        trigger: "review+ci",
        reviewId: 7,
        failingChecks: ["test"],
      });
    });

    it("approved and green posts merge-ready once per head", () => {
      expect(
        decide(
          ready(),
          open({ botReviewAtHead: { id: 9, state: "APPROVED" } }),
        ),
      ).toEqual({ kind: "merge_ready", reviewId: 9 });
      expect(
        decide(
          ready({ mergeReadyHeadSha: "H" }),
          open({ botReviewAtHead: { id: 9, state: "APPROVED" } }),
        ).kind,
      ).toBe("noop");
    });

    it("approved but red starts a ci cycle", () => {
      expect(
        decide(
          ready(),
          open({ ci: RED, botReviewAtHead: { id: 9, state: "APPROVED" } }),
        ),
      ).toEqual({
        kind: "start_cycle",
        trigger: "ci",
        reviewId: 9,
        failingChecks: ["test"],
      });
    });

    it("approved but a human still requests changes goes to a human", () => {
      expect(
        decide(
          ready(),
          open({
            botReviewAtHead: { id: 9, state: "APPROVED" },
            humanChangesRequested: true,
          }),
        ),
      ).toEqual({ kind: "needs_human", reason: "human_changes_requested" });
    });

    it("no verdict yet: waits until REVIEW_WAIT, then decides on CI alone", () => {
      expect(decide(ready(), open()).kind).toBe("noop");
      expect(
        decide(
          ready(),
          open({ botReviewAtHead: { id: 2, state: "COMMENTED" } }),
        ).kind,
      ).toBe("noop");
      const expired = ready({ headSeenAt: LONG_AGO, readyMarkedAt: LONG_AGO });
      expect(decide(expired, open())).toEqual({
        kind: "needs_human",
        reason: "no_bot_review",
      });
      expect(decide(expired, open({ ci: RED }))).toEqual({
        kind: "start_cycle",
        trigger: "ci",
        reviewId: null,
        failingChecks: ["test"],
      });
    });

    it("the review clock restarts at the ready mark, not only at the head", () => {
      expect(
        decide(ready({ headSeenAt: LONG_AGO, readyMarkedAt: EARLIER }), open())
          .kind,
      ).toBe("noop");
    });

    it("a person marking a long-seen draft ready records the ready time, and the bot then gets its full wait", () => {
      const longSeenDraft = row({ headSeenAt: LONG_AGO });
      expect(decide(longSeenDraft, open())).toEqual({
        kind: "set_phase",
        phase: "awaiting_review",
        reason: "marked ready by a person",
        recordReadyAt: true,
      });
      // What the evaluator writes for that step: phase + ready_marked_at=now,
      // with the loop's own ready sha still unset.
      const personReady = row({
        phase: "awaiting_review",
        headSeenAt: LONG_AGO,
        readyMarkedHeadSha: null,
        readyMarkedAt: EARLIER,
      });
      expect(decide(personReady, open()).kind).toBe("noop");
      expect(decide(personReady, open({ ci: RED })).kind).toBe("noop");
    });

    it("a ready time left over from an older head never shortens this head's wait", () => {
      expect(
        decide(
          ready({
            headSeenAt: EARLIER,
            readyMarkedHeadSha: "OLD",
            readyMarkedAt: LONG_AGO,
          }),
          open(),
        ).kind,
      ).toBe("noop");
    });

    it("back to draft after the loop marked it ready pauses; otherwise it waits for CI", () => {
      expect(decide(ready(), pr())).toMatchObject({
        kind: "set_phase",
        phase: "paused",
      });
      expect(decide(ready({ readyMarkedHeadSha: null }), pr())).toMatchObject({
        kind: "set_phase",
        phase: "awaiting_ci",
      });
    });

    it("changes requested past the cap goes to a human", () => {
      expect(
        decide(
          ready({ cyclesUsed: 3 }),
          open({ botReviewAtHead: { id: 7, state: "CHANGES_REQUESTED" } }),
        ),
      ).toEqual({ kind: "needs_human", reason: "fix_cap_reached" });
    });
  });

  describe("fixing", () => {
    const fixing = row({ phase: "fixing", cyclesUsed: 1 });

    it("waits while the cycle is in flight", () => {
      for (const state of ["dispatching", "running"] as const) {
        expect(
          decide(fixing, pr({ ci: RED }), { state, triggerHeadSha: "H" }).kind,
        ).toBe("noop");
      }
      expect(decide(fixing, pr({ ci: RED }), null).kind).toBe("noop");
    });

    it("a finished cycle that left the head unchanged goes to a human", () => {
      for (const state of ["pushed", "no_push", "abandoned"] as const) {
        expect(
          decide(fixing, pr({ ci: RED }), { state, triggerHeadSha: "H" }),
        ).toEqual({ kind: "needs_human", reason: "cycle_pushed_nothing" });
      }
    });

    it("a pushed cycle is picked up as a new head", () => {
      expect(
        decide(fixing, pr({ headSha: "H2" }), {
          state: "pushed",
          triggerHeadSha: "H",
        }),
      ).toEqual({ kind: "observe_head", headSha: "H2", phase: "awaiting_ci" });
    });
  });
});
