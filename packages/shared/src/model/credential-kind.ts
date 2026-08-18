/**
 * The kinds of agent-provider credential a user can connect, and the UI-facing
 * facts about each.
 *
 * WHY THIS EXISTS: `agent_provider_credentials.type` is a `text` column with a
 * TypeScript-only union (db/schema.ts) — there is no PG enum and no exhaustive
 * `switch` anywhere in the app. Every consumer was a ternary, so adding a kind
 * compiled clean and silently mislabelled it in the UI, the admin tools, and the
 * delete-confirmation copy. This record makes the compiler do that work: a new
 * kind is a missing key, which is a build error, not a mislabel found in prod.
 *
 * WHAT MUST NOT GO IN HERE: anything about DELIVERY. How a credential reaches a
 * run (a file in $HOME, an env var, or the control-plane proxy) is the resolver's
 * decision — see apps/www/src/agent/credentials.ts, which maps a credential to an
 * `AIAgentCredentials` SHAPE. The execution planes (packages/sandbox,
 * packages/worker, packages/daemon) branch on shape and must never learn that
 * "setup-token" exists. Keeping kind→UI here and kind→shape in the resolver is
 * what keeps the planes decoupled; neither plane may import this module.
 */

export type CredentialKind = "api-key" | "oauth" | "setup-token";

export interface CredentialKindInfo {
  /** Badge text in the credentials list. */
  label: string;
  /**
   * True when the credential represents a connected ACCOUNT rather than a pasted
   * secret. Drives "Disconnect" vs "Delete" copy, and mirrors the fact that
   * removing one clears the user's `isClaudeSub` flag.
   */
  isConnection: boolean;
  /**
   * True when the control plane can mint a fresh access token for it. Only the
   * interactive OAuth flow stores a refresh token; an API key and a
   * `claude setup-token` token are static until the user replaces them. Gates the
   * admin force-refresh action.
   */
  refreshable: boolean;
  /** Whether the list should render the OAuth account metadata block. */
  showsAccountMetadata: boolean;
}

export const CREDENTIAL_KIND: Record<CredentialKind, CredentialKindInfo> = {
  "api-key": {
    label: "API Key",
    isConnection: false,
    refreshable: false,
    showsAccountMetadata: false,
  },
  oauth: {
    label: "Subscription",
    isConnection: true,
    refreshable: true,
    showsAccountMetadata: true,
  },
  "setup-token": {
    label: "Setup Token",
    isConnection: true,
    // No refresh token exists for a setup-token; the user re-mints with
    // `claude setup-token` and pastes the new one.
    refreshable: false,
    // The account probe needs scopes a setup-token does not carry, so there is
    // usually no email/org to show.
    showsAccountMetadata: false,
  },
};

/**
 * Kind info for a stored credential, tolerant of a row written by a NEWER
 * deployment than the one reading it (rolling deploys, or a row created by a
 * future kind). Falls back to the most conservative presentation rather than
 * throwing: an unknown credential is shown, not hidden, and is never offered a
 * refresh it cannot do.
 */
export function credentialKindInfo(type: string): CredentialKindInfo {
  return (
    CREDENTIAL_KIND[type as CredentialKind] ?? {
      label: "Credential",
      isConnection: true,
      refreshable: false,
      showsAccountMetadata: false,
    }
  );
}
