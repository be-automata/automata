import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { verifyGhAuth } from "./verify-gh-auth";

describe("verifyGhAuth — fail-closed identity precondition", () => {
  it("returns ok when `gh auth status` succeeds, run via bash -lc with the sanitized env", async () => {
    const exec = vi.fn(
      async (
        _command: string,
        _args: string[],
        _opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
      ) => ({ stdout: "Logged in", stderr: "" }),
    );
    const env = {
      GH_TOKEN: "ghs_bot",
      GH_CONFIG_DIR: "/tmp/iso",
      HOME: "/runs/r/home",
    };

    const result = await verifyGhAuth({ workdir: "/run/wd", env, exec });

    expect(result).toEqual({ ok: true });
    const [command, args, opts] = exec.mock.calls[0]!;
    // Runs through a LOGIN shell (mirrors how the daemon spawns the agent) so a box
    // profile that re-exports GH_TOKEN is caught here.
    expect(command).toBe("bash");
    expect(args).toEqual(["-lc", "gh auth status"]);
    expect(opts.cwd).toBe("/run/wd");
    // The sanitized env, not the ambient one — with HOME swapped (below).
    expect(opts.env).toEqual({ ...env, HOME: opts.env.HOME });
  });

  it("runs gh with a throwaway HOME, never the run's, and removes it (#302)", async () => {
    // gh writes ~/.local/state/gh even for `auth status`; as the worker uid in
    // the run HOME that left a .local the agent uid could not write into.
    let seenHome: string | undefined;
    const exec = vi.fn(
      async (
        _command: string,
        _args: string[],
        opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
      ) => {
        seenHome = opts.env.HOME;
        expect(existsSync(seenHome!)).toBe(true);
        return { stdout: "", stderr: "" };
      },
    );
    const env = { GH_TOKEN: "ghs_bot", HOME: "/runs/r/home" };

    await verifyGhAuth({ workdir: "/run/wd", env, exec });

    expect(seenHome).toBeDefined();
    expect(seenHome).not.toBe("/runs/r/home");
    expect(existsSync(seenHome!)).toBe(false);
    expect(env.HOME).toBe("/runs/r/home"); // the caller's env is not mutated
  });

  it("fails closed with detail when gh cannot confirm auth (blocks the run)", async () => {
    const exec = vi.fn(async () => {
      throw Object.assign(new Error("exit 1"), {
        stderr: "You are not logged into any GitHub hosts.",
      });
    });

    const result = await verifyGhAuth({ workdir: "/run/wd", env: {}, exec });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain("not logged into");
    }
  });

  it("fails closed on a transient/exec failure with no stderr (network, missing gh)", async () => {
    const exec = vi.fn(async () => {
      throw new Error("spawn gh ENOENT");
    });
    const result = await verifyGhAuth({ workdir: "/run/wd", env: {}, exec });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain("ENOENT");
    }
  });
});
