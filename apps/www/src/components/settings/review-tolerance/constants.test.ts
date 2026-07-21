import { describe, it, expect } from "vitest";
import {
  BLOCK_TOLERANCES,
  SEVERITY_ORDER,
  toleranceToPolicy,
  isBlockingUnderPolicy,
  classifySeverities,
  tierToVerdict,
  type Severity,
  type BlockTolerance,
} from "@terragon/review/severity-policy";
import {
  blocksUnder,
  consequenceFor,
  isLooser,
  DEFAULT_TOLERANCE,
  type Consequence,
} from "./constants";

/**
 * Frontend↔backend semantic PARITY guard. The dashboard's consequence matrix
 * (constants.ts) hand-maintains severity/tolerance rank tables; those MUST stay
 * cell-for-cell identical to the server kernel the reviewer actually enforces
 * (`@terragon/review/severity-policy`). If they drift, the UI would promise the
 * operator one thing and the bot would post another. This locks every
 * tolerance × severity cell against the real kernel, so any divergence fails CI.
 */

const VERDICT_TO_CONSEQUENCE: Record<
  ReturnType<typeof tierToVerdict>,
  Consequence
> = {
  request_changes: "Request changes",
  comment: "Comment",
  approve: "Approve",
};

describe("review-tolerance matrix ↔ server kernel parity", () => {
  it("blocksUnder matches isBlockingUnderPolicy for every tolerance × severity", () => {
    for (const tolerance of BLOCK_TOLERANCES) {
      const policy = toleranceToPolicy(tolerance);
      for (const severity of SEVERITY_ORDER) {
        expect(
          blocksUnder(tolerance, severity),
          `blocksUnder(${tolerance}, ${severity})`,
        ).toBe(isBlockingUnderPolicy(severity, policy));
      }
    }
  });

  it("consequenceFor matches the kernel's classify→verdict for every tolerance × severity", () => {
    for (const tolerance of BLOCK_TOLERANCES) {
      const policy = toleranceToPolicy(tolerance);
      for (const severity of SEVERITY_ORDER) {
        const kernelVerdict = tierToVerdict(
          classifySeverities([severity], policy),
        );
        expect(
          consequenceFor(tolerance, severity),
          `consequenceFor(${tolerance}, ${severity})`,
        ).toBe(VERDICT_TO_CONSEQUENCE[kernelVerdict]);
      }
    }
  });

  it("the UI tiers are exactly the backend's selectable tolerances", () => {
    // No stray/extra tier (e.g. 'critical' must never be selectable).
    const uiTiers = new Set<BlockTolerance>(["info", "warning", "error"]);
    expect(new Set(BLOCK_TOLERANCES)).toEqual(uiTiers);
    expect(uiTiers.has("info")).toBe(true);
  });

  it("the UI default tolerance is the kernel's default policy tier", () => {
    // warning: block===surface===warning in the kernel default.
    expect(DEFAULT_TOLERANCE).toBe("warning");
    expect(toleranceToPolicy(DEFAULT_TOLERANCE)).toEqual({
      blockSeverity: "warning",
      surfaceSeverity: "warning",
    });
  });

  it("isLooser tracks the kernel's block-rank ordering (error loosest, info strictest)", () => {
    const rank = (t: BlockTolerance): number =>
      SEVERITY_ORDER.indexOf(toleranceToPolicy(t).blockSeverity);
    for (const a of BLOCK_TOLERANCES) {
      for (const b of BLOCK_TOLERANCES) {
        expect(isLooser(a, b), `isLooser(${a}, ${b})`).toBe(rank(a) > rank(b));
      }
    }
  });
});

// Type-only guard: the UI Severity union must include the kernel's severities.
const _severityParity: Severity = "critical";
void _severityParity;
