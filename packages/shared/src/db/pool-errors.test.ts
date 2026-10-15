import { describe, expect, it, vi } from "vitest";

import { createDb } from "./index";

// A pg/neon Pool re-emits an idle client's socket error as a Pool "error"
// event. With no listener, EventEmitter throws "Unhandled error." — on Workers
// that surfaced as `Unhandled error. (Uncaught Error: Network connection lost.)`
// after page loads, and could fail a render in flight.
describe("createDb pool error handling", () => {
  const cases = [
    ["neon-serverless", "postgresql://u:p@ep-x.us-east-1.aws.neon.tech/db"],
    ["node-postgres", "postgresql://u:p@localhost:5432/db"],
  ] as const;

  it.each(cases)(
    "%s: an idle connection error is logged, never thrown",
    (_driver, url) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const pool = (
        createDb(url) as unknown as { $client: NodeJS.EventEmitter }
      ).$client;
      expect(() =>
        pool.emit("error", new Error("Network connection lost.")),
      ).not.toThrow();
      expect(warn).toHaveBeenCalledWith(
        "[db] idle connection error (connection discarded):",
        "Network connection lost.",
      );
      warn.mockRestore();
    },
  );
});
