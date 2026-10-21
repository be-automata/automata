// Fixture corpus for the engine tests: a billing FAQ page grounded on code, a marketing doc and a support
// ticket. Kept as string constants (not files) so formatters never move the lines the pins point at.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { onTestFinished } from "vitest";

import {
  generateSidecar,
  stubUpdater,
  type ReconcileDiff,
  type Sidecar,
  type Updater,
} from "./claims";
import { parseHunks } from "./reanchor";

export const PAGE = "billing-faq";
/** A full source commit for op keys in tests. */
export const SOURCE_SHA = "007a8a0bbf458c93734580a569d9f56cd34ab8dd";

export const FIXTURES: Record<string, string> = {
  "repo/billing.ts": `export const TRIAL_DAYS = 14;
export const SEAT_PRICE_USD = 29;
export const MAX_SEATS_FREE = 3;

export function trialEndsAt(start: Date): Date {
  return new Date(start.getTime() + TRIAL_DAYS * 86_400_000);
}
`,
  "docs/pricing.md": `# Pricing

## Plans
Team plan: per-seat billing, monthly or annual.

## Trial
Every workspace starts with a 14-day free trial. No card required.
`,
  "tickets/SUP-12.json": `{
  "id": "SUP-12",
  "title": "SSO login loops back to the sign-in page",
  "status": "resolved",
  "resolution": {
    "workaround": "Clear the ag_session cookie, then sign in again",
    "fixedIn": "2.4.1"
  }
}
`,
  [`wiki/${PAGE}.md`]: `---
type: faq
title: Billing & access FAQ
audience: [support, marketing, engineering]
---

# Billing & access FAQ

Trials last 14 days and need no card.

Each seat costs $29 per month; workspaces get 3 free seats.

If SSO sign-in loops back to the sign-in page, clear the ag_session cookie and sign in again.

The SSO loop was fixed in version 2.4.1.
`,
  "repo/ratelimit.py": `RATE_LIMIT_PER_MINUTE = 120
BURST_ALLOWANCE = 20


def window_seconds() -> int:
    return 60
`,
  "repo/config.yaml": `limits:
  api:
    requests_per_minute: 120
  seats:
    max_free: 3
`,
  "repo/README.md": `# Limits

The API allows 120 requests per minute per workspace.
`,
  "wiki/limits-faq.md": `# Limits FAQ

The API allows 120 requests per minute.

Bursts may exceed the limit by 20 requests.

The limits README states 120 requests per minute per workspace.
`,
};

export const SEED = [
  {
    id: "trial-length",
    statement: "Trials last 14 days and need no card.",
    evidence: ["repo://billing.ts#L1-L1", "doc://pricing#trial"],
  },
  {
    id: "seat-price",
    statement: "Each seat costs $29 per month; workspaces get 3 free seats.",
    evidence: ["repo://billing.ts#L2-L3"],
  },
  {
    id: "sso-workaround",
    statement:
      "If SSO sign-in loops back to the sign-in page, clear the ag_session cookie and sign in again.",
    evidence: ["ticket://SUP-12#/resolution/workaround"],
  },
  {
    id: "sso-fixed-in",
    statement: "The SSO loop was fixed in version 2.4.1.",
    evidence: ["ticket://SUP-12#/resolution/fixedIn"],
  },
];

/** A second page grounded on whitespace-significant code and config (py, yaml) and on a prose repo file. */
export const LIMITS_PAGE = "limits-faq";

export const LIMITS_SEED = [
  {
    id: "api-rate",
    statement: "The API allows 120 requests per minute.",
    evidence: ["repo://ratelimit.py#L1-L1", "repo://config.yaml#L3-L3"],
  },
  {
    id: "burst",
    statement: "Bursts may exceed the limit by 20 requests.",
    evidence: ["repo://ratelimit.py#L2-L2"],
  },
  {
    id: "readme-rate",
    statement:
      "The limits README states 120 requests per minute per workspace.",
    evidence: ["repo://README.md#L3-L3"],
  },
];

/** The billing source as lines, i.e. the `oldText` side of a diff against the corpus. */
export const BILLING_LINES = (FIXTURES["repo/billing.ts"] ?? "")
  .replace(/\n$/, "")
  .split("\n");

export const pageOf = (root: string) =>
  readFileSync(join(root, "wiki", `${PAGE}.md`), "utf8");
export const edit = (root: string, rel: string, f: (s: string) => string) =>
  writeFileSync(join(root, rel), f(readFileSync(join(root, rel), "utf8")));
export const writeBilling = (root: string, lines: string[]) =>
  writeFileSync(join(root, "repo/billing.ts"), `${lines.join("\n")}\n`);

/** The trial constant moves below a decoy and a second identical copy appears: its pin becomes ambiguous. */
export const duplicateTrial = (s: string) =>
  `// legacy\nexport const TRIAL_DAYS = 14;\n${s.replace("export const TRIAL_DAYS = 14;\n", "// moved\n")}export const TRIAL_DAYS_ALIAS = 0;\nexport const TRIAL_DAYS = 14;\n`;

/** A diff of repo/billing.ts from the fixture to `now`, described by one or more -U0 hunk headers. */
export const diffOf = (now: string[], header: string): ReconcileDiff => ({
  path: "billing.ts",
  hunks: parseHunks(header),
  oldText: `${BILLING_LINES.join("\n")}\n`,
  newText: `${now.join("\n")}\n`,
});

/** The stub updater, recording which claims reached it. */
export function countingUpdater(): { llm: Updater; seen: string[] } {
  const inner = stubUpdater();
  const seen: string[] = [];
  const llm: Updater = {
    get calls() {
      return inner.calls;
    },
    rework(items) {
      seen.push(...items.map((i) => i.claim.id));
      return inner.rework(items);
    },
  };
  return { llm, seen };
}

/** A fresh corpus with its sidecar, removed when the current test finishes. */
export function useCorpus(): { root: string; sc: Sidecar } {
  const { root, cleanup } = makeCorpus();
  onTestFinished(cleanup);
  return { root, sc: generateSidecar(root, PAGE, pageOf(root), SEED) };
}

export const limitsPageOf = (root: string) =>
  readFileSync(join(root, "wiki", `${LIMITS_PAGE}.md`), "utf8");

/** A fresh corpus with the limits page's sidecar, removed when the current test finishes. */
export function useLimitsCorpus(): { root: string; sc: Sidecar } {
  const { root, cleanup } = makeCorpus();
  onTestFinished(cleanup);
  return {
    root,
    sc: generateSidecar(root, LIMITS_PAGE, limitsPageOf(root), LIMITS_SEED),
  };
}

/** Materialize the corpus into a fresh temp directory; call the returned cleanup when done. */
export function makeCorpus(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "knowledge-"));
  for (const [rel, text] of Object.entries(FIXTURES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
