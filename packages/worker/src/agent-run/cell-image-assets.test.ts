import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  codeOf,
  describeBashScriptHygiene,
  repoRoot,
} from "./bash-script-hygiene";
import { CONTAINER_DAEMON_BUNDLE } from "./container-argv";
import { CONTAINER_FLUTTER_SHIM_DIR } from "./container-entry";
import { parsePinnedImage } from "./container-image";
import {
  CELL_BROKER_HOST_PATTERN,
  CELL_CA_BUNDLE,
  CELL_DAEMON_ENV,
  CELL_DAEMON_SOCKET,
  CELL_DAEMON_BUNDLE,
  CELL_ENTRY,
  CELL_ENTRY_EXIT,
  CELL_ENV_ALLOWLIST,
  CELL_FORBIDDEN_ENV_PATTERN,
  CELL_NODE,
  CELL_RUN_ENV,
  CELL_SEND,
  CELL_SEND_EXIT,
  CELL_SEND_MAX_BYTES,
  CELL_MESSAGE_DIR,
  CELL_SELF_CHECK_ARGV,
  CELL_CHECKOUT_WORK_BRANCH_SH,
  CELL_WORKSPACE,
  CELL_WRITE_MESSAGE_SH,
  cellCloneArgv,
  cellEntrypoint,
  cellGhSetup,
  cellGitConfigArgv,
  isForbiddenCellEnvName,
} from "./cell-image";
import { CELL_PG_BIN } from "./cell-test-db";

/**
 * The cell guest image (#656 PR-F): static checks of the Dockerfile and the
 * two baked scripts, and fake-node runs of the scripts. The real image build
 * and verify.sh run in the PR's cell-image workflow, not here.
 */

const CELL_DIR = "deploy/images/cell";
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

const DOCKERFILE = `${CELL_DIR}/Dockerfile`;
const ENTRY = `${CELL_DIR}/cell-entry.sh`;
const SEND = `${CELL_DIR}/cell-send.sh`;
const VERIFY = `${CELL_DIR}/verify.sh`;
const SCAN = `${CELL_DIR}/scan-layers.sh`;
const WORKFLOW = ".github/workflows/cell-image.yml";
const ACTION = ".github/actions/cell-image-build/action.yml";
const BATTERIES_REPOSITORY = "ghcr.io/be-automata/automata-batteries";
const BATTERIES_DOCKERFILE = "deploy/images/batteries/Dockerfile";
const PLACEHOLDER = "automata-cell-daemon-token";

interface Instruction {
  op: string;
  args: string;
}

/** Dockerfile instructions with comments dropped and continuations joined. */
function instructionsOf(dockerfile: string): Instruction[] {
  const joined = codeOf(dockerfile).replace(/\\\n/g, " ");
  return joined
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [op = "", ...rest] = l.split(/\s+/);
      return { op: op.toUpperCase(), args: rest.join(" ") };
    });
}

const envPairs = (args: string) =>
  [...args.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=(\S*)/g)].map(
    (m) => [m[1] ?? "", m[2] ?? ""] as const,
  );

/** ARG/ENV names that look like a credential. */
function credentialShapedNames(dockerfile: string): string[] {
  return instructionsOf(dockerfile)
    .filter((i) => i.op === "ARG" || i.op === "ENV")
    .flatMap((i) => envPairs(i.args).map(([name]) => name))
    .filter((name) => CELL_FORBIDDEN_ENV_PATTERN.test(name));
}

/** The one permission change the cell RUN may make (#724). */
const CA_STORE_CHOWN =
  "chown agent:agent /etc/ssl/certs /usr/local/share/ca-certificates";

/** Every chown/chmod statement of a RUN body, whitespace-normalised. */
const permissionChanges = (run: string) =>
  run
    .split(/[;\n]|&&/)
    .map((part) => part.replace(/\\/g, " ").trim().replace(/\s+/g, " "))
    .filter((part) => /^(chown|chmod)\b/.test(part));

/** Command words `node` that are not an absolute path. */
const bareNodeCalls = (script: string) =>
  [...codeOf(script).matchAll(/(?:^|[\s;|&(])node(?=\s|$)/gm)].length;

describe("the cell Dockerfile", () => {
  const dockerfile = read(DOCKERFILE);
  const ins = instructionsOf(dockerfile);

  // card: protects=the cell is built from exactly one batteries image pinned by digest; fails_when=the FROM is a tag, another repository, a second stage or the base.name label drifts from it; no_claim=that the digest exists in GHCR
  it("has one FROM, pinned by digest to the batteries repository", () => {
    const froms = ins.filter((i) => i.op === "FROM");
    expect(froms).toHaveLength(1);
    const ref = (froms[0]?.args ?? "")
      .split(/\s+/)
      .find((t) => !t.startsWith("--"));
    const parsed = parsePinnedImage(ref);
    expect(parsed.repository).toBe(BATTERIES_REPOSITORY);
    const label = /org\.opencontainers\.image\.base\.name="([^"]+)"/.exec(
      dockerfile,
    );
    expect(label?.[1]).toBe(parsed.reference);
  });

  // card: protects=the pin parser refuses what the cell FROM must never be; fails_when=a tag or a short digest is accepted; no_claim=the Dockerfile
  it("negative control: a tag or a short digest is refused", () => {
    expect(() => parsePinnedImage(`${BATTERIES_REPOSITORY}:latest`)).toThrow();
    expect(() =>
      parsePinnedImage(`${BATTERIES_REPOSITORY}@sha256:abc`),
    ).toThrow();
  });

  // card: protects=no credential-shaped ARG/ENV, no ADD, no secret mount, and one RUN only: the snapshot-pinned Postgres 16 (+ pip/venv, #716) install with no default cluster (#707) plus the CA-store grant (#724); fails_when=any of them appears, a second RUN is added, the RUN loses the snapshot, the pinned major, pip/venv, the no-cluster drop-in or the snakeoil removal, or it chowns/chmods anything but the two CA directories; no_claim=layers of the base image
  it("holds no credential-shaped ARG/ENV, no ADD or secret, and only the Postgres + CA-store RUN", () => {
    expect(credentialShapedNames(dockerfile)).toEqual([]);
    expect(ins.some((i) => i.op === "ADD")).toBe(false);
    expect(codeOf(dockerfile)).not.toContain("--secret");
    const runs = ins.filter((i) => i.op === "RUN");
    expect(runs).toHaveLength(1);
    const run = runs[0]?.args ?? "";
    expect(run).toContain('--snapshot "${APT_SNAPSHOT}"');
    expect(run).toMatch(
      /--no-install-recommends "\$\{snap\[@\]\}" postgresql-16 python3-pip python3-venv;/,
    );
    expect(run).toContain("create_main_cluster = false");
    expect(run).toContain("rm -f /etc/ssl/private/ssl-cert-snakeoil.key");
    expect(run).toContain(`test -x ${CELL_PG_BIN}/initdb`);
    expect(permissionChanges(run)).toEqual([CA_STORE_CHOWN]);
    expect(run).not.toMatch(/\bchmod\b/);
  });

  // card: protects=the permission-change guard actually fires; fails_when=a recursive chown of /etc/ssl, a chmod or an extra directory passes unflagged; no_claim=the real Dockerfile
  it("negative control: a wider chown or a chmod is flagged", () => {
    expect(permissionChanges("chown -R agent /etc/ssl; x")).not.toEqual([
      CA_STORE_CHOWN,
    ]);
    expect(permissionChanges(`${CA_STORE_CHOWN} /etc/ssl; x`)).not.toEqual([
      CA_STORE_CHOWN,
    ]);
    expect(
      permissionChanges(`${CA_STORE_CHOWN}; chmod 0777 /etc/ssl/certs`),
    ).toEqual([CA_STORE_CHOWN, "chmod 0777 /etc/ssl/certs"]);
  });

  // card: protects=the cell's apt snapshot is the batteries image's, so the Postgres .debs come from the same frozen archive; fails_when=the two APT_SNAPSHOT defaults differ; no_claim=that the snapshot still serves them
  it("pins the batteries image's apt snapshot", () => {
    const snapshotOf = (text: string) =>
      /^ARG APT_SNAPSHOT=(\S+)$/m.exec(text)?.[1];
    expect(snapshotOf(dockerfile)).toBeDefined();
    expect(snapshotOf(dockerfile)).toBe(snapshotOf(read(BATTERIES_DOCKERFILE)));
  });

  // card: protects=the credential-name guard actually fires; fails_when=a fixture with ENV DAEMON_TOKEN or ARG API_KEY passes unflagged; no_claim=the real Dockerfile
  it("negative control: a credential-shaped ENV or ARG is flagged", () => {
    expect(credentialShapedNames("FROM x\nENV DAEMON_TOKEN=x\n")).toEqual([
      "DAEMON_TOKEN",
    ]);
    expect(credentialShapedNames("FROM x\nARG GH_API_KEY\nARG A=1\n")).toEqual(
      [],
    );
    expect(credentialShapedNames("FROM x\nARG GH_API_KEY=1\n")).toEqual([
      "GH_API_KEY",
    ]);
  });

  // card: protects=the image carries no token placeholder or secret-shaped file; fails_when=the placeholder string lands in the Dockerfile or either script; no_claim=the daemon bundle
  it("does not carry the daemon token placeholder anywhere", () => {
    for (const rel of [DOCKERFILE, ENTRY, SEND]) {
      expect(read(rel)).not.toContain(PLACEHOLDER);
    }
  });

  // card: protects=the baked paths are the ones the worker constants name; fails_when=a COPY destination drifts from CONTAINER_DAEMON_BUNDLE, CELL_ENTRY or CELL_SEND; no_claim=file modes in the built image (verify.sh)
  it("copies to the paths the worker constants name", () => {
    const dests = ins
      .filter((i) => i.op === "COPY")
      .map((i) => i.args.split(/\s+/).pop());
    expect(dests).toEqual([CELL_DAEMON_BUNDLE, CELL_ENTRY, CELL_SEND]);
    // Negative control: the box's mount path is a new directory, unsearchable when COPY creates it.
    expect(dests).not.toContain(CONTAINER_DAEMON_BUNDLE);
    expect(CELL_DAEMON_BUNDLE.startsWith("/opt/automata/")).toBe(true);
  });

  // card: protects=the CA env and the shim-first PATH; fails_when=the CA paths differ from CELL_CA_BUNDLE or PATH does not start with the shim dir; no_claim=bootstrap behaviour in a live cell
  it("sets the CA bundle env and a shim-first PATH", () => {
    const env = new Map(
      ins.filter((i) => i.op === "ENV").flatMap((i) => envPairs(i.args)),
    );
    expect(env.get("OPENSANDBOX_MERGED_CA_PATH")).toBe(CELL_CA_BUNDLE);
    expect(env.get("GIT_SSL_CAINFO")).toBe(CELL_CA_BUNDLE);
    expect(env.get("PATH")?.startsWith(`${CONTAINER_FLUTTER_SHIM_DIR}:`)).toBe(
      true,
    );
  });

  // card: protects=the cell runs as the non-root agent; fails_when=the last USER is not agent; no_claim=the uid in the built image (verify.sh)
  it("ends as USER agent", () => {
    const users = ins.filter((i) => i.op === "USER");
    expect(users[users.length - 1]?.args).toBe("agent");
  });
});

// card: protects=the BuildKit syntax frontend is pinned by digest, not a movable tag; fails_when=line 1 lacks @sha256:<64 hex>; no_claim=that the digest is the newest 1.7
describe("the Dockerfile syntax frontend", () => {
  const SYNTAX = /^# syntax=docker\/dockerfile:1\.7@sha256:[0-9a-f]{64}$/;

  it("is pinned by digest", () => {
    expect(read(DOCKERFILE).split("\n")[0]).toMatch(SYNTAX);
  });

  it("negative control: a bare tag does not match the pin pattern", () => {
    expect(SYNTAX.test("# syntax=docker/dockerfile:1.7")).toBe(false);
    expect(SYNTAX.test("# syntax=docker/dockerfile:1.7@sha256:abc")).toBe(
      false,
    );
  });
});

[ENTRY, SEND, VERIFY, SCAN].forEach((rel) =>
  describeBashScriptHygiene(rel, read),
);

/** Code lines before the first `PATH=/usr/bin:/bin` assignment, or null. */
function codeBeforePathReset(script: string): string[] | null {
  const code = codeOf(script)
    .split("\n")
    .filter((l) => l.trim() !== "");
  const at = code.indexOf("PATH=/usr/bin:/bin");
  return at < 0 ? null : code.slice(0, at);
}

describe.each([ENTRY, SEND])("%s: command resolution", (rel) => {
  // card: protects=the script execs node by absolute path, never through the agent-writable PATH head; fails_when=it names CELL_NODE no more or has a bare node command word; no_claim=runtime resolution
  it("calls node only by its absolute path", () => {
    expect(codeOf(read(rel))).toContain(CELL_NODE);
    expect(bareNodeCalls(read(rel))).toBe(0);
  });

  // card: protects=every external command resolves through root-owned dirs; fails_when=PATH is not reset before the first command, or anything but set/orig_path comes first; no_claim=the shim dir's contents
  it("resets PATH to /usr/bin:/bin before any other command", () => {
    const before = codeBeforePathReset(read(rel));
    expect(before).not.toBeNull();
    for (const line of before ?? []) {
      expect(line).toMatch(/^(set -euo pipefail|orig_path=.*)$/);
    }
  });
});

// card: protects=the bare-node detector fires; fails_when=a fixture with exec node or a piped node passes unflagged, or an absolute call is flagged; no_claim=the real scripts
it("negative control: bareNodeCalls flags a bare node, not an absolute one", () => {
  expect(bareNodeCalls("exec node a.js\n")).toBe(1);
  expect(bareNodeCalls("x | node a.js\n")).toBe(1);
  expect(bareNodeCalls("exec /usr/local/bin/node a.js\n")).toBe(0);
  expect(bareNodeCalls("# exec node a.js\n")).toBe(0);
});

// card: protects=the PATH-reset detector fires; fails_when=a script that runs a command before resetting PATH, or never resets it, passes; no_claim=the real scripts
it("negative control: codeBeforePathReset sees a command ahead of the reset", () => {
  expect(
    codeBeforePathReset("set -euo pipefail\nmkdir x\nPATH=/usr/bin:/bin\n"),
  ).toEqual(["set -euo pipefail", "mkdir x"]);
  expect(codeBeforePathReset("set -euo pipefail\nmkdir x\n")).toBeNull();
});

/** Runs need bash 4+ (`${name^^}`); the image has it, a stock macOS may not. */
const probe = spawnSync(
  "bash",
  ["-c", 'printf "%s %s" "$BASH" "${BASH_VERSINFO[0]}"'],
  {
    encoding: "utf8",
  },
).stdout.split(" ");
/** Absolute: the runs below replace PATH, which would change the lookup. */
const BASH = probe[0] ?? "bash";
const bashMajor = Number(probe[1]);
const describeRun = bashMajor >= 4 ? describe : describe.skip;

/** Commands the scripts run that a planted copy must never replace. */
const PLANTED_COMMANDS = ["node", "mkdir", "base64", "cat"];

interface Sandbox {
  dir: string;
  /** A copy of a repo script with CELL_NODE pointed at the fake, then `edit`. */
  copy: (rel: string, edit?: (text: string) => string) => string;
  home: string;
  fakeNode: string;
  planted: string;
  marker: string;
  entry: string;
  send: string;
}

/** Fake node: prints umask, argv, its env and stdin, in that order. */
const FAKE_NODE = [
  "#!/bin/bash",
  "umask",
  'printf "%s\\n" "$@"',
  "echo ---ENV---",
  "/usr/bin/env",
  "echo ---STDIN---",
  "/bin/cat",
  "",
].join("\n");

interface FakeOut {
  umask: string;
  argv: string[];
  env: Map<string, string>;
  stdin: string;
}

function parseFake(stdout: string): FakeOut {
  const [head = "", rest = ""] = stdout.split("---ENV---\n");
  const [envPart = "", stdin = ""] = rest.split("---STDIN---\n");
  const [umask = "", ...argv] = head.trimEnd().split("\n");
  const env = new Map<string, string>();
  for (const line of envPart.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) env.set(line.slice(0, at), line.slice(at + 1));
  }
  return { umask, argv, env, stdin };
}

/** Copies of the scripts with CELL_NODE rewritten to a fake that prints argv. */
function makeSandbox(): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cell-image-"));
  const home = path.join(dir, "home");
  const planted = path.join(dir, "planted");
  const marker = path.join(dir, "planted-ran");
  fs.mkdirSync(home);
  fs.mkdirSync(planted);
  const fakeNode = path.join(dir, "fake-node");
  fs.writeFileSync(fakeNode, FAKE_NODE, { mode: 0o755 });
  for (const cmd of PLANTED_COMMANDS) {
    fs.writeFileSync(
      path.join(planted, cmd),
      `#!/bin/bash\ntouch ${marker}\n`,
      { mode: 0o755 },
    );
  }
  let copies = 0;
  const copy = (rel: string, edit = (s: string) => s) => {
    const out = path.join(dir, `${copies++}-${path.basename(rel)}`);
    fs.writeFileSync(out, edit(read(rel).split(CELL_NODE).join(fakeNode)));
    return out;
  };
  return {
    dir,
    copy,
    home,
    fakeNode,
    planted,
    marker,
    entry: copy(ENTRY),
    send: copy(SEND),
  };
}

/** One sandbox per describe, its temp dir removed afterwards. */
function useSandbox(): Sandbox {
  const sb = makeSandbox();
  afterAll(() => fs.rmSync(sb.dir, { recursive: true, force: true }));
  return sb;
}

/** `undefined` in extraEnv removes the name. */
const run = (
  sb: Sandbox,
  script: string,
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
) => {
  const env: Record<string, string | undefined> = {
    PATH: `${sb.planted}:/usr/bin:/bin`,
    HOME: sb.home,
    ...extraEnv,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return spawnSync(BASH, [script, ...args], {
    encoding: "utf8",
    input: "",
    env: env as Record<string, string>,
  });
};

const GOOD_URL = "https://broker.example.org";
const outputOf = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;

/** Names bash hands to children although they are not shell identifiers. */
const NON_IDENTIFIER_NAMES = ["npm_config_//r.org/:_authToken", "X.Y_TOKEN"];

describeRun("cell-entry.sh behaviour (fake node)", () => {
  const sb = useSandbox();

  // card: protects=the entry execs the daemon with exactly the contract argv, by absolute path, and ignores planted commands first on PATH; fails_when=the argv differs or a planted command runs; no_claim=the real daemon
  it("execs the fake node with the contract argv and never a planted command", () => {
    const r = run(sb, sb.entry, ["--url", GOOD_URL]);
    expect(r.status).toBe(0);
    expect(parseFake(r.stdout).argv).toEqual([
      CELL_DAEMON_BUNDLE,
      "--url",
      GOOD_URL,
      "--socket-path",
      `${sb.home}/.automata-run/daemon.sock`,
    ]);
    expect(CELL_DAEMON_SOCKET).toBe("/home/agent/.automata-run/daemon.sock");
    expect(fs.existsSync(sb.marker)).toBe(false);
  });

  // card: protects=the planted-command trap is real; fails_when=a bare node, mkdir or base64 call under the same PATH does not reach the planted copy; no_claim=the real scripts
  it.each(["node x", "mkdir x", "base64 x"])(
    "negative control: a bare `%s` WOULD reach the planted command",
    (cmd) => {
      const bare = path.join(sb.dir, "bare.sh");
      fs.writeFileSync(bare, `#!/bin/bash\n${cmd}\n`, { mode: 0o755 });
      run(sb, bare, []);
      expect(fs.existsSync(sb.marker)).toBe(true);
      fs.rmSync(sb.marker);
    },
  );

  // card: protects=the run and shim dirs are private and the process umask is untouched; fails_when=the dirs are not 0700 or the daemon inherits a changed umask; no_claim=ownership in a cell
  it("creates 0700 run and shim dirs and leaves the umask unchanged", () => {
    const r = run(sb, sb.entry, ["--url", GOOD_URL]);
    const mask = Number.parseInt(parseFake(r.stdout).umask, 8);
    expect(mask).toBe(process.umask());
    for (const d of [".automata-run", ".automata-run/flutter-pin"]) {
      expect(fs.statSync(path.join(sb.home, d)).mode & 0o777).toBe(0o700);
    }
  });

  // card: protects=only https + lowercase host[:port] becomes a daemon flag; fails_when=a bad URL or argv shape does not exit 64; no_claim=DNS or reachability
  it.each([
    ["http scheme", ["--url", "http://broker.example.org"]],
    ["uppercase host", ["--url", "https://Broker.example.org"]],
    ["semicolon", ["--url", "https://a;b"]],
    ["space", ["--url", "https://a b"]],
    ["path", ["--url", "https://a.org/path"]],
    ["--url missing", ["https://a.org", "x"]],
    ["no args", []],
    ["extra argument", ["--url", GOOD_URL, "extra"]],
  ])("refuses a bad invocation with 64: %s", (_label, args) => {
    const r = run(sb, sb.entry, args);
    expect(r.status).toBe(CELL_ENTRY_EXIT.usage);
    expect(r.stdout).toBe("");
  });

  // card: protects=a HOME that is unset, empty, relative or missing stops the entry with its own code; fails_when=it starts or exits other than 66; no_claim=HOME contents
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["relative", "relative/dir"],
    ["missing dir", "/nonexistent-cell-home"],
  ])("refuses HOME %s with 66", (_label, home) => {
    const r = run(sb, sb.entry, ["--url", GOOD_URL], { HOME: home });
    expect(r.status).toBe(CELL_ENTRY_EXIT.noHome);
    expect(r.stdout).toBe("");
  });

  // card: protects=a credential-shaped env name stops the cell and its value is never echoed; fails_when=the entry starts, exits other than 78, or prints the canary; no_claim=the operator's docker.sandbox_env wiring
  it.each([
    "DAEMON_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "GH_TOKEN",
    "ANTHROPIC_API_KEY",
    "my_secret",
    "DB_PASSWORD",
    "AWS_REGION",
    "aws_region",
    "X_CREDENTIAL_FILE",
    "STRIPEAPIKEY",
    "SIGNING_KEY",
    "PRIVATE_DATA",
    "SSH_PASSPHRASE",
    "GH_AUTH",
    "OAUTH_CODE",
    "GITHUB_PAT",
    "SESSION_COOKIE",
    "DATABASE_URL",
  ])("refuses env %s with 78 and never echoes its value", (name) => {
    const canary = `canary-${Math.random().toString(36).slice(2)}`;
    const r = run(sb, sb.entry, ["--url", GOOD_URL], { [name]: canary });
    expect(r.status).toBe(CELL_ENTRY_EXIT.forbiddenEnv);
    expect(outputOf(r)).not.toContain(canary);
    expect(r.stderr).toContain(name);
    expect(isForbiddenCellEnvName(name)).toBe(true);
  });

  // card: protects=a credential name that is not a shell identifier is refused too; fails_when=the entry starts, exits other than 78 or echoes the canary; no_claim=names beyond these two
  it.each(NON_IDENTIFIER_NAMES)(
    "refuses non-identifier env %s with 78 and never echoes its value",
    (name) => {
      const canary = `canary-${Math.random().toString(36).slice(2)}`;
      const r = run(sb, sb.entry, ["--url", GOOD_URL], { [name]: canary });
      expect(r.status).toBe(CELL_ENTRY_EXIT.forbiddenEnv);
      expect(outputOf(r)).not.toContain(canary);
    },
  );

  // card: protects=the non-identifier test is not vacuous; fails_when=compgen -e lists such a name, or env does not; no_claim=the entry
  it("negative control: compgen -e misses what the child env carries", () => {
    for (const name of NON_IDENTIFIER_NAMES) {
      const env = { PATH: "/usr/bin:/bin", [name]: "v" };
      const probe = (cmd: string) =>
        spawnSync(BASH, ["-c", cmd], { encoding: "utf8", env }).stdout;
      expect(probe("compgen -e").split("\n")).not.toContain(name);
      expect(probe("/usr/bin/env")).toContain(`${name}=v`);
    }
  });

  // card: protects=the daemon starts under env -i with only vetted names; fails_when=an unlisted, non-credential name (SOME_PLAIN) reaches the daemon, FORCE_COLOR is dropped, or PATH/HOME change; no_claim=what the agent adds itself
  it("starts the daemon with only allowlisted and run-env names", () => {
    const plain = { SOME_PLAIN: "leak", FORCE_COLOR: "0" };
    const r = run(sb, sb.entry, ["--url", GOOD_URL], plain);
    expect(r.status).toBe(0);
    const { env } = parseFake(r.stdout);
    expect(env.has("SOME_PLAIN")).toBe(false);
    expect(env.get("FORCE_COLOR")).toBe("0");
    expect(env.get("HOME")).toBe(sb.home);
    expect(env.get("PATH")).toBe(`${sb.planted}:/usr/bin:/bin`);
    const shellAdded = new Set(["PWD", "SHLVL", "_", "OLDPWD"]);
    for (const name of env.keys()) {
      expect(CELL_DAEMON_ENV.includes(name) || shellAdded.has(name)).toBe(true);
    }
  });

  // card: protects=the env -i scrub is what drops the name; fails_when=the same run without env -i also hides SOME_PLAIN (so the test above proves nothing); no_claim=the real entry
  it("negative control: without env -i the unlisted name reaches the daemon", () => {
    let changed = false;
    const entry = sb.copy(ENTRY, (text) => {
      const edited = text.replace('/usr/bin/env -i "${keep[@]}" ', "");
      changed = edited !== text;
      return edited;
    });
    expect(changed).toBe(true);
    const r = run(sb, entry, ["--url", GOOD_URL], { SOME_PLAIN: "leak" });
    expect(parseFake(r.stdout).env.get("SOME_PLAIN")).toBe("leak");
  });

  // card: protects=the allowlist lets the platform's own names through and ordinary names start; fails_when=an allowlisted name or a run-env name is refused; no_claim=what the platform really sets
  it("starts with every allowlisted name set at once", () => {
    const all = Object.fromEntries(CELL_ENV_ALLOWLIST.map((n) => [n, "x"]));
    const r = run(sb, sb.entry, ["--url", GOOD_URL], {
      ...all,
      PATH: `${sb.planted}:/usr/bin:/bin`,
      HOME: sb.home,
    });
    expect(r.status).toBe(0);
    const plain = run(sb, sb.entry, ["--url", GOOD_URL], {
      FORCE_COLOR: "0",
      TOOL_FAILURE_STREAK_LIMIT: "5",
    });
    expect(plain.status).toBe(0);
  });

  // card: protects=an allowlist name cannot be smuggled by a name that spans two list entries; fails_when=a name made of adjacent allowlist names is kept or accepted; no_claim=other spacing tricks
  it("does not treat a name spanning two allowlist entries as allowed", () => {
    const name = "NODE_EXTRA_CA_CERTS REQUESTS_CA_BUNDLE";
    const r = run(sb, sb.entry, ["--url", GOOD_URL], { [name]: "v" });
    expect(r.status).toBe(0);
    expect(parseFake(r.stdout).env.has(name)).toBe(false);
  });

  // card: protects=the TS lists and the script's lists cannot drift apart; fails_when=allow, run_env or the pattern differ from their constants; no_claim=the batteries ENV names themselves
  it("keeps the script lists and pattern equal to the constants", () => {
    const text = read(ENTRY);
    const list = (key: string) =>
      (new RegExp(`^${key}="([^"]*)"$`, "m").exec(text)?.[1] ?? "")
        .split(/\s+/)
        .filter(Boolean);
    expect([...list("allow")].sort()).toEqual([...CELL_ENV_ALLOWLIST].sort());
    expect([...list("run_env")].sort()).toEqual([...CELL_RUN_ENV].sort());
    expect(new RegExp("^forbidden='(.*)'$", "m").exec(text)?.[1]).toBe(
      CELL_FORBIDDEN_ENV_PATTERN.source,
    );
    for (const n of CELL_ENV_ALLOWLIST) {
      expect(isForbiddenCellEnvName(n)).toBe(false);
    }
  });
});

describe("the forbidden env pattern", () => {
  // card: protects=no allowlisted or run-env name is itself credential-shaped; fails_when=the pattern matches an exempt or run-env name (it would be refused or hide a rename); no_claim=names the platform adds later
  it("matches nothing in the allowlist or the run env", () => {
    for (const n of [...CELL_ENV_ALLOWLIST, ...CELL_RUN_ENV]) {
      expect(CELL_FORBIDDEN_ENV_PATTERN.test(n)).toBe(false);
    }
  });

  // card: protects=the allowlist check can fail; fails_when=a credential-shaped name added to a fixture list is not caught; no_claim=the real list
  it("negative control: a credential-shaped fixture name is caught", () => {
    const fixture = [...CELL_ENV_ALLOWLIST, "GIT_AUTH_TOKEN"];
    expect(fixture.filter((n) => CELL_FORBIDDEN_ENV_PATTERN.test(n))).toEqual([
      "GIT_AUTH_TOKEN",
    ]);
  });

  // card: protects=the pattern is case-insensitive and anchored where it says; fails_when=a lowercase name is missed or _KEY matches mid-name; no_claim=every name
  it("matches case-insensitively and anchors _KEY$ and ^AWS_", () => {
    expect(CELL_FORBIDDEN_ENV_PATTERN.test("my_secret")).toBe(true);
    expect(CELL_FORBIDDEN_ENV_PATTERN.test("aws_region")).toBe(true);
    expect(CELL_FORBIDDEN_ENV_PATTERN.test("KEY_COUNT")).toBe(false);
    expect(CELL_FORBIDDEN_ENV_PATTERN.test("MY_AWS_REGION")).toBe(false);
  });
});

describeRun("cell-send.sh behaviour (fake node)", () => {
  const sb = useSandbox();

  // card: protects=a valid base64 argument reaches the daemon as decoded stdin with the contract argv; fails_when=the bytes or the argv differ or a planted command runs; no_claim=the real daemon write
  it("pipes the decoded message to node --write", () => {
    const msg = '{"type":"ping"}';
    const r = run(sb, sb.send, [Buffer.from(msg).toString("base64")]);
    expect(r.status).toBe(0);
    const out = parseFake(r.stdout);
    expect(out.argv).toEqual([
      CELL_DAEMON_BUNDLE,
      "--write",
      "--socket-path",
      `${sb.home}/.automata-run/daemon.sock`,
      "--timeout",
      "10000",
    ]);
    expect(out.stdin).toBe(msg);
    expect(fs.existsSync(sb.marker)).toBe(false);
  });

  // card: protects=anything but one base64 argument is refused before node runs; fails_when=a bad argument exits other than 64 or reaches node; no_claim=message size limits
  it.each([
    ["missing", []],
    ["empty", [""]],
    ["not base64", ["ab!c"]],
    ["space", ["ab cd"]],
    ["extra", ["YQ==", "YQ=="]],
  ])("refuses %s with 64", (_label, args) => {
    const r = run(sb, sb.send, args);
    expect(r.status).toBe(CELL_SEND_EXIT.usage);
    expect(r.stdout).toBe("");
  });

  // card: protects=the 128 KiB single-argument cap is enforced with its own code and equals the constant; fails_when=the script's max differs, an argument at the cap is refused, or one over it is accepted; no_claim=the kernel's own E2BIG
  it("enforces CELL_SEND_MAX_BYTES with exit 65", () => {
    expect(read(SEND)).toContain(`max=${CELL_SEND_MAX_BYTES}`);
    // A real message is base64, so its length is a multiple of 4: the largest
    // valid one under the cap. GNU base64 -d rejects an incomplete final group.
    const largestValid = CELL_SEND_MAX_BYTES - (CELL_SEND_MAX_BYTES % 4);
    const atCap = run(sb, sb.send, ["A".repeat(largestValid)]);
    expect(atCap.status).toBe(0);
    const over = run(sb, sb.send, ["A".repeat(CELL_SEND_MAX_BYTES + 1)]);
    // Linux refuses a 128 KiB argument itself (E2BIG) before the script runs.
    const refused =
      over.status === CELL_SEND_EXIT.tooLarge ||
      (over.error as NodeJS.ErrnoException | undefined)?.code === "E2BIG";
    expect(refused).toBe(true);
    // On Linux the kernel refuses the spawn itself (E2BIG), so there is no stdout at all.
    expect(over.stdout ?? "").toBe("");
  });
});

describe("cellEntrypoint", () => {
  // card: protects=the provider entrypoint argv PR-E consumes; fails_when=the argv shape changes; no_claim=the host being the deployment's
  it("returns the exact argv for a host", () => {
    expect(cellEntrypoint("broker.example.org")).toEqual([
      CELL_ENTRY,
      "--url",
      "https://broker.example.org",
    ]);
  });

  const HOSTS: [string, boolean][] = [
    ["example.org", true],
    ["a", true],
    ["localhost:3000", true],
    ["my-app.example.workers.dev", true],
    ["", false],
    ["Example.org", false],
    ["-a.org", false],
    ["a.org-", false],
    ["a b", false],
    ["x;y", false],
    ["a.org/", false],
    ["a.org:12345678", false],
  ];

  // card: protects=a bad host fails in the worker, not in a cell, and the host regex and cellEntrypoint agree; fails_when=a host is accepted by one and refused by the other, or a bad one is accepted; no_claim=hosts beyond this table
  it.each(HOSTS)("accepts or refuses %j consistently", (host, ok) => {
    expect(CELL_BROKER_HOST_PATTERN.test(host)).toBe(ok);
    if (ok) expect(cellEntrypoint(host)).toHaveLength(3);
    else expect(() => cellEntrypoint(host)).toThrow();
  });

  describeRun("against cell-entry.sh", () => {
    const sb = useSandbox();

    // card: protects=the script's host check agrees with the TS one; fails_when=the script accepts what the regex refuses or the reverse; no_claim=hosts beyond this table
    it.each(HOSTS)("the script agrees on %j", (host, ok) => {
      const r = run(sb, sb.entry, ["--url", `https://${host}`]);
      expect(r.status).toBe(ok ? 0 : CELL_ENTRY_EXIT.usage);
    });
  });
});

describe("CELL_ENV_ALLOWLIST and the batteries image", () => {
  /** Names the allowlist takes from elsewhere than the batteries ENV. */
  const NOT_FROM_BATTERIES = [
    "OPENSANDBOX_ID",
    "OPENSANDBOX_EGRESS_MITMPROXY_TRANSPARENT",
    "NODE_EXTRA_CA_CERTS",
    "REQUESTS_CA_BUNDLE",
    "SSL_CERT_FILE",
    "OPENSANDBOX_MERGED_CA_PATH",
    "GIT_SSL_CAINFO",
  ];
  const batteriesEnv = (dockerfile: string) =>
    instructionsOf(dockerfile)
      .filter((i) => i.op === "ENV")
      .flatMap((i) => envPairs(i.args).map(([name]) => name))
      .sort();
  const fromBatteries = (list: readonly string[]) =>
    list.filter((n) => !NOT_FROM_BATTERIES.includes(n)).sort();

  // card: protects=the allowlist's batteries names are exactly the batteries image's ENV names; fails_when=the batteries Dockerfile adds, renames or drops an ENV and the allowlist is not updated; no_claim=env set at run time
  it("matches the ENV names of the batteries Dockerfile", () => {
    expect(fromBatteries(CELL_ENV_ALLOWLIST)).toEqual(
      batteriesEnv(read(BATTERIES_DOCKERFILE)),
    );
  });

  // card: protects=the parity check can fail; fails_when=a batteries ENV missing from the allowlist, or an extra one, passes; no_claim=the real Dockerfile
  it("negative control: a new or missing ENV name is caught", () => {
    const real = read(BATTERIES_DOCKERFILE);
    expect(batteriesEnv(`${real}\nENV NEW_BATTERIES_NAME=1\n`)).not.toEqual(
      fromBatteries(CELL_ENV_ALLOWLIST),
    );
    expect(
      fromBatteries(CELL_ENV_ALLOWLIST.filter((n) => n !== "MCP_TIMEOUT")),
    ).not.toEqual(batteriesEnv(real));
  });
});

/** Text of one top-level job under `jobs:`. */
function jobBlock(workflow: string, name: string): string {
  const after = workflow.split(new RegExp(`^ {2}${name}:\\n`, "m"))[1] ?? "";
  return after.split(/^ {2}[\w-]+:\n/m)[0] ?? "";
}

/**
 * Steps of a job or composite action, as raw text blocks. The worker package
 * carries no YAML parser, and both files are regular (`      - ` or `    - `
 * steps), so the checks read the blocks directly.
 */
function stepsOf(text: string, indent: number): string[] {
  const dash = new RegExp(`^ {${indent}}- `, "m");
  const start = text.search(new RegExp(`^ {${indent - 2}}steps:\\n`, "m"));
  return text
    .slice(start)
    .split(dash)
    .slice(1)
    .map((s) => s.trimEnd());
}

const stepIndex = (steps: string[], needle: string) =>
  steps.findIndex((s) => s.includes(needle));

const PIN = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;
const LOCAL_ACTION = "./.github/actions/cell-image-build";

describe("cell-image.yml and its build action", () => {
  const workflow = read(WORKFLOW);
  const action = read(ACTION);
  const buildVerify = jobBlock(workflow, "build-verify");
  const publish = jobBlock(workflow, "publish");
  const actionSteps = stepsOf(action, 4);
  const publishSteps = stepsOf(publish, 6);

  // card: protects=no dependency lifecycle script runs in the build action that publish runs with write permissions (Automata #666); fails_when=an install in the action drops --ignore-scripts; no_claim=that the daemon build needs no script (the PR's build-verify run proves that)
  it("installs with --ignore-scripts in the shared build action", () => {
    const installs = action
      .split("\n")
      .filter((l) => /\bpnpm install\b/.test(l));
    expect(installs.length).toBeGreaterThan(0);
    for (const l of installs) expect(l).toContain("--ignore-scripts");
    // Negative control: the check itself rejects an install without the flag.
    expect("pnpm install --frozen-lockfile").not.toContain("--ignore-scripts");
  });

  // card: protects=every main commit gets its own concurrency group, so no publish is skipped (Automata #666); fails_when=main shares a ref-wide group again; no_claim=GitHub's queueing itself
  it("groups main runs per commit and PR runs per ref", () => {
    expect(workflow).toContain(
      "group: cell-image-${{ github.event_name == 'pull_request' && github.ref || github.sha }}",
    );
    expect(workflow).toContain(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    );
    expect(workflow).not.toMatch(/group: cell-image-\$\{\{ github\.ref \}\}/);
  });

  // card: protects=every third-party action is pinned by full commit sha; fails_when=a uses: carries a tag or branch (only the repo's own cell-image-build action is local); no_claim=that the sha exists upstream
  it("pins every action by a 40-hex sha", () => {
    const uses = [...(workflow + action).matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)]
      .map((m) => m[1] ?? "")
      .filter((u) => u !== LOCAL_ACTION);
    expect(uses.length).toBeGreaterThanOrEqual(5);
    for (const u of uses) expect(u).toMatch(PIN);
  });

  // card: protects=the pin check refuses a floating tag or another local action; fails_when=@v4, @main or ./other is accepted; no_claim=the real workflow
  it("negative control: a floating tag does not pass the pin pattern", () => {
    expect(PIN.test("actions/checkout@v4")).toBe(false);
    expect(PIN.test("actions/checkout@main")).toBe(false);
    expect(
      PIN.test("actions/checkout@11d5960a326750d5838078e36cf38b85af677262"),
    ).toBe(true);
    expect("./.github/actions/other").not.toBe(LOCAL_ACTION);
  });

  // card: protects=neither job can hang a runner for more than the batteries budget; fails_when=timeout-minutes is not 90 in both jobs; no_claim=a measured build time
  it("has timeout-minutes 90 in both jobs", () => {
    for (const job of [buildVerify, publish]) {
      expect(job).toMatch(/^ {4}timeout-minutes: 90$/m);
    }
  });

  // card: protects=the job every PR runs holds no registry or signing permission; fails_when=build-verify gains packages, id-token or attestations write, or any push/login/attest step; no_claim=repo-level token defaults
  it("gives build-verify read-only permissions and no publishing step", () => {
    const perms = /^ {4}permissions:\n((?: {6}.+\n)+)/m.exec(buildVerify)?.[1];
    expect(perms?.trim()).toBe("contents: read");
    expect(
      workflow.match(/^permissions:\n {2}contents: read$/m),
    ).not.toBeNull();
    expect(buildVerify).not.toMatch(/login-action|docker push|attest-build/);
    expect(buildVerify).not.toContain("secrets.");
  });

  // card: protects=the permission check can fail; fails_when=a build-verify fixture with packages: write is not flagged; no_claim=the real workflow
  it("negative control: the read-only check flags a write permission", () => {
    const bad =
      "  build-verify:\n    permissions:\n      contents: read\n      packages: write\n";
    const perms = /^ {4}permissions:\n((?: {6}.+\n)+)/m.exec(bad)?.[1];
    expect(perms?.trim()).not.toBe("contents: read");
  });

  // card: protects=publishing runs only off a PR on main and is the only holder of the write permissions, and verifies what it pushes itself; fails_when=the if differs, a write permission is missing or elsewhere, or publish skips the shared verify action; no_claim=branch protection
  it("gates publish on main and a non-PR event, with the write permissions", () => {
    expect(publish).not.toMatch(/^ {4}needs:/m);
    expect(publish).toContain(
      "if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'",
    );
    expect(publish).toContain(`uses: ${LOCAL_ACTION}`);
    for (const p of [
      "packages: write",
      "id-token: write",
      "attestations: write",
    ]) {
      expect(publish).toContain(p);
      expect(buildVerify).not.toContain(p);
    }
  });

  // card: protects=build-verify and publish never both run for one event; fails_when=build-verify's if is not the complement of publish's; no_claim=dispatch from other refs
  it("runs build-verify exactly when publish does not", () => {
    expect(buildVerify).toContain(
      "if: github.event_name == 'pull_request' || github.ref != 'refs/heads/main'",
    );
  });

  // card: protects=both jobs run the same shared build action and the checkout leaves no token; fails_when=a job lacks the local action, or a checkout lacks persist-credentials: false; no_claim=other credential paths
  it("uses the shared action in both jobs with persist-credentials false", () => {
    for (const job of [buildVerify, publish]) {
      expect(job).toContain(`uses: ${LOCAL_ACTION}`);
      expect(job).toMatch(
        /actions\/checkout@[0-9a-f]{40}.*\n\s+with:\n\s+persist-credentials: false/,
      );
    }
  });

  // card: protects=the context scan, build, verify and layer scan run in that order inside the shared action; fails_when=any is missing or out of order, or the layer scan does not use the sha256-checked gitleaks; no_claim=gitleaks findings
  it("scans the context, builds, verifies, then scans the layers", () => {
    const download = stepIndex(actionSteps, "sha256sum -c");
    const ctxScan = stepIndex(actionSteps, 'gitleaks" dir');
    const build = stepIndex(actionSteps, "docker buildx build");
    const verify = stepIndex(actionSteps, "cell/verify.sh");
    const layers = stepIndex(actionSteps, "cell/scan-layers.sh");
    expect(download).toBeGreaterThan(-1);
    expect(ctxScan).toBe(download);
    expect(build).toBeGreaterThan(ctxScan);
    expect(verify).toBeGreaterThan(build);
    expect(layers).toBeGreaterThan(verify);
    expect(actionSteps[ctxScan]).toContain('"$RUNNER_TEMP/cell-ctx"');
    expect(actionSteps[ctxScan]).toContain("--redact");
    expect(actionSteps[layers]).toContain(
      'scan-layers.sh automata-cell:ci "$RUNNER_TEMP/gitleaks"',
    );
  });

  // card: protects=publish only logs in, pushes and attests after the verified build; fails_when=login, push or attest comes before the shared action, or attest is not tied to the push; no_claim=registry state
  it("publishes only after the shared build, and attests the pushed digest", () => {
    const build = stepIndex(publishSteps, LOCAL_ACTION);
    const login = stepIndex(publishSteps, "docker/login-action");
    const push = stepIndex(publishSteps, 'docker push "$tag"');
    const attest = stepIndex(publishSteps, "attest-build-provenance");
    expect(build).toBeGreaterThan(-1);
    expect(login).toBeGreaterThan(build);
    expect(push).toBeGreaterThan(login);
    expect(attest).toBeGreaterThan(push);
    const attestStep = publishSteps[attest] ?? "";
    expect(attestStep).toContain("if: steps.push.outcome == 'success'");
    expect(attestStep).toContain(
      "subject-digest: ${{ steps.push.outputs.digest }}",
    );
  });

  // card: protects=the box gets a digest reference to pin; fails_when=the summary does not name OPENSANDBOX_GUEST_IMAGE with the digest; no_claim=the registry contents
  it("writes OPENSANDBOX_GUEST_IMAGE=<image>@<digest> to the summary", () => {
    expect(workflow).toContain(
      'echo "OPENSANDBOX_GUEST_IMAGE=${IMAGE}@${digest}"',
    );
    expect(workflow).toContain("IMAGE: ghcr.io/be-automata/automata-cell");
  });

  // card: protects=a change to anything the bundle is built from triggers the build on push and PR; fails_when=a listed path is missing from the push filter, or the PR filter is not the same list; no_claim=transitive dependencies beyond these
  it("filters paths on everything the image is built from", () => {
    const on = workflow.split(/^permissions:/m)[0] ?? "";
    const [push = "", pr = ""] = on.split(/^ {2}pull_request:/m);
    for (const p of [
      "deploy/images/cell/**",
      ".github/actions/cell-image-build/**",
      "packages/daemon/**",
      "packages/agent/**",
      "packages/tsconfig/**",
      "package.json",
      "pnpm-workspace.yaml",
      ".npmrc",
      "pnpm-lock.yaml",
      ".github/workflows/cell-image.yml",
    ]) {
      expect(push).toContain(`"${p}"`);
    }
    // One list, shared by an anchor: the PR trigger cannot drift from push.
    expect(push).toContain("paths: &paths");
    expect(pr).toMatch(/^ {4}paths: \*paths$/m);
    expect(on).toContain("workflow_dispatch:");
  });

  // card: protects=pnpm downloads are cached in the shared build action; fails_when=setup-node loses cache: pnpm; no_claim=cache hit rate
  it("caches pnpm in setup-node", () => {
    const node =
      actionSteps[stepIndex(actionSteps, "actions/setup-node")] ?? "";
    expect(node).toContain("cache: pnpm");
  });

  // card: protects=no secret or credential-shaped name in the build args; fails_when=the build passes any build-arg but REVISION or reads secrets.*; no_claim=repo secrets config
  it("passes no credential-shaped build arg", () => {
    const buildStep =
      actionSteps[stepIndex(actionSteps, "docker buildx build")] ?? "";
    expect(buildStep.match(/--build-arg\s+"?(\w+)/g)).toEqual([
      '--build-arg "REVISION',
    ]);
    expect(action).not.toContain("secrets.");
  });
});

// ---- #656 PR-E: the constants the cell executor consumes -----------------------

const HARNESS = "packages/sandbox/src/providers/opensandbox-it/harness.ts";

describe("CELL_SELF_CHECK_ARGV (the copy of the harness's argv)", () => {
  /** The harness's SELF_CHECK_ARGV array, read as TEXT (no import: sandbox never loads worker code). */
  function harnessArgv(): string[] {
    const text = read(HARNESS);
    const start = text.indexOf("export const SELF_CHECK_ARGV");
    expect(start).toBeGreaterThan(-1);
    const open = text.indexOf("= [", start);
    const end = text.indexOf("\n];", open);
    const body = text.slice(open + 2, end + 3);
    // The literal is a plain array of strings and one `[...].join("\n")`.
    // eslint-disable-next-line no-new-func -- evaluates the repo's own constant literal, in a test
    return new Function(`return ${body};`)() as string[];
  }

  // card: protects=the worker's self-check argv equals the harness's after python3 is made absolute; fails_when=either side's probe text drifts; no_claim=the probe's behaviour in a live cell (IT-E1)
  it("equals the harness's argv once argv[0] is normalised", () => {
    const theirs = harnessArgv();
    expect(theirs[0]).toBe("python3");
    const normalised = [
      theirs[0] === "python3" ? "/usr/bin/python3" : (theirs[0] ?? ""),
      ...theirs.slice(1),
    ];
    expect([...CELL_SELF_CHECK_ARGV]).toEqual(normalised);
  });

  // card: protects=the sync test can fail; fails_when=a changed probe text still compares equal; no_claim=anything about the harness
  it("negative control: a different probe text does not compare equal", () => {
    const changed = [...CELL_SELF_CHECK_ARGV];
    changed[2] = (changed[2] ?? "").replace("example.org", "example.com");
    expect(changed).not.toEqual([...CELL_SELF_CHECK_ARGV]);
    expect(harnessArgv()[2]).toBe(CELL_SELF_CHECK_ARGV[2]);
  });
});

describe("CELL_WRITE_MESSAGE_SH", () => {
  const sb = useSandbox();

  // card: protects=the message goes to the daemon on stdin from a staged file and the file is removed; fails_when=the argv carries more than the path, the file stays, or stdin is not the file; no_claim=the real daemon's socket write
  it("feeds the file to the daemon bundle's --write and removes it", () => {
    const dir = path.join(sb.dir, "run");
    fs.mkdirSync(dir);
    const script = CELL_WRITE_MESSAGE_SH.split(CELL_NODE)
      .join(sb.fakeNode)
      .split(CELL_MESSAGE_DIR)
      .join(dir);
    const file = path.join(dir, "msg.json");
    fs.writeFileSync(file, '{"type":"ping"}');
    const r = spawnSync("/bin/bash", ["-c", script, "cell-write", file], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const out = parseFake(r.stdout);
    expect(out.argv).toEqual([
      CELL_DAEMON_BUNDLE,
      "--write",
      "--socket-path",
      CELL_DAEMON_SOCKET.split(CELL_MESSAGE_DIR).join(dir),
      "--timeout",
      "10000",
    ]);
    expect(out.stdin).toBe('{"type":"ping"}');
    expect(fs.existsSync(file)).toBe(false);
  });

  // card: protects=a path outside the message dir is refused and nothing is removed; fails_when=the script writes or deletes a file it was not staged; no_claim=symlink races inside the dir
  it("refuses a path outside the message dir (exit 64) and keeps the file", () => {
    const outside = path.join(sb.dir, "victim");
    fs.writeFileSync(outside, "keep");
    const r = spawnSync(
      "/bin/bash",
      [
        "-c",
        CELL_WRITE_MESSAGE_SH.split(CELL_NODE).join(sb.fakeNode),
        "cell-write",
        outside,
      ],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(64);
    expect(fs.readFileSync(outside, "utf8")).toBe("keep");
  });

  // card: protects=the script names no credential and is bash-clean; fails_when=a token env or a bare command word appears; no_claim=runtime
  it("has no credential and resolves node by absolute path", () => {
    expect(CELL_WRITE_MESSAGE_SH).toContain(CELL_NODE);
    expect(CELL_WRITE_MESSAGE_SH).not.toMatch(CELL_FORBIDDEN_ENV_PATTERN);
    const r = spawnSync("/bin/bash", ["-n", "-c", CELL_WRITE_MESSAGE_SH], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
  });
});

describe("cellCloneArgv and cellGitConfigArgv (T-CLONE, argv half)", () => {
  const base = {
    brokerHost: "automata.example.org",
    repoFullName: "acme/widgets",
    branch: "main",
  };

  // card: protects=the clone goes through the broker route with no credential and checks out the run's branch; fails_when=the URL carries userinfo or a token, or the branch flag is lost; no_claim=git's behaviour against the broker (UAT)
  it("clones through the broker route with no credential", () => {
    expect(cellCloneArgv(base)).toEqual([
      [
        "git",
        "clone",
        "--no-tags",
        "--branch",
        "main",
        "https://automata.example.org/api/cell/git/acme/widgets.git",
        CELL_WORKSPACE,
      ],
    ]);
    expect(JSON.stringify(cellCloneArgv(base))).not.toMatch(/@|token|bearer/i);
  });

  // card: protects=a work branch and a base branch add exactly the two fixed argvs, the checkout as a fixed script with the ref positional; fails_when=the order changes, either is dropped or the ref is spliced into the script; no_claim=git's behaviour (the next test runs the script)
  it("adds the work-branch checkout script and fetch for a base branch", () => {
    expect(
      cellCloneArgv({ ...base, workBranch: "fix/x", baseBranch: "dev" }).slice(
        1,
      ),
    ).toEqual([
      ["/bin/bash", "-c", CELL_CHECKOUT_WORK_BRANCH_SH, "workbranch", "fix/x"],
      ["git", "-C", CELL_WORKSPACE, "fetch", "origin", "dev"],
    ]);
    expect(CELL_CHECKOUT_WORK_BRANCH_SH).not.toContain("fix/x");
    expect(cellCloneArgv({ ...base }).length).toBe(1);
  });

  // card: protects=an existing remote work branch is continued and a missing one starts from the checkout, like the box; fails_when=either case checks out the wrong commit; no_claim=the broker or the dind's git
  it("the checkout script continues origin/<ref> when it exists, else branches from head", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cell-checkout-"));
    try {
      const git = (cwd: string, ...a: string[]) =>
        spawnSync("git", a, { cwd, encoding: "utf8" });
      const seed = path.join(dir, "seed");
      fs.mkdirSync(seed);
      const g = (...a: string[]) =>
        git(seed, "-c", "user.name=t", "-c", "user.email=t@t", ...a);
      g("init", "-q", "-b", "main");
      fs.writeFileSync(path.join(seed, "f"), "1");
      g("add", "f");
      g("commit", "-qm", "base");
      g("checkout", "-qb", "fix/x");
      fs.writeFileSync(path.join(seed, "f"), "2");
      g("commit", "-qam", "earlier push");
      g("checkout", "-q", "main");
      const remote = path.join(dir, "remote.git");
      git(dir, "clone", "-q", "--bare", seed, remote);
      const head = (cwd: string) => git(cwd, "rev-parse", "HEAD").stdout.trim();
      const run = (ref: string) => {
        const ws = path.join(dir, `ws-${ref.replace(/\W/g, "_")}`);
        git(dir, "clone", "-q", "--no-tags", "--branch", "main", remote, ws);
        const script =
          CELL_CHECKOUT_WORK_BRANCH_SH.split(CELL_WORKSPACE).join(ws);
        const r = spawnSync("/bin/bash", ["-c", script, "workbranch", ref], {
          encoding: "utf8",
        });
        expect(r.status, r.stderr).toBe(0);
        return {
          ws,
          branch: git(ws, "branch", "--show-current").stdout.trim(),
        };
      };
      const existing = run("fix/x");
      expect(existing.branch).toBe("fix/x");
      expect(head(existing.ws)).toBe(
        git(remote, "rev-parse", "fix/x").stdout.trim(),
      );
      const fresh = run("fix/new");
      expect(fresh.branch).toBe("fix/new");
      expect(head(fresh.ws)).toBe(
        git(remote, "rev-parse", "main").stdout.trim(),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // card: protects=an owner with a slash, an option-shaped ref and a bad host are refused before any exec; fails_when=any of them reaches an argv; no_claim=refs git itself would reject
  it("refuses an unsafe owner, repo, ref or host", () => {
    for (const repoFullName of [
      "a/b/c",
      "a/../b",
      "../x",
      "acme",
      "ac me/w",
      "/w",
    ]) {
      expect(() => cellCloneArgv({ ...base, repoFullName })).toThrow();
    }
    expect(() =>
      cellCloneArgv({ ...base, branch: "--upload-pack=x" }),
    ).toThrow();
    expect(() => cellCloneArgv({ ...base, workBranch: "-B" })).toThrow();
    expect(() => cellCloneArgv({ ...base, baseBranch: "a..b" })).toThrow();
    expect(() => cellCloneArgv({ ...base, brokerHost: "Evil;host" })).toThrow();
  });

  // card: protects=the repo-local bot identity replaces the box's GIT_CONFIG env; fails_when=the identity differs from botGitIdentity or the config is global; no_claim=commit authorship in a live cell
  it("sets the repo-local bot identity", () => {
    expect(cellGitConfigArgv("automata-bot")).toEqual([
      ["git", "-C", CELL_WORKSPACE, "config", "user.name", "automata-bot"],
      [
        "git",
        "-C",
        CELL_WORKSPACE,
        "config",
        "user.email",
        "automata-bot@users.noreply.github.com",
      ],
    ]);
  });
});

describe("the cell layer scan's gitleaks config", () => {
  const SCAN = "deploy/images/cell/scan-layers.sh";
  const CONFIG = "deploy/images/cell/gitleaks-layers.toml";
  const MSVC_PATH =
    "usr/lib/python3/dist-packages/setuptools/_distutils/msvccompiler\\.py$";
  const ALIAS_LINE = "^\\s*Reg\\w+\\s*=\\s*win32api\\.Reg\\w+\\s*$";
  const toml = read(CONFIG);
  // The TOML minus comments and blank lines, so the checks read only settings.
  const settings = toml
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  const literals = (key: string) =>
    settings
      .filter((l) => l.startsWith(`${key} =`))
      .map((l) => [...l.matchAll(/'''(.*?)'''/g)].map((m) => m[1]));

  // card: protects=the layer scan runs with the config, redacted, exactly once; fails_when=--config or --redact is dropped, or a second unconfigured gitleaks call is added; no_claim=what gitleaks finds
  it("scan-layers.sh passes the config to its only gitleaks call", () => {
    const calls = read(SCAN)
      .split("\n")
      .filter((l) => l.includes('"$gitleaks" dir'));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(
      '--config "$(dirname "$0")/gitleaks-layers.toml"',
    );
    expect(calls[0]).toContain("--redact");
  });

  // card: protects=the config keeps every default rule and holds exactly one AND allowlist (one path, one line regex); fails_when=useDefault goes, a rule/stopword/commit allowlist or a second allowlist is added, the condition becomes OR, or the path or regex widens; no_claim=gitleaks' own matching
  it("keeps the default rules and one narrow AND allowlist", () => {
    expect(settings).toEqual([
      "[extend]",
      "useDefault = true",
      "[[allowlists]]",
      expect.stringMatching(/^description = "/),
      'condition = "AND"',
      `paths = ['''${MSVC_PATH}''']`,
      'regexTarget = "line"',
      `regexes = ['''${ALIAS_LINE}''']`,
    ]);
    expect(literals("paths")).toEqual([[MSVC_PATH]]);
    expect(literals("regexes")).toEqual([[ALIAS_LINE]]);
  });

  // card: protects=the line regex allows only the win32api registry aliases; fails_when=it matches a credential-shaped line; no_claim=RE2 vs JS differences beyond \s and \w
  it("allows the alias lines and nothing credential-shaped", () => {
    const line = new RegExp(ALIAS_LINE);
    const msvc = new RegExp(MSVC_PATH);
    for (const ok of [
      "        RegOpenKeyEx = win32api.RegOpenKeyEx",
      "RegEnumValue = win32api.RegEnumValue",
    ]) {
      expect(line.test(ok)).toBe(true);
    }
    expect(
      msvc.test(
        "scan/layer-0/usr/lib/python3/dist-packages/setuptools/_distutils/msvccompiler.py",
      ),
    ).toBe(true);
  });

  // card: protects=negative control for the allowlist; fails_when=a widened regex or path would accept a real secret or another file; no_claim=every secret format
  it("negative control: a secret line or another file is not allowed", () => {
    const line = new RegExp(ALIAS_LINE);
    const msvc = new RegExp(MSVC_PATH);
    for (const bad of [
      'api_key = "sk-live-0123456789abcdef0123456789abcdef"',
      "RegOpenKeyEx = 'AKIAIOSFODNN7EXAMPLE'",
      "RegKey = win32api.RegOpenKeyEx; token = abc123",
    ]) {
      expect(line.test(bad)).toBe(false);
    }
    for (const other of [
      "usr/lib/python3/dist-packages/setuptools/_distutils/msvccompiler.py.bak",
      "home/agent/msvccompiler.py",
      "usr/lib/python3/dist-packages/setuptools/_distutils/other.py",
    ]) {
      expect(msvc.test(other)).toBe(false);
    }
  });
});

describe("cellGhSetup (#727 B)", () => {
  const base = {
    brokerHost: "www.example.org",
    repoFullName: "acme/widgets",
    botLogin: "automata-ai-bot[bot]",
  };

  // card: protects=gh's host login names the broker host with the non-secret placeholder only; fails_when=the token is anything but the placeholder or the host differs; no_claim=gh reading it (real-gh test)
  it("logs the broker host in with the placeholder", () => {
    expect(cellGhSetup(base).hostsYml).toBe(
      [
        "www.example.org:",
        "    oauth_token: automata-cell-gh-placeholder",
        '    user: "automata-ai-bot[bot]"',
        "    git_protocol: https",
        "",
      ].join("\n"),
    );
  });

  // card: protects=gh defaults to the broker host and the run's repo, since origin is the broker's git path; fails_when=GH_REPO lacks the host or names another repo; no_claim=the CLI applying the env block
  it("makes the broker host and the run's repo gh's defaults", () => {
    expect(cellGhSetup(base).env).toEqual({
      GH_HOST: "www.example.org",
      GH_REPO: "www.example.org/acme/widgets",
      GH_CONFIG_DIR: "/home/agent/.config/gh",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
    });
  });

  // card: protects=AC-7: no gh name is a credential name the entry refuses, and none is a GH_TOKEN-style variable; fails_when=a name matches the forbidden pattern; no_claim=cell-entry.sh itself
  it("sets no name the cell entry treats as a credential", () => {
    for (const name of Object.keys(cellGhSetup(base).env)) {
      expect(isForbiddenCellEnvName(name), name).toBe(false);
    }
  });

  // card: protects=nothing unvalidated reaches a YAML key or GH_REPO; fails_when=a bad host, repo or login is accepted; no_claim=none
  it("refuses a host, repo or login it will not write", () => {
    expect(() =>
      cellGhSetup({ ...base, brokerHost: "Evil.example\n" }),
    ).toThrow();
    expect(() => cellGhSetup({ ...base, brokerHost: "a b" })).toThrow();
    expect(() => cellGhSetup({ ...base, repoFullName: "acme/../x" })).toThrow();
    expect(() => cellGhSetup({ ...base, repoFullName: "acme" })).toThrow();
    expect(() =>
      cellGhSetup({ ...base, botLogin: "x\noauth_token: y" }),
    ).toThrow();
  });
});
