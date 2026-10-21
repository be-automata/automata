import { describe, it, expect } from "vitest";

import { isBotAuthor, isPrAuthoredByBot } from "./bot-login";

describe("isPrAuthoredByBot", () => {
  it("matches the App's `<slug>[bot]` author login against the review bot", () => {
    expect(
      isPrAuthoredByBot("automata-ai-bot[bot]", "automata-ai-bot[bot]"),
    ).toBe(true);
  });

  it("ignores case, as GitHub logins do", () => {
    expect(
      isPrAuthoredByBot("Automata-AI-Bot[bot]", "automata-ai-bot[bot]"),
    ).toBe(true);
  });

  it.each([
    ["a person", "octocat"],
    ["another app", "dependabot[bot]"],
    ["the slug without [bot]", "automata-ai-bot"],
    ["a deleted account", null],
    ["an unknown author", undefined],
  ])("is false for %s", (_label, authorLogin) => {
    expect(isPrAuthoredByBot(authorLogin, "automata-ai-bot[bot]")).toBe(false);
  });

  it("is false when no bot login is configured", () => {
    expect(isPrAuthoredByBot("automata-ai-bot[bot]", "")).toBe(false);
  });
});

describe("isBotAuthor", () => {
  it("matches the REST (`[bot]`) and GraphQL (bare) forms, any case", () => {
    for (const login of ["automata-ai-bot[bot]", "Automata-AI-Bot"]) {
      expect(isBotAuthor(login, "automata-ai-bot[bot]"), login).toBe(true);
    }
  });

  it.each([
    ["a person", "octocat"],
    ["another app", "dependabot[bot]"],
    ["a longer handle", "automata-ai-bot-2"],
    ["a deleted account", null],
  ])("is false for %s", (_label, login) => {
    expect(isBotAuthor(login, "automata-ai-bot[bot]")).toBe(false);
  });

  it("is false when no bot login is configured", () => {
    expect(isBotAuthor("automata-ai-bot", "")).toBe(false);
  });
});
