import type { Octokit } from "octokit";
import { describe, expect, it, vi } from "vitest";

import { isBranchRef } from "@terragon/utils/receive-pack-refs";

import {
  chooseMentionWorkBranch,
  isMentionWorkBranch,
  mentionWorkBranchName,
} from "./mention-work-branch";

const name = (title: string, body: string | null = null) =>
  mentionWorkBranchName({ title, body });

describe("mentionWorkBranchName", () => {
  it("AC-1: a bracketed key and a plain title give feat/<KEY>-<slug>", () => {
    expect(name("[ACME-123] Add request logging")).toBe(
      "feat/ACME-123-add-request-logging",
    );
  });

  it("takes the type from the Conventional prefix", () => {
    expect(name("fix: ACME-9 handle null input")).toBe(
      "fix/ACME-9-handle-null-input",
    );
    expect(name("Docs(readme)!: ACME-4 explain setup")).toBe(
      "docs/ACME-4-explain-setup",
    );
  });

  it("defaults to feat when there is no known type prefix", () => {
    expect(name("wip: ACME-2 try it")).toBe("feat/ACME-2-try-it");
    expect(name("ACME-2 try it")).toBe("feat/ACME-2-try-it");
  });

  it("finds the key in a scope and uses the words after the prefix", () => {
    expect(name("feat(ACME-5): add x")).toBe("feat/ACME-5-add-x");
  });

  it("returns null with no key in the title or the body", () => {
    expect(name("Add request logging")).toBeNull();
    expect(name("Add request logging", "no ticket here")).toBeNull();
    expect(name("Add request logging", null)).toBeNull();
  });

  it("falls back to the body for the key and the title for the slug", () => {
    expect(name("fix: Add request logging", "Tracked in ACME-77.")).toBe(
      "fix/ACME-77-add-request-logging",
    );
  });

  it("prefers the title's key over the body's", () => {
    expect(name("ACME-1 first", "ACME-2")).toBe("feat/ACME-1-first");
  });

  it("uses the words before the key when nothing follows it", () => {
    expect(name("Add request logging ACME-123")).toBe(
      "feat/ACME-123-add-request-logging",
    );
    expect(name("fix: Add logging ACME-8")).toBe("fix/ACME-8-add-logging");
  });

  it("gives a bare <type>/<KEY> when no words are left", () => {
    expect(name("ACME-123")).toBe("feat/ACME-123");
    expect(name("[ACME-123]")).toBe("feat/ACME-123");
    expect(name("fix(ACME-5):")).toBe("fix/ACME-5");
    expect(name("fix: ACME-123 !!!")).toBe("fix/ACME-123");
  });

  describe("the denylist", () => {
    it.each(["UTF-8", "SHA-256", "ISO-8601", "RFC-7231"])(
      "skips %s and takes the next key",
      (standard) => {
        expect(name(`Support ${standard} names (ACME-7)`)).toBe(
          `feat/ACME-7-support-${standard.toLowerCase()}-names`,
        );
      },
    );
    it("returns null when only a denylisted match exists", () => {
      expect(name("Support UTF-8 names")).toBeNull();
      expect(name("Support UTF-8 names", "see RFC-7231")).toBeNull();
    });
    it("a denylisted key in the title falls through to the body", () => {
      expect(name("Support UTF-8 names", "ACME-3")).toBe(
        "feat/ACME-3-support-utf-8-names",
      );
    });
  });

  describe("key boundaries", () => {
    it.each([
      ["inside a longer word", "fooACME-12 thing"],
      ["followed by a letter", "ACME-12x thing"],
      ["lowercase", "acme-12 thing"],
      ["a one-letter project", "A-12 thing"],
      ["a number over 12 digits", "ACME-1234567890123 thing"],
      ["a project over 32 characters", `${"A".repeat(33)}-1 thing`],
    ])("does not match %s", (_, title) => {
      expect(name(title)).toBeNull();
    });
    it("matches a key next to punctuation", () => {
      expect(name("(ACME-12) thing")).toBe("feat/ACME-12-thing");
      expect(name("x/ACME-12.")).toBe("feat/ACME-12-x");
    });
    it("matches the longest allowed key", () => {
      const project = `A${"B".repeat(31)}`;
      expect(name(`${project}-123456789012 x`)).toBe(
        `feat/${project}-123456789012-x`,
      );
    });
  });

  describe("the slug", () => {
    it("is ASCII kebab-case: diacritics stripped, symbols collapsed", () => {
      expect(name("ACME-1 Añadir logs: café & crème")).toBe(
        "feat/ACME-1-anadir-logs-cafe-creme",
      );
    });
    it("drops a title that is all non-Latin script", () => {
      expect(name("ACME-1 日本語のタイトル")).toBe("feat/ACME-1");
    });
    it("cuts at the last word boundary within 40 characters", () => {
      const out = name(
        "ACME-1 implement the very long request logging middleware now",
      );
      expect(out).toBe("feat/ACME-1-implement-the-very-long-request-logging");
      const slug = out?.slice("feat/ACME-1-".length) ?? "";
      expect(slug.length).toBeLessThanOrEqual(40);
    });
    it("keeps a slug of exactly 40 characters whole", () => {
      const slug = `${"a".repeat(19)}-${"b".repeat(20)}`;
      expect(slug).toHaveLength(40);
      expect(name(`ACME-1 ${slug}`)).toBe(`feat/ACME-1-${slug}`);
    });
    it("cuts at 40 when a word boundary falls right after it", () => {
      const out = name(`ACME-1 ${"a".repeat(40)} tail`);
      expect(out).toBe(`feat/ACME-1-${"a".repeat(40)}`);
    });
    it("hard-cuts a single word longer than 40 characters", () => {
      expect(name(`ACME-1 ${"a".repeat(5000)}`)).toBe(
        `feat/ACME-1-${"a".repeat(40)}`,
      );
    });
    it("survives an extreme title", () => {
      const out = name(`ACME-1 ${"word ".repeat(40_000)}`);
      expect(out).not.toBeNull();
      expect(out?.length).toBeLessThanOrEqual(128);
    });
  });

  describe("fence-hostile titles never escape the shape", () => {
    it.each([
      ["a double dot", "ACME-1 ../../etc/passwd"],
      ["@{", "ACME-1 @{upstream} and HEAD@{1}"],
      [".lock", "ACME-1 fix foo.lock"],
      ["a leading dash", "ACME-1 --force -rf"],
      ["a trailing dot", "ACME-1 stop."],
      ["git punctuation", "ACME-1 a~b^c:d?e*f[g\\h i"],
      ["control characters", "ACME-1 a\u0000b\u001fc\u007fd\ne"],
      ["a lone surrogate", "ACME-1 a\ud800b"],
      ["a replacement character", "ACME-1 a�b"],
      ["emoji and unicode", "ACME-1 ship it 🚀 ñandú Ωmega"],
      ["fullwidth letters", "ACME-1 ＡＢＣ１２３"],
      ["a slash and a leading dot", "ACME-1 /.hidden/ .x"],
    ])("%s", (_, title) => {
      const out = name(title);
      expect(out).not.toBeNull();
      expect(isMentionWorkBranch(out ?? "")).toBe(true);
      expect(isBranchRef(`refs/heads/${out}`)).toBe(true);
      expect(out).toMatch(/^feat\/ACME-1(-[a-z0-9]+)*$/);
      expect(out).not.toMatch(/\.\.|@\{|\.lock|\/-|\.$/);
    });
    it("a hostile key position still yields a valid name or null", () => {
      for (const title of [
        "../ACME-1",
        "-ACME-1 x",
        "@{ACME-1}",
        "ACME-1.lock",
        "ACME-1..2",
      ]) {
        const out = name(title);
        if (out !== null) expect(isMentionWorkBranch(out)).toBe(true);
      }
    });
  });

  it("never resolves to the base branch or main", () => {
    for (const title of [
      "main",
      "ACME-1 main",
      "ACME-1",
      "develop ACME-2",
      "master",
    ]) {
      const out = name(title);
      expect(out).not.toBe("main");
      expect(out).not.toBe("develop");
      expect(out).not.toBe("master");
      if (out !== null) expect(out).toMatch(/^[a-z]+\/ACME-\d+/);
    }
  });
});

describe("isMentionWorkBranch", () => {
  it.each([
    "feat/ACME-123-add-request-logging",
    "fix/ACME-9",
    "refactor/AB1-5-a-b-c",
    "ci/ACME-1-add-request-logging-0a1b2c3d",
  ])("accepts %s", (candidate) => {
    expect(isMentionWorkBranch(candidate)).toBe(true);
  });

  it.each([
    ["the base branch", "main"],
    ["develop", "develop"],
    ["a bare key", "ACME-1"],
    ["the task branch", "automata/task-abcdef12"],
    ["a dotted path", "feat/../x"],
    ["a dotted path with a key", "feat/ACME-1/../x"],
    [".lock", "feat/ACME-1.lock"],
    [".lock slug", "feat/ACME-1-foo.lock"],
    ["a reflog", "feat/ACME-1@{1}"],
    ["non-ASCII", "feat/ACME-1-café"],
    ["fullwidth", "feat/ACME-１"],
    ["a leading dash", "-feat/ACME-1"],
    ["a space", "feat/ACME-1 x"],
    ["an unknown type", "wip/ACME-1"],
    ["uppercase in the slug", "feat/ACME-1-Add"],
    ["a double dash", "feat/ACME-1--x"],
    ["a trailing dash", "feat/ACME-1-"],
    ["a trailing slash", "feat/ACME-1/"],
    ["a nested slash", "feat/ACME-1/x"],
    ["an empty name", ""],
    ["a lowercase key", "feat/acme-1"],
    ["over 128 characters", `feat/ACME-1-${"a".repeat(120)}`],
  ])("refuses %s", (_, candidate) => {
    expect(isMentionWorkBranch(candidate)).toBe(false);
  });
});

describe("chooseMentionWorkBranch", () => {
  const BARE = "feat/ACME-123-add-request-logging";
  const input = { title: "[ACME-123] Add request logging", body: null };

  function fakeOctokit(getRef: () => Promise<unknown>) {
    const spy = vi.fn(getRef);
    const octokit = { rest: { git: { getRef: spy } } } as unknown as Octokit;
    return { octokit, getRef: spy };
  }
  const notFound = () =>
    Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));
  const failing = (status: number) => () =>
    Promise.reject(Object.assign(new Error("boom"), { status }));

  const choose = (
    gh: ReturnType<typeof fakeOctokit>,
    isClaimed: (n: string) => Promise<boolean>,
    over: Partial<typeof input> = {},
  ) =>
    chooseMentionWorkBranch({
      octokit: gh.octokit,
      owner: "acme",
      repo: "widgets",
      ...input,
      ...over,
      isClaimed,
    });

  it("returns {} and calls nothing when the issue names no key", async () => {
    const gh = fakeOctokit(notFound);
    const isClaimed = vi.fn(async () => false);
    await expect(
      choose(gh, isClaimed, { title: "No ticket here" }),
    ).resolves.toEqual({});
    expect(gh.getRef).not.toHaveBeenCalled();
    expect(isClaimed).not.toHaveBeenCalled();
  });

  it("writes the bare name on a 404 when nothing claims it", async () => {
    const gh = fakeOctokit(notFound);
    const isClaimed = vi.fn(async () => false);
    const out = await choose(gh, isClaimed);
    expect(out).toEqual({ workBranch: BARE });
    expect(out).not.toHaveProperty("workBranchTaken");
    expect(gh.getRef).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      ref: `heads/${BARE}`,
    });
    expect(isClaimed).toHaveBeenCalledWith(BARE);
  });

  it("marks the name taken when the branch exists on the remote", async () => {
    const gh = fakeOctokit(async () => ({ data: {} }));
    await expect(choose(gh, async () => false)).resolves.toEqual({
      workBranch: BARE,
      workBranchTaken: true,
    });
  });

  it("marks the name taken when a thread already claims it (RF-1)", async () => {
    const gh = fakeOctokit(notFound);
    await expect(choose(gh, async () => true)).resolves.toEqual({
      workBranch: BARE,
      workBranchTaken: true,
    });
  });

  it("fails open to the suffix when the claim query rejects", async () => {
    const gh = fakeOctokit(notFound);
    await expect(
      choose(gh, async () => {
        throw new Error("db down");
      }),
    ).resolves.toEqual({ workBranch: BARE, workBranchTaken: true });
  });

  it("fails open to the suffix when the claim query throws synchronously", async () => {
    const gh = fakeOctokit(notFound);
    await expect(
      choose(gh, () => {
        throw new Error("db down");
      }),
    ).resolves.toEqual({ workBranch: BARE, workBranchTaken: true });
  });

  it.each([500, 403, 401])(
    "fails open to the suffix on a %i from getRef",
    async (status) => {
      const gh = fakeOctokit(failing(status));
      await expect(choose(gh, async () => false)).resolves.toEqual({
        workBranch: BARE,
        workBranchTaken: true,
      });
    },
  );

  it("fails open to the suffix when getRef throws a non-HTTP error", async () => {
    const gh = fakeOctokit(() => Promise.reject(new Error("network")));
    await expect(choose(gh, async () => false)).resolves.toEqual({
      workBranch: BARE,
      workBranchTaken: true,
    });
    const gh2 = fakeOctokit(() => Promise.reject("nope"));
    await expect(choose(gh2, async () => false)).resolves.toEqual({
      workBranch: BARE,
      workBranchTaken: true,
    });
  });
});
