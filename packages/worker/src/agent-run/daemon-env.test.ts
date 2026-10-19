import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadWorkerConfig } from "./config";
import { DaemonProcess } from "./daemon-process";
import {
  AGENT_PATH_PREPEND_ENV,
  appendGitConfig,
  buildDaemonEnv,
  buildRunProxyEnv,
  gitProxyAuthConfig,
  isReservedRepoEnvKey,
  SAFE_ENV_KEYS,
} from "./daemon-env";
import type { AgentRunInput } from "./types";

const INSTALL_TOKEN = "ghs_installationtoken123";

function build(overrides: Record<string, string | undefined> = {}) {
  return buildDaemonEnv({
    baseEnv: {
      PATH: "/usr/bin:/bin",
      HOME: "/home/op",
      LANG: "en_US.UTF-8",
      // Ambient operator credentials/identity that MUST NOT reach the agent:
      GH_TOKEN: "gho_operatorpersonaltoken",
      GITHUB_TOKEN: "gho_operatorpersonaltoken",
      GH_CONFIG_DIR: "/home/op/.config/gh",
      GH_HOST: "github.com",
      GITHUB_ACTOR: "espinozasenior",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      GIT_ASKPASS: "/usr/bin/op-askpass",
      GIT_CONFIG_GLOBAL: "/home/op/.gitconfig",
      GITHUB_ENTERPRISE_TOKEN: "ent_token",
      // Unknown ambient secrets a whitelist blocks by default (a denylist would miss):
      AWS_SECRET_ACCESS_KEY: "aws_secret_xyz",
      NPM_TOKEN: "npm_secret_xyz",
      STRIPE_API_KEY: "sk_live_xyz",
      SOME_RANDOM_VAR: "whatever",
      ...overrides,
    },
    anthropicApiKey: "sk-ant-xxx",
    claudeBinDir: "/opt/claude/bin",
    installationToken: INSTALL_TOKEN,
    ghConfigDir: "/tmp/isolated-gh",
    botLogin: "automata-ai-bot[bot]",
  });
}

describe("buildDaemonEnv — credential isolation (ADR-002 customer box)", () => {
  it("whitelists: only known-safe keys are forwarded; every ambient secret/unknown var is dropped", () => {
    const env = build();
    // Ambient GitHub/git identity + credential vars: gone.
    expect(env.GITHUB_ACTOR).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
    expect(env.GH_HOST).toBeUndefined();
    // The strength of the whitelist: UNKNOWN ambient secrets a denylist would miss.
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.STRIPE_API_KEY).toBeUndefined();
    expect(env.SOME_RANDOM_VAR).toBeUndefined();
    // None of the ambient secret VALUES appear anywhere in the child env.
    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain("gho_operatorpersonaltoken");
    expect(serialized).not.toContain("aws_secret_xyz");
    expect(serialized).not.toContain("sk_live_xyz");
    // Only whitelisted keys or the explicitly-injected run keys survive.
    const injected = new Set([
      "ANTHROPIC_API_KEY",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_CONFIG_DIR",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM",
      "GIT_CONFIG_COUNT",
      "GIT_TERMINAL_PROMPT",
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
    ]);
    for (const key of Object.keys(env)) {
      const ok =
        SAFE_ENV_KEYS.has(key) ||
        injected.has(key) ||
        /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key);
      expect(ok, `unexpected key leaked into child env: ${key}`).toBe(true);
    }
  });

  describe("D1 — which model credential the run gets", () => {
    it("legacy shape (no runHome): the box key is the credential and HOME stays ambient", () => {
      const env = build();
      expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xxx");
      expect(env.HOME).toBe("/home/op");
    });

    it("a credits-only run STILL gets a fresh HOME — an inherited one leaks the box owner's Keychain login", () => {
      // The failure this pins has no file and no env var to find: on macOS the
      // agent CLI reads its OAuth from the login Keychain, so a run left on the
      // operator's HOME authenticates AS the operator and spends their
      // subscription — on a run that was routed to the proxy. Verified on Claude
      // Code 2.1.234: a fresh HOME yields "Not logged in".
      const env = buildDaemonEnv({
        baseEnv: { PATH: "/usr/bin", HOME: "/home/op" },
        anthropicApiKey: "sk-ant-boxkey",
        claudeBinDir: "",
        installationToken: INSTALL_TOKEN,
        ghConfigDir: "/tmp/isolated-gh",
        botLogin: "automata-ai-bot[bot]",
        runHome: "/tmp/run-42/home",
        credentialDelivered: false,
      });
      expect(env.HOME).toBe("/tmp/run-42/home");
      expect(env.HOME).not.toBe("/home/op");
    });

    it("with a delivered credential: HOME is the run's own, and the box key is GONE", () => {
      const env = buildDaemonEnv({
        baseEnv: { PATH: "/usr/bin", HOME: "/home/op" },
        anthropicApiKey: "sk-ant-boxkey",
        claudeBinDir: "",
        installationToken: INSTALL_TOKEN,
        ghConfigDir: "/tmp/isolated-gh",
        botLogin: "automata-ai-bot[bot]",
        runHome: "/tmp/run-42/home",
        credentialDelivered: true,
      });
      // The agent CLI reads $HOME/.claude/.credentials.json. Pointing HOME at the
      // run dir is what makes it read THIS run's credential instead of the
      // operator's login — and what stops one run clobbering another's.
      expect(env.HOME).toBe("/tmp/run-42/home");
      // Two credentials for one call means the CLI's precedence rule picks who
      // pays. That ambiguity is exactly how the box key silently won for users
      // who had a subscription, so the box key must not be present at all.
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(JSON.stringify(env)).not.toContain("sk-ant-boxkey");
    });

    it("injects credential env (Amp) past the secret-pattern filter that would drop it", () => {
      const env = buildDaemonEnv({
        baseEnv: { PATH: "/usr/bin", HOME: "/home/op" },
        anthropicApiKey: "",
        claudeBinDir: "",
        installationToken: INSTALL_TOKEN,
        ghConfigDir: "/tmp/isolated-gh",
        botLogin: "automata-ai-bot[bot]",
        credentialEnv: { AMP_API_KEY: "sgamp_user_test" },
      });
      // AMP_API_KEY matches SECRET_KEY_PATTERN, so ambient forwarding would drop
      // it. It is injected explicitly, after the whitelist pass.
      expect(env.AMP_API_KEY).toBe("sgamp_user_test");
    });
  });

  it("CLAUDE_CODE_SIMPLE never reaches the child env, review-lane or not (#77)", () => {
    // Nothing in the repo sets this var; forwarding it is the documented
    // OAuth-file-auth killer this whitelist exists to fence. Pinned with
    // teeth: even if an operator's ambient env carries it, it must not
    // survive the whitelist pass, in either credential mode.
    const reviewLane = build({ CLAUDE_CODE_SIMPLE: "1" });
    expect(reviewLane.CLAUDE_CODE_SIMPLE).toBeUndefined();

    const nonReviewLane = buildDaemonEnv({
      baseEnv: { PATH: "/usr/bin", HOME: "/home/op", CLAUDE_CODE_SIMPLE: "1" },
      anthropicApiKey: "sk-ant-boxkey",
      claudeBinDir: "",
      installationToken: INSTALL_TOKEN,
      ghConfigDir: "/tmp/isolated-gh",
      botLogin: "automata-ai-bot[bot]",
      runHome: "/tmp/run-42/home",
      credentialDelivered: true,
    });
    expect(nonReviewLane.CLAUDE_CODE_SIMPLE).toBeUndefined();
  });

  describe("#66 slice 2 — egress proxy env injection", () => {
    const PROXY_URL = "http://127.0.0.1:54321";
    // Operator boxes can carry an ambient corporate proxy — it must NEVER
    // reach the child (it would re-route run traffic through operator infra
    // and, when a policy is set, shadow the enforcing per-run proxy).
    const ambientProxies = {
      HTTPS_PROXY: "http://corp-proxy.internal:3128",
      HTTP_PROXY: "http://corp-proxy.internal:3128",
      https_proxy: "http://corp-proxy.internal:3128",
      http_proxy: "http://corp-proxy.internal:3128",
      NO_PROXY: "corp.internal",
      no_proxy: "corp.internal",
    };

    it("sets all 6 proxy vars when egressProxyUrl is set (and they point at the run proxy, not ambient)", () => {
      const env = buildDaemonEnv({
        baseEnv: { PATH: "/usr/bin", HOME: "/home/op", ...ambientProxies },
        anthropicApiKey: "sk-ant-xxx",
        claudeBinDir: "",
        installationToken: INSTALL_TOKEN,
        ghConfigDir: "/tmp/isolated-gh",
        botLogin: "automata-ai-bot[bot]",
        egressProxyUrl: PROXY_URL,
      });
      expect(env.HTTPS_PROXY).toBe(PROXY_URL);
      expect(env.HTTP_PROXY).toBe(PROXY_URL);
      expect(env.https_proxy).toBe(PROXY_URL);
      expect(env.http_proxy).toBe(PROXY_URL);
      // Loopback carve-out: daemon socket, git broker, and the proxy itself.
      expect(env.NO_PROXY).toBe("127.0.0.1,localhost");
      expect(env.no_proxy).toBe("127.0.0.1,localhost");
      expect(JSON.stringify(env)).not.toContain("corp-proxy.internal");
      // #108 D1: belt-and-braces for the agent CLI child (node >=22.21/>=24).
      expect(env.NODE_USE_ENV_PROXY).toBe("1");
      // #108 F5: a policy-bearing run WITHOUT agentUser keeps the DIRECT daemon
      // callback it has always had. This is the pre-existing #66 shape.
      expect(env.AUTOMATA_DAEMON_CALLBACK_VIA_PROXY).toBeUndefined();
    });

    it("opts the daemon callback onto the proxy ONLY in agent-uid mode (#108 F5)", () => {
      const env = buildDaemonEnv({
        baseEnv: { PATH: "/usr/bin", HOME: "/home/op" },
        anthropicApiKey: "sk-ant-xxx",
        claudeBinDir: "",
        installationToken: INSTALL_TOKEN,
        ghConfigDir: "/tmp/isolated-gh",
        botLogin: "automata-ai-bot[bot]",
        egressProxyUrl: PROXY_URL,
        agentUser: "_automata-agent",
        runHome: "/tmp/run-home",
      });
      expect(env.AUTOMATA_DAEMON_CALLBACK_VIA_PROXY).toBe("1");
    });

    it("never opts in without a proxy, even in agent-uid mode (#108 F5)", () => {
      const env = buildDaemonEnv({
        baseEnv: { PATH: "/usr/bin", HOME: "/home/op" },
        anthropicApiKey: "sk-ant-xxx",
        claudeBinDir: "",
        installationToken: INSTALL_TOKEN,
        ghConfigDir: "/tmp/isolated-gh",
        botLogin: "automata-ai-bot[bot]",
        agentUser: "_automata-agent",
        runHome: "/tmp/run-home",
      });
      expect(env.AUTOMATA_DAEMON_CALLBACK_VIA_PROXY).toBeUndefined();
    });

    it("injects NOTHING when unset — and ambient proxy vars stay stripped by the whitelist", () => {
      const env = buildDaemonEnv({
        baseEnv: { PATH: "/usr/bin", HOME: "/home/op", ...ambientProxies },
        anthropicApiKey: "sk-ant-xxx",
        claudeBinDir: "",
        installationToken: INSTALL_TOKEN,
        ghConfigDir: "/tmp/isolated-gh",
        botLogin: "automata-ai-bot[bot]",
      });
      for (const key of Object.keys(ambientProxies)) {
        expect(env[key], key).toBeUndefined();
      }
      // The default-off proof for #108 D1: no proxy, no node proxy hint.
      expect(env.NODE_USE_ENV_PROXY).toBeUndefined();
      expect(env.AUTOMATA_DAEMON_CALLBACK_VIA_PROXY).toBeUndefined();
    });
  });

  describe("#108 — agent-uid mode drops what is unsafe across a uid boundary", () => {
    const AMBIENT = {
      PATH: "/usr/bin",
      HOME: "/home/op",
      USER: "operator",
      NODE_OPTIONS: "--require /Users/op/evil.js",
      TMPDIR: "/var/folders/j0/abc/T/",
      TMP: "/var/folders/j0/abc/T/",
      TEMP: "/var/folders/j0/abc/T/",
      XDG_CONFIG_HOME: "/home/op/.config",
      XDG_DATA_HOME: "/home/op/.local/share",
      XDG_CACHE_HOME: "/home/op/.cache",
      XDG_RUNTIME_DIR: "/run/user/501",
    };

    const base = {
      anthropicApiKey: "sk-ant-xxx",
      claudeBinDir: "",
      installationToken: INSTALL_TOKEN,
      ghConfigDir: "/tmp/isolated-gh",
      botLogin: "automata-ai-bot[bot]",
    };

    it("agentUser empty: forwards NODE_OPTIONS, TMPDIR, USER and the XDG dirs exactly as today", () => {
      const env = buildDaemonEnv({ baseEnv: AMBIENT, ...base });
      expect(env.NODE_OPTIONS).toBe("--require /Users/op/evil.js");
      expect(env.TMPDIR).toBe("/var/folders/j0/abc/T/");
      expect(env.TMP).toBe("/var/folders/j0/abc/T/");
      expect(env.TEMP).toBe("/var/folders/j0/abc/T/");
      expect(env.USER).toBe("operator");
      expect(env.XDG_CONFIG_HOME).toBe("/home/op/.config");
      expect(env.XDG_RUNTIME_DIR).toBe("/run/user/501");
      expect(env.LOGNAME).toBeUndefined();
    });

    it("agentUser set: NODE_OPTIONS is dropped (sudo -E would carry a --require across)", () => {
      const env = buildDaemonEnv({
        baseEnv: AMBIENT,
        ...base,
        agentUser: "_automata-agent",
      });
      expect(env.NODE_OPTIONS).toBeUndefined();
    });

    it("agentUser set: the operator TMPDIR/TMP/TEMP and every XDG_* var are dropped", () => {
      const env = buildDaemonEnv({
        baseEnv: AMBIENT,
        ...base,
        agentUser: "_automata-agent",
      });
      for (const key of [
        "TMP",
        "TEMP",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_RUNTIME_DIR",
      ]) {
        expect(env[key], key).toBeUndefined();
      }
      expect(env.TMPDIR).toBeUndefined(); // no runTmpDir given
    });

    it("agentUser set: TMPDIR points into the run workdir when one is given", () => {
      const env = buildDaemonEnv({
        baseEnv: AMBIENT,
        ...base,
        agentUser: "_automata-agent",
        runTmpDir: "/usr/local/automata/runs/thr_1/tmp",
      });
      expect(env.TMPDIR).toBe("/usr/local/automata/runs/thr_1/tmp");
    });

    it("agentUser set: USER and LOGNAME name the agent account, not the operator", () => {
      const env = buildDaemonEnv({
        baseEnv: AMBIENT,
        ...base,
        agentUser: "_automata-agent",
      });
      expect(env.USER).toBe("_automata-agent");
      expect(env.LOGNAME).toBe("_automata-agent");
    });

    it("agentUser set: HOME is still the per-run HOME (the #50 seed is unaffected)", () => {
      const env = buildDaemonEnv({
        baseEnv: AMBIENT,
        ...base,
        agentUser: "_automata-agent",
        runHome: "/usr/local/automata/runs/thr_1/home",
      });
      expect(env.HOME).toBe("/usr/local/automata/runs/thr_1/home");
    });
  });

  describe("#81 — brokered credentials: the agent env NEVER carries the installation token", () => {
    const BROKER = {
      gitUrl: "http://127.0.0.1:45678",
      ghSocketPath: "/tmp/automata-agent-run/w-1/thr_1-gh.sock",
      bearer: "runbearer0123456789abcdef",
      repoFullName: "be-automata/automata",
    };

    function buildBrokered() {
      return buildDaemonEnv({
        baseEnv: { PATH: "/usr/bin", HOME: "/home/op" },
        anthropicApiKey: "sk-ant-xxx",
        claudeBinDir: "",
        installationToken: INSTALL_TOKEN,
        ghConfigDir: "/tmp/isolated-gh",
        botLogin: "automata-ai-bot[bot]",
        broker: BROKER,
      });
    }

    it("the DoD assertion: no env value equals or contains the installation token (raw or base64)", () => {
      const serialized = JSON.stringify(buildBrokered());
      expect(serialized).not.toContain(INSTALL_TOKEN);
      const b64 = Buffer.from(`x-access-token:${INSTALL_TOKEN}`).toString(
        "base64",
      );
      expect(serialized).not.toContain(b64);
    });

    it("GH_TOKEN/GITHUB_TOKEN are the per-run bearer, GH_REPO restores gh targeting, config dir unchanged", () => {
      const env = buildBrokered();
      // The bearer doubles as gh's non-empty token placeholder; `gh auth token`
      // prints only this useless-off-box value.
      expect(env.GH_TOKEN).toBe(BROKER.bearer);
      expect(env.GITHUB_TOKEN).toBe(BROKER.bearer);
      // The insteadOf rewrite breaks gh's remote-based repo resolution (spike
      // E4); GH_REPO is the verified mitigation.
      expect(env.GH_REPO).toBe(BROKER.repoFullName);
      expect(env.GH_CONFIG_DIR).toBe("/tmp/isolated-gh");
    });

    it("git config rewrites github.com onto the broker with the Bearer extraheader — and NO github.com extraheader", () => {
      const env = buildBrokered();
      const count = Number(env.GIT_CONFIG_COUNT);
      const entries = new Map<string, string>();
      for (let i = 0; i < count; i++) {
        entries.set(env[`GIT_CONFIG_KEY_${i}`]!, env[`GIT_CONFIG_VALUE_${i}`]!);
      }
      // insteadOf also rewrites ad-hoc URLs the agent types — remote surgery
      // on the clone would miss those.
      expect(entries.get(`url.${BROKER.gitUrl}/.insteadOf`)).toBe(
        "https://github.com/",
      );
      // Exactly the `Bearer ${runBearer}` git-broker.ts expects.
      expect(entries.get(`http.${BROKER.gitUrl}/.extraheader`)).toBe(
        `Authorization: Bearer ${BROKER.bearer}`,
      );
      expect(entries.has("http.https://github.com/.extraheader")).toBe(false);
      // Neutralization + bot identity survive brokering.
      expect(entries.get("credential.helper")).toBe("");
      expect(entries.get("user.name")).toBe("automata-ai-bot[bot]");
    });

    describe("phase 7 — read-only task token (GITHUB_TOKEN only, brokered only)", () => {
      const READ = "ghs_read";
      const brokeredWith = (githubReadToken?: string | null) =>
        buildDaemonEnv({
          baseEnv: { PATH: "/usr/bin", HOME: "/home/op" },
          anthropicApiKey: "sk-ant-xxx",
          claudeBinDir: "",
          installationToken: INSTALL_TOKEN,
          ghConfigDir: "/tmp/isolated-gh",
          botLogin: "automata-ai-bot[bot]",
          broker: BROKER,
          githubReadToken,
        });

      it("brokered + read token: GITHUB_TOKEN is the read token, everything else is today's brokered env", () => {
        const env = brokeredWith(READ);
        const today = buildBrokered();
        expect(env.GITHUB_TOKEN).toBe(READ);
        expect(env.GH_TOKEN).toBe(BROKER.bearer);
        expect({ ...env, GITHUB_TOKEN: today.GITHUB_TOKEN }).toEqual(today);
        // git still authenticates to the git broker with the bearer.
        const values = Object.entries(env)
          .filter(([k]) => k.startsWith("GIT_CONFIG_VALUE_"))
          .map(([, v]) => v);
        expect(values).toContain(`Authorization: Bearer ${BROKER.bearer}`);
        expect(values.some((v) => v?.includes(READ))).toBe(false);
        // The write-capable installation token is still nowhere.
        expect(JSON.stringify(env)).not.toContain(INSTALL_TOKEN);
      });

      it.each([[undefined], [null], [""]])(
        "brokered with githubReadToken %j: byte-identical to today's brokered env",
        (value) => {
          expect(brokeredWith(value)).toEqual(buildBrokered());
        },
      );

      it("legacy (no broker) ignores the read token: byte-identical to today's legacy env", () => {
        const legacy = (githubReadToken?: string) =>
          buildDaemonEnv({
            baseEnv: { PATH: "/usr/bin", HOME: "/home/op" },
            anthropicApiKey: "sk-ant-xxx",
            claudeBinDir: "",
            installationToken: INSTALL_TOKEN,
            ghConfigDir: "/tmp/isolated-gh",
            botLogin: "automata-ai-bot[bot]",
            githubReadToken,
          });
        expect(legacy(READ)).toEqual(legacy());
        expect(JSON.stringify(legacy(READ))).not.toContain(READ);
      });
    });

    it("broker: null is the verbatim legacy env — the rollback contract", () => {
      const env = build();
      expect(env.GH_TOKEN).toBe(INSTALL_TOKEN);
      expect(env.GH_REPO).toBeUndefined();
      expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    });
  });

  it("defense-in-depth: a secret-looking key is never forwarded even if whitelisted", () => {
    // Sanity: no whitelisted key matches the secret pattern (would be dropped).
    const secretish = [...SAFE_ENV_KEYS].filter((k) =>
      /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i.test(k),
    );
    expect(secretish).toEqual([]);
  });

  it("wires the installation token as THE gh credential with an isolated config dir", () => {
    const env = build();
    expect(env.GH_TOKEN).toBe(INSTALL_TOKEN);
    expect(env.GITHUB_TOKEN).toBe(INSTALL_TOKEN);
    // Isolated empty gh config dir → gh cannot fall back to the operator's hosts.yml.
    expect(env.GH_CONFIG_DIR).toBe("/tmp/isolated-gh");
  });

  it("wires the installation token as the git push credential and neutralizes host git config", () => {
    const env = build();
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_CONFIG_SYSTEM).toBe("/dev/null");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    // The injected git config carries the installation-token extraheader + bot identity.
    const count = Number(env.GIT_CONFIG_COUNT);
    expect(count).toBeGreaterThan(0);
    const keys: string[] = [];
    const values: string[] = [];
    for (let i = 0; i < count; i++) {
      keys.push(env[`GIT_CONFIG_KEY_${i}`]!);
      values.push(env[`GIT_CONFIG_VALUE_${i}`]!);
    }
    expect(keys).toContain("http.https://github.com/.extraheader");
    expect(keys).toContain("credential.helper");
    expect(keys).toContain("user.name");
    // The extraheader encodes x-access-token:<installationToken> (base64 Basic).
    const b64 = Buffer.from(`x-access-token:${INSTALL_TOKEN}`).toString(
      "base64",
    );
    expect(values.some((v) => v.includes(b64))).toBe(true);
    // credential.helper is reset to empty (disables inherited osxkeychain/gh helpers).
    const helperIdx = keys.indexOf("credential.helper");
    expect(values[helperIdx]).toBe("");
    // Commit identity is the bot, never the operator.
    expect(values[keys.indexOf("user.name")]).toBe("automata-ai-bot[bot]");
  });

  it("preserves non-credential env the agent needs (PATH augmented, HOME/LANG kept)", () => {
    const env = build();
    expect(env.HOME).toBe("/home/op");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xxx");
    expect(env.PATH).toBe("/opt/claude/bin:/usr/bin:/bin");
  });

  it("does not leak a stale GIT_CONFIG_KEY_* injection from the base env", () => {
    // An ambient GIT_CONFIG_COUNT/KEY/VALUE (operator injection) must be dropped so
    // it cannot shadow ours.
    const env = build({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "osxkeychain",
    });
    // Our injection replaces it: KEY_0 is our extraheader, not the operator's helper.
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
  });
});

describe("#108: git must not refuse the agent's own checkout", () => {
  const base = {
    baseEnv: {} as NodeJS.ProcessEnv,
    anthropicApiKey: "",
    claudeBinDir: "/usr/local/bin",
    installationToken: "ghs_x",
    ghConfigDir: "/tmp/gh",
    botLogin: "automata-ai-bot[bot]",
    workdir: "/usr/local/automata/runs/thr-1",
  };

  function gitConfigOf(env: NodeJS.ProcessEnv): Record<string, string> {
    const out: Record<string, string> = {};
    const n = Number(env.GIT_CONFIG_COUNT ?? "0");
    for (let i = 0; i < n; i++) {
      const k = env[`GIT_CONFIG_KEY_${i}`];
      const v = env[`GIT_CONFIG_VALUE_${i}`];
      if (k !== undefined) out[k] = v ?? "";
    }
    return out;
  }

  it("marks THIS run's checkout safe for the agent uid", () => {
    // The worker clones it, the agent runs in it, and git refuses a repository
    // owned by someone else: "detected dubious ownership". Every git command
    // then fails — including the `git diff origin/main...HEAD` a review agent
    // opens with, so it reports that it cannot review instead of producing a
    // verdict. Observed in production the first run that got that far.
    const env = buildDaemonEnv({ ...base, agentUser: "automata-agent" });
    expect(gitConfigOf(env)["safe.directory"]).toBe(base.workdir);
  });

  it("scopes it to the workdir and never uses the wildcard", () => {
    // `*` would trust every repository on the box, including other runs' and
    // the operator's own checkouts.
    const env = buildDaemonEnv({ ...base, agentUser: "automata-agent" });
    expect(gitConfigOf(env)["safe.directory"]).not.toBe("*");
    expect(Object.values(gitConfigOf(env))).not.toContain("*");
  });

  it("adds nothing in default mode, where owner and runner are one uid", () => {
    const env = buildDaemonEnv({ ...base, agentUser: "" });
    expect(gitConfigOf(env)).not.toHaveProperty("safe.directory");
  });
});

describe("buildRunProxyEnv (phase 8 shared proxy subset)", () => {
  it("returns exactly the proxy subset for an empty base", () => {
    expect(buildRunProxyEnv("http://127.0.0.1:9999", {})).toEqual({
      HTTPS_PROXY: "http://127.0.0.1:9999",
      HTTP_PROXY: "http://127.0.0.1:9999",
      https_proxy: "http://127.0.0.1:9999",
      http_proxy: "http://127.0.0.1:9999",
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
      NODE_USE_ENV_PROXY: "1",
    });
  });

  it("does not mutate base and keeps its keys", () => {
    const base = { PATH: "/bin" };
    const out = buildRunProxyEnv("http://127.0.0.1:1", base);
    expect(base).toEqual({ PATH: "/bin" });
    expect(out.PATH).toBe("/bin");
  });

  it("buildDaemonEnv with a proxy url carries the same subset", () => {
    const env = buildDaemonEnv({
      baseEnv: { PATH: "/bin" },
      anthropicApiKey: "k",
      claudeBinDir: "",
      installationToken: "t",
      ghConfigDir: "/g",
      botLogin: "b",
      egressProxyUrl: "http://127.0.0.1:4242",
    });
    const subset = buildRunProxyEnv("http://127.0.0.1:4242", {});
    for (const [k, v] of Object.entries(subset)) expect(env[k]).toBe(v);
  });

  it("a run input carrying a selfHeal check token never reaches the daemon env", () => {
    const env = buildDaemonEnv({
      baseEnv: { PATH: "/bin", CHECK_TOKEN: "TOKEN_SENTINEL" },
      anthropicApiKey: "k",
      claudeBinDir: "",
      installationToken: "t",
      ghConfigDir: "/g",
      botLogin: "b",
    });
    expect(JSON.stringify(env)).not.toContain("TOKEN_SENTINEL");
  });
});

describe("GATE-01: a fix run's gate token never reaches the daemon/agent env (09-10)", () => {
  it("the env DaemonProcess builds from a fix input carries no gate token", async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-gate-"));
    const input: AgentRunInput = {
      threadId: "thr_gate",
      threadChatId: "tc_1",
      repoFullName: "o/r",
      branch: "main",
      daemonCallbackUrl: "http://localhost:3999",
      installationToken: "inst",
      daemonToken: "daemon",
      orgId: "org-1",
      selfHeal: {
        kind: "fix",
        attemptId: "11111111-1111-4111-8111-111111111111",
        branch: "automata/fix-1-a1",
        baseBranch: "main",
        checks: [],
        denyExceptions: [],
        gateToken: "TOKEN_SENTINEL",
      },
    };
    const daemon = new DaemonProcess(
      loadWorkerConfig({}),
      input,
      workdir,
      null,
      "http://127.0.0.1:4242",
      {
        gitUrl: "http://127.0.0.1:41999",
        ghSocketPath: "/tmp/gate-gh.sock",
        bearer: "bearer",
        repoFullName: "o/r",
      },
    );
    const internals = daemon as unknown as {
      ensureEnv(): Promise<NodeJS.ProcessEnv>;
      ghConfigDir: string | null;
    };
    try {
      const env = await internals.ensureEnv();
      expect(Object.keys(env).length).toBeGreaterThan(0);
      expect(JSON.stringify(env)).not.toContain("TOKEN_SENTINEL");
    } finally {
      if (internals.ghConfigDir) {
        fs.rmSync(internals.ghConfigDir, { recursive: true, force: true });
      }
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });
});

describe("task-run repo environment (prompt-defined automations)", () => {
  const base = {
    baseEnv: { PATH: "/usr/bin:/bin", HOME: "/home/op" },
    anthropicApiKey: "sk-ant-box",
    claudeBinDir: "/opt/claude/bin",
    installationToken: INSTALL_TOKEN,
    ghConfigDir: "/tmp/isolated-gh",
    botLogin: "automata-ai-bot[bot]",
    runHome: "/run/home",
  };

  it("hands the owner's variables to the agent", () => {
    const env = buildDaemonEnv({
      ...base,
      repoEnv: {
        YOUTRACK_URL: "https://tracker.example",
        YOUTRACK_AGENT_TOKEN: "perm:abc",
      },
    });
    expect(env.YOUTRACK_URL).toBe("https://tracker.example");
    expect(env.YOUTRACK_AGENT_TOKEN).toBe("perm:abc");
  });

  it("never lets them steer the runtime or replace a platform key", () => {
    const env = buildDaemonEnv({
      ...base,
      egressProxyUrl: "http://127.0.0.1:9999",
      repoEnv: {
        PATH: "/evil",
        home: "/evil",
        NODE_OPTIONS: "--require /evil.js",
        LD_PRELOAD: "/evil.so",
        GH_TOKEN: "x",
        GITHUB_TOKEN: "x",
        GIT_CONFIG_COUNT: "0",
        ANTHROPIC_API_KEY: "sk-ant-user",
        CLAUDE_CODE_SIMPLE: "1",
        HTTPS_PROXY: "http://evil",
        https_proxy: "http://evil",
      },
    });
    expect(env.PATH).toBe("/opt/claude/bin:/usr/bin:/bin");
    expect(env.HOME).toBe("/run/home");
    expect(env.home).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.GH_TOKEN).toBe(INSTALL_TOKEN);
    expect(env.GITHUB_TOKEN).toBe(INSTALL_TOKEN);
    expect(env.GIT_CONFIG_COUNT).not.toBe("0");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-box");
    expect(env.CLAUDE_CODE_SIMPLE).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:9999");
    expect(env.https_proxy).toBe("http://127.0.0.1:9999");
  });

  it("never overrides an ambient key the whitelist forwards, nor TLS trust", () => {
    const ambient = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/op",
      EDITOR: "vim",
      PAGER: "less",
      NODE_EXTRA_CA_CERTS: "/etc/op-ca.pem",
      npm_config_cache: "/var/npm",
      LANG: "en_US.UTF-8",
    };
    const env = buildDaemonEnv({
      ...base,
      baseEnv: ambient,
      repoEnv: {
        EDITOR: "/evil",
        VISUAL: "/evil",
        PAGER: "/evil",
        NODE_EXTRA_CA_CERTS: "/evil-ca.pem",
        npm_config_cache: "/evil",
        NPM_CONFIG_PREFIX: "/evil",
        LANG: "C",
        SSL_CERT_FILE: "/evil-ca.pem",
        REQUESTS_CA_BUNDLE: "/evil-ca.pem",
        CURL_CA_BUNDLE: "/evil-ca.pem",
        BASH_ENV: "/evil.sh",
      },
    });
    expect(env.EDITOR).toBe("vim");
    expect(env.VISUAL).toBeUndefined();
    expect(env.PAGER).toBe("less");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/op-ca.pem");
    expect(env.npm_config_cache).toBe("/var/npm");
    expect(env.NPM_CONFIG_PREFIX).toBeUndefined();
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.SSL_CERT_FILE).toBeUndefined();
    expect(env.REQUESTS_CA_BUNDLE).toBeUndefined();
    expect(env.CURL_CA_BUNDLE).toBeUndefined();
    expect(env.BASH_ENV).toBeUndefined();
  });

  it("changes nothing when absent", () => {
    expect(buildDaemonEnv({ ...base, repoEnv: {} })).toEqual(
      buildDaemonEnv(base),
    );
  });
});

describe("harness battery env (gstack, gsd, ruflo)", () => {
  const base = {
    baseEnv: { PATH: "/usr/bin:/bin", HOME: "/home/op" },
    anthropicApiKey: "sk-ant-box",
    claudeBinDir: "/opt/claude/bin",
    installationToken: INSTALL_TOKEN,
    ghConfigDir: "/tmp/isolated-gh",
    botLogin: "automata-ai-bot[bot]",
    runHome: "/run/home",
  };
  const PACK = "/usr/local/lib/automata-batteries/gstack@df89475b";
  const batteryEnv = {
    GSTACK_SESSION_KIND: "spawned",
    PLAYWRIGHT_BROWSERS_PATH: `${PACK}/ms-playwright`,
    MCP_TIMEOUT: "30000",
  };

  it("applies the seeded packs' env", () => {
    const env = buildDaemonEnv({ ...base, batteryEnv });
    expect(env.GSTACK_SESSION_KIND).toBe("spawned");
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(`${PACK}/ms-playwright`);
    expect(env.MCP_TIMEOUT).toBe("30000");
  });

  it("repoEnv can never set or override a battery key (any case), nor the browse proxy", () => {
    const repoEnv = {
      GSTACK_SESSION_KIND: "interactive",
      PLAYWRIGHT_BROWSERS_PATH: "/evil",
      playwright_skip_validate_host_requirements: "1",
      MCP_TIMEOUT: "1",
      MCP_TOOL_TIMEOUT: "1",
      CLAUDE_FLOW_MODE: "online",
      BROWSE_PROXY_URL: "http://evil:1",
      BROWSE_PROXY_USER: "u",
    };
    const withPacks = buildDaemonEnv({
      ...base,
      egressProxyUrl: "http://127.0.0.1:9999",
      browseProxy: true,
      repoEnv,
      batteryEnv,
    });
    expect(withPacks.GSTACK_SESSION_KIND).toBe("spawned");
    expect(withPacks.PLAYWRIGHT_BROWSERS_PATH).toBe(`${PACK}/ms-playwright`);
    expect(withPacks.MCP_TIMEOUT).toBe("30000");
    expect(withPacks.BROWSE_PROXY_URL).toBe("http://127.0.0.1:9999");
    for (const key of [
      "playwright_skip_validate_host_requirements",
      "MCP_TOOL_TIMEOUT",
      "CLAUDE_FLOW_MODE",
      "BROWSE_PROXY_USER",
    ]) {
      expect(withPacks[key]).toBeUndefined();
    }
    // Without packs the repo still cannot set them.
    const without = buildDaemonEnv({ ...base, repoEnv });
    for (const key of Object.keys(repoEnv)) {
      expect(without[key]).toBeUndefined();
    }
  });

  it("only battery-prefixed keys apply (defense in depth past the manifest guard)", () => {
    const env = buildDaemonEnv({
      ...base,
      batteryEnv: {
        PATH: "/evil",
        HOME: "/evil",
        NODE_OPTIONS: "x",
        MCP_TIMEOUT: "5",
      },
    });
    expect(env.PATH).toBe("/opt/claude/bin:/usr/bin:/bin");
    expect(env.HOME).toBe("/run/home");
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.MCP_TIMEOUT).toBe("5");
  });

  it("browse proxy: BROWSE_PROXY_URL is the run's egress proxy, only with gstack AND a proxy", () => {
    const proxy = "http://127.0.0.1:9999";
    expect(
      buildDaemonEnv({ ...base, egressProxyUrl: proxy, browseProxy: true })
        .BROWSE_PROXY_URL,
    ).toBe(proxy);
    expect(
      buildDaemonEnv({ ...base, egressProxyUrl: proxy }).BROWSE_PROXY_URL,
    ).toBeUndefined();
    expect(
      buildDaemonEnv({ ...base, browseProxy: true }).BROWSE_PROXY_URL,
    ).toBeUndefined();
  });

  it("#205 browse proxy with a per-run credential: the URL never carries userinfo; the credential goes to BROWSE_PROXY_USER/PASS", () => {
    const proxy = "http://run:s3cr%40t@127.0.0.1:9999";
    const env = buildDaemonEnv({
      ...base,
      egressProxyUrl: proxy,
      browseProxy: true,
    });
    expect(env.BROWSE_PROXY_URL).toBe("http://127.0.0.1:9999");
    expect(env.BROWSE_PROXY_URL).not.toContain("@");
    expect(env.BROWSE_PROXY_USER).toBe("run");
    expect(env.BROWSE_PROXY_PASS).toBe("s3cr@t");
    // The agent CLI's own proxy env keeps the credentialed URL (undici/curl/git
    // read userinfo); only Chromium's path is split.
    expect(env.HTTPS_PROXY).toBe(proxy);
    // Credential-less (N = 1): no BROWSE_PROXY_USER/PASS at all — byte-identical.
    const plain = buildDaemonEnv({
      ...base,
      egressProxyUrl: "http://127.0.0.1:9999",
      browseProxy: true,
    });
    expect(plain.BROWSE_PROXY_USER).toBeUndefined();
    expect(plain.BROWSE_PROXY_PASS).toBeUndefined();
  });

  it("#205 gitProxyAuthConfig/appendGitConfig: the one rule the check runner and fix-check env share with the agent's git", () => {
    expect(gitProxyAuthConfig("http://run:s3cret@127.0.0.1:9999")).toEqual([
      ["http.proxyAuthMethod", "basic"],
    ]);
    expect(gitProxyAuthConfig("http://127.0.0.1:9999")).toEqual([]);
    expect(gitProxyAuthConfig(null)).toEqual([]);
    expect(gitProxyAuthConfig("not a url")).toEqual([]);
    const env: NodeJS.ProcessEnv = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "/w",
    };
    const out = appendGitConfig(
      env,
      gitProxyAuthConfig("http://run:x@127.0.0.1:1"),
    );
    expect(out.GIT_CONFIG_COUNT).toBe("2");
    expect(out.GIT_CONFIG_KEY_1).toBe("http.proxyAuthMethod");
    expect(out.GIT_CONFIG_VALUE_1).toBe("basic");
    // The input is not mutated.
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_1).toBeUndefined();
    // Nothing to add ⇒ env untouched (no GIT_CONFIG_COUNT conjured).
    const empty: NodeJS.ProcessEnv = {};
    expect(appendGitConfig(empty, [])).toBe(empty);
    expect(empty).toEqual({});
  });

  it("#205 a credentialed run proxy makes git send Basic proxy auth up front (no 407 round-trip, no false deny); a plain proxy adds nothing", () => {
    const gitEntries = (env: NodeJS.ProcessEnv) => {
      const out = new Map<string, string>();
      for (let i = 0; i < Number(env.GIT_CONFIG_COUNT); i++) {
        out.set(env[`GIT_CONFIG_KEY_${i}`]!, env[`GIT_CONFIG_VALUE_${i}`]!);
      }
      return out;
    };
    const withCred = buildDaemonEnv({
      ...base,
      egressProxyUrl: "http://run:s3cret@127.0.0.1:9999",
    });
    expect(gitEntries(withCred).get("http.proxyAuthMethod")).toBe("basic");
    const plain = buildDaemonEnv({
      ...base,
      egressProxyUrl: "http://127.0.0.1:9999",
    });
    expect(gitEntries(plain).has("http.proxyAuthMethod")).toBe(false);
    expect(gitEntries(buildDaemonEnv(base)).has("http.proxyAuthMethod")).toBe(
      false,
    );
  });

  it("hands the seeded packs' PATH dirs to the daemon, never PATH itself", () => {
    const env = buildDaemonEnv({
      ...base,
      batteryPathDirs: [`${PACK}/bin`, "/other/pack/bin"],
    });
    expect(env[AGENT_PATH_PREPEND_ENV]).toBe(`${PACK}/bin:/other/pack/bin`);
    // PATH stays today's: sudo's secure_path would replace it in agent-uid
    // mode anyway, so the daemon applies the prepend on its side of sudo.
    expect(env.PATH).toBe("/opt/claude/bin:/usr/bin:/bin");
  });

  it("drops a relative PATH dir or one that would split into more entries", () => {
    const env = buildDaemonEnv({
      ...base,
      batteryPathDirs: ["bin", `${PACK}/bin:/tmp/evil`, `${PACK}/bin`],
    });
    expect(env[AGENT_PATH_PREPEND_ENV]).toBe(`${PACK}/bin`);
    expect(
      buildDaemonEnv({ ...base, batteryPathDirs: ["relative"] })[
        AGENT_PATH_PREPEND_ENV
      ],
    ).toBeUndefined();
  });

  it("repoEnv can never set the PATH prepend (the AUTOMATA_ prefix is reserved)", () => {
    const repoEnv = { [AGENT_PATH_PREPEND_ENV]: "/tmp/evil" };
    expect(isReservedRepoEnvKey(AGENT_PATH_PREPEND_ENV)).toBe(true);
    expect(
      buildDaemonEnv({ ...base, repoEnv })[AGENT_PATH_PREPEND_ENV],
    ).toBeUndefined();
    expect(
      buildDaemonEnv({ ...base, repoEnv, batteryPathDirs: [`${PACK}/bin`] })[
        AGENT_PATH_PREPEND_ENV
      ],
    ).toBe(`${PACK}/bin`);
  });

  it("changes nothing when absent", () => {
    expect(
      buildDaemonEnv({
        ...base,
        batteryEnv: {},
        batteryPathDirs: [],
        browseProxy: false,
      }),
    ).toEqual(buildDaemonEnv(base));
  });
});

describe("harness battery env: the DaemonProcess call site wires it", () => {
  it("a seeded gstack reaches the env DaemonProcess builds (env + PATH dirs + browse proxy)", async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-harness-"));
    const input: AgentRunInput = {
      threadId: "thr_harness",
      threadChatId: "tc_1",
      repoFullName: "o/r",
      branch: "main",
      daemonCallbackUrl: "http://localhost:3999",
      installationToken: "inst",
      daemonToken: "daemon",
      orgId: "org-1",
      repoEnv: { PLAYWRIGHT_BROWSERS_PATH: "/evil" },
    };
    const packDir = "/usr/local/lib/automata-batteries/gstack@x";
    const daemon = new DaemonProcess(
      loadWorkerConfig({}),
      input,
      workdir,
      {
        home: path.join(workdir, "home"),
        delivered: false,
        env: {},
        batteries: {
          harness: {
            ok: true,
            harnessHash: "a".repeat(64),
            packs: [
              {
                id: "gstack",
                pin: "x",
                packDir,
                env: { PLAYWRIGHT_BROWSERS_PATH: `${packDir}/ms-playwright` },
                pathDirs: [`${packDir}/bin`],
                mcpServers: {},
                denyTools: [],
                headlessSafe: [],
                linked: [],
              },
            ],
          },
        },
      },
      "http://127.0.0.1:4242",
    );
    const internals = daemon as unknown as {
      ensureEnv(): Promise<NodeJS.ProcessEnv>;
      ghConfigDir: string | null;
    };
    try {
      const env = await internals.ensureEnv();
      expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(`${packDir}/ms-playwright`);
      expect(env.BROWSE_PROXY_URL).toBe("http://127.0.0.1:4242");
      expect(env[AGENT_PATH_PREPEND_ENV]).toBe(`${packDir}/bin`);
    } finally {
      if (internals.ghConfigDir) {
        fs.rmSync(internals.ghConfigDir, { recursive: true, force: true });
      }
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });
});
