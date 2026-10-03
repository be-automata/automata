import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/auth", () => ({
  signInWithGithub: vi.fn(),
}));

const { signInWithGithub } = await import("@/components/auth");
const { RepoListEmptyState } = await import("./create-environment-button");

interface ElementWithProps {
  props: { onClick?: () => void; children?: unknown };
}

/** Depth-first search of a rendered element tree for the first onClick. */
function findOnClick(node: unknown): (() => void) | undefined {
  if (!node || typeof node !== "object") {
    return undefined;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findOnClick(child);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  const { props } = node as ElementWithProps;
  if (!props) {
    return undefined;
  }
  return props.onClick ?? findOnClick(props.children);
}

// An expired GitHub user token lists ZERO repos. The dialog used to say "No
// repositories found." and point at the App-install page, which cannot fix it.
describe("RepoListEmptyState", () => {
  it("offers Reconnect GitHub instead of 'No repositories found.' when the token is missing", () => {
    const html = renderToStaticMarkup(
      <RepoListEmptyState githubTokenMissing searchQuery="" />,
    );
    expect(html).toContain("Reconnect GitHub");
    expect(html).toContain("GitHub connection expired");
    expect(html).not.toContain("No repositories found.");
  });

  it("reconnecting returns the user to /environments", () => {
    const element = RepoListEmptyState({
      githubTokenMissing: true,
      searchQuery: "",
    });
    const onClick = findOnClick(element);
    expect(onClick).toBeDefined();
    onClick?.();
    expect(signInWithGithub).toHaveBeenCalledWith(
      expect.objectContaining({ returnUrl: "/environments" }),
    );
  });

  it("keeps the ordinary empty states when the token is fine", () => {
    expect(
      renderToStaticMarkup(
        <RepoListEmptyState githubTokenMissing={false} searchQuery="" />,
      ),
    ).toContain("No repositories found.");
    expect(
      renderToStaticMarkup(
        <RepoListEmptyState githubTokenMissing={false} searchQuery="widgets" />,
      ),
    ).toContain("No repositories found matching your search.");
  });
});
