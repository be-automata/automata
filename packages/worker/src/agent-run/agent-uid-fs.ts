import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * macOS ACL grants that let the agent uid reach exactly one run's files (#108).
 *
 * WHY ACLs AND NOT MODE BITS. The #50 workspace-trust seed is a 0700 per-run
 * HOME holding a 0600 `.claude.json` (agent-credentials.ts), and a review run
 * dies in seconds with no output if that seed is unreadable. Widening to a
 * shared group would force 0770/0660 and destroy the seed's intent. A macOS ACE
 * adds ONE named-user grant on top of unchanged mode bits: macOS evaluates ACEs
 * before the mode, an allow ACE short-circuits the mode check, and — verified on
 * macOS 15.7.3/APFS — `chmod 600` does NOT strip it.
 *
 * WHY THE SOCKETS NEED THIS TOO. Darwin enforces unix-socket permissions:
 * unix(4) says "the destination of a connect(2) or sendto(2) must be writable",
 * and XNU's unp_connect() runs the full vnode_authorize(KAUTH_VNODE_WRITE_DATA)
 * path, so mode bits AND ACLs both apply — and namei() requires search (--x) on
 * EVERY path component. Node binds unix sockets 0755, so under a uid split the
 * daemon (agent uid) cannot even bind inside a worker-owned run dir, and the
 * worker cannot connect to a socket the daemon binds. Inherited ACEs DO land on
 * bind(2)-created sockets (verified), so ONE ACE per direction on the run
 * namespace dir fixes both, with no daemon and no gh-broker change.
 *
 * WHY PER-RUN AND NEVER THE ROOT. Inheritance is applied by the kernel at
 * create time, so an inheritable ACE on the SHARED root would make every run
 * readable by the agent uid — i.e. every OTHER run's credentials and checkout.
 * All runs share one uid: cross-run isolation comes from ACE PLACEMENT, never
 * from ownership. The shared root therefore gets traverse (`search`) only — no
 * read, no list, not inheritable.
 */

/**
 * The per-run grant. Inheritance flags mean every file and directory created
 * INSIDE afterwards carries the grant — which is why the ACE must be applied
 * BEFORE the clone, not after. Nothing already present when it is set gets it.
 */
export const INHERITABLE_ACE_RIGHTS =
  // FILE data rights. Without these the whole feature is inert: the agent uid
  // could stat the checkout and its own credential file but not read one byte
  // of either, and could create nothing. `read`/`write`/`append`/`execute` are
  // chmod(1)'s file-permission names; `delete` is a "both" right and is what
  // lets the agent replace a file it owns the content of (git rewrites in
  // place). See chmod(1) "ACL MANIPULATION OPTIONS" for the exact vocabulary.
  "read,write,append,execute,delete," +
  // DIRECTORY rights: traverse it, list it, create and remove entries in it.
  "list,search,add_file,add_subdirectory,delete_child," +
  // ATTRIBUTE rights: xattrs + the ACL itself, so a git checkout and the
  // credential seed keep working across the uid split.
  "readattr,writeattr,readextattr,writeextattr,readsecurity," +
  // Inheritance: applied by the kernel at CREATE time, which is why the ACE
  // goes on before the clone.
  "file_inherit,directory_inherit";

/**
 * The shared-root grant: cross the directory, learn nothing about it. Not
 * inheritable, so it never reaches another run's contents.
 */
export const TRAVERSE_ACE_RIGHTS = "search";

/**
 * LINUX: the same two grants expressed as POSIX ACLs (#192 P4).
 *
 * THE VOCABULARY COLLAPSES. POSIX ACLs have exactly r, w and x — none of macOS's
 * separate delete/attribute/inheritance rights. `rwx` on a directory already
 * carries what the long macOS list spells out, and `--x` is traverse-without-read.
 *
 * INHERITANCE IS A SEPARATE ENTRY, NOT A FLAG. macOS folds inheritance into the
 * ACE via file_inherit/directory_inherit. Linux splits it: the ACCESS ACL governs
 * the directory itself, and the DEFAULT ACL (`-d`) is what newly created entries
 * copy. Both are needed — a default ACL alone grants nothing on the directory it
 * sits on, so the daemon could not write its pidfile into a dir it was "granted".
 *
 * THE DEFAULT ACL NEVER GOES ON THE SHARED ROOT. Same reason the macOS traverse
 * ACE is not inheritable: it would hand the agent uid every OTHER run's contents.
 * All runs share one uid, so cross-run isolation is placement, not ownership.
 *
 * ── THE TRAP, AND IT IS THE OPPOSITE OF macOS ──────────────────────────────
 *
 * The macOS note above records, verified, that `chmod 600` does NOT strip an ACE.
 * On Linux it effectively does. POSIX ACLs have a MASK that caps every named-user
 * entry, and when an ACL is present `chmod`'s GROUP bits ARE the mask. Measured on
 * Ubuntu 24.04/ext4:
 *
 *   after creation:   user:agent:rwx  #effective:rw-   mask::rw-   agent reads: YES
 *   after chmod 600:  user:agent:rwx  #effective:---   mask::---   agent reads: NO
 *
 * `getfacl` STILL LISTS THE ENTRY. The fence is inert and inspection says it is
 * applied. This matters here because the #50 workspace-trust seed writes a 0600
 * `.claude.json`, and a review run dies in seconds with no output if that seed is
 * unreadable — so on Linux, anything that chmods a file AFTER creating it must
 * re-apply the ACL or not chmod at all. Verify a Linux fence by reading
 * `#effective:`, or better by reading the file as the agent uid; never by the
 * presence of the entry.
 */
export const LINUX_INHERITABLE_ACL_RIGHTS = "rwx";
export const LINUX_TRAVERSE_ACL_RIGHTS = "--x";

export type AceExec = (file: string, args: string[]) => Promise<void>;

/** Which of the two grants to apply. The rights per platform follow from it. */
export type AceGrant = "inheritable" | "traverse";

/** `chmod +a "<user> allow <rights>" <dir>` as argv. Pure. */
export function buildAceInvocation(opts: {
  user: string;
  dir: string;
  rights: string;
}): { file: string; args: string[] } {
  return {
    file: "/bin/chmod",
    args: ["+a", `${opts.user} allow ${opts.rights}`, opts.dir],
  };
}

/**
 * The setfacl argv for one grant. Pure.
 *
 * Returns TWO invocations for the inheritable grant — access ACL then default
 * ACL — and ONE for traverse. Order matters only for readability; neither
 * depends on the other.
 */
export function buildSetfaclInvocations(opts: {
  user: string;
  dir: string;
  grant: AceGrant;
}): { file: string; args: string[] }[] {
  const { user, dir, grant } = opts;
  if (grant === "traverse") {
    return [
      {
        file: "/usr/bin/setfacl",
        args: ["-m", `u:${user}:${LINUX_TRAVERSE_ACL_RIGHTS}`, dir],
      },
    ];
  }
  return [
    {
      file: "/usr/bin/setfacl",
      args: ["-m", `u:${user}:${LINUX_INHERITABLE_ACL_RIGHTS}`, dir],
    },
    {
      file: "/usr/bin/setfacl",
      args: ["-d", "-m", `u:${user}:${LINUX_INHERITABLE_ACL_RIGHTS}`, dir],
    },
  ];
}

const defaultExec: AceExec = async (file, args) => {
  await execFileAsync(file, args);
};

async function applyAces(opts: {
  dir: string;
  users: string[];
  grant: AceGrant;
  exec?: AceExec;
  platform?: NodeJS.Platform;
}): Promise<void> {
  const { dir, users, grant } = opts;
  const platform = opts.platform ?? process.platform;
  // No users = the default-off path.
  if (users.length === 0) {
    return;
  }
  // Anything that is neither darwin nor linux has no mechanism here. This used
  // to read `platform !== "darwin"`, which made the whole fence a silent no-op
  // on Linux: callers got a resolved promise and a box with no boundary on it.
  if (platform !== "darwin" && platform !== "linux") {
    return;
  }
  const exec = opts.exec ?? defaultExec;
  for (const user of users) {
    const invocations =
      platform === "darwin"
        ? [
            buildAceInvocation({
              user,
              dir,
              rights:
                grant === "traverse"
                  ? TRAVERSE_ACE_RIGHTS
                  : INHERITABLE_ACE_RIGHTS,
            }),
          ]
        : buildSetfaclInvocations({ user, dir, grant });
    for (const inv of invocations) {
      // Deliberately NOT swallowed: the tool fails on a filesystem mounted
      // without ACL support, and a silently-missing grant surfaces later as a
      // 15s "daemon socket not ready", or as a run that dies on an unwritable
      // pidfile, with nothing pointing at the cause. Fail loud, here.
      await exec(inv.file, inv.args);
    }
  }
}

/**
 * Grant every `users` entry an INHERITABLE ACE on one per-run directory.
 * No-op when `users` is empty or the platform is not darwin.
 */
export function applyInheritableAces(opts: {
  dir: string;
  users: string[];
  exec?: AceExec;
  platform?: NodeJS.Platform;
}): Promise<void> {
  return applyAces({ ...opts, grant: "inheritable" });
}

/**
 * Grant every `users` entry traverse-only on a SHARED root: `namei()` needs
 * search on every path component, and this is the least that satisfies it.
 */
export function applyTraverseAce(opts: {
  dir: string;
  users: string[];
  exec?: AceExec;
  platform?: NodeJS.Platform;
}): Promise<void> {
  return applyAces({ ...opts, grant: "traverse" });
}

/**
 * The BOOT-TIME grant on this worker's run-namespace dir (#108 F2).
 *
 * WHY BOOT AND NOT PER-RUN. macOS applies inheritance at CREATE time. The
 * gh-broker socket (`<threadId>-gh.sock`) and the daemon socket are bound by
 * workflow.ts BEFORE `DaemonProcess.start()` runs, so an ACE applied inside
 * start() reaches neither — the agent's `gh` then cannot connect (Darwin
 * enforces unix-socket permissions) and the failure looks like a broker bug.
 * Applying the two grants ONCE at worker boot, before any run or broker
 * exists, makes every file and socket later created in the dir inherit them.
 *
 * TWO grants, because the dir is a cross-uid rendezvous in BOTH directions:
 * the agent uid must bind the daemon socket and write the wrapper's pidfile
 * here, and the worker's own login must connect to a socket the agent uid
 * created. The shared ROOT gets traverse only — one inheritable ACE there
 * would hand the agent uid every OTHER worker's runs.
 *
 * No-op when `agentUser` is empty (the default-off contract).
 */
export async function applyRunNamespaceAces(opts: {
  /** The SHARED namespace root — traverse only. */
  root: string;
  /** This worker's own `<root>/<workerId>` dir — inheritable grant. */
  runDir: string;
  agentUser: string;
  /** The worker's own login, so it can reach back into agent-created files. */
  workerLogin: string;
  exec?: AceExec;
  platform?: NodeJS.Platform;
}): Promise<void> {
  const { root, runDir, agentUser, workerLogin, exec, platform } = opts;
  if (!agentUser) {
    return;
  }
  await applyTraverseAce({ dir: root, users: [agentUser], exec, platform });
  await applyInheritableAces({
    dir: runDir,
    users: [agentUser, workerLogin],
    exec,
    platform,
  });
}
