import { nanoid } from "nanoid/non-secure";
import { IDaemonRuntime } from "./runtime";
import { type PermissionMode, reviewPolicyArgsFor } from "./shared";

/**
 * Get the Amp API key from the environment.
 * The key is passed from the sandbox environment variables.
 */
export function getAmpApiKeyOrNull(_runtime: IDaemonRuntime): string {
  return process.env.AMP_API_KEY ?? "";
}

/**
 * Review tool-policy for amp (#88, ADR-004 named seam). Ships `[]`: a
 * WebSearch for amp CLI permission/tool flags for the pinned build, amp
 * 0.0.1765471542-g74e231 (packages/sandbox-image/Dockerfile.hbs:81-86),
 * found no verified CLI-argument restriction surface — amp's own
 * documentation exposes `amp.dangerouslyAllowAll` and
 * `amp.permissions`/`amp.guardedFiles.allowlist` as SETTINGS.JSON keys
 * (ampcode.com/manual), not `amp exec`/CLI flags this seam can compose, and
 * no version-pinned confirmation exists that a restricted mode short of the
 * `--dangerously-allow-all` flag runs non-interactively without hanging on
 * a confirmation prompt (amp has no documented non-interactive
 * confirmation-error fallback the way gemini-cli does).
 *
 * Per the orchestrator's safety ruling (#88): do NOT drop
 * `--dangerously-allow-all` without verified non-hanging behavior — the
 * withhold flag (`withholdGitCredentialsInReviewMode`, #76) is the hard
 * guarantee here; #89 (on-disk credential channel) is what actually closes
 * the remaining gap for amp review runs. This seam stays wired (composed as
 * a no-op array spread below) so a verified restriction is a one-array edit
 * later.
 */
export function ampReviewPolicyArgs(): string[] {
  return [];
}

/**
 * Create a command to run the Amp CLI with the given prompt.
 *
 * The command format is:
 *   cat <prompt_file> | amp [threads continue <sessionId>] --execute --stream-json --dangerously-allow-all
 *
 * @param runtime - The daemon runtime
 * @param prompt - The prompt to send to Gemini
 * @returns The shell command to execute
 */
export function ampCommand({
  runtime,
  prompt,
  sessionId,
  permissionMode,
}: {
  runtime: IDaemonRuntime;
  prompt: string;
  sessionId: string | null;
  permissionMode?: PermissionMode;
}): string {
  // Write prompt to a temporary file
  const tmpFileName = `/tmp/amp-prompt-${nanoid()}.txt`;
  runtime.writeFileSync(tmpFileName, prompt);
  // Build the command pipeline
  const parts = ["cat", tmpFileName, "|", "amp"];
  if (sessionId) {
    parts.push("threads continue", sessionId);
  }
  parts.push("--execute", "--stream-json", "--dangerously-allow-all"); // Skip confirmation prompts
  parts.push(...reviewPolicyArgsFor(permissionMode, ampReviewPolicyArgs));
  return parts.join(" ");
}
