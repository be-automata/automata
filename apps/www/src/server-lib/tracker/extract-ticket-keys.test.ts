import { describe, expect, it } from "vitest";

import { extractTicketKeys, MAX_TICKET_KEYS } from "./extract-ticket-keys";

const acme = ["ACME"];

describe("extractTicketKeys", () => {
  it("the title names the primary; other mentions are referenced only", () => {
    const result = extractTicketKeys({
      title: "feat(ACME-812): void predictions",
      body: "Also touches ACME-900.",
      headBranch: "ACME-700-something-else",
      projects: acme,
    });
    expect(result.primary).toBe("ACME-812");
    expect(result.auditKeys).toEqual(["ACME-812"]);
    expect(result.referencedKeys).toEqual(["ACME-900", "ACME-700"]);
  });

  it("the head branch outranks a body mention for the primary", () => {
    // The follow-up ticket named in the body must never become the ticket
    // this PR is measured against, commented on, or moved.
    const result = extractTicketKeys({
      title: "Fix void flow",
      body: "AC-3 deferred to ACME-901.",
      headBranch: "acme-812-void",
      projects: acme,
    });
    expect(result.primary).toBe("ACME-812");
    expect(result.auditKeys).toEqual(["ACME-812"]);
    expect(result.referencedKeys).toEqual(["ACME-901"]);
  });

  it("a closing keyword makes a body key the primary when title and branch name none", () => {
    const result = extractTicketKeys({
      title: "void predictions",
      body: "See ACME-9 for context. Fixes ACME-5.",
      headBranch: "feat/void",
      projects: acme,
    });
    expect(result.primary).toBe("ACME-5");
    expect(result.auditKeys).toEqual(["ACME-5"]);
    expect(result.referencedKeys).toEqual(["ACME-9"]);
  });

  it("a lone body key is the primary; several bare body keys deliver nothing", () => {
    expect(
      extractTicketKeys({
        title: "void predictions",
        body: "Implements ACME-5.",
        headBranch: "feat/void",
        projects: acme,
      }).auditKeys,
    ).toEqual(["ACME-5"]);

    const ambiguous = extractTicketKeys({
      title: "void predictions",
      body: "Relates to ACME-5 and ACME-6.",
      headBranch: "feat/void",
      projects: acme,
    });
    expect(ambiguous.primary).toBeNull();
    expect(ambiguous.auditKeys).toEqual([]);
    expect(ambiguous.referencedKeys).toEqual(["ACME-5", "ACME-6"]);
  });

  it("the real shape that motivated this: one delivered ticket, several related ones", () => {
    // A real-shaped case: the PR delivered ACME-822, mentioned ACME-824 / ACME-840 / ACME-821.
    const result = extractTicketKeys({
      title: "feat(ACME-822): read the cache password in every client",
      body: "Depends on ACME-821. The redis command line is ACME-824's. Related: ACME-840.",
      headBranch: "ACME-822-redis-password-in-code",
      projects: acme,
    });
    expect(result.auditKeys).toEqual(["ACME-822"]);
    expect(result.referencedKeys).toEqual(["ACME-821", "ACME-824", "ACME-840"]);
    expect(result.truncated).toBe(false);
  });

  it("closing keywords add delivered tickets after the primary", () => {
    const result = extractTicketKeys({
      title: "feat(ACME-1): thing",
      body: "Closes ACME-2, ACME-3. Refs ACME-4.",
      headBranch: "x",
      projects: acme,
    });
    expect(result.auditKeys).toEqual(["ACME-1", "ACME-2", "ACME-3"]);
    expect(result.closingKeys).toEqual(["ACME-2", "ACME-3"]);
    expect(result.referencedKeys).toEqual(["ACME-4"]);
    expect(result.truncated).toBe(false);
  });

  it("caps the delivered tickets and says so; references are not what overflows", () => {
    const result = extractTicketKeys({
      title: "ACME-1",
      body: "Closes ACME-2, ACME-3, ACME-4 and ACME-5. Refs ACME-6.",
      headBranch: "",
      projects: acme,
    });
    expect(result.auditKeys).toHaveLength(MAX_TICKET_KEYS);
    expect(result.truncated).toBe(true);
    // A delivered ticket past the cap is not demoted to "referenced".
    expect(result.referencedKeys).toEqual(["ACME-6"]);
  });

  it("a closing keyword does not deliver a key that runs into more text", () => {
    const result = extractTicketKeys({
      title: "Tidy up",
      body: "fixes ACME-12abc",
      headBranch: "",
      projects: acme,
    });
    expect(result.closingKeys).toEqual([]);
  });

  it("recognises every closing-keyword form", () => {
    for (const word of [
      "close",
      "closes",
      "closed",
      "fix",
      "fixes",
      "fixed",
      "resolve",
      "resolves",
      "resolved",
    ]) {
      const result = extractTicketKeys({
        title: "ACME-1",
        body: `${word} ACME-2`,
        headBranch: "",
        projects: acme,
      });
      expect(result.closingKeys, word).toEqual(["ACME-2"]);
    }
  });

  it("matches a configured project case-insensitively and normalises to upper case", () => {
    const result = extractTicketKeys({
      title: "fix(acme-12): thing",
      body: "",
      headBranch: "feat/acme-12-thing",
      projects: acme,
    });
    expect(result.auditKeys).toEqual(["ACME-12"]);
    expect(result.referencedKeys).toEqual([]);
  });

  it("ignores keys from projects that are not configured", () => {
    const result = extractTicketKeys({
      title: "MAR-44 and ACME-1",
      body: "HTTP-2 UTF-8",
      headBranch: "main",
      projects: acme,
    });
    expect(result.auditKeys).toEqual(["ACME-1"]);
    expect(result.referencedKeys).toEqual([]);
  });

  it("does not match a key embedded in a longer token", () => {
    const result = extractTicketKeys({
      title: "XACME-12 ACME-12a prefix_ACME-7",
      body: "",
      headBranch: "",
      projects: acme,
    });
    expect(result.auditKeys).toEqual([]);
    expect(result.referencedKeys).toEqual([]);
  });

  it("returns nothing for a PR with no key", () => {
    expect(
      extractTicketKeys({
        title: "chore: bump deps",
        body: undefined,
        headBranch: "chore/bump",
        projects: acme,
      }),
    ).toEqual({
      primary: null,
      closingKeys: [],
      auditKeys: [],
      referencedKeys: [],
      truncated: false,
    });
  });

  it("the closing-keyword scan stays linear on a long whitespace run", () => {
    const started = performance.now();
    extractTicketKeys({
      title: "x",
      body: `fix${" ".repeat(60_000)}`,
      headBranch: "",
      projects: acme,
    });
    expect(performance.now() - started).toBeLessThan(250);
  });

  describe("generic matching (no projects configured)", () => {
    it("matches upper-case keys and rejects standards-style tokens", () => {
      const result = extractTicketKeys({
        title: "PROJ-7: speak HTTP-2 with UTF-8 and SHA-256",
        body: "",
        headBranch: "",
        projects: [],
      });
      expect(result.auditKeys).toEqual(["PROJ-7"]);
    });

    it("stays case-sensitive so ordinary prose is not a key", () => {
      const result = extractTicketKeys({
        title: "bump to node-22 and step-3",
        body: "",
        headBranch: "feature/thing-2",
        projects: [],
      });
      expect(result.auditKeys).toEqual([]);
    });
  });

  it("drops a malformed project name instead of building a pattern from it", () => {
    const result = extractTicketKeys({
      title: "ACME-1 and anything-9",
      body: "",
      headBranch: "",
      projects: ["ACME", ".*", ""],
    });
    expect(result.auditKeys).toEqual(["ACME-1"]);
  });
});
