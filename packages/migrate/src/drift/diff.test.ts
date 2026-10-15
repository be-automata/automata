import { describe, expect, it } from "vitest";

import type { Catalog, CatalogEntry } from "./catalog";
import {
  AllowlistError,
  diffCatalogs,
  formatDiffReport,
  parseAllowlist,
} from "./diff";

function catalog(...entries: CatalogEntry[]): Catalog {
  return { entries };
}

const column = (name: string, definition: string): CatalogEntry => ({
  kind: "column",
  table: "thread",
  name,
  definition,
});

describe("diffCatalogs", () => {
  it("reports a missing column, an extra index and a default mismatch", () => {
    const a = catalog(
      column("id", "integer | not null | default none"),
      column("repo", "text | null | default none"),
      column("title", "text | null | default none"),
    );
    const b = catalog(
      column("id", "integer | not null | default none"),
      column("repo", "text | null | default ''::text"),
      {
        kind: "index",
        table: "thread",
        name: "thread_repo_index",
        definition:
          "CREATE INDEX thread_repo_index ON public.thread USING btree (repo)",
      },
    );
    const result = diffCatalogs(a, b, []);
    expect(result.diffs.map((d) => [d.kind, d.name, d.change])).toEqual([
      ["column", "repo", "differs"],
      ["column", "title", "only-in-a"],
      ["index", "thread_repo_index", "only-in-b"],
    ]);
    expect(result.unusedAllow).toEqual([]);
  });

  it("matches allowlist entries on kind, table and name", () => {
    const a = catalog(column("repo", "text | null | default none"));
    const b = catalog(column("repo", "text | null | default ''::text"));
    const otherTable = {
      kind: "column" as const,
      table: "message",
      name: "repo",
      reason: "different table",
    };
    const hit = {
      kind: "column" as const,
      table: "thread",
      name: "repo",
      reason: "known",
    };
    const result = diffCatalogs(a, b, [otherTable, hit]);
    expect(result.diffs).toEqual([]);
    expect(result.allowed.map((d) => d.reason)).toEqual(["known"]);
    expect(result.unusedAllow).toEqual([otherTable]);
  });

  it("names stale entries in the report", () => {
    const report = formatDiffReport(
      diffCatalogs(catalog(), catalog(), [
        { kind: "enum", table: null, name: "status", reason: "gone" },
      ]),
    );
    expect(report).toContain("stale allowlist entry enum status");
  });
});

describe("parseAllowlist", () => {
  it("accepts well-formed entries", () => {
    expect(
      parseAllowlist([
        { kind: "index", table: "t", name: "i", reason: "push artifact" },
        { kind: "enum", table: null, name: "e", reason: "why" },
      ]),
    ).toHaveLength(2);
  });

  it.each([
    [{}],
    [[{ kind: "view", table: "t", name: "v", reason: "r" }]],
    [[{ kind: "index", table: "t", name: "i", reason: "" }]],
    [[{ kind: "index", table: 3, name: "i", reason: "r" }]],
    [
      [
        { kind: "index", table: "t", name: "i", reason: "r" },
        { kind: "index", table: "t", name: "i", reason: "again" },
      ],
    ],
  ])("rejects %j", (value) => {
    expect(() => parseAllowlist(value)).toThrow(AllowlistError);
  });
});
