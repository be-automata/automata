import { describe, it, expect } from "vitest";
import { repoEmptyText } from "./repo-branch-selector";

describe("repoEmptyText", () => {
  it("names the expired GitHub connection instead of blaming a missing repo", () => {
    // The repo list needs the user's GitHub OAuth token (8h, never refreshed);
    // the branch list needs only the App installation token. When the user token
    // dies the picker empties while branches still work, and the generic copy
    // ("Add a repo to get started.") points at the App-install page — a fix that
    // cannot work. Both search states must say the same true thing.
    const text = repoEmptyText(true);
    expect(text(false)).toMatch(/GitHub connection expired/);
    expect(text(true)).toMatch(/GitHub connection expired/);
  });

  it("keeps the ordinary empty states when the token is fine", () => {
    const text = repoEmptyText(false);
    expect(text(false)).toBe("Add a repo to get started.");
    expect(text(true)).toBe("No repositories found.");
  });
});
