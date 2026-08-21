/**
 * (b) Adapter-level goldens for #75 — call each façade's `buildArgs` /
 * `prepareEnv` / `capabilities` directly (no daemon, no socket) and assert
 * against the SAME expected literals `daemon-golden.test.ts` pins for the
 * real per-agent `run*Command` path. This pair is the actual byte-identical
 * proof: (a) proves what today's daemon.ts produces, (b) proves the façade
 * reproduces it — from `__golden-fixtures.ts`, never from each other.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IDaemonRuntime } from "../runtime";
import { reviewPolicyArgs } from "../claude";
import { claudeAdapter } from "./claude-adapter";
import { codexAdapter } from "./codex-adapter";
import { ampAdapter } from "./amp-adapter";
import { geminiAdapter } from "./gemini-adapter";
import { opencodeAdapter } from "./opencode-adapter";
import { harnessAdapterRegistry } from "./registry";
import {
  NORMALIZED_URL,
  TOKEN,
  REVIEW_POLICY_JOINED,
  normalizePromptPath,
  expectedClaudeEnvNoCredits,
  expectedClaudeEnvWithCredits,
  expectedGeminiEnv,
  expectedOpencodeEnv,
  expectedAmpEnv,
  EXPECTED_CODEX_MOCK,
  EXPECTED_OPENCODE_MOCK,
  EXPECTED_CODEX_COMMAND_DEFAULT,
  EXPECTED_CODEX_COMMAND_CREDITS_RESUME,
  EXPECTED_AMP_COMMAND,
  EXPECTED_GEMINI_COMMAND,
  EXPECTED_OPENCODE_COMMAND,
  EXPECTED_CODEX_REVIEW_POLICY,
  EXPECTED_GEMINI_REVIEW_POLICY,
  EXPECTED_AMP_REVIEW_POLICY,
  EXPECTED_OPENCODE_REVIEW_POLICY,
  EXPECTED_CODEX_COMMAND_REVIEW,
  EXPECTED_GEMINI_COMMAND_REVIEW,
  EXPECTED_AMP_COMMAND_REVIEW,
  EXPECTED_OPENCODE_COMMAND_REVIEW,
  OPENCODE_REVIEW_MODE_ENV_KEY,
  OPENCODE_REVIEW_MODE_ENV_VALUE,
} from "./__golden-fixtures";

vi.mock("nanoid/non-secure", () => ({ nanoid: () => "NANOID" }));

function fakeRuntime(): IDaemonRuntime {
  return {
    writeFileSync: () => {},
    readFileSync: () => "",
    execSync: () => "NOT_EXISTS\n",
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    normalizedUrl: NORMALIZED_URL,
  } as unknown as IDaemonRuntime;
}

describe("adapter-golden (#75, part b) — façades reproduce today's exact output", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("reviewPolicyArgs (named seam, ADR-004)", () => {
    it("is pinned to the exact byte-identical joined review tool-policy", () => {
      expect(reviewPolicyArgs().join(" ")).toBe(REVIEW_POLICY_JOINED);
    });

    it("claudeAdapter.buildArgs in review mode includes reviewPolicyArgs() output verbatim", () => {
      const cmd = claudeAdapter.buildArgs({
        runtime: fakeRuntime(),
        prompt: "review this PR",
        sessionId: null,
        model: "sonnet",
        permissionMode: "review",
      });
      expect(cmd).toContain(REVIEW_POLICY_JOINED);
      expect(cmd).not.toContain("--dangerously-skip-permissions");
    });
  });

  describe("claudeAdapter", () => {
    it("prepareEnv without useCredits matches expectedClaudeEnvNoCredits (falls back to process.env.ANTHROPIC_API_KEY)", () => {
      const env = claudeAdapter.prepareEnv({
        runtime: fakeRuntime(),
        useCredits: false,
        token: TOKEN,
        normalizedUrl: NORMALIZED_URL,
      });
      // vitest.config.ts sets ANTHROPIC_API_KEY="test-api-key-from-env";
      // execSync stub returns "NOT_EXISTS" so getAnthropicApiKeyOrNull falls
      // back to it exactly as daemon.ts:666-687 does.
      expect(env).toEqual(expectedClaudeEnvNoCredits("test-api-key-from-env"));
    });

    it("prepareEnv with useCredits matches expectedClaudeEnvWithCredits (blanked key + proxy vars)", () => {
      const env = claudeAdapter.prepareEnv({
        runtime: fakeRuntime(),
        useCredits: true,
        token: TOKEN,
        normalizedUrl: NORMALIZED_URL,
      });
      expect(env).toEqual(expectedClaudeEnvWithCredits());
    });

    it("authFilePath is '.claude/.credentials.json'; normalizeModel is identity", () => {
      expect(claudeAdapter.authFilePath()).toBe(".claude/.credentials.json");
      expect(claudeAdapter.normalizeModel("sonnet")).toBe("sonnet");
    });
  });

  describe("codexAdapter", () => {
    it("buildArgs default model, no session, useCredits=false matches EXPECTED_CODEX_COMMAND_DEFAULT", () => {
      const cmd = codexAdapter.buildArgs({
        runtime: fakeRuntime(),
        prompt: "TEST_PROMPT_STRING",
        sessionId: null,
        model: "gpt-5",
      });
      expect(normalizePromptPath(cmd)).toBe(EXPECTED_CODEX_COMMAND_DEFAULT);
    });

    it("buildArgs useCredits + resume matches EXPECTED_CODEX_COMMAND_CREDITS_RESUME", () => {
      const cmd = codexAdapter.buildArgs({
        runtime: fakeRuntime(),
        prompt: "TEST_PROMPT_STRING",
        sessionId: "SESSION_ABC",
        model: "gpt-5-codex-high",
        useCredits: true,
      });
      expect(normalizePromptPath(cmd)).toBe(
        EXPECTED_CODEX_COMMAND_CREDITS_RESUME,
      );
    });

    it("prepareEnv is empty; authFilePath is '.codex/auth.json'; mockSuccessResult is 'Codex successfully completed'", () => {
      expect(
        codexAdapter.prepareEnv({
          runtime: fakeRuntime(),
          useCredits: false,
          token: TOKEN,
          normalizedUrl: NORMALIZED_URL,
        }),
      ).toEqual({});
      expect(codexAdapter.authFilePath()).toBe(".codex/auth.json");
      expect(codexAdapter.capabilities.mockSuccessResult).toBe(
        EXPECTED_CODEX_MOCK,
      );
    });
  });

  describe("ampAdapter", () => {
    it("buildArgs matches EXPECTED_AMP_COMMAND; prepareEnv matches expectedAmpEnv", () => {
      vi.stubEnv("AMP_API_KEY", "amp-secret-key");
      const cmd = ampAdapter.buildArgs({
        runtime: fakeRuntime(),
        prompt: "TEST_PROMPT_STRING",
        sessionId: null,
        model: "amp",
      });
      expect(normalizePromptPath(cmd)).toBe(EXPECTED_AMP_COMMAND);
      const env = ampAdapter.prepareEnv({
        runtime: fakeRuntime(),
        useCredits: false,
        token: TOKEN,
        normalizedUrl: NORMALIZED_URL,
      });
      expect(env).toEqual(expectedAmpEnv("amp-secret-key"));
    });
  });

  describe("geminiAdapter", () => {
    it("buildArgs matches EXPECTED_GEMINI_COMMAND; prepareEnv matches expectedGeminiEnv", () => {
      const cmd = geminiAdapter.buildArgs({
        runtime: fakeRuntime(),
        prompt: "TEST_PROMPT_STRING",
        sessionId: null,
        model: "gemini-3-pro",
      });
      expect(normalizePromptPath(cmd)).toBe(EXPECTED_GEMINI_COMMAND);
      const env = geminiAdapter.prepareEnv({
        runtime: fakeRuntime(),
        useCredits: false,
        token: TOKEN,
        normalizedUrl: NORMALIZED_URL,
      });
      expect(env).toEqual(expectedGeminiEnv());
    });

    it("makeLineParser().finalize() flushes accumulated content exactly like the onClose handler", () => {
      const parser = geminiAdapter.makeLineParser({ runtime: fakeRuntime() });
      // Feed a delta message line so state accumulates (mirrors
      // daemon.ts:887-921 driving parseGeminiLine with shared state).
      parser.parse(
        JSON.stringify({
          type: "message",
          role: "assistant",
          content: "partial",
          delta: true,
        }),
        { isWorking: true },
      );
      const flushed = parser.finalize?.();
      expect(flushed).toEqual([
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "partial" }],
          },
          parent_tool_use_id: null,
          session_id: "",
        },
      ]);
      // Second finalize call is a no-op (content already flushed).
      expect(parser.finalize?.()).toEqual([]);
    });
  });

  describe("opencodeAdapter", () => {
    it("buildArgs normalizes the legacy model prefix inline and matches EXPECTED_OPENCODE_COMMAND", () => {
      vi.stubEnv("OPENCODE_API_KEY", "opencode-secret-key");
      const cmd = opencodeAdapter.buildArgs({
        runtime: fakeRuntime(),
        prompt: "TEST_PROMPT_STRING",
        sessionId: null,
        model: "opencode/grok-code",
      });
      expect(normalizePromptPath(cmd)).toBe(EXPECTED_OPENCODE_COMMAND);
      const env = opencodeAdapter.prepareEnv({
        runtime: fakeRuntime(),
        useCredits: false,
        token: TOKEN,
        normalizedUrl: NORMALIZED_URL,
      });
      expect(env).toEqual(expectedOpencodeEnv("opencode-secret-key"));
      expect(opencodeAdapter.capabilities.mockSuccessResult).toBe(
        EXPECTED_OPENCODE_MOCK,
      );
    });

    it("makeLineParser().parse reads isWorking at CALL time, not construction time", () => {
      const parser = opencodeAdapter.makeLineParser({
        runtime: fakeRuntime(),
      });
      const stepStart = JSON.stringify({
        type: "step_start",
        sessionID: "s1",
        part: { type: "step-start" },
      });
      // isWorking=false on the first call emits a synthetic system/init.
      expect(parser.parse(stepStart, { isWorking: false })).toEqual([
        {
          type: "system",
          subtype: "init",
          session_id: "s1",
          tools: [],
          mcp_servers: [],
        },
      ]);
      // isWorking=true on a later call for the SAME parser instance suppresses it.
      expect(parser.parse(stepStart, { isWorking: true })).toEqual([]);
    });
  });

  describe("reviewPolicyArgs() per adapter (#88, AC3) — best-available-per-CLI, verified or documented []", () => {
    // The four []-shipping adapters, each with its documented reason (the
    // full verification lives in the named builder file's JSDoc).
    const emptyPolicyAdapters: Array<{
      name: string;
      reason: string;
      adapter: typeof codexAdapter;
      model: string;
      stubEnv?: [string, string];
      expectedPolicy: string[];
      expectedReviewCommand: string;
      expectedDefaultCommand: string;
    }> = [
      {
        name: "codexAdapter",
        reason:
          "verified-unsafe against pinned codex 0.76.0, see codex.ts JSDoc",
        adapter: codexAdapter,
        model: "gpt-5",
        expectedPolicy: EXPECTED_CODEX_REVIEW_POLICY,
        expectedReviewCommand: EXPECTED_CODEX_COMMAND_REVIEW,
        expectedDefaultCommand: EXPECTED_CODEX_COMMAND_DEFAULT,
      },
      {
        name: "geminiAdapter",
        reason:
          "verified-unsafe against pinned gemini-cli 0.20.0, see gemini.ts JSDoc",
        adapter: geminiAdapter,
        model: "gemini-3-pro",
        expectedPolicy: EXPECTED_GEMINI_REVIEW_POLICY,
        expectedReviewCommand: EXPECTED_GEMINI_COMMAND_REVIEW,
        expectedDefaultCommand: EXPECTED_GEMINI_COMMAND,
      },
      {
        name: "ampAdapter",
        reason:
          "no verified restriction surface for pinned amp build, see amp.ts JSDoc",
        adapter: ampAdapter,
        model: "amp",
        stubEnv: ["AMP_API_KEY", "amp-secret-key"],
        expectedPolicy: EXPECTED_AMP_REVIEW_POLICY,
        expectedReviewCommand: EXPECTED_AMP_COMMAND_REVIEW,
        expectedDefaultCommand: EXPECTED_AMP_COMMAND,
      },
      {
        name: "opencodeAdapter",
        reason: "args aren't the seam — the plugin is, see opencode.ts JSDoc",
        adapter: opencodeAdapter,
        model: "opencode/grok-code",
        stubEnv: ["OPENCODE_API_KEY", "opencode-secret-key"],
        expectedPolicy: EXPECTED_OPENCODE_REVIEW_POLICY,
        expectedReviewCommand: EXPECTED_OPENCODE_COMMAND_REVIEW,
        expectedDefaultCommand: EXPECTED_OPENCODE_COMMAND,
      },
    ];

    it.each(emptyPolicyAdapters)(
      "$name.reviewPolicyArgs() is [] ($reason)",
      ({ adapter, expectedPolicy }) => {
        expect(adapter.reviewPolicyArgs()).toEqual(expectedPolicy);
      },
    );

    it.each(emptyPolicyAdapters)(
      "$name.buildArgs(review/allowAll/undefined) are all byte-identical since reviewPolicyArgs() is []",
      ({
        adapter,
        model,
        stubEnv,
        expectedReviewCommand,
        expectedDefaultCommand,
      }) => {
        if (stubEnv) {
          vi.stubEnv(stubEnv[0], stubEnv[1]);
        }
        const base = {
          runtime: fakeRuntime(),
          prompt: "TEST_PROMPT_STRING",
          sessionId: null,
          model,
        };
        expect(
          normalizePromptPath(
            adapter.buildArgs({ ...base, permissionMode: "review" }),
          ),
        ).toBe(expectedReviewCommand);
        for (const permissionMode of ["allowAll", undefined] as const) {
          expect(
            normalizePromptPath(adapter.buildArgs({ ...base, permissionMode })),
          ).toBe(expectedDefaultCommand);
        }
        expect(expectedReviewCommand).toBe(expectedDefaultCommand);
      },
    );

    it("opencodeAdapter.prepareEnv sets TERRAGON_REVIEW_MODE=1 only in review mode (#88 AC2)", () => {
      vi.stubEnv("OPENCODE_API_KEY", "opencode-secret-key");
      const reviewEnv = opencodeAdapter.prepareEnv({
        runtime: fakeRuntime(),
        useCredits: false,
        token: TOKEN,
        normalizedUrl: NORMALIZED_URL,
        permissionMode: "review",
      });
      expect(reviewEnv[OPENCODE_REVIEW_MODE_ENV_KEY]).toBe(
        OPENCODE_REVIEW_MODE_ENV_VALUE,
      );

      const allowAllEnv = opencodeAdapter.prepareEnv({
        runtime: fakeRuntime(),
        useCredits: false,
        token: TOKEN,
        normalizedUrl: NORMALIZED_URL,
        permissionMode: "allowAll",
      });
      expect(allowAllEnv[OPENCODE_REVIEW_MODE_ENV_KEY]).toBeUndefined();

      const undefinedModeEnv = opencodeAdapter.prepareEnv({
        runtime: fakeRuntime(),
        useCredits: false,
        token: TOKEN,
        normalizedUrl: NORMALIZED_URL,
      });
      expect(undefinedModeEnv[OPENCODE_REVIEW_MODE_ENV_KEY]).toBeUndefined();
    });
  });

  describe("HarnessCapabilities — CLOSED by #76 for env-strip; this PR closes the tool-policy gap where verifiable (ADR-004/ADR-006)", () => {
    it("every adapter reports withholdGitCredentialsInReviewMode === true (CLOSED by #76 — daemon.ts's generic runAgentCommand reads this uniformly; see the inverted pin in daemon-golden.test.ts)", () => {
      for (const agent of Object.keys(harnessAdapterRegistry) as Array<
        keyof typeof harnessAdapterRegistry
      >) {
        expect(
          harnessAdapterRegistry[agent].capabilities
            .withholdGitCredentialsInReviewMode,
        ).toBe(true);
      }
    });

    it("displayName matches the exact agentName string spawnAgentProcess uses today", () => {
      expect(claudeAdapter.displayName).toBe("Claude");
      expect(opencodeAdapter.displayName).toBe("Opencode");
      expect(ampAdapter.displayName).toBe("Amp");
      expect(codexAdapter.displayName).toBe("Codex");
      expect(geminiAdapter.displayName).toBe("Gemini");
    });
  });
});
