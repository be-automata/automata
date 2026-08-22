import { describe, it, expect, afterEach, vi } from "vitest";
import {
  buildOpencodeConfig,
  getModelId,
  OPENCODE_AUTO_APPROVE_PLUGIN_CONTENT,
} from "./opencode-config";
import { agentToModels } from "@terragon/agent/utils";
import { validateProviderModel } from "@terragon/agent/proxy";

describe("buildOpencodeConfig", () => {
  it("should build a valid opencode config", () => {
    const config = buildOpencodeConfig({
      publicUrl: "https://www.terragonlabs.com",
      userMcpConfig: {
        mcpServers: {
          terry: {
            command: "npx",
            args: ["-y", "terry", "mcp"],
            env: {
              DAEMON_TOKEN: "test-token",
            },
          },
        },
      },
    });
    expect(config).toMatchInlineSnapshot(`
      "{
        "$schema": "https://opencode.ai/config.json",
        "autoupdate": false,
        "mcp": {
          "terry": {
            "type": "local",
            "command": [
              "npx",
              "-y",
              "terry",
              "mcp"
            ],
            "enabled": true,
            "environment": {
              "DAEMON_TOKEN": "test-token"
            }
          }
        },
        "provider": {
          "terry": {
            "npm": "@ai-sdk/openai-compatible",
            "name": "Terragon",
            "options": {
              "baseURL": "https://www.terragonlabs.com/api/proxy/openrouter/v1",
              "headers": {
                "X-Daemon-Token": "{env:DAEMON_TOKEN}"
              }
            },
            "models": {
              "glm-4.6": {
                "id": "z-ai/glm-4.6:exacto",
                "name": "GLM 4.6"
              },
              "kimi-k2": {
                "id": "moonshotai/kimi-k2-0905:exacto",
                "name": "Kimi K2"
              },
              "grok-code": {
                "id": "x-ai/grok-code-fast-1",
                "name": "Grok Code Fast 1"
              },
              "qwen3-coder": {
                "id": "qwen/qwen3-coder:exacto",
                "name": "Qwen3 Coder 480B"
              },
              "gemini-2.5-pro": {
                "id": "google/gemini-2.5-pro",
                "name": "Gemini 2.5 Pro"
              },
              "gemini-3-pro": {
                "id": "google/gemini-3-pro-preview",
                "name": "Gemini 3 Pro"
              }
            }
          },
          "terry-google": {
            "npm": "@ai-sdk/google",
            "name": "Terragon Google",
            "options": {
              "baseURL": "https://www.terragonlabs.com/api/proxy/google/v1",
              "apiKey": "unused",
              "headers": {
                "X-Daemon-Token": "{env:DAEMON_TOKEN}"
              }
            },
            "models": {
              "gemini-2.5-pro": {
                "id": "gemini-2.5-pro",
                "name": "Gemini 2.5 Pro"
              },
              "gemini-3-pro": {
                "id": "gemini-3-pro-preview",
                "name": "Gemini 3 Pro"
              }
            }
          },
          "terry-ant": {
            "npm": "@ai-sdk/anthropic",
            "name": "Terragon Anthropic",
            "options": {
              "baseURL": "https://www.terragonlabs.com/api/proxy/anthropic/v1",
              "apiKey": "unused",
              "headers": {
                "X-Daemon-Token": "{env:DAEMON_TOKEN}"
              }
            },
            "models": {
              "sonnet": {
                "id": "claude-sonnet-4-5",
                "name": "Claude Sonnet 4.5"
              }
            }
          },
          "terry-oai": {
            "npm": "@ai-sdk/openai",
            "name": "Terragon OpenAI",
            "options": {
              "baseURL": "https://www.terragonlabs.com/api/proxy/openai/v1",
              "apiKey": "unused",
              "headers": {
                "X-Daemon-Token": "{env:DAEMON_TOKEN}"
              }
            },
            "models": {
              "gpt-5": {
                "id": "gpt-5",
                "name": "GPT-5"
              },
              "gpt-5-codex": {
                "id": "gpt-5-codex",
                "name": "GPT-5-Codex"
              }
            }
          }
        }
      }"
    `);
  });
});

describe("opencode model validation", () => {
  const OPENCODE_MODELS = agentToModels("opencode", {
    agentVersion: "latest",
    enableOpenRouterOpenAIAnthropicModel: true,
    enableOpencodeGemini3ProModelOption: true,
  });
  const OPENROUTER_MODELS = OPENCODE_MODELS.filter((model) =>
    model.startsWith("opencode/"),
  );

  it.each(OPENROUTER_MODELS)("should support %s", (model) => {
    const modelId = getModelId(model);
    expect(modelId).toBeDefined();
    expect(
      validateProviderModel({ provider: "openrouter", model: modelId }),
    ).toEqual({ valid: true });
  });
});

/**
 * #88 AC2 — the auto-approve plugin becomes mode-aware: it denies every
 * `permission.ask` when `TERRAGON_REVIEW_MODE === "1"` and allows exactly
 * as before otherwise. The plugin ships as a TypeScript source STRING
 * (written verbatim into the sandbox's plugin file, not imported/compiled
 * here), so these tests extract and eval its `permission.ask` handler logic
 * directly against Node's `process.env`, mirroring how the sandbox actually
 * executes it (Bun/Node reading `process.env.TERRAGON_REVIEW_MODE`).
 */
describe("OPENCODE_AUTO_APPROVE_PLUGIN_CONTENT — mode-aware auto-approve (#88 AC2)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Extracts the RHS expression of `output.status = ...;` directly from the
  // actual plugin source string (not a hand-duplicated literal) and evals
  // it against the real process.env, without needing to compile the
  // plugin's TypeScript/ESM source (which imports "@opencode-ai/plugin",
  // not installed in this test env). If the plugin source changes shape,
  // this extraction — and therefore the test — breaks loudly.
  function evaluateStatus(): string {
    const match = OPENCODE_AUTO_APPROVE_PLUGIN_CONTENT.match(
      /output\.status\s*=\s*(.+);/,
    );
    if (!match) {
      throw new Error(
        "Could not extract output.status assignment from OPENCODE_AUTO_APPROVE_PLUGIN_CONTENT",
      );
    }
    // eslint-disable-next-line no-new-func
    const fn = new Function(`return (${match[1]});`);
    return fn();
  }

  it("plugin source references the TERRAGON_REVIEW_MODE marker and both allow/deny statuses", () => {
    expect(OPENCODE_AUTO_APPROVE_PLUGIN_CONTENT).toContain(
      "TERRAGON_REVIEW_MODE",
    );
    expect(OPENCODE_AUTO_APPROVE_PLUGIN_CONTENT).toContain('"allow"');
    expect(OPENCODE_AUTO_APPROVE_PLUGIN_CONTENT).toContain('"deny"');
    // Re-pins normal-mode behavior: the handler still exists and still
    // assigns output.status (no regression to a no-op plugin).
    expect(OPENCODE_AUTO_APPROVE_PLUGIN_CONTENT).toContain("output.status =");
  });

  it("denies every permission.ask when TERRAGON_REVIEW_MODE=1 (review mode)", () => {
    vi.stubEnv("TERRAGON_REVIEW_MODE", "1");
    expect(evaluateStatus()).toBe("deny");
  });

  it("allows every permission.ask when TERRAGON_REVIEW_MODE is unset (normal mode — unchanged from pre-#88 behavior)", () => {
    vi.stubEnv("TERRAGON_REVIEW_MODE", undefined as unknown as string);
    delete process.env.TERRAGON_REVIEW_MODE;
    expect(evaluateStatus()).toBe("allow");
  });

  it("allows every permission.ask when TERRAGON_REVIEW_MODE is any other value (defense against a truthy-but-wrong marker)", () => {
    vi.stubEnv("TERRAGON_REVIEW_MODE", "true");
    expect(evaluateStatus()).toBe("allow");
  });
});
