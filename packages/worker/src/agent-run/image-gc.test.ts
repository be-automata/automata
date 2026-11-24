import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../deploy/linux/image-gc.sh",
);

const BAT = "ghcr.io/be-automata/automata-batteries";
const CELL = "ghcr.io/be-automata/automata-cell";
const d = (c: string) => `sha256:${c.repeat(64)}`;

/**
 * Runs image-gc.sh against a fake `docker`: `images` prints the rows file of
 * the socket's directory, `rmi` appends to a log and fails for ids in `inuse`.
 */
describe("image-gc.sh (2026-11-24: old images filled the box disk)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "image-gc-"));
    fs.writeFileSync(
      path.join(dir, "docker"),
      `#!/bin/bash
sock="\${2#unix://}"; name="$(basename "$(dirname "$sock")")"; shift 2
case "$1" in
  images) cat "${dir}/$name.rows" 2>/dev/null ;;
  rmi) echo "$name $2" >> "${dir}/rmi.log"
       grep -qx "$2" "${dir}/inuse" 2>/dev/null && exit 1; exit 0 ;;
esac
`,
      { mode: 0o755 },
    );
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup(opts: {
    runner?: string[];
    osb?: string[];
    state?: string;
    env?: string;
    inuse?: string[];
  }) {
    if (opts.runner)
      fs.writeFileSync(path.join(dir, "runner.rows"), opts.runner.join("\n"));
    if (opts.osb)
      fs.writeFileSync(path.join(dir, "osb.rows"), opts.osb.join("\n"));
    if (opts.state !== undefined)
      fs.writeFileSync(path.join(dir, "state"), opts.state);
    fs.writeFileSync(path.join(dir, "worker.env"), opts.env ?? "");
    if (opts.inuse)
      fs.writeFileSync(path.join(dir, "inuse"), opts.inuse.join("\n"));
  }

  function run(...args: string[]) {
    const r = spawnSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        IMAGE_GC_DOCKER: path.join(dir, "docker"),
        IMAGE_GC_RUNNER_SOCK: path.join(dir, "runner", "docker.sock"),
        IMAGE_GC_OSB_SOCK: path.join(dir, "osb", "docker.sock"),
        IMAGE_GC_STATE: path.join(dir, "state"),
        IMAGE_GC_WORKER_ENV: path.join(dir, "worker.env"),
        IMAGE_GC_SKIP_ROOT_CHECK: "1",
        IMAGE_GC_SKIP_SOCKET_CHECK: "1",
      },
    });
    const log = path.join(dir, "rmi.log");
    const rmi = fs.existsSync(log)
      ? fs.readFileSync(log, "utf8").trim().split("\n")
      : [];
    return { ...r, rmi };
  }

  // card: protects=only images nothing pins are removed: batteries other than CURRENT, PREVIOUS and the worker pin, cells other than the worker's cell pin; fails_when=a pinned image is removed or an unpinned one is kept; no_claim=Docker's own refusal of an image in use (next test)
  it("removes exactly the unpinned image of each repository", () => {
    setup({
      runner: [
        `${d("1")} ${BAT} ${d("a")}`,
        `${d("2")} ${BAT} ${d("b")}`,
        `${d("3")} ${BAT} ${d("c")}`,
      ],
      osb: [`${d("4")} ${CELL} ${d("e")}`, `${d("5")} ${CELL} ${d("f")}`],
      state: `CURRENT=${BAT}@${d("a")}\nPREVIOUS=${BAT}@${d("b")}\n`,
      env: `WORKER_BATTERIES_IMAGE=${BAT}@${d("a")}\nexport WORKER_OPENSANDBOX_GUEST_IMAGE="${CELL}@${d("f")}"\n`,
    });
    const r = run();
    expect(r.status).toBe(0);
    expect(r.rmi).toEqual([`runner ${d("3")}`, `osb ${d("4")}`]);
  });

  it("keeps an image when any digest it carries is pinned, and the last env line wins", () => {
    setup({
      osb: [
        `${d("4")} ${CELL} ${d("e")}`,
        `${d("4")} ${CELL} ${d("f")}`,
        `${d("5")} ${CELL} ${d("0")}`,
      ],
      env: `WORKER_OPENSANDBOX_GUEST_IMAGE=${CELL}@${d("0")}\nWORKER_OPENSANDBOX_GUEST_IMAGE=${CELL}@${d("f")}\n`,
    });
    const r = run();
    expect(r.rmi).toEqual([`osb ${d("5")}`]);
  });

  // card: protects=with no pin found for a daemon nothing of it is removed (never "remove all"); fails_when=any rmi runs with an empty keep set; no_claim=a pin that names an image not pulled (it is simply kept)
  it("removes nothing on a daemon whose pin cannot be found", () => {
    setup({
      runner: [`${d("1")} ${BAT} ${d("a")}`],
      osb: [`${d("4")} ${CELL} ${d("e")}`],
    });
    const r = run();
    expect(r.status).toBe(0);
    expect(r.rmi).toEqual([]);
    expect(r.stdout).toMatch(/skip .*automata-batteries: no pinned digest/);
    expect(r.stdout).toMatch(/skip .*automata-cell: no pinned digest/);
  });

  it("logs an image Docker refuses to remove and still exits 0", () => {
    setup({
      osb: [`${d("4")} ${CELL} ${d("e")}`, `${d("5")} ${CELL} ${d("f")}`],
      env: `WORKER_OPENSANDBOX_GUEST_IMAGE=${CELL}@${d("f")}`,
      inuse: [d("4")],
    });
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/kept .*docker refused the removal/);
    expect(r.stdout).toMatch(/removed=0 refused=1/);
  });

  it("--dry-run removes nothing and says what it would remove", () => {
    setup({
      osb: [`${d("4")} ${CELL} ${d("e")}`, `${d("5")} ${CELL} ${d("f")}`],
      env: `WORKER_OPENSANDBOX_GUEST_IMAGE=${CELL}@${d("f")}`,
    });
    const r = run("--dry-run");
    expect(r.rmi).toEqual([]);
    expect(r.stdout).toMatch(/would remove .*automata-cell 4{64}/);
  });

  it("never runs rmi with --force", () => {
    const code = fs
      .readFileSync(SCRIPT, "utf8")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(code).toMatch(/rmi "\$id"/);
    expect(code).not.toMatch(/rmi[^\n]*(-f\b|--force)/);
  });
});
