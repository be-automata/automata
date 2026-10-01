import { assertNever } from "../utils";

/**
 * Which credential path an agent run actually took (#209 item 1). ONE union,
 * decided once by the execution plane (mirrored structurally in
 * packages/worker/src/agent-run/types.ts — never imported across planes) and
 * read back by the thread transcript. Adding a source without mapping it below
 * fails compilation (assertNever).
 *
 * This file contains only literals and user-facing copy. No token, no key, no
 * process.env — the value is an enum label, never credential material.
 */
export const CREDENTIAL_SOURCES = [
  "user-credential",
  "built-in-credits",
  "box-key",
] as const;
export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number];

export function isCredentialSource(value: string): value is CredentialSource {
  return (CREDENTIAL_SOURCES as readonly string[]).includes(value);
}

/**
 * The ONE place the user-facing copy lives — no label literal may appear in a
 * component. The exhaustive switch is the compile-time drift guard.
 */
export function describeCredentialSource(source: CredentialSource): string {
  switch (source) {
    case "user-credential":
      // Agent-neutral on purpose: a delivered credential may be a Claude Code
      // auth file OR an env-var key (Gemini, Amp), so naming one agent here
      // would be wrong for the others.
      return "your connected credential";
    case "built-in-credits":
      return "built-in credits";
    case "box-key":
      return "this box's own API key";
    default:
      return assertNever(source);
  }
}
