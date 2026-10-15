import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const pools: EventEmitter[] = [];
vi.mock("pg", () => ({
  Pool: class FakePool extends EventEmitter {
    constructor() {
      super();
      pools.push(this);
    }
    async connect() {
      throw new Error("not used");
    }
    async end() {}
  },
}));

import { createEngineDb } from "./engine-db";

// pg re-emits an idle client's socket error as a Pool "error" event; with no
// listener EventEmitter throws and the worker process dies.
describe("createEngineDb pool error handling", () => {
  it("logs an idle connection error instead of throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engineDb = createEngineDb({
      HATCHET_ENGINE_DATABASE_URL: "postgresql://u:p@127.0.0.1:1/engine",
    } as NodeJS.ProcessEnv);
    expect(engineDb).not.toBeNull();
    const pool = pools.at(-1);
    expect(pool).toBeDefined();
    expect(() =>
      pool!.emit("error", new Error("Connection terminated unexpectedly")),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      "[engine-db] idle connection error (connection discarded):",
      "Connection terminated unexpectedly",
    );
    warn.mockRestore();
  });
});
