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
  "list,search,add_file,add_subdirectory,delete_child," +
  "readattr,writeattr,readextattr,writeextattr,readsecurity," +
  "file_inherit,directory_inherit";

/**
 * The shared-root grant: cross the directory, learn nothing about it. Not
 * inheritable, so it never reaches another run's contents.
 */
export const TRAVERSE_ACE_RIGHTS = "search";

export type AceExec = (file: string, args: string[]) => Promise<void>;

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

const defaultExec: AceExec = async (file, args) => {
  await execFileAsync(file, args);
};

async function applyAces(opts: {
  dir: string;
  users: string[];
  rights: string;
  exec?: AceExec;
  platform?: NodeJS.Platform;
}): Promise<void> {
  const { dir, users, rights } = opts;
  const platform = opts.platform ?? process.platform;
  // No users = the default-off path. Non-darwin = the mechanism does not exist;
  // the worker still runs (and its suite still passes) on Linux CI.
  if (users.length === 0 || platform !== "darwin") {
    return;
  }
  const exec = opts.exec ?? defaultExec;
  for (const user of users) {
    const inv = buildAceInvocation({ user, dir, rights });
    // Deliberately NOT swallowed: `chmod +a` fails on a volume without ACL
    // support, and a silently-missing ACE surfaces later as a 15s "daemon
    // socket not ready" with nothing pointing at the cause. Fail loud, here.
    await exec(inv.file, inv.args);
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
  return applyAces({ ...opts, rights: INHERITABLE_ACE_RIGHTS });
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
  return applyAces({ ...opts, rights: TRAVERSE_ACE_RIGHTS });
}
