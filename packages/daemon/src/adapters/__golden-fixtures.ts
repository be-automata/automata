/**
 * Shared expected values for the A1 golden tests (#75). Both halves —
 * `daemon-golden.test.ts` (drives the REAL daemon over the unix socket,
 * today's path) and `adapter-golden.test.ts` (calls the façades directly,
 * pure) — import from HERE so they assert against the exact same expected
 * literal, not two independently-typed-out strings that could silently
 * drift apart. That is what makes the pair a byte-identical proof rather
 * than two similar-looking snapshots.
 */

export const NORMALIZED_URL = "http://localhost:3000";
export const TOKEN = "TEST_TOKEN_STRING";

/**
 * The review tool-policy, pinned as its exact joined-with-space form
 * (ADR-004 "named seam" invariant: "reviewPolicyArgs() ... a golden test
 * pins."). Byte-identical to the array `claudeCommand` spread before AND
 * after the #75 AC4 extraction.
 */
export const REVIEW_POLICY_JOINED =
  "--permission-mode default --allowedTools Read Grep Glob Bash --disallowedTools 'Bash(gh:*)' 'Bash(git push:*)' --setting-sources user";

export function expectedClaudeEnvNoCredits(
  anthropicApiKey: string,
): Record<string, string> {
  return {
    ANTHROPIC_API_KEY: anthropicApiKey,
    BASH_MAX_TIMEOUT_MS: "60000",
  };
}

export function expectedClaudeEnvWithCredits(): Record<string, string> {
  return {
    ANTHROPIC_API_KEY: "",
    BASH_MAX_TIMEOUT_MS: "60000",
    ANTHROPIC_BASE_URL: `${NORMALIZED_URL}/api/proxy/anthropic`,
    ANTHROPIC_AUTH_TOKEN: TOKEN,
  };
}

export function expectedGeminiEnv(): Record<string, string> {
  return {
    GOOGLE_GEMINI_BASE_URL: `${NORMALIZED_URL}/api/proxy/google`,
    GEMINI_API_KEY: TOKEN,
  };
}

export function expectedOpencodeEnv(apiKey: string): Record<string, string> {
  return { OPENCODE_API_KEY: apiKey };
}

export function expectedAmpEnv(apiKey: string): Record<string, string> {
  return { AMP_API_KEY: apiKey };
}

export const EXPECTED_OPENCODE_MOCK = "Opencode successfully completed";
export const EXPECTED_CODEX_MOCK = "Codex successfully completed";

// Command-string goldens, nanoid-normalized (`/tmp/<agent>-prompt-NANOID.txt`).
// Both daemon-golden.test.ts (real daemon, today's path) and
// adapter-golden.test.ts (pure façade) assert their command output against
// these SAME literals.
export const EXPECTED_CODEX_COMMAND_DEFAULT =
  "cat /tmp/codex-prompt-NANOID.txt | codex exec --dangerously-bypass-approvals-and-sandbox --json --model gpt-5";

export const EXPECTED_CODEX_COMMAND_CREDITS_RESUME =
  'cat /tmp/codex-prompt-NANOID.txt | codex exec --dangerously-bypass-approvals-and-sandbox --json --model gpt-5-codex --config model_reasoning_effort=high -c model_provider="terry" resume SESSION_ABC';

export const EXPECTED_AMP_COMMAND =
  "cat /tmp/amp-prompt-NANOID.txt | amp --execute --stream-json --dangerously-allow-all";

export const EXPECTED_GEMINI_COMMAND =
  "cat /tmp/gemini-prompt-NANOID.txt | gemini --model gemini-3-pro --include-directories / --yolo --output-format stream-json";

export const EXPECTED_OPENCODE_COMMAND =
  "cat /tmp/opencode-prompt-NANOID.txt | opencode run --model terry/grok-code --format json";

/** Normalizes the nanoid-embedded prompt filename so command strings compare stably. */
export function normalizePromptPath(command: string): string {
  return command.replace(
    /\/tmp\/(claude|codex|gemini|opencode|amp)-prompt-[^ ]+\.txt/,
    "/tmp/$1-prompt-NANOID.txt",
  );
}

/**
 * #88 additions — per-adapter `reviewPolicyArgs()` goldens and the
 * review-mode command/env expectations. codex/gemini/amp/opencode ship `[]`
 * (verified-unsafe or wrong-seam per adapter JSDoc, see codex.ts /
 * gemini.ts / amp.ts / opencode.ts); claude's is the pre-existing
 * REVIEW_POLICY_JOINED above. These are ADDITIONS ONLY — the constants
 * above this comment (lines 20-21, 63-76) are byte-identical to pre-#88
 * (AC4 gate).
 */
export const EXPECTED_CODEX_REVIEW_POLICY: string[] = [];
export const EXPECTED_GEMINI_REVIEW_POLICY: string[] = [];
export const EXPECTED_AMP_REVIEW_POLICY: string[] = [];
export const EXPECTED_OPENCODE_REVIEW_POLICY: string[] = [];

// review-mode command strings are byte-identical to the non-review
// EXPECTED_*_COMMAND constants above for codex/gemini/amp/opencode, because
// each ships an empty reviewPolicyArgs() (composed as a no-op array
// spread). Named separately so a future non-empty policy is a single
// literal edit here, not a hunt through the test files.
export const EXPECTED_CODEX_COMMAND_REVIEW = EXPECTED_CODEX_COMMAND_DEFAULT;
export const EXPECTED_GEMINI_COMMAND_REVIEW = EXPECTED_GEMINI_COMMAND;
export const EXPECTED_AMP_COMMAND_REVIEW = EXPECTED_AMP_COMMAND;
export const EXPECTED_OPENCODE_COMMAND_REVIEW = EXPECTED_OPENCODE_COMMAND;

/** The opencode review-mode env marker the mode-aware auto-approve plugin reads (#88 AC2). */
export const OPENCODE_REVIEW_MODE_ENV_KEY = "TERRAGON_REVIEW_MODE";
export const OPENCODE_REVIEW_MODE_ENV_VALUE = "1";
