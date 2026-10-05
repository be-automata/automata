/**
 * Shared plumbing of the self-heal benchmark CLIs (R6, phase 9): argument
 * parsing (node:util parseArgs, strict), the exit-on-error helpers, the
 * owner/repo check, the no-overwrite rule and the JSON file format.
 */
import { existsSync, writeFileSync } from "node:fs";
import { parseArgs, type ParseArgsConfig } from "node:util";

export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs main; any error ends the process with `<name> failed: <message>`. */
export function runMain(name: string, main: () => Promise<void> | void): void {
  const run = async (): Promise<void> => {
    try {
      await main();
    } catch (error) {
      fail(`${name} failed: ${errorMessage(error)}`);
    }
  };
  void run();
}

/** Strict parseArgs over process.argv; a bad argument prints the usage. */
export function parseCli<const T extends ParseArgsConfig>(
  config: T,
  usage: string,
): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(config);
  } catch (error) {
    return fail(`${errorMessage(error)}\n${usage}`);
  }
}

export function assertRepo(repo: string): void {
  if (!REPO_RE.test(repo)) fail(`--repo must be owner/repo, got: ${repo}`);
}

export function refuseOverwrite(path: string, force: boolean): void {
  if (existsSync(path) && !force) {
    fail(`refusing to overwrite ${path} (pass --force)`);
  }
}

/** Pretty JSON with a trailing newline, the format every bench file uses. */
export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
