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

    const target = path.join(result.home!, ".claude/.credentials.json");
    expect(await fs.readFile(target, "utf8")).toBe('{"claudeAiOauth":{}}');
    const mode = (await fs.stat(target)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("cleanup removes every credential byte, and is safe to call twice", async () => {
    const result = await materialiseAgentCredentials({
      credentials: { type: "json-file", contents: "secret-token-material" },
      agent: "claudeCode",
      runRoot,
    });
    await result.cleanup();
    await expect(fs.stat(result.home!)).rejects.toThrow();
    await result.cleanup();
  });

  it("built-in-credits writes nothing and leaves HOME alone", async () => {
    const result = await materialiseAgentCredentials({
      credentials: { type: "built-in-credits" },
      agent: "claudeCode",
      runRoot,
    });
    expect(result.home).toBeNull();
    expect(result.env).toEqual({});
    await expect(fs.stat(path.join(runRoot, "home"))).rejects.toThrow();
  });

  it("an agent with no known credential path degrades to credits rather than guessing", async () => {
    const result = await materialiseAgentCredentials({
      credentials: { type: "json-file", contents: "x" },
      agent: "someFutureAgent",
      runRoot,
    });
    expect(result.home).toBeNull();
    await expect(fs.stat(path.join(runRoot, "home"))).rejects.toThrow();
  });

  it("env-var credentials need no file and no HOME override", async () => {
    const result = await materialiseAgentCredentials({
      credentials: { type: "env-var", key: "AMP_API_KEY", value: "sgamp_x" },
      agent: "amp",
      runRoot,
    });
    expect(result.home).toBeNull();
    expect(result.env).toEqual({ AMP_API_KEY: "sgamp_x" });
  });
});
