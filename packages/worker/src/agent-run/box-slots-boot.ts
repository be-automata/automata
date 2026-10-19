import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";

import { BOX_SLOTS_MAX } from "./box-lock";
import { isInertPolicy, parseMeminfo, readProcMeminfo } from "./headroom";
import { KILL_BIN, SH_BIN, SUDO_BIN, agentUserForSlot } from "./spawn-as-user";
import { resolveUidViaId } from "./uid-reaper";

const execFileAsync = promisify(execFile);
const SUDO_PROBE_TIMEOUT_MS = 5_000;

/**
 * #205 boot-time helpers for the counting box budget, kept out of
 * hello/worker.ts so they are unit-testable (that module runs main() on import).
 */

/**
 * #205: every slot account must resolve to a uid — checked in parallel through
 * the reaper's bounded `id -u` (2 s, SIGKILL), so a hung NSS lookup cannot wedge
 * boot. The names were validated as plain logins by loadWorkerConfig. Returns
 * the uids, in slot order, and refuses the box when the uids are not what the
 * fence assumes (ADR-007 I4, one uid per slot and never the worker's): two
 * logins aliasing one uid (`useradd -o`), uid 0, or the worker's own uid would
 * all pass a name check and share HOME, sockets, /proc and the uid-wide kill.
 */
export async function assertSlotAccountsExist(
  users: string[],
  resolveUid: (user: string) => Promise<number> = resolveUidViaId,
  selfUid: number | undefined = process.getuid?.(),
): Promise<number[]> {
  const results = await Promise.allSettled(users.map((u) => resolveUid(u)));
  const missing = results.flatMap((r, i) =>
    r.status === "rejected"
      ? [
          `${JSON.stringify(users[i])} (${
            r.reason instanceof Error ? r.reason.message : String(r.reason)
          })`,
        ]
      : [],
  );
  if (missing.length > 0) {
    throw new Error(
      `slot account(s) ${missing.join(", ")} do not exist on this box; provision them (deploy/AGENT-UID-PROVISIONING.md §6) or lower WORKER_BOX_SLOTS`,
    );
  }
  const uids = results.map((r) => (r.status === "fulfilled" ? r.value : -1));
  const seen = new Map<number, string>();
  uids.forEach((uid, i) => {
    // `uids` was built from `users` index for index; the slot is always there.
    const user = users[i] ?? `slot ${i}`;
    if (uid === 0) {
      throw new Error(
        `slot account ${JSON.stringify(user)} is uid 0; refusing`,
      );
    }
    if (selfUid !== undefined && uid === selfUid) {
      throw new Error(
        `slot account ${JSON.stringify(user)} is the worker's own uid ${uid}; a run would share the worker's files, sockets and processes — refusing`,
      );
    }
    const other = seen.get(uid);
    if (other !== undefined) {
      throw new Error(
        `slot accounts ${JSON.stringify(other)} and ${JSON.stringify(user)} share uid ${uid}; one uid per slot is the fence between concurrent runs (ADR-007 I4) — refusing`,
      );
    }
    seen.set(uid, user);
  });
  return uids;
}

/**
 * #205: every slot account must be a permitted Runas target for the worker's
 * sudo grant — probed by EXERCISING the rule the runs use: `sudo -n -u <slot>
 * kill -l` (lists signal names; harmless; matches the AUTOMATA_KILL Cmnd) and
 * never prompts (-n). Not `sudo -l`: that obeys `listpw`, so an unrelated
 * password-requiring entry for the worker login (the macOS pilot's admin
 * login) would fail it although the NOPASSWD kill grant is fine. A box whose
 * Runas list was not re-rendered for a new slot otherwise boots clean,
 * registers N engine slots, and every run that lands on the new slot dies at
 * `sudo -u <slot>` with "a password is required" — the failure the account
 * check exists to move to boot. Called at N > 1 only (only there can a Runas
 * entry be missing on a box that booted before). Probes run in parallel; every
 * refused account is named.
 */
export async function assertSlotSudoGrants(
  users: readonly string[],
  probe: (user: string) => Promise<void> = sudoListProbe,
): Promise<void> {
  const results = await Promise.allSettled(users.map((u) => probe(u)));
  const refused = results.flatMap((r, i) =>
    r.status === "rejected"
      ? [
          `${JSON.stringify(users[i])} (${
            r.reason instanceof Error ? r.reason.message : String(r.reason)
          })`,
        ]
      : [],
  );
  if (refused.length > 0) {
    throw new Error(
      `sudo does not permit the worker to run as slot account(s) ${refused.join(", ")}; re-render the sudoers Runas list for every slot account (deploy/AGENT-UID-PROVISIONING.md §6) or lower WORKER_BOX_SLOTS`,
    );
  }
}

async function sudoListProbe(user: string): Promise<void> {
  await execFileAsync(SUDO_BIN, ["-n", "-u", user, "--", KILL_BIN, "-l"], {
    timeout: SUDO_PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
}

/** The `hidepid=` values that hide other uids' processes (`2` ≡ invisible, `4` ≡ ptraceable). */
const HIDEPID_OK = new Set(["invisible", "2", "ptraceable", "4"]);

/**
 * The mount options of the /proc mount in effect for this process, from a
 * `/proc/self/mountinfo` text: per-mount AND superblock options (hidepid is a
 * superblock option). The LAST /proc entry wins — a later overmount is the one
 * in effect. null when there is no /proc mount.
 */
export function procMountOptions(mountinfo: string): string[] | null {
  const procLine = mountinfo
    .split("\n")
    .map((l) => l.split(" "))
    .filter((f) => f[4] === "/proc")
    .at(-1);
  if (!procLine) return null;
  const sep = procLine.indexOf("-");
  return [procLine[5] ?? "", procLine[sep + 3] ?? ""].join(",").split(",");
}

function hidepidOf(options: readonly string[]): string | undefined {
  return options
    .find((o) => o.startsWith("hidepid="))
    ?.slice("hidepid=".length);
}

/** Where the N > 1 drop-in lives on a box (the unit is installed system-wide). */
export const HIDEPID_DROPIN_PATH =
  "/etc/systemd/system/automata-worker.service.d/20-hidepid.conf";

/**
 * #205, the OTHER direction of the hidepid check: at N = 1 the unit should run
 * under the base unit's `ProtectSystem=full` / `ProtectKernelTunables=yes`. The
 * N > 1 drop-in (`20-hidepid.conf`) relaxes both, and nothing else notices it
 * left behind after a rollback. Two triggers: the drop-in file itself at its
 * installed path (direct — catches a rollback that also reverted the host
 * remount), and a hidepid /proc seen INSIDE the unit (the base unit's private
 * /proc has none, so seeing the host's means the relaxation is in effect).
 * A warning, never a refusal: the fence is intact either way. Returns the
 * warning text, or null (not Linux, neither trigger, or an unreadable probe —
 * a one-slot box never fails its boot on this).
 */
export function hidepidDropinLeftAtOneSlot(
  opts: {
    platform?: NodeJS.Platform;
    readMountinfo?: () => string;
    /** stat of the installed drop-in; injectable for tests. */
    dropinExists?: () => boolean;
  } = {},
): string | null {
  const {
    platform = process.platform,
    readMountinfo = () => readFileSync("/proc/self/mountinfo", "utf8"),
    dropinExists = () => existsSync(HIDEPID_DROPIN_PATH),
  } = opts;
  if (platform !== "linux") return null;
  const triggers: string[] = [];
  try {
    if (dropinExists()) triggers.push(`${HIDEPID_DROPIN_PATH} exists`);
  } catch {
    // unreadable path: fall through to the mount probe
  }
  try {
    const options = procMountOptions(readMountinfo());
    const hidepid = options ? hidepidOf(options) : undefined;
    if (hidepid !== undefined && HIDEPID_OK.has(hidepid)) {
      triggers.push(
        `/proc is mounted with hidepid=${hidepid} inside the worker unit`,
      );
    }
  } catch {
    // unreadable mountinfo: the file probe above is the only signal
  }
  if (triggers.length === 0) return null;
  return `the N > 1 drop-in automata-worker.service.d/20-hidepid.conf (ProtectSystem=no, ProtectKernelTunables=no) is still in effect at WORKER_BOX_SLOTS=1 (${triggers.join("; ")}) — remove it and \`systemctl daemon-reload && systemctl restart automata-worker\` when nothing is in flight (deploy/AGENT-UID-PROVISIONING.md §6)`;
}

/**
 * #205: at N > 1 on Linux, /proc must be mounted with `hidepid` (invisible or
 * ptraceable) — the run's proxy credential rides in the agent children's
 * HTTPS_PROXY, the worker keeps it out of every argv it writes, but a tool the
 * agent runs may copy it into one, and `/proc/<pid>/cmdline` is otherwise
 * world-readable to a sibling slot. The same fail-closed shape as the other
 * N > 1 preconditions (accounts, sudo, fence): a box raised to N = 2 without
 * the remount must not boot clean. Reads /proc/self/mountinfo — the /proc
 * mount's per-mount AND superblock options (hidepid is a superblock option).
 * Not Linux ⇒ nothing.
 */
export function assertProcHidepid(
  opts: {
    platform?: NodeJS.Platform;
    readMountinfo?: () => string;
    /** The worker's gid and supplementary gids; one of them must be the mount's `gid=` exemption. */
    workerGids?: readonly number[];
  } = {},
): number | null {
  const {
    platform = process.platform,
    readMountinfo = () => readFileSync("/proc/self/mountinfo", "utf8"),
    workerGids = [
      ...(process.getgid ? [process.getgid()] : []),
      ...(process.getgroups ? process.getgroups() : []),
    ],
  } = opts;
  if (platform !== "linux") return null;
  let text: string;
  try {
    text = readMountinfo();
  } catch (e) {
    throw new Error(
      `cannot read /proc/self/mountinfo (${e instanceof Error ? e.message : String(e)}); at WORKER_BOX_SLOTS > 1 the /proc hidepid mount is a precondition (deploy/AGENT-UID-PROVISIONING.md §6)`,
    );
  }
  const options = procMountOptions(text);
  if (!options) {
    throw new Error(
      "no /proc mount in /proc/self/mountinfo; at WORKER_BOX_SLOTS > 1 the /proc hidepid mount is a precondition (deploy/AGENT-UID-PROVISIONING.md §6)",
    );
  }
  const hidepid = hidepidOf(options);
  if (hidepid === undefined || !HIDEPID_OK.has(hidepid)) {
    throw new Error(
      `/proc is mounted ${hidepid === undefined ? "without hidepid" : `with hidepid=${hidepid}`}; at WORKER_BOX_SLOTS > 1 another slot's account could read a run's argv (and a copied proxy credential) — remount with hidepid=invisible and the worker group exempt (deploy/AGENT-UID-PROVISIONING.md §6)`,
    );
  }
  // The worker itself must stay exempt: without `gid=<a group of the worker>`
  // hidepid blinds the non-root worker to every slot account's processes, so
  // the escapee reaper scans nothing and silently never kills — while the boot
  // would report fail-closed. `ptraceable` without the exemption blinds it the
  // same way (it cannot ptrace other uids).
  const gidOpt = options
    .find((o) => o.startsWith("gid="))
    ?.slice("gid=".length);
  const gid = gidOpt === undefined ? undefined : Number(gidOpt);
  if (
    gid === undefined ||
    !Number.isInteger(gid) ||
    !workerGids.includes(gid)
  ) {
    throw new Error(
      `/proc hidepid=${hidepid} ${gidOpt === undefined ? "has no gid= exemption" : `exempts gid ${gidOpt}, which the worker (gids ${workerGids.join(", ")}) is not in`}; the worker would see none of the slot accounts' processes and the escapee reaper would silently scan nothing — remount with gid=<a group of the worker> (deploy/AGENT-UID-PROVISIONING.md §6)`,
    );
  }
  return gid;
}

/**
 * #205: the hidepid exemption must not also cover the slot accounts — a shared
 * group (`users`, or any supplementary group of the worker the slots are in)
 * would make hidepid isolate nothing between slots while the boot reported the
 * precondition met. Each slot account's groups come from the bounded
 * `id -G <slot>`; one in the exempt group refuses the boot.
 */
export async function assertSlotAccountsOutsideGroup(
  users: readonly string[],
  exemptGid: number | null,
  resolveGids: (user: string) => Promise<number[]> = resolveGidsViaId,
): Promise<void> {
  if (exemptGid === null || users.length === 0) return;
  const results = await Promise.allSettled(users.map((u) => resolveGids(u)));
  const inside = results.flatMap((r, i) =>
    r.status === "fulfilled" && r.value.includes(exemptGid)
      ? [JSON.stringify(users[i])]
      : [],
  );
  const unknown = results.flatMap((r, i) =>
    r.status === "rejected" ? [JSON.stringify(users[i])] : [],
  );
  if (inside.length > 0 || unknown.length > 0) {
    throw new Error(
      `${inside.length > 0 ? `slot account(s) ${inside.join(", ")} are in the hidepid-exempt group ${exemptGid}, so /proc hides nothing between slots` : ""}${inside.length > 0 && unknown.length > 0 ? "; " : ""}${unknown.length > 0 ? `groups of ${unknown.join(", ")} could not be read` : ""} — the exempt group must hold the worker alone (deploy/AGENT-UID-PROVISIONING.md §6)`,
    );
  }
}

async function resolveGidsViaId(user: string): Promise<number[]> {
  const { stdout } = await execFileAsync("/usr/bin/id", ["-G", user], {
    timeout: SUDO_PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  return stdout.trim().split(/\s+/).filter(Boolean).map(Number);
}

/**
 * #205: at N > 1 every slot account needs traverse (`--x`) on the workdir root
 * — §6 step 4's `setfacl -m u:<slot>:--x` — or every run that lands on that
 * slot dies at the clone grant or the daemon start with EACCES, after the box
 * registered N slots. Exercised through the sudo grant the runs use
 * (`sudo -n -u <slot> sh -c 'test -x "$1"' sh <root>`), so it is the slot
 * account's own view that is tested, ACL mask included. Probes run in
 * parallel; every refused account is named. Not Linux ⇒ nothing (macOS runs
 * N = 1 by construction).
 */
export async function assertSlotWorkdirTraverse(
  users: readonly string[],
  workdirRoot: string,
  probe: (user: string, root: string) => Promise<void> = sudoTraverseProbe,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== "linux" || users.length === 0) return;
  const results = await Promise.allSettled(
    users.map((u) => probe(u, workdirRoot)),
  );
  const refused = results.flatMap((r, i) =>
    r.status === "rejected" ? [JSON.stringify(users[i])] : [],
  );
  if (refused.length > 0) {
    throw new Error(
      `slot account(s) ${refused.join(", ")} cannot traverse the workdir root ${workdirRoot}; grant it (setfacl -m u:<slot>:--x, deploy/AGENT-UID-PROVISIONING.md §6 step 4) or lower WORKER_BOX_SLOTS`,
    );
  }
}

async function sudoTraverseProbe(user: string, root: string): Promise<void> {
  await execFileAsync(
    SUDO_BIN,
    ["-n", "-u", user, "--", SH_BIN, "-c", 'test -x "$1"', "sh", root],
    { timeout: SUDO_PROBE_TIMEOUT_MS, killSignal: "SIGKILL" },
  );
}

/** The systemd unit that loads the fence (nft-preflight.sh) and drops it with its marker. */
export const EGRESS_UNIT = "automata-egress.service";

function egressUnitActive(): boolean {
  try {
    execFileSync("/usr/bin/systemctl", ["is-active", "--quiet", EGRESS_UNIT], {
      timeout: SUDO_PROBE_TIMEOUT_MS,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** Where nft-preflight.sh records the uids the loaded fence covers (tmpfs: gone at reboot, rewritten by the automata-egress unit). */
export const EGRESS_FENCE_UIDS_FILE = "/run/automata/egress-fence.uids";

/**
 * #205: at N > 1 on Linux the box refuses to boot unless the kernel egress
 * fence provably covers EVERY slot uid. The proof is the uid list the preflight
 * wrote after `nft -f` succeeded; a missing file means the fence never loaded
 * this boot, a missing uid means egress-nft.conf was not re-rendered for the
 * new slot — either way that slot's agent would egress around the cooperative
 * proxy with no backstop while the box looked healthy. Not Linux ⇒ nothing (the
 * macOS pilot is fenced by PF and runs N = 1 by construction).
 */
export function assertFenceCoversSlotUids(opts: {
  uids: readonly number[];
  markerPath?: string;
  platform?: NodeJS.Platform;
  readMarker?: (path: string) => string;
  /** Whether the fence unit is active now — the marker is only trusted alongside it. */
  unitActive?: () => boolean;
}): void {
  const {
    uids,
    markerPath = EGRESS_FENCE_UIDS_FILE,
    platform = process.platform,
    readMarker = (p) => readFileSync(p, "utf8"),
    unitActive = egressUnitActive,
  } = opts;
  if (platform !== "linux" || uids.length === 0) return;
  // The marker says what the preflight loaded; the unit says whether that load
  // is still the one in force. A table dropped by hand (`nft delete table`,
  // `nft flush ruleset`, another tool reloading nftables) leaves the marker
  // behind, so the marker alone is not proof. Residual: a hand delete while
  // the unit stays active — §6 documents the rollback that removes both.
  if (!unitActive()) {
    throw new Error(
      `egress fence coverage unproven: ${EGRESS_UNIT} is not active, so ${markerPath} describes a fence that is not loaded; at WORKER_BOX_SLOTS > 1 the box refuses to run unfenced slots (deploy/AGENT-UID-PROVISIONING.md §6)`,
    );
  }
  let fenced: Set<number>;
  try {
    fenced = new Set(
      readMarker(markerPath)
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number),
    );
  } catch (e) {
    throw new Error(
      `egress fence coverage unproven: cannot read ${markerPath} (${
        e instanceof Error ? e.message : String(e)
      }) — the automata-egress unit (nft-preflight.sh) did not load the fence this boot; at WORKER_BOX_SLOTS > 1 the box refuses to run unfenced slots`,
    );
  }
  const uncovered = uids.filter((u) => !fenced.has(u));
  if (uncovered.length > 0) {
    throw new Error(
      `egress fence does not cover slot uid(s) ${uncovered.join(", ")} (fenced: ${[...fenced].join(", ")}); re-render egress-nft.conf for every slot account and re-run nft-preflight.sh (deploy/AGENT-UID-PROVISIONING.md §6)`,
    );
  }
}

/**
 * #205: slot accounts that exist on this box ABOVE the current N — left behind
 * by a higher WORKER_BOX_SLOTS (the §6 rollback keeps them). Probed with the
 * bounded `id -u`, in parallel; a name that does not resolve (or would exceed
 * the login limit) is simply not one. Never throws; [] with agent-uid mode off.
 * The boot scan reaps these too, since no slot lock guards them any more.
 */
export async function retiredSlotAccounts(
  base: string,
  slots: number,
  resolveUid: (user: string) => Promise<number> = resolveUidViaId,
): Promise<RetiredSlot[]> {
  if (!base) return [];
  const candidates: RetiredSlot[] = [];
  for (let slot = slots; slot < BOX_SLOTS_MAX; slot++) {
    try {
      candidates.push({ slot, account: agentUserForSlot(base, slot) });
    } catch {
      // over the login-name limit: cannot exist
    }
  }
  const results = await Promise.allSettled(
    candidates.map((c) => resolveUid(c.account)),
  );
  return candidates.filter((_c, i) => results[i]?.status === "fulfilled");
}

/** A provisioned slot account above the current N, with the slot it belongs to. */
export interface RetiredSlot {
  slot: number;
  account: string;
}

/**
 * #205: a loud line when N × per-run ceiling exceeds the box's RAM. Not a
 * refusal — #371's headroom check bounds the SUM at admission and #372's tuple
 * validation decides what to refuse — but an operator who set N = 3 with a
 * 5000M ceiling on a 7.6 GB box should read it at boot, not after the ENOMEM.
 */
export function warnIfSlotsExceedMemory(
  cfg: { boxSlots: number; memoryMaxBytes: number },
  readMeminfo: () => string = () => readFileSync("/proc/meminfo", "utf8"),
  log: (line: string) => void = (l) => console.warn(l),
): void {
  if (cfg.boxSlots <= 1 || cfg.memoryMaxBytes <= 0) {
    return;
  }
  const memTotalBytes = readMemTotalBytes(readMeminfo);
  if (memTotalBytes === null) {
    return;
  }
  const need = cfg.boxSlots * cfg.memoryMaxBytes;
  if (need > memTotalBytes) {
    log(
      `[worker-boot] WARNING: WORKER_BOX_SLOTS=${cfg.boxSlots} × WORKER_RUN_MEMORY_MAX=${cfg.memoryMaxBytes} = ${need} bytes exceeds MemTotal ${memTotalBytes}; runs cannot swap (memory.swap.max=0). With the memory-headroom check armed (#371) a second concurrent run is DEFERRED — expect box.headroom_rejected / box.headroom_deferred_wait lines and, past the budget, budget-exhausted failures; with the check OFF (inert rollback) concurrent runs can hit ENOMEM under load`,
    );
  }
}

/**
 * #372: the base load every box carries beside its runs (worker, engine
 * container, Postgres, sshd — measured 2.4–3.5 GB idle on the pilot). The
 * FLOOR of that range, deliberately: this is the operator's typo guard for the
 * tuple, not the admission decision — #371's boot-load WARNING reports the
 * Committed_AS actually observed, and its admission uses the live figure.
 */
export const BOX_BASE_COMMIT_BYTES = 2 * 1024 ** 3;

/**
 * #372: the operator's typo guard for the memory side of the tuple, in the
 * SAME terms the #371 headroom check admits by: N runs' expected commit
 * (`WORKER_HEADROOM_RUN_COMMIT`, = the ceiling by default) plus the box's base
 * load must fit `WORKER_HEADROOM_COMMIT_FRACTION × CommitLimit` (swap +
 * overcommit_ratio × RAM), or N full runs could never be admitted together —
 * the headroom check would defer every run past the first until it failed
 * (observed: #371's drill on the cx33 deferred every second 5000M run). With
 * the whole headroom policy inert (the documented rollback: floor 0 AND
 * fraction 1.0) the check is skipped — nothing would defer; with only the
 * commit arm inert (fraction ≥ 1) the whole `CommitLimit` is the budget. Refuses
 * (throws, naming the knobs) on Linux with the ceiling on; a box without the
 * ceiling or /proc/meminfo is not this check's business (N > 1 already
 * requires both). `warnIfSlotsExceedMemory` stays the softer RAM warning
 * beside it: swap can absorb N × ceiling > MemTotal, nothing absorbs the
 * commit budget.
 */
export function assertSlotsFitCommitLimit(
  cfg: {
    boxSlots: number;
    memoryMaxBytes: number;
    headroomFloorBytes: number;
    headroomRunCommitBytes: number;
    headroomCommitFraction: number;
  },
  opts: {
    platform?: NodeJS.Platform;
    readMeminfo?: () => string;
    baseBytes?: number;
  } = {},
): void {
  const {
    platform = process.platform,
    readMeminfo = readProcMeminfo,
    baseBytes = BOX_BASE_COMMIT_BYTES,
  } = opts;
  // N = 1 is #371's business (assessHeadroomSupport refuses a run commit the
  // box can never admit); this guard is the N-run SUM the ticket's AC names.
  if (platform !== "linux" || cfg.memoryMaxBytes <= 0 || cfg.boxSlots <= 1) {
    return;
  }
  // The documented rollback (floor 0, fraction 1.0) turns the headroom check
  // OFF — then nothing defers, CommitLimit is not kernel-enforced
  // (vm.overcommit_memory 0), and this guard has nothing to guard.
  if (
    isInertPolicy({
      floorBytes: cfg.headroomFloorBytes,
      commitFraction: cfg.headroomCommitFraction,
      runCommitBytes: cfg.headroomRunCommitBytes,
    })
  ) {
    return;
  }
  const { commitLimit } = parseMeminfo(readMeminfo());
  const fraction = Math.min(cfg.headroomCommitFraction, 1);
  const budget = fraction * commitLimit;
  const need = cfg.boxSlots * cfg.headroomRunCommitBytes + baseBytes;
  if (need > budget) {
    throw new Error(
      `WORKER_BOX_SLOTS=${cfg.boxSlots} × run commit ${cfg.headroomRunCommitBytes} (WORKER_HEADROOM_RUN_COMMIT, = WORKER_RUN_MEMORY_MAX by default) + ${baseBytes} base = ${need} bytes exceeds ${fraction} × CommitLimit ${commitLimit} = ${Math.floor(budget)} (the memory-headroom budget; CommitLimit = swap + overcommit_ratio × RAM): ${cfg.boxSlots} full runs could never be admitted together — the headroom check would defer every run past the first until it failed. Lower WORKER_BOX_SLOTS (and WORKER_GLOBAL_MAX_RUNS with it) or the run commit, raise vm.overcommit_ratio or add swap, or resize the box.`,
    );
  }
}

/** `MemTotal` from /proc/meminfo text in bytes; null when unreadable or absent. */
function readMemTotalBytes(read: () => string): number | null {
  try {
    const m = /^MemTotal:\s+(\d+)\s+kB/m.exec(read());
    return m?.[1] ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}
