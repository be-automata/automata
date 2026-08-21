import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { materialiseAgentCredentials } from "./agent-credentials";

describe("materialiseAgentCredentials (D1)", () => {
  let runRoot: string;

  beforeEach(async () => {
    runRoot = await fs.mkdtemp(path.join(os.tmpdir(), "automata-cred-test-"));
  });
  afterEach(async () => {
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("writes the Claude credential to a per-run HOME at 0600, never the box's", async () => {
    const result = await materialiseAgentCredentials({
      credentials: { type: "json-file", contents: '{"claudeAiOauth":{}}' },
      agent: "claudeCode",
      runRoot,
    });

    // A per-run HOME under the run dir — NOT os.homedir(). The daemon probes
    // $HOME/.claude/.credentials.json, so this is what decides whose credential
    // the agent sees; writing to the real home would clobber the operator's
    // login and leak one tenant's token to the next run.
    expect(result.home).toBe(path.join(runRoot, "home"));
    expect(result.home).not.toBe(os.homedir());

    const target = path.join(result.home, ".claude/.credentials.json");
    expect(await fs.readFile(target, "utf8")).toBe('{"claudeAiOauth":{}}');
    const mode = (await fs.stat(target)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("writes the Codex credential to a per-run HOME at 0600 (#77 shared map)", async () => {
    const result = await materialiseAgentCredentials({
      credentials: { type: "json-file", contents: '{"tokens":{}}' },
      agent: "codex",
      runRoot,
    });

    const target = path.join(result.home, ".codex/auth.json");
    expect(await fs.readFile(target, "utf8")).toBe('{"tokens":{}}');
    const mode = (await fs.stat(target)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it.each(["gemini", "amp", "opencode"])(
    "%s has no file-based auth path — a json-file credential degrades to credits (pins the null mapping, #77)",
    async (agent) => {
      const result = await materialiseAgentCredentials({
        credentials: { type: "json-file", contents: "hypothetical-cred" },
        agent,
        runRoot,
      });
      expect(result.delivered).toBe(false);
      expect(result.env).toEqual({});
      // The dir exists (fresh HOME + trust seed) but holds no credential file.
      expect((await fs.readdir(result.home)).length).toBe(1); // trust seed only
    },
  );

  it("seeds workspace trust under BOTH the raw and realpath'd workdir", async () => {
    // The realpath half is a reproduced production bug: os.tmpdir() on macOS is
    // /var/folders/… — a symlink to /private/var/folders/… — and the CLI keys
    // trust by the RESOLVED cwd. A seed keyed only by the symlinked spelling
    // missed, and review agents exited 1 with zero API calls.
    const result = await materialiseAgentCredentials({
      credentials: { type: "json-file", contents: '{"claudeAiOauth":{}}' },
      agent: "claudeCode",
      runRoot,
    });
    const seed = JSON.parse(
      await fs.readFile(path.join(result.home, ".claude.json"), "utf8"),
    );
    expect(seed.hasCompletedOnboarding).toBe(true);
    const resolved = await fs.realpath(runRoot).catch(() => runRoot);
    for (const key of new Set([runRoot, resolved])) {
      expect(seed.projects[key], `missing trust for ${key}`).toMatchObject({
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      });
    }
    // 0600: the seed lives beside the credential and follows its hygiene.
    expect(
      (await fs.stat(path.join(result.home, ".claude.json"))).mode & 0o777,
    ).toBe(0o600);
  });

  it("cleanup removes every credential byte, and is safe to call twice", async () => {
    const result = await materialiseAgentCredentials({
      credentials: { type: "json-file", contents: "secret-token-material" },
      agent: "claudeCode",
      runRoot,
    });
    await result.cleanup();
    await expect(fs.stat(result.home)).rejects.toThrow();
    await result.cleanup();
  });

  it("built-in-credits writes no credential but STILL gets a fresh HOME", async () => {
    // The empty HOME is the point: on macOS the agent CLI authenticates from the
    // login Keychain, so a run left on the operator's HOME spends the BOX
    // OWNER's subscription with no file and no env var involved. Verified on
    // Claude Code 2.1.234: a fresh HOME yields "Not logged in".
    const result = await materialiseAgentCredentials({
      credentials: { type: "built-in-credits" },
      agent: "claudeCode",
      runRoot,
    });
    expect(result.home).toBe(path.join(runRoot, "home"));
    expect(result.home).not.toBe(os.homedir());
    expect(result.delivered).toBe(false);
    expect(result.env).toEqual({});
    // The dir exists but holds no credential.
    expect((await fs.readdir(result.home)).length).toBe(1); // trust seed only
  });

  it("an agent with no known credential path degrades to credits rather than guessing", async () => {
    const result = await materialiseAgentCredentials({
      credentials: { type: "json-file", contents: "x" },
      agent: "someFutureAgent",
      runRoot,
    });
    expect(result.delivered).toBe(false);
    expect((await fs.readdir(result.home)).length).toBe(1); // trust seed only
  });

  it("env-var credentials need no file, but the run is still HOME-isolated", async () => {
    const result = await materialiseAgentCredentials({
      credentials: { type: "env-var", key: "AMP_API_KEY", value: "sgamp_x" },
      agent: "amp",
      runRoot,
    });
    expect(result.home).toBe(path.join(runRoot, "home"));
    expect(result.delivered).toBe(true);
    expect(result.env).toEqual({ AMP_API_KEY: "sgamp_x" });
  });
});
