/**
 * #442 (epic #440 C2): why a credential is marked unavailable, stored in
 * `agent_provider_credentials.unavailable_reason` (plain `text` + this union,
 * like `CredentialKind`, so widening it needs no migration).
 *
 * - `usage_limit`: a five-hour or weekly cap; timed, it resets on its own.
 * - `subscription_disabled`: the Claude organization's admin disabled Claude
 *   Code; indefinite, only an admin clear removes it.
 * - `auth_rejected` (#472): the provider refused the credential (revoked,
 *   invalid); indefinite until reconnected, which inserts a new row.
 *
 * `credit_exhausted` is deliberately absent: it concerns the built-in key, not
 * a row (epic decision), and is an operator alert (C4), never a mark.
 */
export type CredentialUnavailableReason =
  | "usage_limit"
  | "subscription_disabled"
  | "auth_rejected";
