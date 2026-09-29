import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyInheritableAces,
  applyTraverseAce,
  applyRunNamespaceAces,
  buildAceInvocation,
  buildSetfaclInvocations,
  LINUX_TRAVERSE_ACL_RIGHTS,
  INHERITABLE_ACE_RIGHTS,
  TRAVERSE_ACE_RIGHTS,
} from "./agent-uid-fs";

const execFileAsync = promisify(execFile);

describe("buildAceInvocation", () => {
  it('emits chmod +a "<user> allow <rights>" <dir>', () => {
    expect(
      buildAceInvocation({
        user: "_automata-agent",
        dir: "/usr/local/automata/runs/thr_1",
        rights: INHERITABLE_ACE_RIGHTS,
      }),
    ).toEqual({
      file: "/bin/chmod",
      args: [
        "+a",
        `_automata-agent allow ${INHERITABLE_ACE_RIGHTS}`,
        "/usr/local/automata/runs/thr_1",
      ],
    });
  });

  it("the per-run rights carry every FILE data right, by name", () => {
    // Regression fence for the shipped-inert bug: the first cut of this
    // constant listed directory + attribute rights ONLY, so an inheriting file
    // granted the agent uid metadata access and nothing else — it could not
    // read the checkout or its own credential file, and agent-uid mode could
    // not work at all. The whole feature rests on this string.
    for (const right of ["read", "write", "append", "execute", "delete"]) {
      expect(INHERITABLE_ACE_RIGHTS.split(",")).toContain(right);
    }
    // …and still every directory right it needs to create the run's tree.
    for (const right of [
      "list",
      "search",
      "add_file",
      "add_subdirectory",
      "delete_child",
    ]) {
      expect(INHERITABLE_ACE_RIGHTS.split(",")).toContain(right);
    }
    // Never granted: taking ownership or rewriting the ACL out from under us.
    expect(INHERITABLE_ACE_RIGHTS.split(",")).not.toContain("writesecurity");
    expect(INHERITABLE_ACE_RIGHTS.split(",")).not.toContain("chown");
  });

  it("the per-run rights are inheritable and the shared-root rights are not", () => {
    expect(INHERITABLE_ACE_RIGHTS).toContain("file_inherit");
    expect(INHERITABLE_ACE_RIGHTS).toContain("directory_inherit");
    // A shared root must never hand the agent uid another run's contents.
    expect(TRAVERSE_ACE_RIGHTS).toBe("search");
    expect(TRAVERSE_ACE_RIGHTS).not.toContain("inherit");
    expect(TRAVERSE_ACE_RIGHTS).not.toContain("list");
    expect(TRAVERSE_ACE_RIGHTS).not.toContain("read");
  });
});

describe("applyInheritableAces", () => {
  it("is a no-op when users is empty (the default-off contract)", async () => {
    const calls: unknown[] = [];
    await applyInheritableAces({
      dir: "/x",
      users: [],
      platform: "darwin",
      exec: async (f, a) => void calls.push([f, a]),
    });
    expect(calls).toEqual([]);
  });

  it("is a no-op on a platform with no mechanism — but Linux is no longer one", async () => {
    // This test used to assert the no-op for "non-darwin", which quietly meant
    // Linux: the fence resolved successfully and put no boundary on the box.
    // The box still ran, the suite still passed, and the security property was
    // simply absent. Linux now has a real branch; freebsd and friends do not.
    const calls: unknown[] = [];
    await applyInheritableAces({
      dir: "/x",
      users: ["_automata-agent"],
      platform: "freebsd",
      exec: async (f, a) => void calls.push([f, a]),
    });
    expect(calls).toEqual([]);

    const linuxCalls: unknown[] = [];
    await applyInheritableAces({
      dir: "/x",
      users: ["_automata-agent"],
      platform: "linux",
      exec: async (f, a) => void linuxCalls.push([f, a]),
    });
    expect(linuxCalls.length, "linux must not silently no-op").toBeGreaterThan(
      0,
    );
  });

  it("grants one ACE per user, in order", async () => {
    const users: string[] = [];
    await applyInheritableAces({
      dir: "/runs/w-1",
      users: ["_automata-agent", "operator"],
      platform: "darwin",
      exec: async (_f, args) => void users.push(args[1] ?? ""),
    });
    expect(users).toEqual([
      `_automata-agent allow ${INHERITABLE_ACE_RIGHTS}`,
      `operator allow ${INHERITABLE_ACE_RIGHTS}`,
    ]);
  });

  it("propagates a chmod failure instead of leaving a silently missing ACE", async () => {
    await expect(
      applyInheritableAces({
        dir: "/x",
        users: ["_automata-agent"],
        platform: "darwin",
        exec: async () => {
          throw new Error("chmod: Operation not supported");
        },
      }),
    ).rejects.toThrow(/Operation not supported/);
  });

  it("applyTraverseAce uses the search-only rights", async () => {
    const args: string[][] = [];
    await applyTraverseAce({
      dir: "/runs",
      users: ["_automata-agent"],
      platform: "darwin",
      exec: async (_f, a) => void args.push(a),
    });
    expect(args).toEqual([
      ["+a", `_automata-agent allow ${TRAVERSE_ACE_RIGHTS}`, "/runs"],
    ]);
  });
});

/**
 * Real-FS regression guard for the three verified properties the design rests
 * on. No sudo, no network, no uid switching: the ACE names the CURRENT user,
 * which always exists. Skipped off darwin.
 */
describe.skipIf(process.platform !== "darwin")(
  "macOS ACE inheritance (real FS)",
  () => {
    const roots: string[] = [];
    afterEach(async () => {
      await Promise.all(
        roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })),
      );
    });

    // `ls -le` shows `@` (xattrs) INSTEAD of `+` (ACL) and macOS 15 files
    // routinely carry com.apple.provenance — so never grep for `+`. Parse the
    // ACE lines, and use /bin/ls (a shell's `ls` may be eza, which rejects -e).
    async function aceLines(target: string): Promise<string[]> {
      const { stdout } = await execFileAsync("/bin/ls", ["-lde", target]);
      return stdout
        .split("\n")
        .filter((l) => /^\s*\d+:\s/.test(l))
        .map((l) => l.trim());
    }

    it("an ACE on a 0700 dir is inherited by a file and by a bound unix socket, and survives chmod 600", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "ace-test-"));
      roots.push(root);
      await fs.chmod(root, 0o700);
      const me = os.userInfo().username;
      await applyInheritableAces({ dir: root, users: [me] });

      const filePath = path.join(root, "f.json");
      await fs.writeFile(filePath, "{}", { mode: 0o600 });
      expect((await aceLines(filePath)).join("\n")).toMatch(
        new RegExp(`user:${me}\\s+inherited allow`),
      );

      // chmod 600 must NOT strip the ACE: agent-credentials.ts re-chmods the
      // credential file after writing it.
      await fs.chmod(filePath, 0o600);
      expect((await aceLines(filePath)).join("\n")).toMatch(/inherited allow/);

      // bind(2) goes through the same VFS create path, so the socket inherits.
      const sockPath = path.join(root, "d.sock");
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(sockPath, resolve));
      try {
        expect((await aceLines(sockPath)).join("\n")).toMatch(
          new RegExp(`user:${me}\\s+inherited allow`),
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("a traverse-only ACE on a root grants no inheritance to its children", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "ace-root-"));
      roots.push(root);
      const me = os.userInfo().username;
      await applyTraverseAce({ dir: root, users: [me] });
      const child = path.join(root, "child.txt");
      await fs.writeFile(child, "x");
      expect(await aceLines(child)).toEqual([]);
    });
  },
);

/**
 * #192 P4: the Linux branch. Before this existed, applyAces() returned early on
 * `platform !== "darwin"` — so on Linux the whole fence resolved successfully
 * and granted nothing. The box ran, the suite passed, and the boundary the
 * egress fence is keyed on was simply not there.
 */
describe("POSIX ACL branch (Linux)", () => {
  it("the inheritable grant needs BOTH the access and the default ACL", () => {
    // A default ACL alone governs only entries created LATER; it grants nothing
    // on the directory itself, so the daemon could not write its pidfile into a
    // dir it had supposedly been granted. Access alone is not inherited, so
    // every file created afterwards is ungranted. It takes both.
    const invs = buildSetfaclInvocations({
      user: "automata-agent",
      dir: "/run/x",
      grant: "inheritable",
    });
    expect(invs.map((i) => i.args)).toEqual([
      ["-m", "u:automata-agent:rwx", "/run/x"],
      ["-d", "-m", "u:automata-agent:rwx", "/run/x"],
    ]);
  });

  it("the traverse grant is execute-only and NEVER a default ACL", () => {
    // `-d` here would make the SHARED root inheritable, handing the agent uid
    // every other run's checkout and credentials. All runs share one uid, so
    // cross-run isolation is placement, not ownership. And `--x` must not carry
    // `r`: traverse the directory, learn nothing about it.
    const invs = buildSetfaclInvocations({
      user: "automata-agent",
      dir: "/run",
      grant: "traverse",
    });
    expect(invs).toHaveLength(1);
    expect(invs[0]?.args).toEqual(["-m", "u:automata-agent:--x", "/run"]);
    expect(invs[0]?.args).not.toContain("-d");
    expect(LINUX_TRAVERSE_ACL_RIGHTS).not.toContain("r");
  });

  it("applyRunNamespaceAces emits root-traverse then per-user grants, in order", async () => {
    const calls: string[] = [];
    await applyRunNamespaceAces({
      root: "/run",
      runDir: "/run/w-1",
      agentUser: "automata-agent",
      workerLogin: "automata",
      platform: "linux",
      exec: async (_f, a) => void calls.push(a.join(" ")),
    });
    expect(calls).toEqual([
      "-m u:automata-agent:--x /run",
      "-m u:automata-agent:rwx /run/w-1",
      "-d -m u:automata-agent:rwx /run/w-1",
      "-m u:automata:rwx /run/w-1",
      "-d -m u:automata:rwx /run/w-1",
    ]);
  });

  it("propagates a setfacl failure instead of leaving a silent half-grant", async () => {
    // setfacl fails on a filesystem mounted without ACL support. Swallowing it
    // produces a dir that looks granted and is not — the failure then surfaces
    // minutes later as an unwritable pidfile, three layers from the cause.
    await expect(
      applyInheritableAces({
        dir: "/run/x",
        users: ["automata-agent"],
        platform: "linux",
        exec: async () => {
          throw new Error("setfacl: Operation not supported");
        },
      }),
    ).rejects.toThrow(/Operation not supported/);
  });

  it("stays off when no agent user is configured", async () => {
    const calls: unknown[] = [];
    await applyRunNamespaceAces({
      root: "/run",
      runDir: "/run/w-1",
      agentUser: "",
      workerLogin: "automata",
      platform: "linux",
      exec: async (f, a) => void calls.push([f, a]),
    });
    expect(calls).toEqual([]);
  });
});

/**
 * Real-FS proof of the Linux mask trap, and the reason the module's macOS note
 * must never be read as platform-neutral. macOS: `chmod 600` does NOT strip an
 * ACE. Linux: it effectively does, because chmod's GROUP bits ARE the POSIX ACL
 * mask, and the mask caps every named-user entry.
 *
 * The cruelty is that `getfacl` keeps listing the entry either way, so the fence
 * reads as applied while granting nothing. The #50 workspace-trust seed writes a
 * 0600 `.claude.json`, and a review run dies in seconds with no output when that
 * seed is unreadable — so anything that chmods after creating must re-apply the
 * ACL, and this test is what makes that non-negotiable.
 */
describe.skipIf(process.platform !== "linux")(
  "POSIX ACL mask (real FS, Linux only)",
  () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const d of dirs.splice(0)) {
        fsSync.rmSync(d, { recursive: true, force: true });
      }
    });

    function effectiveFor(file: string, user: string): string {
      const out = execFileSync("/usr/bin/getfacl", ["-p", file], {
        encoding: "utf8",
      });
      const line = out.split("\n").find((l) => l.startsWith(`user:${user}:`));
      if (!line) throw new Error(`no ACL entry for ${user} in:\n${out}`);
      const effective = /#effective:(\S+)/.exec(line);
      // No "#effective:" annotation means the mask does not reduce the entry.
      return effective?.[1] ?? line.split(":")[2] ?? "";
    }

    it("chmod 600 zeroes the mask and neuters the grant, entry still listed", () => {
      const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "maskprobe-"));
      dirs.push(dir);
      const self = os.userInfo().username;

      execFileSync("/usr/bin/setfacl", ["-m", `u:${self}:rwx`, dir]);
      execFileSync("/usr/bin/setfacl", ["-d", "-m", `u:${self}:rwx`, dir]);

      const file = path.join(dir, "seed.json");
      fsSync.writeFileSync(file, "{}\n");
      expect(effectiveFor(file, self)).toMatch(/r/);

      // Exactly what the workspace-trust seed does to its credential file.
      fsSync.chmodSync(file, 0o600);

      // The entry is STILL THERE — this is the whole trap.
      const out = execFileSync("/usr/bin/getfacl", ["-p", file], {
        encoding: "utf8",
      });
      expect(out).toContain(`user:${self}:rwx`);
      // ...and it grants nothing.
      expect(effectiveFor(file, self)).toBe("---");
    });
  },
);
