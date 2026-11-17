import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CONTAINER_DAEMON_BUNDLE } from "./container-argv";
import { CONTAINER_FLUTTER_SHIM_DIR } from "./container-entry";
import { parsePinnedImage } from "./container-image";
import {
  CELL_BROKER_HOST_PATTERN,
  CELL_CA_BUNDLE,
  CELL_DAEMON_SOCKET,
  CELL_ENTRY,
  CELL_ENTRY_EXIT,
  CELL_ENV_ALLOWLIST,
  CELL_NODE,
  CELL_SEND,
  cellEntrypoint,
  isForbiddenCellEnvName,
} from "./cell-image";

/**
 * The cell guest image (#656 PR-F): static checks of the Dockerfile and the
 * two baked scripts, and fake-node runs of the scripts. The real image build
 * and verify.sh run in the PR's cell-image workflow, not here.
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const CELL_DIR = "deploy/images/cell";
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

const DOCKERFILE = `${CELL_DIR}/Dockerfile`;
const ENTRY = `${CELL_DIR}/cell-entry.sh`;
const SEND = `${CELL_DIR}/cell-send.sh`;
const VERIFY = `${CELL_DIR}/verify.sh`;
const WORKFLOW = ".github/workflows/cell-image.yml";
const BATTERIES_REPOSITORY = "ghcr.io/be-automata/automata-batteries";
const FORBIDDEN_NAME = /TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|AUTH/i;
const PLACEHOLDER = "automata-cell-daemon-token";

/** Code lines only: comments state guarantees in prose. */
const codeOf = (text: string) =>
  text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

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
    .filter((name) => FORBIDDEN_NAME.test(name));
}

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

  // card: protects=no credential-shaped ARG/ENV, no ADD, no secret mount, no RUN in the image; fails_when=any of them appears; no_claim=layers of the base image
  it("holds no credential-shaped ARG/ENV and no ADD, secret or RUN", () => {
    expect(credentialShapedNames(dockerfile)).toEqual([]);
    expect(ins.some((i) => i.op === "ADD")).toBe(false);
    expect(ins.some((i) => i.op === "RUN")).toBe(false);
    expect(codeOf(dockerfile)).not.toContain("--secret");
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
    expect(dests).toEqual([CONTAINER_DAEMON_BUNDLE, CELL_ENTRY, CELL_SEND]);
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

describe.each([ENTRY, SEND, VERIFY])("%s: bash script hygiene", (rel) => {
  // card: protects=the script is executable, bash in strict mode, parses and is shellcheck clean; fails_when=it loses +x, strict mode, parses wrong or regresses shellcheck; no_claim=its behaviour in a cell
  it("is executable, strict, parses and is shellcheck clean", (ctx) => {
    const abs = path.join(repoRoot, rel);
    expect(fs.statSync(abs).mode & 0o777).toBe(0o755);
    const lines = read(rel).split("\n");
    expect(lines[0]).toBe("#!/bin/bash");
    expect(lines[1]).toBe("set -euo pipefail");
    expect(spawnSync("bash", ["-n", abs]).status).toBe(0);
    if (
      spawnSync("shellcheck", ["--version"], { stdio: "ignore" }).status !== 0
    ) {
      ctx.skip();
    }
    const r = spawnSync("shellcheck", ["-s", "bash", abs], {
      encoding: "utf8",
    });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  // card: protects=the script execs node by absolute path, never through the agent-writable PATH head; fails_when=it names CELL_NODE no more or has a bare node command word; no_claim=runtime resolution
  it("calls node only by its absolute path", () => {
    expect(codeOf(read(rel))).toContain(CELL_NODE);
    expect(bareNodeCalls(read(rel))).toBe(0);
  });
});

// card: protects=the bare-node detector fires; fails_when=a fixture with exec node or a piped node passes unflagged, or an absolute call is flagged; no_claim=the real scripts
it("negative control: bareNodeCalls flags a bare node, not an absolute one", () => {
  expect(bareNodeCalls("exec node a.js\n")).toBe(1);
  expect(bareNodeCalls("x | node a.js\n")).toBe(1);
  expect(bareNodeCalls("exec /usr/local/bin/node a.js\n")).toBe(0);
  expect(bareNodeCalls("# exec node a.js\n")).toBe(0);
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

interface Sandbox {
  dir: string;
  home: string;
  fakeNode: string;
  planted: string;
  marker: string;
  entry: string;
  send: string;
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
  fs.writeFileSync(fakeNode, '#!/bin/bash\numask\nprintf "%s\\n" "$@"\ncat\n', {
    mode: 0o755,
  });
  fs.writeFileSync(
    path.join(planted, "node"),
    `#!/bin/bash\ntouch ${marker}\n`,
    { mode: 0o755 },
  );
  const copy = (rel: string) => {
    const out = path.join(dir, path.basename(rel));
    fs.writeFileSync(out, read(rel).split(CELL_NODE).join(fakeNode));
    return out;
  };
  return {
    dir,
    home,
    fakeNode,
    planted,
    marker,
    entry: copy(ENTRY),
    send: copy(SEND),
  };
}

const run = (
  sb: Sandbox,
  script: string,
  args: string[],
  extraEnv: Record<string, string> = {},
) =>
  spawnSync(BASH, [script, ...args], {
    encoding: "utf8",
    input: "",
    env: {
      PATH: `${sb.planted}:/usr/bin:/bin`,
      HOME: sb.home,
      ...extraEnv,
    },
  });

const GOOD_URL = "https://broker.example.org";
const outputOf = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;

describeRun("cell-entry.sh behaviour (fake node)", () => {
  const sb = makeSandbox();

  // card: protects=the entry execs the daemon with exactly the contract argv, by absolute path, and ignores a planted node first on PATH; fails_when=the argv differs or the planted node runs; no_claim=the real daemon
  it("execs the fake node with the contract argv and never the planted node", () => {
    const r = run(sb, sb.entry, ["--url", GOOD_URL]);
    expect(r.status).toBe(0);
    const [, ...argv] = r.stdout.trim().split("\n");
    expect(argv).toEqual([
      CONTAINER_DAEMON_BUNDLE,
      "--url",
      GOOD_URL,
      "--socket-path",
      `${sb.home}/.automata-run/daemon.sock`,
    ]);
    expect(CELL_DAEMON_SOCKET).toBe("/home/agent/.automata-run/daemon.sock");
    expect(fs.existsSync(sb.marker)).toBe(false);
  });

  // card: protects=the planted-node trap is real; fails_when=a bare node call under the same PATH does not reach the planted node; no_claim=the real scripts
  it("negative control: a bare node call WOULD reach the planted node", () => {
    const bare = path.join(sb.dir, "bare.sh");
    fs.writeFileSync(bare, "#!/bin/bash\nnode x\n", { mode: 0o755 });
    run(sb, bare, []);
    expect(fs.existsSync(sb.marker)).toBe(true);
    fs.rmSync(sb.marker);
  });

  // card: protects=the run and shim dirs are private and the process umask is untouched; fails_when=the dirs are not 0700 or the daemon inherits a changed umask; no_claim=ownership in a cell
  it("creates 0700 run and shim dirs and leaves the umask unchanged", () => {
    const r = run(sb, sb.entry, ["--url", GOOD_URL]);
    const mask = Number.parseInt(r.stdout.split("\n")[0] ?? "", 8);
    const mine = process.umask();
    expect(mask).toBe(mine);
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

  // card: protects=a credential-shaped env name stops the cell and its value is never echoed; fails_when=the entry starts, exits other than 78, or prints the canary; no_claim=the operator's docker.sandbox_env wiring
  it.each([
    "DAEMON_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "GH_TOKEN",
    "ANTHROPIC_API_KEY",
    "my_secret",
    "DB_PASSWORD",
    "AWS_REGION",
    "X_CREDENTIAL_FILE",
  ])("refuses env %s with 78 and never echoes its value", (name) => {
    const canary = `canary-${Math.random().toString(36).slice(2)}`;
    const r = run(sb, sb.entry, ["--url", GOOD_URL], { [name]: canary });
    expect(r.status).toBe(CELL_ENTRY_EXIT.forbiddenEnv);
    expect(outputOf(r)).not.toContain(canary);
    expect(r.stderr).toContain(name);
    expect(isForbiddenCellEnvName(name)).toBe(true);
  });

  // card: protects=the allowlist lets the platform's own names through and ordinary names start; fails_when=an allowlisted name or FORCE_COLOR is refused; no_claim=what the platform really sets
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

  // card: protects=the TS allowlist and the script's allow list cannot drift apart; fails_when=they differ or an allowlisted name is judged forbidden; no_claim=the batteries ENV names themselves
  it("keeps the script allow list equal to CELL_ENV_ALLOWLIST", () => {
    const line = /^allow="([^"]*)"$/m.exec(read(ENTRY));
    const names = (line?.[1] ?? "").split(/\s+/).filter(Boolean);
    expect([...names].sort()).toEqual([...CELL_ENV_ALLOWLIST].sort());
    for (const n of CELL_ENV_ALLOWLIST) {
      expect(isForbiddenCellEnvName(n)).toBe(false);
    }
  });
});

describeRun("cell-send.sh behaviour (fake node)", () => {
  const sb = makeSandbox();

  // card: protects=a valid base64 argument reaches the daemon as decoded stdin with the contract argv; fails_when=the bytes or the argv differ; no_claim=the real daemon write
  it("pipes the decoded message to node --write", () => {
    const msg = '{"type":"ping"}';
    const r = run(sb, sb.send, [Buffer.from(msg).toString("base64")]);
    expect(r.status).toBe(0);
    const [, ...rest] = r.stdout.split("\n");
    expect(rest.slice(0, 6)).toEqual([
      CONTAINER_DAEMON_BUNDLE,
      "--write",
      "--socket-path",
      `${sb.home}/.automata-run/daemon.sock`,
      "--timeout",
      "10000",
    ]);
    expect(rest.slice(6).join("\n")).toBe(msg);
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
    expect(r.status).toBe(CELL_ENTRY_EXIT.usage);
    expect(r.stdout).toBe("");
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

  // card: protects=a bad host fails in the worker, not in a cell; fails_when=an empty, spaced or injected host is accepted; no_claim=the script's own check (see parity below)
  it.each(["", "a b", "x;y"])("throws on %j", (host) => {
    expect(() => cellEntrypoint(host)).toThrow();
  });

  const HOSTS: [string, boolean][] = [
    ["example.org", true],
    ["a", true],
    ["localhost:3000", true],
    ["my-app.example.workers.dev", true],
    ["Example.org", false],
    ["-a.org", false],
    ["a.org-", false],
    ["a b", false],
    ["x;y", false],
    ["a.org/", false],
    ["a.org:12345678", false],
  ];

  // card: protects=the TS host regex and the script's agree; fails_when=a host is accepted by one and refused by the other; no_claim=hosts beyond this table
  it.each(HOSTS)("agrees with the script on %j", (host, ok) => {
    expect(CELL_BROKER_HOST_PATTERN.test(host)).toBe(ok);
    expect(() => cellEntrypoint(host)).toSatisfy((fn: () => void) => {
      try {
        fn();
        return ok;
      } catch {
        return !ok;
      }
    });
    if (bashMajor < 4) return;
    const sb = makeSandbox();
    const r = run(sb, sb.entry, ["--url", `https://${host}`]);
    expect(r.status).toBe(ok ? 0 : CELL_ENTRY_EXIT.usage);
  });
});

/**
 * Steps of the single job, as raw text blocks. The worker package carries no
 * YAML parser, and the workflow is regular (one job, `      - ` steps), so the
 * checks read the blocks directly.
 */
function stepsOf(workflow: string): string[] {
  const body = workflow.split(/^ {4}steps:\n/m)[1] ?? "";
  return body
    .split(/^ {6}- /m)
    .slice(1)
    .map((s) => s.trimEnd());
}

const stepIndex = (steps: string[], needle: string) =>
  steps.findIndex((s) => s.includes(needle));

describe("cell-image.yml", () => {
  const workflow = read(WORKFLOW);
  const steps = stepsOf(workflow);

  // card: protects=every third-party action is pinned by full commit sha; fails_when=a uses: carries a tag or branch; no_claim=that the sha exists upstream
  it("pins every action by a 40-hex sha", () => {
    const uses = [...workflow.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map(
      (m) => m[1] ?? "",
    );
    expect(uses.length).toBeGreaterThanOrEqual(5);
    for (const u of uses) {
      expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
  });

  // card: protects=the pin check refuses a floating tag; fails_when=@v4 or @main is accepted; no_claim=the real workflow
  it("negative control: a floating tag does not pass the pin pattern", () => {
    const pinned = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;
    expect(pinned.test("actions/checkout@v4")).toBe(false);
    expect(pinned.test("actions/checkout@main")).toBe(false);
    expect(
      pinned.test("actions/checkout@11d5960a326750d5838078e36cf38b85af677262"),
    ).toBe(true);
  });

  // card: protects=the build cannot hang a runner for more than the batteries budget; fails_when=timeout-minutes is not 90; no_claim=a measured build time
  it("has timeout-minutes 90", () => {
    expect(workflow).toMatch(/^ {4}timeout-minutes: 90$/m);
  });

  // card: protects=the secret scan and verify.sh gate the push; fails_when=either comes after the first push, login or attest step; no_claim=gitleaks findings
  it("scans and verifies before any push", () => {
    const scan = stepIndex(steps, 'gitleaks" dir');
    const verify = stepIndex(steps, "cell/verify.sh");
    const firstPublish = Math.min(
      stepIndex(steps, "docker/login-action"),
      stepIndex(steps, 'docker push "$tag"'),
      stepIndex(steps, "attest-build-provenance"),
    );
    expect(scan).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(scan);
    expect(firstPublish).toBeGreaterThan(verify);
    expect(steps[scan]).toContain('"$RUNNER_TEMP/cell-ctx"');
    expect(steps[scan]).toContain("--redact");
  });

  // card: protects=publishing happens on main only; fails_when=login or push lacks the main guard, or attest is not tied to the push; no_claim=branch protection
  it("guards login and push by refs/heads/main and attest by the push", () => {
    for (const needle of ["docker/login-action", 'docker push "$tag"']) {
      const step = steps[stepIndex(steps, needle)] ?? "";
      expect(step).toContain("if: github.ref == 'refs/heads/main'");
    }
    const attest = steps[stepIndex(steps, "attest-build-provenance")] ?? "";
    expect(attest).toContain("if: steps.push.outcome == 'success'");
    expect(attest).toContain(
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

  // card: protects=the checkout leaves no token in .git/config; fails_when=persist-credentials is not false; no_claim=other credential paths
  it("sets persist-credentials: false on checkout", () => {
    const checkout = steps[stepIndex(steps, "actions/checkout")] ?? "";
    expect(checkout).toContain("persist-credentials: false");
  });

  // card: protects=a daemon, agent-dependency or image change triggers the build on push and PR; fails_when=packages/daemon or deploy/images/cell is missing from either trigger; no_claim=transitive dependencies beyond packages/agent
  it("filters paths on the daemon and the cell directory", () => {
    const on = workflow.split(/^permissions:/m)[0] ?? "";
    const triggers = on.split(/^ {2}pull_request:/m);
    expect(triggers).toHaveLength(2);
    for (const block of triggers) {
      expect(block).toContain('"packages/daemon/**"');
      expect(block).toContain('"deploy/images/cell/**"');
    }
    expect(on).toContain("workflow_dispatch:");
  });

  // card: protects=no secret or credential-shaped name in the workflow env; fails_when=an env/build-arg name matches the credential pattern outside GITHUB_TOKEN use; no_claim=repo secrets config
  it("passes no credential-shaped build arg", () => {
    const buildStep = steps[stepIndex(steps, "docker buildx build")] ?? "";
    expect(buildStep.match(/--build-arg\s+"?(\w+)/g)).toEqual([
      '--build-arg "REVISION',
    ]);
    expect(buildStep).not.toContain("secrets.");
  });
});
