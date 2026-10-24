import { describe, expect, it, vi } from "vitest";

import { buildReviewTicketContext } from "./review-ticket-context";
import type { TrackerConfig } from "./tracker-config";
import {
  type TrackerClient,
  type TrackerIssue,
  TrackerRequestError,
} from "./tracker-types";

vi.mock("@/lib/db", () => ({ db: {} }));

/**
 * The `ticket` review-context block (pre-merge acceptance-criteria check).
 *
 * protects: the review agent sees the delivered tickets' text and never the
 *   tracker token; every case with nothing to check carries the sentence the
 *   review skills key off; one failed ticket does not lose the others.
 * fails_when: a token reaches the block, shadow mode reads the tracker, a
 *   referenced-only ticket is offered for checking, or a fetch error throws.
 * no_claim: real tracker responses (a fake client stands in).
 */

const SKIP = "Leave the ticket acceptance-criteria group out.";

const config: TrackerConfig = {
  kind: "youtrack",
  baseUrl: "https://yt.example.com",
  token: "perm:secret-token-value",
  projects: ["ACME"],
  writes: "off",
};

const issue = (key: string): TrackerIssue => ({
  key,
  summary: "Void predictions",
  description: "## Acceptance Criteria\n- AC-1 reject closed questions",
  stage: "In Progress",
  resolved: false,
  links: [],
  comments: [{ id: "c1", text: "AC-2 deferred to ACME-50" }],
});

const fakeTracker = (getIssue: TrackerClient["getIssue"]): TrackerClient => ({
  getIssue,
  getStage: vi.fn(),
  setStage: vi.fn(),
  listStageTargets: vi.fn(async () => null),
  addComment: vi.fn(),
  issueUrl: (key) => `https://yt.example.com/issue/${key}`,
});

const scope = { organizationId: "org-1", ownerUserId: "user-1", shadow: false };

function build({
  title = "feat(ACME-1): void predictions",
  body = "",
  headBranch = "ACME-1-void",
  shadow = false,
  resolved = config as TrackerConfig | null,
  getIssue = vi.fn(async (key: string) => issue(key)),
}: {
  title?: string;
  body?: string;
  headBranch?: string;
  shadow?: boolean;
  resolved?: TrackerConfig | null;
  getIssue?: TrackerClient["getIssue"];
} = {}) {
  const resolveConfig = vi.fn(async () => resolved);
  const createClient = vi.fn(() => fakeTracker(getIssue));
  return {
    resolveConfig,
    createClient,
    run: () =>
      buildReviewTicketContext({
        scope: { ...scope, shadow },
        repoFullName: "acme-inc/acme-core",
        pullRequest: { title, body, headBranch },
        resolveConfig,
        createClient,
      }),
  };
}

describe("buildReviewTicketContext", () => {
  it("renders the delivered ticket without the token or nested wrappers", async () => {
    const { run, createClient } = build();
    const out = await run();
    expect(out).toContain('<ticket_context tickets="1">');
    expect(out).toContain("### ACME-1 (primary)");
    expect(out).toContain("- AC-1 reject closed questions");
    expect(out).toContain("AC-2 deferred to ACME-50");
    expect(out).not.toContain("secret-token-value");
    expect(out).not.toContain("<user_content>");
    expect(createClient).toHaveBeenCalledWith(config, { timeoutMs: 4_000 });
  });

  it("shadow mode never reads the tracker", async () => {
    const { run, resolveConfig } = build({ shadow: true });
    const out = await run();
    expect(out).toContain("shadow mode");
    expect(out).toContain(SKIP);
    expect(resolveConfig).not.toHaveBeenCalled();
  });

  it("no tracker configured says so", async () => {
    const { run, createClient } = build({ resolved: null });
    const out = await run();
    expect(out).toContain('<ticket_context tickets="0">');
    expect(out).toContain("No tracker is configured");
    expect(out).toContain(SKIP);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("no ticket key says so", async () => {
    const { run } = build({ title: "chore: bump deps", headBranch: "deps" });
    const out = await run();
    expect(out).toContain("No ticket key was found");
    expect(out).toContain(SKIP);
  });

  it("a referenced-only ticket is never offered for checking", async () => {
    const getIssue = vi.fn(async (key: string) => issue(key));
    const { run } = build({
      title: "chore: tidy",
      headBranch: "tidy",
      body: "Relates to ACME-5 and ACME-6.",
      getIssue,
    });
    const out = await run();
    expect(out).toContain("The PR mentions ACME-5, ACME-6 but names none");
    expect(out).toContain(SKIP);
    expect(getIssue).not.toHaveBeenCalled();
  });

  it("one failed ticket is named; the other still renders", async () => {
    const getIssue = vi.fn(async (key: string) => {
      if (key === "ACME-2") {
        throw new TrackerRequestError("issue fetch", 503);
      }
      return issue(key);
    });
    const { run } = build({ body: "Closes ACME-2", getIssue });
    const out = await run();
    expect(out).toContain('<ticket_context tickets="2">');
    expect(out).toContain("### ACME-1 (primary)");
    expect(out).toContain("### ACME-2\n\nTracker unavailable for this ticket");
  });
});
