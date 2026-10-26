import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "provision-tenant.ts",
);

/** Runs the CLI as an operator would; never reaches an engine in these cases. */
async function run(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", SCRIPT, ...args],
      { env: { ...process.env, ...env }, timeout: 30_000 },
    );
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return {
      code: err.code ?? -1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

describe("provision:tenant CLI contract", () => {
  it.each([
    [
      ["--name", "A", "--slug", "client-a", "--expires", "24h"],
      /Unknown option/,
    ],
    [["--name", "A"], /--name and --slug are both required/],
    [
      ["--tenant-id", "11111111-2222-3333-4444-555555555555", "--name", "A"],
      /drop --name\/--slug/,
    ],
    [
      ["--tenant-id", "11111111-2222-3333-4444-555555555555"],
      /--tenant-id needs --token-name/,
    ],
    [["--name", "A", "--slug", "client-a", "stray"], /positional/i],
  ])("exits 2 with nothing on stdout for %j", async (args, message) => {
    const r = await run(args);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(message);
  });

  it("exits 1 with nothing on stdout when the engine URL is not loopback", async () => {
    const r = await run(["--name", "A", "--slug", "client-a"], {
      HATCHET_ENGINE_URL: "https://hatchet.beautomata.com",
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(
      /refused: engine URL must be the loopback literal/,
    );
  });
}, 60_000);
