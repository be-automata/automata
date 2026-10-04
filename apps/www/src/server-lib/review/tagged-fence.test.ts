import { describe, expect, it } from "vitest";

import { buildTaggedFence } from "./tagged-fence";

const fence = buildTaggedFence("review-intent");

describe("buildTaggedFence", () => {
  it("matches the opener at text start and after a newline, not mid-line", () => {
    expect(fence.hasOpener("```json review-intent\n{}\n```")).toBe(true);
    expect(fence.hasOpener("prose\n```json review-intent\n{}\n```")).toBe(true);
    expect(fence.hasOpener("see ```json review-intent\n{}")).toBe(false);
  });

  it("matches a CRLF opener", () => {
    expect(fence.hasOpener("```json review-intent\r\n{}\r\n```")).toBe(true);
  });

  it("returns the payload of the LAST block", () => {
    const text =
      '```json review-intent\n{"a":1}\n```\ntext\n```json review-intent\n{"b":2}\n```\n';
    expect(fence.extractLast(text)).toEqual({ ok: true, payload: '{"b":2}' });
  });

  it("reports an unclosed last block", () => {
    const text =
      '```json review-intent\n{"a":1}\n```\n```json review-intent\n{"b"';
    const res = fence.extractLast(text);
    expect(res).not.toBeNull();
    expect(res?.ok).toBe(false);
  });

  it("returns null when there is no opener", () => {
    expect(fence.extractLast("nothing here")).toBeNull();
  });

  it("rejects an invalid info string", () => {
    expect(() => buildTaggedFence("Bad Info")).toThrow();
  });
});
