/**
 * T7: push-time skill flattening (deploy/lib/flatten-skill.ts).
 *
 *   Run:  node --test deploy/flatten-skill.test.ts
 *
 * protects=no half-flattened skill ships: every include resolves or the push
 *   aborts before anything is written, and the same inputs give the same sha;
 * fails_when=a partial is silently skipped, an unpinned URL is fetched, a
 *   404 still writes --out, or two runs differ by a byte;
 * no_claim=the network (fetch is a fake here) and the www validator (the
 *   real validateSkillBody runs in the skill-push dry run, not in this file).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  FlattenError,
  MAX_INCLUDE_DEPTH,
  flattenSkillBody,
  prepareSkillBody,
  skillBodySha,
  type FetchText,
  type FlattenOptions,
} from "./lib/flatten-skill.ts";

const SHA = "1584e818d0243df9e9cbc8e6c0a9c34862d05dcf";
const pinnedUrl = (file: string) =>
  `https://raw.githubusercontent.com/example-org/rules/${SHA}/rules/${file}`;

/**
 * Stands in for review-skill.ts `stripFrontmatter` (www, not loadable under
 * node --test): drop a leading `---` block, then trim — the same contract.
 */
function stripFrontmatter(md: string): string {
  if (!md.startsWith("---")) return md.trim();
  const fence = /\n---[ \t]*(?:\r?\n|$)/.exec(md.slice(3));
  if (!fence) return md.trim();
  return md.slice(3 + fence.index + fence[0].length).trim();
}

function fakeFetch(files: Record<string, { status: number; body?: string }>) {
  const calls: string[] = [];
  const fetchText: FetchText = async (url) => {
    calls.push(url);
    const hit = files[url] ?? { status: 404 };
    return { status: hit.status, text: async () => hit.body ?? "Not Found" };
  };
  return { fetchText, calls };
}

function options(
  partials: Record<string, string>,
  fetchText: FetchText = fakeFetch({}).fetchText,
): FlattenOptions {
  return {
    readPartial: (name) => {
      const text = partials[name];
      if (text === undefined) throw new Error(`ENOENT _shared/${name}.md`);
      return text;
    },
    fetchText,
    stripFrontmatter,
  };
}

describe("flattenSkillBody: include", () => {
  test("replaces each whole-line include with the partial, frontmatter stripped", async () => {
    const body = [
      "# Skill",
      "<!-- include: alpha -->",
      "<!-- include: beta -->",
      "- after",
    ].join("\n");
    const out = await flattenSkillBody(
      body,
      options({
        alpha: "---\nname: alpha\n---\n- from alpha\n",
        beta: "- from beta",
      }),
    );
    assert.equal(out, "# Skill\n- from alpha\n- from beta\n- after");
  });

  test("a body without directives comes back unchanged", async () => {
    const body = "# Skill\n\nNo includes here.\n";
    assert.equal(await flattenSkillBody(body, options({})), body);
  });

  test("a partial may include one more partial (depth 2)", async () => {
    const out = await flattenSkillBody(
      "<!-- include: outer -->",
      options({
        outer: "outer start\n<!-- include: inner -->\nouter end",
        inner: "inner text",
      }),
    );
    assert.equal(out, "outer start\ninner text\nouter end");
  });

  test("a missing partial throws and names it", async () => {
    await assert.rejects(
      flattenSkillBody("x\n<!-- include: nope -->", options({})),
      (err: unknown) =>
        err instanceof FlattenError &&
        /line 2: partial "nope" not found/.test(err.message),
    );
  });

  test(`nesting deeper than ${MAX_INCLUDE_DEPTH} levels throws`, async () => {
    await assert.rejects(
      flattenSkillBody(
        "<!-- include: one -->",
        options({
          one: "<!-- include: two -->",
          two: "<!-- include: three -->",
          three: "too deep",
        }),
      ),
      (err: unknown) =>
        err instanceof FlattenError &&
        /_shared\/two\.md line 1: include nested deeper than 2/.test(
          err.message,
        ),
    );
  });

  test("a malformed or indented include line throws instead of passing through", async () => {
    for (const line of [
      "<!-- include: Upper_Case -->",
      "  <!-- include: alpha -->",
      "<!-- include:alpha -->",
      "<!-- include-pinned: -->",
      "<!-- includes: alpha -->",
    ]) {
      await assert.rejects(
        flattenSkillBody(line, options({ alpha: "a" })),
        (err: unknown) =>
          err instanceof FlattenError &&
          /malformed include directive/.test(err.message),
        line,
      );
    }
  });
});

describe("flattenSkillBody: include-pinned", () => {
  test("inlines the pinned file verbatim under a pinned heading", async () => {
    const { fetchText, calls } = fakeFetch({
      [pinnedUrl("testing.md")]: {
        status: 200,
        body: "---\nfront: kept\n---\n# Testing\n\n- rule\n",
      },
    });
    const out = await flattenSkillBody(
      `1. inlined below\n\n<!-- include-pinned: ${pinnedUrl("testing.md")} -->\n\n2. next`,
      options({}, fetchText),
    );
    assert.equal(
      out,
      "1. inlined below\n\n" +
        "#### testing.md (pinned example-org/rules@1584e81)\n\n" +
        "---\nfront: kept\n---\n# Testing\n\n- rule\n" +
        "\n\n2. next",
    );
    assert.deepEqual(calls, [pinnedUrl("testing.md")]);
  });

  test("rejects every URL that is not raw GitHub content at a 40-hex sha", async () => {
    for (const url of [
      `https://raw.githubusercontent.com/example-org/rules/main/rules/testing.md`,
      `https://raw.githubusercontent.com/example-org/rules/${SHA.slice(0, 7)}/rules/testing.md`,
      `https://raw.githubusercontent.com/example-org/rules/${SHA.toUpperCase()}/rules/testing.md`,
      `http://raw.githubusercontent.com/example-org/rules/${SHA}/rules/testing.md`,
      `https://example.com/example-org/rules/${SHA}/rules/testing.md`,
      `https://raw.githubusercontent.com/example-org/rules/${SHA}/rules/testing.txt`,
      `https://raw.githubusercontent.com.evil.test/example-org/rules/${SHA}/rules/testing.md`,
    ]) {
      const { fetchText, calls } = fakeFetch({});
      await assert.rejects(
        flattenSkillBody(
          `<!-- include-pinned: ${url} -->`,
          options({}, fetchText),
        ),
        (err: unknown) =>
          err instanceof FlattenError &&
          /include-pinned URL must be raw\.githubusercontent\.com/.test(
            err.message,
          ),
        url,
      );
      assert.deepEqual(calls, [], `${url} must never be fetched`);
    }
  });

  test("a pinned include inside a partial counts toward the depth limit", async () => {
    const { fetchText } = fakeFetch({
      [pinnedUrl("a.md")]: { status: 200, body: "A" },
    });
    // depth 2 (partial → pinned) is fine …
    assert.equal(
      await flattenSkillBody(
        "<!-- include: std -->",
        options(
          { std: `<!-- include-pinned: ${pinnedUrl("a.md")} -->` },
          fetchText,
        ),
      ),
      "#### a.md (pinned example-org/rules@1584e81)\n\nA",
    );
    // … depth 3 (partial → partial → pinned) is not.
    await assert.rejects(
      flattenSkillBody(
        "<!-- include: outer -->",
        options(
          {
            outer: "<!-- include: std -->",
            std: `<!-- include-pinned: ${pinnedUrl("a.md")} -->`,
          },
          fetchText,
        ),
      ),
      /include nested deeper than 2/,
    );
  });
});

describe("prepareSkillBody: abort before any write", () => {
  const raw =
    "---\nname: s\n---\n# Skill\n" +
    `<!-- include-pinned: ${pinnedUrl("ok.md")} -->\n` +
    `<!-- include-pinned: ${pinnedUrl("gone.md")} -->\n`;

  for (const [label, failing] of [
    ["a 404", { status: 404 }],
    ["a 500", { status: 500 }],
  ] as const) {
    test(`${label} on any pinned URL rejects and writes nothing`, async () => {
      const { fetchText } = fakeFetch({
        [pinnedUrl("ok.md")]: { status: 200, body: "ok" },
        [pinnedUrl("gone.md")]: failing,
      });
      const writes: string[] = [];
      let validated = false;
      await assert.rejects(
        prepareSkillBody({
          raw,
          skillName: "s",
          label: "SKILL.md",
          flatten: options({}, fetchText),
          validate: () => {
            validated = true;
          },
          writeOut: (body) => writes.push(body),
        }),
        new RegExp(`returned HTTP ${failing.status} \\(expected 200\\)`),
      );
      assert.equal(validated, false);
      assert.deepEqual(writes, []);
    });
  }

  test("a network error rejects and writes nothing", async () => {
    const writes: string[] = [];
    await assert.rejects(
      prepareSkillBody({
        raw,
        skillName: "s",
        label: "SKILL.md",
        flatten: options({}, async () => {
          throw new Error("getaddrinfo ENOTFOUND");
        }),
        validate: () => {},
        writeOut: (body) => writes.push(body),
      }),
      /failed: getaddrinfo ENOTFOUND/,
    );
    assert.deepEqual(writes, []);
  });

  test("a validation failure (after flattening) writes nothing", async () => {
    const { fetchText } = fakeFetch({
      [pinnedUrl("ok.md")]: { status: 200, body: "ok" },
      [pinnedUrl("gone.md")]: { status: 200, body: "back" },
    });
    const writes: string[] = [];
    const seen: string[] = [];
    await assert.rejects(
      prepareSkillBody({
        raw,
        skillName: "s",
        label: "SKILL.md",
        flatten: options({}, fetchText),
        validate: (_name, body) => {
          seen.push(body);
          throw new Error("no verdict contract");
        },
        writeOut: (body) => writes.push(body),
      }),
      /no verdict contract/,
    );
    // The validator saw the FLATTENED body, never a directive.
    assert.equal(seen.length, 1);
    assert.doesNotMatch(seen[0]!, /<!-- include/);
    assert.deepEqual(writes, []);
  });
});

describe("prepareSkillBody: deterministic output", () => {
  test("the same inputs give the same bytes and sha, whatever the fetch timing", async () => {
    const raw = [
      "# Skill",
      "<!-- include: std -->",
      `<!-- include-pinned: ${pinnedUrl("b.md")} -->`,
    ].join("\n");
    const partials = {
      std: `<!-- include-pinned: ${pinnedUrl("a.md")} -->\ntail`,
    };
    const run = async (delays: Record<string, number>) => {
      const fetchText: FetchText = async (url) => {
        await new Promise((r) => setTimeout(r, delays[url] ?? 0));
        return {
          status: 200,
          text: async () => `content of ${path.basename(url)}\n`,
        };
      };
      const writes: string[] = [];
      const prepared = await prepareSkillBody({
        raw,
        skillName: "s",
        label: "SKILL.md",
        flatten: options(partials, fetchText),
        validate: () => {},
        writeOut: (body) => writes.push(body),
      });
      assert.deepEqual(writes, [prepared.body]);
      return prepared;
    };
    const first = await run({ [pinnedUrl("a.md")]: 15 });
    const second = await run({ [pinnedUrl("b.md")]: 15 });
    assert.equal(first.body, second.body);
    assert.equal(first.sha, second.sha);
    assert.equal(first.sha, skillBodySha(first.body));
    assert.equal(first.bytes, Buffer.byteLength(first.body, "utf8"));
    assert.match(first.sha, /^[0-9a-f]{64}$/);
  });
});

describe("the tracked ported skills flatten completely", () => {
  const skillsDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "skills",
  );
  const readPartial = (name: string) =>
    readFileSync(path.join(skillsDir, "_shared", `${name}.md`), "utf8");
  const read = (skill: string) =>
    readFileSync(path.join(skillsDir, skill, "SKILL.md"), "utf8");

  test("flutter-pr-review: seven pinned sections, no directive left", async () => {
    const { fetchText, calls } = fakeFetch(
      Object.fromEntries(
        [
          "testing.md",
          "bloc-test.md",
          "architecture.md",
          "best-practices.md",
          "code-patterns.md",
          "layout.md",
          "ui-theming.md",
        ].map((file) => [
          `https://raw.githubusercontent.com/somnio-software/somnio-ai-tools/${SHA}/agent-rules/rules/flutter/${file}`,
          { status: 200, body: `# ${file}\n` },
        ]),
      ),
    );
    const body = await flattenSkillBody(
      stripFrontmatter(read("flutter-pr-review")),
      { readPartial, fetchText, stripFrontmatter },
    );
    const headings = body.match(
      /^#### [a-z-]+\.md \(pinned somnio-software\/somnio-ai-tools@1584e81\)$/gm,
    );
    assert.equal(headings?.length, 7);
    assert.equal(calls.length, 7);
    assert.doesNotMatch(body, /<!-- include/);
    assert.equal(
      body.match(
        /^<!-- automata:context pr-view prior-reviews review-threads -->$/gm,
      )?.length,
      1,
    );
  });

  test("github-ops: partials inlined, nothing fetched", async () => {
    const { fetchText, calls } = fakeFetch({});
    const body = await flattenSkillBody(stripFrontmatter(read("github-ops")), {
      readPartial,
      fetchText,
      stripFrontmatter,
    });
    assert.equal(calls.length, 0);
    assert.doesNotMatch(body, /<!-- include/);
    assert.match(body, /The four `\/simplify` lenses/);
    assert.match(body, /```json[\s\S]*"verdict"[\s\S]*```/);
  });
});
