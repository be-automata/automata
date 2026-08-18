import { describe, it, expect } from "vitest";
import {
  CREDENTIAL_KIND,
  credentialKindInfo,
  type CredentialKind,
} from "./credential-kind";

describe("CREDENTIAL_KIND", () => {
  it("covers every kind — a new kind is a compile error, not a silent mislabel", () => {
    // The Record<CredentialKind, …> type is the real enforcement; this asserts the
    // runtime shape matches, so a kind added to the union without an entry fails
    // here too rather than rendering as "Credential" in production.
    const kinds: CredentialKind[] = ["api-key", "oauth", "setup-token"];
    expect(Object.keys(CREDENTIAL_KIND).sort()).toEqual([...kinds].sort());
  });

  it("only the interactive OAuth flow is refreshable", () => {
    // A setup-token and an API key are static until the user replaces them —
    // offering "force refresh" for either would be a no-op that reports success.
    expect(CREDENTIAL_KIND.oauth.refreshable).toBe(true);
    expect(CREDENTIAL_KIND["setup-token"].refreshable).toBe(false);
    expect(CREDENTIAL_KIND["api-key"].refreshable).toBe(false);
  });

  it("account-backed kinds read as connections, a pasted key does not", () => {
    // Drives "Disconnect" vs "Delete" copy.
    expect(CREDENTIAL_KIND.oauth.isConnection).toBe(true);
    expect(CREDENTIAL_KIND["setup-token"].isConnection).toBe(true);
    expect(CREDENTIAL_KIND["api-key"].isConnection).toBe(false);
  });

  it("labels are distinct so the list never shows two kinds the same way", () => {
    const labels = Object.values(CREDENTIAL_KIND).map((k) => k.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("a row from a newer deployment degrades safely instead of throwing", () => {
    // Rolling deploys mean an older instance can read a row a newer one wrote.
    // Show it, never offer it a refresh it cannot do, and do not crash the list.
    const info = credentialKindInfo("some-future-kind");
    expect(info.label).toBe("Credential");
    expect(info.refreshable).toBe(false);
  });
});
