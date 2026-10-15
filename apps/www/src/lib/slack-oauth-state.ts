import { decryptValue, encryptValue } from "@terragon/utils/encryption";

/**
 * The OAuth `state` round-tripped through Slack: encrypted, then base64url so
 * no `+`, `/` or `=` reaches the URL. Plain base64 broke the callback on prod:
 * a `+` that comes back as a space corrupts the ciphertext and the AES-GCM tag
 * check throws. Decoding is lenient (spaces → `+`, either alphabet) so links
 * minted before this change still work, and never throws.
 */
export interface SlackOAuthState {
  userId: string;
  organizationId: string | null;
  type: "app_install" | "openid";
  /**
   * The workspace the user asked for, or null for "whichever Slack picks".
   * Slack treats `team` as a hint and can sign the user in elsewhere (a
   * non-distributed app always lands in its home workspace), so the callback
   * refuses a token for any other team.
   */
  teamId: string | null;
  timestamp: number;
}

export function encodeSlackOAuthState(
  state: Omit<SlackOAuthState, "timestamp" | "teamId"> & {
    teamId?: string | null;
  },
  masterKey: string,
  now: number = Date.now(),
): string {
  return encryptValue(
    JSON.stringify({ ...state, teamId: state.teamId ?? null, timestamp: now }),
    masterKey,
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** The decoded state, or null for anything that does not decrypt and parse. */
export function decodeSlackOAuthState(
  raw: string,
  masterKey: string,
): SlackOAuthState | null {
  const base64 = raw.replace(/ /g, "+").replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  try {
    const parsed: unknown = JSON.parse(decryptValue(padded, masterKey));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as SlackOAuthState).userId !== "string" ||
      typeof (parsed as SlackOAuthState).timestamp !== "number"
    ) {
      return null;
    }
    const state = parsed as SlackOAuthState;
    return {
      userId: state.userId,
      // States minted before org-scoped Slack apps carry no org.
      organizationId: state.organizationId ?? null,
      type: state.type,
      // States minted before the workspace check carry no team.
      teamId: typeof state.teamId === "string" ? state.teamId : null,
      timestamp: state.timestamp,
    };
  } catch {
    return null;
  }
}

/**
 * Whether Slack returned the workspace the flow asked for. A flow that named
 * no workspace accepts any.
 */
export function isRequestedSlackTeam(
  state: Pick<SlackOAuthState, "teamId">,
  returnedTeamId: string | null | undefined,
): boolean {
  return state.teamId === null || state.teamId === returnedTeamId;
}
