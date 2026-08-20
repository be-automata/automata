import { describe, it, expect } from "vitest";
import {
  parseGitPackRef,
  fetchGitPackBody,
} from "../../../../../deploy/lib/git-pack-ref";

// deploy/lib has no test runner of its own; like skill-contract-drift.test.ts
// (which imports deploy/lib/review-skill-file), this pure-logic test lives in
// apps/www where vitest runs it.

const SHA = "a".repeat(40);

describe("parseGitPackRef (#64 git skill packs — pinned refs only)", () => {
  it("parses owner/repo@sha:path into canonical provenance", () => {
    const r = parseGitPackRef(
      `be-automata/skill-library@${SHA}:github-ops/SKILL.md`,
    );
    expect(r).toEqual({
      owner: "be-automata",
      repo: "skill-library",
      sha: SHA,
      path: "github-ops/SKILL.md",
      canonical: `be-automata/skill-library@${SHA}:github-ops/SKILL.md`,
    });
  });

  it("lowercases the sha so provenance is canonical", () => {
    const r = parseGitPackRef(`o/r@${"A".repeat(40)}:p.md`);
    expect(r.sha).toBe(SHA);
    expect(r.canonical).toContain(SHA);
  });

  it("REJECTS a branch name in place of a sha (the pin is the point)", () => {
    expect(() => parseGitPackRef("o/r@main:p.md")).toThrow(/40-hex commit sha/);
  });

  it("rejects a short sha", () => {
    expect(() => parseGitPackRef("o/r@abc123:p.md")).toThrow(/40-hex/);
  });

  it("rejects a missing path", () => {
    expect(() => parseGitPackRef(`o/r@${SHA}`)).toThrow(/missing ':<path>'/);
    expect(() => parseGitPackRef(`o/r@${SHA}:`)).toThrow(/empty path/);
  });

  it("rejects a malformed repo", () => {
    expect(() => parseGitPackRef(`justrepo@${SHA}:p.md`)).toThrow(/owner\/repo/);
    expect(() => parseGitPackRef(`a/b/c@${SHA}:p.md`)).toThrow(/owner\/repo/);
  });

  it("rejects input with no @", () => {
    expect(() => parseGitPackRef("o/r:p.md")).toThrow(/owner\/repo@/);
  });
});

describe("fetchGitPackBody", () => {
  const ref = parseGitPackRef(`o/r@${SHA}:p.md`);

  it("requests the contents API at the pinned sha and returns raw text", async () => {
    let calledUrl = "";
    const fakeFetch = (async (url: string) => {
      calledUrl = String(url);
      return { ok: true, status: 200, text: async () => "SKILL BODY" };
    }) as unknown as typeof fetch;
    await expect(fetchGitPackBody(ref, fakeFetch)).resolves.toBe("SKILL BODY");
    expect(calledUrl).toBe(
      `https://api.github.com/repos/o/r/contents/p.md?ref=${SHA}`,
    );
  });

  it("throws a helpful message on 404", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 404,
      text: async () => "",
    })) as unknown as typeof fetch;
    await expect(fetchGitPackBody(ref, fakeFetch)).rejects.toThrow(
      /404.*GITHUB_TOKEN/s,
    );
  });
});
