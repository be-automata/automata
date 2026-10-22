import { describe, expect, it } from "vitest";

import { containerLanePolicy } from "./container-argv";
import {
  assertNoGithubCredential,
  buildContainerRunEnv,
  composeContainerSettings,
  ContainerPolicyError,
  serializeRunEnvFile,
} from "./container-policy";
import { FOREGROUND_ONLY_PRE_TOOL_USE } from "./foreground-only-hook";

const base = {
  botLogin: "automata-ai-bot[bot]",
  anthropicApiKey: "sk-ant-box",
  credentialDelivered: false,
  credentialEnv: {},
  repoEnv: {},
};

describe("buildContainerRunEnv (the run env file's content)", () => {
  // card: protects=a review container's env carries no GitHub credential of any shape, in C2 and when C3 passes no broker; fails_when=GH_TOKEN/GITHUB_TOKEN or a credential-bearing git config appears; no_claim=files in HOME (the copy-in carries no token either: container-daemon-process.test.ts)
  it("review: no GitHub credential at all", () => {
    const env = buildContainerRunEnv({
      ...base,
      policy: containerLanePolicy("review"),
    });
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(Object.values(env).join("\n")).not.toMatch(/authorization/i);
    expect(() => assertNoGithubCredential(env)).not.toThrow();
  });

  // card: protects=a broker handoff on a review lane is REFUSED (ADR-013 I4: absence, not denial); fails_when=a review env is built with a bearer; no_claim=the C3 wiring itself
  it("review: refuses a broker handoff", () => {
    expect(() =>
      buildContainerRunEnv({
        ...base,
        policy: containerLanePolicy("review"),
        broker: {
          gitUrl: "http://127.0.0.1:3129",
          bearer: "b".repeat(64),
          repoFullName: "acme/app",
        },
      }),
    ).toThrow(ContainerPolicyError);
  });

  // card: protects=a review repo env value shaped like a GitHub token is refused rather than smuggled in; fails_when=`ghs_…` in repo env reaches a review container; no_claim=detection of every possible token format
  it("review: a token-shaped repo env value is refused", () => {
    expect(() =>
      buildContainerRunEnv({
        ...base,
        policy: containerLanePolicy("review"),
        repoEnv: { DEPLOY: `ghs_${"A".repeat(36)}` },
      }),
    ).toThrow(/looks like a GitHub token/);
  });

  // card: protects=the C3 seam: a task lane with a broker gets the bearer as GH_TOKEN/GITHUB_TOKEN and the git insteadOf+extraheader onto the bridged broker URL, never the installation token; fails_when=the bearer is missing or a raw token path exists; no_claim=that the bridge works (C3)
  it("task + broker (C3 seam): bearer only, git rewritten onto the bridge", () => {
    const bearer = "b".repeat(64);
    const env = buildContainerRunEnv({
      ...base,
      policy: containerLanePolicy("task"),
      broker: {
        gitUrl: "http://127.0.0.1:3129",
        bearer,
        repoFullName: "acme/app",
      },
      egressProxyUrl: "http://127.0.0.1:3128",
    });
    expect(env.GH_TOKEN).toBe(bearer);
    expect(env.GITHUB_TOKEN).toBe(bearer);
    expect(env.GH_REPO).toBe("acme/app");
    expect(env.GIT_CONFIG_KEY_0).toBe("url.http://127.0.0.1:3129/.insteadOf");
    expect(env.GIT_CONFIG_VALUE_1).toBe(`Authorization: Bearer ${bearer}`);
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:3128");
    expect(env.AUTOMATA_DAEMON_CALLBACK_VIA_PROXY).toBe("1");
  });

  // card: protects=C2 with no broker: no GitHub credential on any lane, the clone is safe.directory, the bot identity is set, git/system config neutralised; fails_when=any of those drifts; no_claim=git's runtime behaviour in the container
  it("task without a broker (C2): bot identity, safe.directory, no credential", () => {
    const env = buildContainerRunEnv({
      ...base,
      policy: containerLanePolicy("task"),
    });
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_AUTHOR_NAME).toBe("automata-ai-bot[bot]");
    const pairs = Object.fromEntries(
      Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [
        env[`GIT_CONFIG_KEY_${i}`],
        env[`GIT_CONFIG_VALUE_${i}`],
      ]),
    );
    expect(pairs["safe.directory"]).toBe("/workspace");
    expect(pairs["credential.helper"]).toBe("");
    expect(env.GH_CONFIG_DIR).toBe("/home/agent/.config/gh");
  });

  // card: protects=the box key is injected only when no credential was delivered, a delivered credential's env wins, and repo env can neither set a reserved key nor shadow the platform's; fails_when=both credentials coexist or repo env sets HOME/ANTHROPIC_API_KEY/GIT_*; no_claim=the reserved list itself (daemon-env.test.ts)
  it("credential precedence and reserved repo keys", () => {
    const delivered = buildContainerRunEnv({
      ...base,
      policy: containerLanePolicy("task"),
      credentialDelivered: true,
      credentialEnv: { AMP_API_KEY: "amp" },
      repoEnv: { HOME: "/evil", ANTHROPIC_API_KEY: "repo", MY_VAR: "ok" },
    });
    expect(delivered.ANTHROPIC_API_KEY).toBeUndefined();
    expect(delivered.AMP_API_KEY).toBe("amp");
    expect(delivered.HOME).toBeUndefined();
    expect(delivered.MY_VAR).toBe("ok");
    const boxKey = buildContainerRunEnv({
      ...base,
      policy: containerLanePolicy("pr"),
    });
    expect(boxKey.ANTHROPIC_API_KEY).toBe("sk-ant-box");
  });
});

describe("serializeRunEnvFile", () => {
  // card: protects=every value is single-quoted with `'` escaped and names are shell identifiers; fails_when=a value is emitted unquoted or a bad name is accepted; no_claim=the round trip through bash (container-entry.test.ts sources it)
  it("quotes values and refuses non-identifier names", () => {
    expect(serializeRunEnvFile({ A: "it's", B: "" })).toBe(
      "export A='it'\\''s'\nexport B=''\n",
    );
    expect(() => serializeRunEnvFile({ "BAD-NAME": "x" })).toThrow(
      ContainerPolicyError,
    );
    expect(serializeRunEnvFile({})).toBe("");
  });
});

describe("composeContainerSettings (ADR-013 Decision 4)", () => {
  const batteries = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "gsd-start" }] }],
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "gstack-guard" }],
        },
      ],
    },
    permissions: { allow: ["Bash(*)"] },
    env: { LEAK: "1" },
  };

  // card: protects=a review's settings carry ONLY the risky-skill denies: no batteries hooks, no foreground hook, nothing else from the image; fails_when=a hook or an image permission leaks into a review; no_claim=Claude honouring the deny (daemon/CLI behaviour)
  it("review: denies only, no hooks", () => {
    expect(
      composeContainerSettings(containerLanePolicy("review"), batteries),
    ).toEqual({
      permissions: {
        deny: [
          "Skill(cso)",
          "Skill(ship)",
          "Skill(land-and-deploy)",
          "Skill(setup-deploy)",
          "Skill(canary)",
          "Skill(release)",
        ],
      },
    });
  });

  // card: protects=a task's settings take the batteries' hooks (concatenated per event, image hooks first) plus the foreground-only guard, and nothing but hooks from the image file; fails_when=a batteries hook is dropped, the guard is missing, or the image's permissions/env are copied; no_claim=hook execution
  it("task: batteries hooks + foreground guard, nothing else from the image", () => {
    const s = composeContainerSettings(
      containerLanePolicy("task"),
      batteries,
    ) as {
      hooks: Record<string, unknown[]>;
      permissions?: unknown;
      env?: unknown;
    };
    expect(s.permissions).toBeUndefined();
    expect(s.env).toBeUndefined();
    expect(s.hooks.SessionStart).toEqual(batteries.hooks.SessionStart);
    expect(s.hooks.PreToolUse).toEqual([
      ...batteries.hooks.PreToolUse,
      ...FOREGROUND_ONLY_PRE_TOOL_USE,
    ]);
  });

  // card: protects=an absent/unparseable batteries file still yields the foreground guard; fails_when=a missing file drops the guard; no_claim=nothing
  it("task without a batteries file: the guard alone", () => {
    const s = composeContainerSettings(containerLanePolicy("pr"), null) as {
      hooks: Record<string, unknown[]>;
    };
    expect(s.hooks.PreToolUse).toEqual([...FOREGROUND_ONLY_PRE_TOOL_USE]);
  });
});
