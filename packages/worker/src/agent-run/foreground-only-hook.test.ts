import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FOREGROUND_ONLY_BASH_COMMAND,
  FOREGROUND_ONLY_BASH_MESSAGE,
  FOREGROUND_ONLY_MONITOR_COMMAND,
  FOREGROUND_ONLY_MONITOR_MESSAGE,
  FOREGROUND_ONLY_PRE_TOOL_USE,
  mergeForegroundOnlySettings,
} from "./foreground-only-hook";

const BASH_ENTRY = {
  matcher: "Bash",
  hooks: [{ type: "command", command: FOREGROUND_ONLY_BASH_COMMAND }],
};
const MONITOR_ENTRY = {
  matcher: "Monitor",
  hooks: [{ type: "command", command: FOREGROUND_ONLY_MONITOR_COMMAND }],
};

describe("foreground-only hook content", () => {
  it("the exact commands", () => {
    expect(FOREGROUND_ONLY_BASH_COMMAND).toBe(
      "command -v jq >/dev/null 2>&1 || exit 0; " +
        "if jq -e '.tool_input.run_in_background == true' >/dev/null 2>&1; then " +
        "echo 'Background commands are killed when this headless session ends. " +
        "Run it in the foreground (no run_in_background) and wait for it; " +
        "for parallel work use a sub-agent.' >&2; exit 2; fi; exit 0",
    );
    expect(FOREGROUND_ONLY_MONITOR_COMMAND).toBe(
      `echo '${FOREGROUND_ONLY_MONITOR_MESSAGE}' >&2; exit 2`,
    );
  });

  it("messages are single-quote-free (they are embedded in '...')", () => {
    expect(FOREGROUND_ONLY_BASH_MESSAGE).not.toContain("'");
    expect(FOREGROUND_ONLY_MONITOR_MESSAGE).not.toContain("'");
  });

  it("commands reference no file path (self-contained)", () => {
    for (const cmd of [
      FOREGROUND_ONLY_BASH_COMMAND,
      FOREGROUND_ONLY_MONITOR_COMMAND,
    ]) {
      expect(cmd.replaceAll("/dev/null", "")).not.toMatch(/\//);
    }
  });

  it("PreToolUse entries: Bash, then Monitor", () => {
    expect(FOREGROUND_ONLY_PRE_TOOL_USE).toEqual([BASH_ENTRY, MONITOR_ENTRY]);
  });
});

describe("mergeForegroundOnlySettings", () => {
  it("empty ⇒ only the two PreToolUse entries", () => {
    expect(mergeForegroundOnlySettings({})).toEqual({
      hooks: { PreToolUse: [BASH_ENTRY, MONITOR_ENTRY] },
    });
  });

  it("keeps other keys, other hook events and existing PreToolUse entries", () => {
    const mine = {
      matcher: "Write",
      hooks: [{ type: "command", command: "x" }],
    };
    const stop = [{ hooks: [{ type: "command", command: "y" }] }];
    const existing = {
      model: "sonnet",
      permissions: { allow: ["Bash(ls)"] },
      hooks: { PreToolUse: [mine], Stop: stop },
    };
    const snapshot = JSON.stringify(existing);
    expect(mergeForegroundOnlySettings(existing)).toEqual({
      model: "sonnet",
      permissions: { allow: ["Bash(ls)"] },
      hooks: { PreToolUse: [mine, BASH_ENTRY, MONITOR_ENTRY], Stop: stop },
    });
    // Pure: the input is untouched.
    expect(JSON.stringify(existing)).toBe(snapshot);
  });

  it("idempotent: a second merge (retry into the same HOME) adds nothing", () => {
    const once = mergeForegroundOnlySettings({ a: 1 });
    expect(mergeForegroundOnlySettings(once)).toEqual(once);
  });

  it("a non-object hooks / non-array PreToolUse is replaced", () => {
    expect(mergeForegroundOnlySettings({ hooks: "nope" })).toEqual({
      hooks: { PreToolUse: [BASH_ENTRY, MONITOR_ENTRY] },
    });
    expect(
      mergeForegroundOnlySettings({ hooks: { PreToolUse: 3, Stop: [] } }),
    ).toEqual({
      hooks: { PreToolUse: [BASH_ENTRY, MONITOR_ENTRY], Stop: [] },
    });
  });
});

/** Executed: the commands run under /bin/sh exactly as a hook would. */
describe("foreground-only hook commands (executed)", () => {
  const hasJq =
    spawnSync("/bin/sh", ["-c", "command -v jq"], { encoding: "utf8" })
      .status === 0;
  let emptyPath: string;

  beforeAll(async () => {
    emptyPath = await fs.mkdtemp(path.join(os.tmpdir(), "fg-only-nojq-"));
  });
  afterAll(async () => {
    await fs.rm(emptyPath, { recursive: true, force: true });
  });

  function runHook(
    command: string,
    stdin: string,
    env: NodeJS.ProcessEnv = process.env,
  ): { status: number | null; stderr: string } {
    const r = spawnSync("/bin/sh", ["-c", command], {
      input: stdin,
      encoding: "utf8",
      env,
      timeout: 10_000,
    });
    return { status: r.status, stderr: r.stderr };
  }

  const bashInput = (toolInput: Record<string, unknown>) =>
    JSON.stringify({
      session_id: "s",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: toolInput,
    });

  it.skipIf(!hasJq)(
    "Bash run_in_background:true ⇒ exit 2 + the message on stderr",
    () => {
      const r = runHook(
        FOREGROUND_ONLY_BASH_COMMAND,
        bashInput({ command: "sleep 600", run_in_background: true }),
      );
      expect(r.status).toBe(2);
      expect(r.stderr.trim()).toBe(FOREGROUND_ONLY_BASH_MESSAGE);
    },
  );

  it.skipIf(!hasJq).each([
    ["false", { command: "ls", run_in_background: false }],
    ["absent", { command: "ls" }],
    ['the string "true"', { command: "ls", run_in_background: "true" }],
  ])("Bash run_in_background %s ⇒ exit 0, silent", (_label, toolInput) => {
    const r = runHook(FOREGROUND_ONLY_BASH_COMMAND, bashInput(toolInput));
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it.skipIf(!hasJq)("unparseable hook input ⇒ exit 0 (fail open)", () => {
    const r = runHook(FOREGROUND_ONLY_BASH_COMMAND, "not json{");
    expect(r.status).toBe(0);
  });

  it("jq missing ⇒ exit 0 even for run_in_background:true (fail open)", () => {
    const r = runHook(
      FOREGROUND_ONLY_BASH_COMMAND,
      bashInput({ command: "sleep 600", run_in_background: true }),
      { PATH: emptyPath },
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("Monitor ⇒ exit 2 + the message on stderr", () => {
    const r = runHook(
      FOREGROUND_ONLY_MONITOR_COMMAND,
      JSON.stringify({ tool_name: "Monitor", tool_input: {} }),
    );
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toBe(FOREGROUND_ONLY_MONITOR_MESSAGE);
  });
});
