import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyInheritableAces,
  applyTraverseAce,
  buildAceInvocation,
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

  it("is a no-op on a non-darwin platform so the worker still runs on Linux CI", async () => {
    const calls: unknown[] = [];
    await applyInheritableAces({
      dir: "/x",
      users: ["_automata-agent"],
      platform: "linux",
      exec: async (f, a) => void calls.push([f, a]),
    });
    expect(calls).toEqual([]);
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
