import { describe, it, expect } from "vitest";
import { claudeCommand } from "./claude";
import { stripGithubCredentials } from "./daemon";
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
    // shell-quoted so `bash -c` doesn't choke on the parens/space/glob
    expect(cmd).toContain("--disallowedTools 'Bash(gh:*)' 'Bash(git push:*)'");
    // Review runs execute untrusted PR content in a trust-seeded workspace, so
    // the reviewed branch's own .claude/settings.json must never be loaded — a
    // fork PR could commit permission grants that widen this scoped tool set.
    expect(cmd).toContain("--setting-sources user");
  });

  it('permissionMode "review" never loads project-level settings; other modes are unrestricted', () => {
    // allowAll runs use --dangerously-skip-permissions, where settings-based
    // grants are moot; restricting sources there would break repo-intended
    // configuration for ordinary task runs.
    expect(
      claudeCommand({ ...base, permissionMode: "allowAll" }),
    ).not.toContain("--setting-sources");
    expect(claudeCommand({ ...base, permissionMode: "plan" })).not.toContain(
      "--setting-sources",
    );
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

describe("stripGithubCredentials — review-run token withhold (single-writer)", () => {
  const fullEnv = {
    PATH: "/usr/bin",
    HOME: "/home/x",
    ANTHROPIC_API_KEY: "sk-ant-xxx",
    GH_TOKEN: "ghs_write_token",
    GITHUB_TOKEN: "ghs_write_token",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic <base64-token>",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
    GIT_AUTHOR_NAME: "automata-ai-bot[bot]",
  };

  it("removes every GitHub credential vector (token + git extraheader auth)", () => {
    const out = stripGithubCredentials(fullEnv);
    expect(out.GH_TOKEN).toBeUndefined();
    expect(out.GITHUB_TOKEN).toBeUndefined();
    expect(out.GIT_CONFIG_COUNT).toBeUndefined();
    expect(out.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(out.GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(out.GIT_CONFIG_KEY_1).toBeUndefined();
    expect(out.GIT_CONFIG_VALUE_1).toBeUndefined();
  });

  it("keeps host-isolation + identity + runtime env (does not over-strip)", () => {
    const out = stripGithubCredentials(fullEnv);
    expect(out.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(out.GIT_CONFIG_SYSTEM).toBe("/dev/null");
    expect(out.PATH).toBe("/usr/bin");
    expect(out.HOME).toBe("/home/x");
    expect(out.ANTHROPIC_API_KEY).toBe("sk-ant-xxx");
    expect(out.GIT_AUTHOR_NAME).toBe("automata-ai-bot[bot]");
  });

  it("is pure (does not mutate the input)", () => {
    const copy = { ...fullEnv };
    stripGithubCredentials(fullEnv);
    expect(fullEnv).toEqual(copy);
  });
});
