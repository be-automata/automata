import { describe, it, expect } from "vitest";
import { claudeCommand } from "./claude";
import type { IDaemonRuntime } from "./runtime";

// Minimal runtime: claudeCommand only writes the prompt file + (for a non-null
// sessionId) logs. sessionId=null keeps it to writeFileSync.
function fakeRuntime(): IDaemonRuntime {
  return {
    writeFileSync: () => {},
    readFileSync: () => "",
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as IDaemonRuntime;
}

const base = {
  runtime: fakeRuntime(),
  prompt: "review this PR",
  sessionId: null,
  model: "sonnet",
  mcpConfigPath: null,
};

describe("claudeCommand — permissionMode policy (phase-2 single-writer)", () => {
  it('permissionMode "review" emits the scoped gh/push-deny policy and NOT --dangerously-skip-permissions', () => {
    const cmd = claudeCommand({ ...base, permissionMode: "review" });
    expect(cmd).not.toContain("--dangerously-skip-permissions");
    expect(cmd).toContain("--permission-mode default");
    expect(cmd).toContain("--allowedTools Read Grep Glob Bash");
    expect(cmd).toContain("--disallowedTools Bash(gh:*) Bash(git push:*)");
  });

  it('permissionMode "allowAll" (default) still uses --dangerously-skip-permissions', () => {
    const cmd = claudeCommand({ ...base, permissionMode: "allowAll" });
    expect(cmd).toContain("--dangerously-skip-permissions");
    expect(cmd).not.toContain("Bash(gh:*)");
  });

  it("undefined permissionMode falls back to --dangerously-skip-permissions", () => {
    const cmd = claudeCommand({ ...base });
    expect(cmd).toContain("--dangerously-skip-permissions");
  });

  it('permissionMode "plan" is unchanged (plan mode + WebSearch/WebFetch/Read/Bash)', () => {
    const cmd = claudeCommand({ ...base, permissionMode: "plan" });
    expect(cmd).toContain("--permission-mode plan");
    expect(cmd).toContain("--allowedTools WebSearch WebFetch Read Bash");
    expect(cmd).not.toContain("--dangerously-skip-permissions");
    expect(cmd).not.toContain("Bash(gh:*)");
  });
});
