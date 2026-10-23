import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assertRepoAllowed,
  assertTokenResponseRestricted,
  CanaryRefusal,
  installationTokenRequestBody,
  mintInstallationToken,
  parseRepoAllowlist,
  signAppJwt,
} from "./github-token";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

describe("canary repo allowlist", () => {
  // card: protects=the App key only ever mints for an allowlisted repo (default: the container-canary repo); fails_when=any other org repo passes, by case, prefix, wildcard or a crafted slug; no_claim=GitHub's own installation scope
  it("refuses every repo outside CANARY_REPOS", () => {
    const allow = parseRepoAllowlist(undefined);
    expect([...allow]).toEqual(["be-automata/automata-container-canary"]);
    expect(
      assertRepoAllowed("be-automata/automata-container-canary", allow),
    ).toEqual({
      owner: "be-automata",
      name: "automata-container-canary",
    });
    for (const repo of [
      "be-automata/automata",
      "be-automata/automata-container-canary-2",
      "other/automata-container-canary",
      "be-automata/automata-container-canary/../automata",
      "",
    ]) {
      expect(() => assertRepoAllowed(repo, allow)).toThrow(CanaryRefusal);
    }
  });

  // card: protects=an explicit allowlist is exact slugs only; fails_when=a wildcard or malformed entry widens the fence; no_claim=none
  it("parses an explicit list and rejects wildcard entries", () => {
    expect([...parseRepoAllowlist("A/b, c/D")]).toEqual(["a/b", "c/d"]);
    expect(() => parseRepoAllowlist("be-automata/*")).toThrow(CanaryRefusal);
  });
});

describe("canary token request restriction", () => {
  // card: protects=the token request names exactly one repository and the lane's minimum permissions (review read-only); fails_when=the body omits repositories (all-repo token) or asks for admin/workflow/write on a review; no_claim=what GitHub grants (checked by the next card)
  it("builds a single-repo, least-permission body per lane", () => {
    expect(installationTokenRequestBody("canary", "review")).toEqual({
      repositories: ["canary"],
      permissions: {
        contents: "read",
        metadata: "read",
        pull_requests: "read",
      },
    });
    for (const lane of ["task", "mention"] as const) {
      expect(installationTokenRequestBody("canary", lane)).toEqual({
        repositories: ["canary"],
        permissions: {
          contents: "write",
          metadata: "read",
          pull_requests: "write",
          issues: "write",
        },
      });
    }
    expect(() => installationTokenRequestBody("a/b", "task")).toThrow(
      CanaryRefusal,
    );
  });

  // card: protects=a token GitHub returned wider than requested is refused, never used; fails_when=an all-repos selection, a second repo or an unrequested/escalated permission passes; no_claim=GitHub honouring the request
  it("refuses a response that is wider than the request", () => {
    const req = installationTokenRequestBody("canary", "review");
    const ok = {
      token: "ghs_x",
      expires_at: "2026-10-23T12:00:00Z",
      repository_selection: "selected",
      repositories: [{ name: "canary" }],
      permissions: { contents: "read", metadata: "read" },
    };
    expect(assertTokenResponseRestricted(ok, req)).toEqual({
      token: "ghs_x",
      expiresAt: "2026-10-23T12:00:00Z",
    });
    for (const bad of [
      { ...ok, repository_selection: "all" },
      { ...ok, repositories: [{ name: "canary" }, { name: "automata" }] },
      { ...ok, permissions: { contents: "write" } },
      { ...ok, permissions: { administration: "read" } },
      { ...ok, token: undefined },
    ]) {
      expect(() => assertTokenResponseRestricted(bad, req)).toThrow(
        CanaryRefusal,
      );
    }
  });

  // card: protects=the mint POSTs the restricted body to the installation's access_tokens route with an RS256 App JWT; fails_when=the wire body or route drifts from what the restriction card checks; no_claim=a live GitHub call
  it("sends the restricted body with an App JWT", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          token: "ghs_minted",
          expires_at: "2026-10-23T12:00:00Z",
          repository_selection: "selected",
          repositories: [{ name: "automata-container-canary" }],
          permissions: { contents: "write", metadata: "read" },
        }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;
    const out = await mintInstallationToken({
      appId: "123",
      installationId: "456",
      privateKeyPem: PEM,
      repoName: "automata-container-canary",
      lane: "task",
      fetchImpl,
    });
    expect(out.token).toBe("ghs_minted");
    expect(calls[0]?.url).toBe(
      "https://api.github.com/app/installations/456/access_tokens",
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(
      installationTokenRequestBody("automata-container-canary", "task"),
    );
    const auth = (calls[0]?.init.headers as Record<string, string>)
      .Authorization;
    const [, payload] = (auth ?? "").replace("Bearer ", "").split(".");
    expect(
      JSON.parse(Buffer.from(payload ?? "", "base64url").toString()),
    ).toMatchObject({
      iss: "123",
    });
  });

  // card: protects=the App JWT lives ≤ 10 min and is backdated for skew (GitHub's limits); fails_when=exp-iat exceeds 600 s or the id is not numeric; no_claim=signature verification by GitHub
  it("signs a short-lived JWT for a numeric App id only", () => {
    const now = new Date("2026-10-23T10:00:00Z");
    const [, payload] = signAppJwt("123", PEM, now).split(".");
    const claims = JSON.parse(
      Buffer.from(payload ?? "", "base64url").toString(),
    );
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(claims.iat).toBe(now.getTime() / 1000 - 60);
    expect(() => signAppJwt("abc", PEM, now)).toThrow(CanaryRefusal);
  });
});
