import { describe, it, expect } from "vitest";
import { diffLines, diffStat } from "./line-diff";

describe("diffLines (#64 slice 2 — skill version diff)", () => {
  it("identical bodies are all context, no add/del", () => {
    const rows = diffLines("a\nb\nc", "a\nb\nc");
    expect(rows.every((r) => r.kind === "ctx")).toBe(true);
    expect(diffStat(rows)).toEqual({ added: 0, removed: 0 });
    expect(rows.map((r) => [r.aLine, r.bLine])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it("a changed middle line reads as one del + one add", () => {
    const rows = diffLines("a\nOLD\nc", "a\nNEW\nc");
    expect(rows.map((r) => `${r.kind}:${r.text}`)).toEqual([
      "ctx:a",
      "del:OLD",
      "add:NEW",
      "ctx:c",
    ]);
    expect(diffStat(rows)).toEqual({ added: 1, removed: 1 });
  });

  it("pure insertion at the end is all adds after shared context", () => {
    const rows = diffLines("a\nb", "a\nb\nc\nd");
    expect(diffStat(rows)).toEqual({ added: 2, removed: 0 });
    expect(rows.filter((r) => r.kind === "add").map((r) => r.text)).toEqual([
      "c",
      "d",
    ]);
  });

  it("pure deletion is all dels; line numbers track the source side", () => {
    const rows = diffLines("keep\ndrop1\ndrop2\nkeep2", "keep\nkeep2");
    expect(diffStat(rows)).toEqual({ added: 0, removed: 2 });
    const del = rows.filter((r) => r.kind === "del");
    expect(del.map((r) => [r.text, r.aLine, r.bLine])).toEqual([
      ["drop1", 2, null],
      ["drop2", 3, null],
    ]);
  });

  it("empty-vs-nonempty: every line is an add", () => {
    // "".split("\n") === [""], so one del of "" then the real adds — the stat
    // still reflects the real additions.
    const rows = diffLines("", "x\ny");
    expect(rows.some((r) => r.kind === "add" && r.text === "x")).toBe(true);
    expect(rows.some((r) => r.kind === "add" && r.text === "y")).toBe(true);
  });
});
