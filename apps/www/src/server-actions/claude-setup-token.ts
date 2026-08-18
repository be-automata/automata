"use server";

import { getTenantContextOrNull, userOnlyAction } from "@/lib/auth-server";
import { saveClaudeSetupToken as saveToken } from "@/agent/msg/claudeCredentials";
import { getPostHogServer } from "@/lib/posthog-server";
import { UserFacingError } from "@/lib/server-actions";

/**
 * Prefix of a token minted by `claude setup-token`.
 *
 * Matched on `sk-ant-oat` rather than the current `sk-ant-oat01-` on purpose: the
 * numeric segment is a token-format version, and pinning it would lock every user
 * out the day Anthropic ships `oat02`. The cost of being loose here is bounded —
 * a wrong-but-oat-shaped value fails at first use with a clear 401.
 */
const SETUP_TOKEN_PREFIX = "sk-ant-oat";
/** Anthropic API keys — rejected here so the two fields cannot be swapped. */
const API_KEY_PREFIX = "sk-ant-api";

export const saveClaudeSetupToken = userOnlyAction(
  async function saveClaudeSetupToken(
    userId: string,
    { token }: { token: string },
  ) {
    const trimmed = token.trim();
    if (!trimmed) {
      throw new UserFacingError("Paste the token from `claude setup-token`.");
    }
    // The two Claude credential fields take different secrets that look alike.
    // Naming the mistake beats a generic "invalid format": pasting an API key
    // here (or a setup token in the API-key field) is the likely error, and left
    // unchecked it stores fine and fails later as an opaque 401 at run time.
    if (trimmed.startsWith(API_KEY_PREFIX)) {
      throw new UserFacingError(
        'That is an Anthropic API key. Use "Add API key" instead, or run `claude setup-token` to mint a subscription token.',
      );
    }
    if (!trimmed.startsWith(SETUP_TOKEN_PREFIX)) {
      throw new UserFacingError(
        "That does not look like a `claude setup-token` token — it should start with `sk-ant-oat`.",
      );
    }
    getPostHogServer().capture({
      distinctId: userId,
      event: "claude_setup_token_saved",
      properties: {},
    });
    const tenant = await getTenantContextOrNull();
    await saveToken({
      userId,
      organizationId: tenant?.organizationId ?? null,
      token: trimmed,
    });
  },
  { defaultErrorMessage: "Failed to save the setup token" },
);
