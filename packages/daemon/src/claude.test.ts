import { describe, it, expect } from "vitest";
import { claudeCommand, reviewPolicyArgs } from "./claude";
import { stripGithubCredentials } from "./daemon";
import type { IDaemonRuntime } from "./runtime";
import {
  DaemonMessageClaudeSchema,
  parseDaemonReviewAgent,
  reviewPolicyVariantFor,
  type DaemonReviewAgent,
} from "./shared";
import {
  ORCHESTRATED_REVIEW_POLICY_JOINED,
  REVIEW_POLICY_JOINED,
} from "./adapters/__golden-fixtures";

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

const normalizePrompt = (cmd: string) =>
  cmd.replace(/\/tmp\/claude-prompt-[^ ]+\.txt/, "/tmp/claude-prompt-X.txt");

const ORCHESTRATED: DaemonReviewAgent = {
  mode: "orchestrated",
  commandTimeoutMs: 300000,
  maxTurns: 12,
};

describe("reviewPolicyArgs(variant) — classic pin + D2 orchestrated variant", () => {
  it("classic (no argument / explicit) is the ADR-004 pin byte-for-byte", () => {
    expect(reviewPolicyArgs().join(" ")).toBe(REVIEW_POLICY_JOINED);
    expect(reviewPolicyArgs({ mode: "classic" })).toEqual(reviewPolicyArgs());
  });

  it("orchestrated adds Agent/Task/Skill + explicit denies, keeps the classic fences", () => {
    const joined = reviewPolicyArgs({ mode: "orchestrated" }).join(" ");
    expect(joined).toBe(ORCHESTRATED_REVIEW_POLICY_JOINED);
    expect(joined).toContain("'Bash(gh:*)' 'Bash(git push:*)'");
    expect(joined).toContain("--setting-sources user");
    expect(joined).not.toContain("--dangerously-skip-permissions");
    expect(joined).not.toContain("--max-turns");
  });

  it("orchestrated with maxTurns appends --max-turns N last", () => {
    expect(
      reviewPolicyArgs({ mode: "orchestrated", maxTurns: 40 }).join(" "),
    ).toBe(`${ORCHESTRATED_REVIEW_POLICY_JOINED} --max-turns 40`);
  });
});

describe("reviewPolicyVariantFor — resolved review shape (ADR-006)", () => {
  it("is classic for review without reviewAgent or with mode classic", () => {
    expect(reviewPolicyVariantFor("review", undefined)).toEqual({
      mode: "classic",
    });
    expect(
      reviewPolicyVariantFor("review", {
        mode: "classic",
        commandTimeoutMs: 60000,
      }),
    ).toEqual({ mode: "classic" });
  });

  it("is orchestrated (with maxTurns) only for review + orchestrated", () => {
    expect(
      reviewPolicyVariantFor("review", {
        mode: "orchestrated",
        commandTimeoutMs: 300000,
        maxTurns: 40,
      }),
    ).toEqual({ mode: "orchestrated", maxTurns: 40 });
    expect(
      reviewPolicyVariantFor("review", {
        mode: "orchestrated",
        commandTimeoutMs: 300000,
      }),
    ).toEqual({ mode: "orchestrated" });
  });

  it("any non-review permissionMode is classic whatever reviewAgent says", () => {
    for (const pm of ["allowAll", "plan", undefined] as const) {
      expect(reviewPolicyVariantFor(pm, ORCHESTRATED)).toEqual({
        mode: "classic",
      });
    }
  });
});

describe("claudeCommand — reviewAgent", () => {
  it("review without reviewAgent and with classic reviewAgent are today's command", () => {
    const today = normalizePrompt(
      claudeCommand({ ...base, permissionMode: "review" }),
    );
    expect(today).toContain(REVIEW_POLICY_JOINED);
    expect(today).not.toContain("Agent");
    expect(
      normalizePrompt(
        claudeCommand({
          ...base,
          permissionMode: "review",
          reviewAgent: { mode: "classic", commandTimeoutMs: 120000 },
        }),
      ),
    ).toBe(today);
  });

  it("review + orchestrated reviewAgent carries the orchestrated policy and --max-turns", () => {
    const cmd = claudeCommand({
      ...base,
      permissionMode: "review",
      reviewAgent: ORCHESTRATED,
    });
    expect(cmd).toContain(
      `${ORCHESTRATED_REVIEW_POLICY_JOINED} --max-turns 12`,
    );
    expect(cmd).not.toContain("--dangerously-skip-permissions");
  });

  it("allowAll + orchestrated reviewAgent is still the unrestricted command", () => {
    const cmd = claudeCommand({
      ...base,
      permissionMode: "allowAll",
      reviewAgent: ORCHESTRATED,
    });
    expect(cmd).toContain("--dangerously-skip-permissions");
    expect(cmd).not.toContain("Agent");
    expect(cmd).not.toContain("--max-turns");
  });
});

describe("DaemonMessageClaudeSchema.reviewAgent + parseDaemonReviewAgent", () => {
  const message = {
    type: "claude",
    token: "t",
    prompt: "p",
    model: "sonnet",
    agent: "claudeCode",
    agentVersion: 1,
    sessionId: null,
    threadId: "th",
    threadChatId: "tc",
    permissionMode: "review",
  };

  it("accepts the message with or without reviewAgent, and with ANY reviewAgent value", () => {
    expect(DaemonMessageClaudeSchema.safeParse(message).success).toBe(true);
    for (const reviewAgent of [
      ORCHESTRATED,
      { mode: "turbo" },
      "x",
      42,
      null,
    ]) {
      expect(
        DaemonMessageClaudeSchema.safeParse({ ...message, reviewAgent })
          .success,
      ).toBe(true);
    }
  });

  it("undefined ⇒ {} (no reviewAgent, not rejected)", () => {
    expect(parseDaemonReviewAgent(undefined)).toEqual({});
  });

  it("a valid value ⇒ {reviewAgent}", () => {
    expect(parseDaemonReviewAgent(ORCHESTRATED)).toEqual({
      reviewAgent: ORCHESTRATED,
    });
  });

  it.each([
    [{ mode: "orchestrated", commandTimeoutMs: 5 }, "commandTimeoutMs"],
    [{ mode: "orchestrated", commandTimeoutMs: 600001 }, "commandTimeoutMs"],
    [{ mode: "orchestrated", commandTimeoutMs: 1.5 }, "commandTimeoutMs"],
    [
      { mode: "orchestrated", commandTimeoutMs: 60000, maxTurns: 0 },
      "maxTurns",
    ],
    [
      { mode: "orchestrated", commandTimeoutMs: 60000, maxTurns: 501 },
      "maxTurns",
    ],
    [{ mode: "turbo", commandTimeoutMs: 60000 }, "mode"],
  ])("rejects %j naming %s and never echoing the value", (raw, path) => {
    const result = parseDaemonReviewAgent(raw);
    expect(result.reviewAgent).toBeUndefined();
    expect(result.rejected).toContain(path);
    expect(result.rejected).not.toContain("turbo");
    expect(result.rejected).not.toContain("600001");
  });

  it('rejects a non-object ("x") without echoing it', () => {
    const result = parseDaemonReviewAgent("x");
    expect(result.reviewAgent).toBeUndefined();
    expect(typeof result.rejected).toBe("string");
    expect(result.rejected).not.toContain('"x"');
  });
});

describe("stripGithubCredentials — review-run token withhold (single-writer)", () => {
  // Mirrors the real worker layout (packages/worker/src/agent-run/daemon-env.ts):
  // extraheader first, then credential.helper, user.*, and (agent-uid mode)
  // safe.directory last.
  const fullEnv = {
    PATH: "/usr/bin",
    HOME: "/home/x",
    ANTHROPIC_API_KEY: "sk-ant-xxx",
    GH_TOKEN: "ghs_write_token",
    GITHUB_TOKEN: "ghs_write_token",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_COUNT: "5",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic <base64-token>",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_KEY_2: "user.name",
    GIT_CONFIG_VALUE_2: "automata-ai-bot[bot]",
    GIT_CONFIG_KEY_3: "user.email",
    GIT_CONFIG_VALUE_3: "bot@users.noreply.github.com",
    GIT_CONFIG_KEY_4: "safe.directory",
    GIT_CONFIG_VALUE_4: "/work/run",
    GIT_AUTHOR_NAME: "automata-ai-bot[bot]",
  };

  function gitConfigEntries(
    env: Record<string, string | undefined>,
  ): Array<[string, string | undefined]> {
    return Object.keys(env)
      .filter((key) => /^GIT_CONFIG_KEY_\d+$/.test(key))
      .map((key) => {
        const index = key.slice("GIT_CONFIG_KEY_".length);
        return [env[key] ?? "", env[`GIT_CONFIG_VALUE_${index}`]];
      });
  }

  function hasNoGitConfigGroup(env: Record<string, string | undefined>) {
    return !Object.keys(env).some((key) =>
      /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key),
    );
  }

  it("keeps non-credential git config (safe.directory, user.*, credential.helper) renumbered from 0 (#229)", () => {
    const out = stripGithubCredentials(fullEnv);
    expect(out.GIT_CONFIG_COUNT).toBe("4");
    expect(out.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(out.GIT_CONFIG_VALUE_0).toBe("");
    expect(out.GIT_CONFIG_KEY_1).toBe("user.name");
    expect(out.GIT_CONFIG_VALUE_1).toBe("automata-ai-bot[bot]");
    expect(out.GIT_CONFIG_KEY_2).toBe("user.email");
    expect(out.GIT_CONFIG_VALUE_2).toBe("bot@users.noreply.github.com");
    expect(out.GIT_CONFIG_KEY_3).toBe("safe.directory");
    expect(out.GIT_CONFIG_VALUE_3).toBe("/work/run");
    expect(out.GIT_CONFIG_KEY_4).toBeUndefined();
    expect(out.GIT_CONFIG_VALUE_4).toBeUndefined();
  });

  it("removes every GitHub credential vector (token + git extraheader auth)", () => {
    const out = stripGithubCredentials(fullEnv);
    expect(out.GH_TOKEN).toBeUndefined();
    expect(out.GITHUB_TOKEN).toBeUndefined();
    for (const [key, value] of gitConfigEntries(out)) {
      expect(key).not.toMatch(/extraheader$/i);
      expect(key).not.toMatch(/insteadof$/i);
      expect(value ?? "").not.toContain("ghs_write_token");
      expect(value ?? "").not.toContain("AUTHORIZATION");
    }
  });

  it("removes extraheader and insteadOf / pushInsteadOf keys case-insensitively", () => {
    const credentialKeys = [
      "HTTP.https://github.com/.ExtraHeader",
      "http.extraheader",
      "url.http://broker:8080/.insteadOf",
      "url.https://x-access-token:T@github.com/.InsteadOf",
      "url.x.pushInsteadOf",
    ];
    const env: Record<string, string | undefined> = {
      GIT_CONFIG_COUNT: String(credentialKeys.length + 1),
    };
    credentialKeys.forEach((key, i) => {
      env[`GIT_CONFIG_KEY_${i}`] = key;
      env[`GIT_CONFIG_VALUE_${i}`] = "credential-bearing";
    });
    env[`GIT_CONFIG_KEY_${credentialKeys.length}`] = "safe.directory";
    env[`GIT_CONFIG_VALUE_${credentialKeys.length}`] = "/work/run";

    const out = stripGithubCredentials(env);
    expect(out.GIT_CONFIG_COUNT).toBe("1");
    expect(out.GIT_CONFIG_KEY_0).toBe("safe.directory");
    expect(out.GIT_CONFIG_VALUE_0).toBe("/work/run");
    expect(gitConfigEntries(out)).toHaveLength(1);
  });

  it("drops an entry whose value embeds the GitHub token under any key", () => {
    const out = stripGithubCredentials({
      GH_TOKEN: "ghs_write_token",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "remote.origin.url",
      GIT_CONFIG_VALUE_0:
        "https://x-access-token:ghs_write_token@github.com/o/r",
      GIT_CONFIG_KEY_1: "safe.directory",
      GIT_CONFIG_VALUE_1: "/work/run",
    });
    expect(out.GIT_CONFIG_COUNT).toBe("1");
    expect(out.GIT_CONFIG_KEY_0).toBe("safe.directory");
    expect(out.GIT_CONFIG_KEY_1).toBeUndefined();
  });

  it("removes GIT_CONFIG_COUNT when no entry survives", () => {
    const out = stripGithubCredentials({
      PATH: "/usr/bin",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic <base64-token>",
    });
    expect(out.GIT_CONFIG_COUNT).toBeUndefined();
    expect(hasNoGitConfigGroup(out)).toBe(true);
    expect(out.PATH).toBe("/usr/bin");
  });

  it.each([
    ["non-numeric COUNT", { GIT_CONFIG_COUNT: "abc" }],
    ["negative COUNT", { GIT_CONFIG_COUNT: "-1" }],
    ["missing COUNT", {}],
  ])("fails closed on %s (drops the whole group)", (_label, countEnv) => {
    const out = stripGithubCredentials({
      ...countEnv,
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "/work/run",
      GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_1: "AUTHORIZATION: basic <base64-token>",
    });
    expect(hasNoGitConfigGroup(out)).toBe(true);
  });

  it("fails closed when an index below COUNT has no key", () => {
    const out = stripGithubCredentials({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_1: "safe.directory",
      GIT_CONFIG_VALUE_1: "/work/run",
    });
    expect(hasNoGitConfigGroup(out)).toBe(true);
  });

  it("drops orphan entries at indices >= COUNT", () => {
    const out = stripGithubCredentials({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "/work/run",
      GIT_CONFIG_KEY_1: "core.sshCommand",
      GIT_CONFIG_VALUE_1: "orphan",
    });
    expect(out.GIT_CONFIG_COUNT).toBe("1");
    expect(out.GIT_CONFIG_KEY_0).toBe("safe.directory");
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

  it("is pure (does not mutate the input, including surviving entries)", () => {
    const copy = { ...fullEnv };
    const out = stripGithubCredentials(fullEnv);
    expect(fullEnv).toEqual(copy);
    expect(out).not.toBe(fullEnv);
    expect(out.GIT_CONFIG_COUNT).toBe("4");
  });
});
