import { describe, expect, it } from "vitest";
import { AUTH_FILE_BY_AGENT, authFilePathForAgent } from "./auth-file";
import { AIAgentSchema } from "./types";

describe("AUTH_FILE_BY_AGENT", () => {
  it("has the exact byte-for-byte paths worker/daemon depend on", () => {
    expect(AUTH_FILE_BY_AGENT.claudeCode).toBe(".claude/.credentials.json");
    expect(AUTH_FILE_BY_AGENT.codex).toBe(".codex/auth.json");
  });

  it("has no file-based credential for gemini/amp/opencode — permanent, not a TODO", () => {
    expect(AUTH_FILE_BY_AGENT.gemini).toBeNull();
    expect(AUTH_FILE_BY_AGENT.amp).toBeNull();
    expect(AUTH_FILE_BY_AGENT.opencode).toBeNull();
  });

  it("is exhaustive over AIAgentSchema — adding an agent forces a decision here", () => {
    for (const agent of AIAgentSchema.options) {
      expect(
        Object.prototype.hasOwnProperty.call(AUTH_FILE_BY_AGENT, agent),
      ).toBe(true);
    }
    expect(Object.keys(AUTH_FILE_BY_AGENT).sort()).toEqual(
      [...AIAgentSchema.options].sort(),
    );
  });
});

describe("authFilePathForAgent", () => {
  it("resolves known agents to their file path", () => {
    expect(authFilePathForAgent("claudeCode")).toBe(
      ".claude/.credentials.json",
    );
    expect(authFilePathForAgent("codex")).toBe(".codex/auth.json");
  });

  it("resolves file-less agents to null", () => {
    expect(authFilePathForAgent("gemini")).toBeNull();
    expect(authFilePathForAgent("amp")).toBeNull();
    expect(authFilePathForAgent("opencode")).toBeNull();
  });

  it("accepts a plain string (worker's agent field is unnarrowed) and degrades unknowns to null", () => {
    expect(authFilePathForAgent("someFutureAgent")).toBeNull();
    expect(authFilePathForAgent("")).toBeNull();
  });
});
