import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { materialiseAgentCredentials } from "./agent-credentials";
import { CONTAINER_WORKSPACE } from "./container-argv";
import { runPaths, type RunPaths } from "./run-owned-paths";

describe("materialiseAgentCredentials (D1)", () => {
  let runRoot: string;
  /** The clone beside the HOME, as provisionWorkdir lays a run dir out. */
  let run: RunPaths;
  let workdir: string;

  beforeEach(async () => {
    runRoot = await fs.mkdtemp(path.join(os.tmpdir(), "automata-cred-test-"));
    run = runPaths(runRoot);
    workdir = run.repo;
    await fs.mkdir(workdir);
  });
  afterEach(async () => {
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("writes the Claude credential to a per-run HOME at 0600, never the box's", async () => {
    const result = await materialiseAgentCredentials({
      credentials: { type: "json-file", contents: '{"claudeAiOauth":{}}' },
      agent: "claudeCode",
      run,
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
      run,
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
        run,
      });
      expect(result.delivered).toBe(false);
      expect(result.env).toEqual({});
      // The dir exists (fresh HOME + trust seed) but holds no credential file.
      expect((await fs.readdir(result.home)).length).toBe(1); // trust seed only
    },
  );

  // card: protects=the trust seed names the clone as the container sees it (/workspace) and nothing else — not the host clone path, not the run dir — at 0600; fails_when=another key is trusted, /workspace is missing, or the mode is wider; no_claim=that the CLI honours the seed (box proof, review runs)
  it("seeds workspace trust for /workspace only (ADR-013: one fixed path)", async () => {
    const result = await materialiseAgentCredentials({
      credentials: { type: "json-file", contents: '{"claudeAiOauth":{}}' },
      agent: "claudeCode",
      run,
    });
    const seed = JSON.parse(
      await fs.readFile(path.join(result.home, ".claude.json"), "utf8"),
    );
    expect(seed.hasCompletedOnboarding).toBe(true);
    expect(Object.keys(seed.projects)).toEqual([CONTAINER_WORKSPACE]);
    expect(seed.projects[CONTAINER_WORKSPACE]).toMatchObject({
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    });
    expect(seed.projects[workdir]).toBeUndefined();
    // 0600: the seed lives beside the credential and follows its hygiene.
    expect(
      (await fs.stat(path.join(result.home, ".claude.json"))).mode & 0o777,
    ).toBe(0o600);
  });

  it("cleanup removes every credential byte, and is safe to call twice", async () => {
    const result = await materialiseAgentCredentials({
      credentials: { type: "json-file", contents: "secret-token-material" },
      agent: "claudeCode",
      run,
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
      run,
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
      run,
    });
    expect(result.delivered).toBe(false);
    expect((await fs.readdir(result.home)).length).toBe(1); // trust seed only
  });

  it("env-var credentials need no file, but the run is still HOME-isolated", async () => {
    const result = await materialiseAgentCredentials({
      credentials: { type: "env-var", key: "AMP_API_KEY", value: "sgamp_x" },
      agent: "amp",
      run,
    });
    expect(result.home).toBe(path.join(runRoot, "home"));
    expect(result.delivered).toBe(true);
    expect(result.env).toEqual({ AMP_API_KEY: "sgamp_x" });
  });
});
