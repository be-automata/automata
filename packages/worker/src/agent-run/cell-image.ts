import { CELL_GH_TOKEN_PLACEHOLDER } from "@terragon/types/cell";

import { CONTAINER_HOME } from "./container-argv";
import { botGitIdentity } from "./daemon-env";

/**
 * Constants of the cell guest image (deploy/images/cell, #656 PR-F). PR-E
 * consumes them to build the cell's entrypoint and exec argv. No I/O.
 */

export const CELL_ENTRY = "/opt/automata/cell-entry.sh";
export const CELL_SEND = "/opt/automata/cell-send.sh";
/**
 * The daemon bundle baked into the cell image. Not the box's mount path
 * (`CONTAINER_DAEMON_BUNDLE`, `/opt/automata-daemon/index.js`): a COPY into a new
 * directory leaves it unsearchable for uid 10001, so it lives in the base's
 * existing `/opt/automata`.
 */
export const CELL_DAEMON_BUNDLE = "/opt/automata/daemon.js";
export const CELL_NODE = "/usr/local/bin/node";
export const CELL_DAEMON_SOCKET = `${CONTAINER_HOME}/.automata-run/daemon.sock`;
export const CELL_CA_BUNDLE = `${CONTAINER_HOME}/.opensandbox/merged-ca-certificates.pem`;

/**
 * Exit codes of cell-entry.sh (sysexits): 64 bad arguments, 66 HOME missing or
 * not an absolute directory, 78 a forbidden env name. cell-send.sh exits 64
 * for a bad argument and 65 for one over CELL_SEND_MAX_BYTES.
 */
export const CELL_ENTRY_EXIT = {
  usage: 64,
  noHome: 66,
  forbiddenEnv: 78,
} as const;
export const CELL_SEND_EXIT = { usage: 64, tooLarge: 65 } as const;

/**
 * Longest single argv string cell-send.sh accepts: Linux caps one argument at
 * MAX_ARG_STRLEN (128 KiB including the NUL). PR-E caps or splits a message
 * whose base64 is longer.
 */
export const CELL_SEND_MAX_BYTES = 128 * 1024 - 1;

/**
 * Env names the entry refuses (case-insensitive), the AWS_ prefix included.
 * The script holds the same text in its `forbidden=` line (a test compares it
 * with this regex's `.source`).
 */
export const CELL_FORBIDDEN_ENV_PATTERN =
  /TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|APIKEY|_KEY$|PRIVATE|PASS|AUTH|_PAT$|COOKIE|DATABASE_URL|^AWS_/i;

/**
 * Names exempt from the refusal. Must equal the `allow` list in
 * cell-entry.sh (a test keeps them equal), and none may match the pattern.
 */
export const CELL_ENV_ALLOWLIST: readonly string[] = [
  // set by OpenSandbox
  "OPENSANDBOX_ID",
  "OPENSANDBOX_EGRESS_MITMPROXY_TRANSPARENT",
  // set by its bootstrap
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_FILE",
  // set by this image
  "OPENSANDBOX_MERGED_CA_PATH",
  "GIT_SSL_CAINFO",
  // set by the batteries image
  "DEBIAN_FRONTEND",
  "LANG",
  "LC_ALL",
  "PUB_CACHE",
  "FLUTTER_ROOT",
  "FLUTTER_SUPPRESS_ANALYTICS",
  "DART_SUPPRESS_ANALYTICS",
  "CI",
  "PATH",
  "SOMNIO_ROOT",
  "VENDOR_SKILLS_ROOT",
  "CLAUDE_PLUGIN_ROOT",
  "YTCTL",
  "PLAYWRIGHT_BROWSERS_PATH",
  "HOME",
  "GSTACK_SESSION_KIND",
  "ROBOREV_TELEMETRY_ENABLED",
  "MCP_TIMEOUT",
];

/**
 * Static, non-secret run env the operator may set (docker.sandbox_env). Not
 * exempt from the refusal; they simply do not match it.
 */
export const CELL_RUN_ENV: readonly string[] = [
  "FORCE_COLOR",
  "TOOL_FAILURE_STREAK_LIMIT",
];

/**
 * The only names the daemon starts with: the entry runs it under `env -i`
 * with these and nothing else (a test keeps the script's two lists equal to
 * the two constants above).
 */
export const CELL_DAEMON_ENV: readonly string[] = [
  ...CELL_ENV_ALLOWLIST,
  ...CELL_RUN_ENV,
];

/** The entry's rule: a credential-shaped name, unless it is allowlisted. */
export function isForbiddenCellEnvName(name: string): boolean {
  if (CELL_ENV_ALLOWLIST.includes(name)) return false;
  return CELL_FORBIDDEN_ENV_PATTERN.test(name);
}

/** The same shape cell-entry.sh accepts after `https://`. */
export const CELL_BROKER_HOST_PATTERN =
  /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?$/;

function assertBrokerHost(host: string): void {
  if (!CELL_BROKER_HOST_PATTERN.test(host)) {
    throw new Error(
      `cell broker host ${JSON.stringify(host)} is not a lowercase host[:port]`,
    );
  }
}

/**
 * The provider entrypoint for a deployment's broker host. Throws on a host the
 * entry would refuse, so a bad host fails in the worker, not in a cell.
 */
export function cellEntrypoint(brokerHost: string): string[] {
  assertBrokerHost(brokerHost);
  return [CELL_ENTRY, "--url", `https://${brokerHost}`];
}

/**
 * The self-check argv (#656 PR-E): a COPY of the sandbox IT harness's
 * `SELF_CHECK_ARGV` (`packages/sandbox/src/providers/opensandbox-it/harness.ts`)
 * with `python3` by absolute path, so the cell's agent-writable PATH head cannot
 * shadow it. The sandbox package never imports the worker, so the two are kept
 * equal by a test that reads the harness as text (cell-image-assets.test.ts).
 * A TLS request to `example.org`, which the policy denies: exit 3 = blocked.
 */
export const CELL_SELF_CHECK_ARGV: readonly string[] = [
  "/usr/bin/python3",
  "-c",
  [
    "import sys, urllib.request, urllib.error",
    "code = 3",
    "try:",
    '    urllib.request.urlopen("https://example.org/", timeout=5)',
    "    code = 0",
    "except urllib.error.HTTPError:",
    "    code = 0",
    "except Exception:",
    "    code = 3",
    "sys.exit(code)",
  ].join("\n"),
];

/** The checkout inside the cell. */
export const CELL_WORKSPACE = "/workspace";

/**
 * Checks out the work branch (`$1`, validated by `assertRef`) in the clone:
 * `origin/$1` when the remote has it, else a new branch from the current head.
 * A fixed script with the ref as a positional argument: argv has no shell.
 */
export const CELL_CHECKOUT_WORK_BRANCH_SH = [
  `if git -C ${CELL_WORKSPACE} rev-parse --verify -q "refs/remotes/origin/$1" >/dev/null; then`,
  `  git -C ${CELL_WORKSPACE} checkout -B "$1" "origin/$1"`,
  "else",
  `  git -C ${CELL_WORKSPACE} checkout -B "$1"`,
  "fi",
].join("\n");

/**
 * Where a daemon message is staged: the directory cell-entry.sh creates 0700
 * (its umask-scoped `mkdir`), so no other uid can traverse it while upstream
 * execd's upload leaves the file at `0777 &^ umask` before its chmod.
 */
export const CELL_MESSAGE_DIR = `${CONTAINER_HOME}/.automata-run`;

/**
 * Writes one staged message file to the daemon socket, then removes it. The
 * only argument is the file's path, so the prompt never reaches execd's
 * command log (it logs argv) and no size cap from argv applies. The path must
 * sit under CELL_MESSAGE_DIR. The file is removed whether or not the write
 * worked.
 * `bash -c <script> cell-write <path>`: the path is `$1`.
 */
export const CELL_WRITE_MESSAGE_SH = [
  "set -eu",
  "PATH=/usr/bin:/bin",
  'case "$1" in',
  `  "${CELL_MESSAGE_DIR}/"*) ;;`,
  '  *) echo "cell-write: path is outside the message dir" >&2; exit 64 ;;',
  "esac",
  "rc=0",
  `${CELL_NODE} ${CELL_DAEMON_BUNDLE} --write --socket-path ${CELL_DAEMON_SOCKET} --timeout 10000 < "$1" || rc=$?`,
  'rm -f -- "$1"',
  'exit "$rc"',
].join("\n");

const REPO_PART = /^[A-Za-z0-9._-]+$/;
/** A git ref the worker will put in an argv slot: no leading `-`, no whitespace or control characters, no `..`. */
const REF_NAME = /^[A-Za-z0-9._/@+-]+$/;

/** `owner/name` split, or a throw for anything that is not a plain repo. */
function plainRepo(repoFullName: string): [string, string] {
  const parts = repoFullName.split("/");
  const [owner, repo] = parts;
  if (
    parts.length !== 2 ||
    !owner ||
    !repo ||
    !REPO_PART.test(owner) ||
    !REPO_PART.test(repo) ||
    owner === "." ||
    owner === ".." ||
    repo === "." ||
    repo === ".."
  ) {
    throw new Error("cell repo is not a plain owner/name");
  }
  return [owner, repo];
}

function assertRef(label: string, value: string): void {
  if (!REF_NAME.test(value) || value.startsWith("-") || value.includes("..")) {
    throw new Error(`cell ${label} is not a safe git ref`);
  }
}

/**
 * The argvs, in order, that put the checkout in the cell (AC-15's worker half):
 * a clone through the www broker (the vault adds the bearer, so no credential
 * is in argv or in the git config), then the work-branch checkout (continuing
 * `origin/<workBranch>` when it exists) when the push branch differs, then `fetch origin <baseBranch>` when it is set.
 * Throws on an owner, repo or ref it will not put in an argv.
 */
export function cellCloneArgv(opts: {
  brokerHost: string;
  repoFullName: string;
  branch: string;
  workBranch?: string | null;
  baseBranch?: string | null;
}): string[][] {
  assertBrokerHost(opts.brokerHost);
  const [owner, repo] = plainRepo(opts.repoFullName);
  assertRef("branch", opts.branch);
  const argvs: string[][] = [
    [
      "git",
      "clone",
      "--no-tags",
      "--branch",
      opts.branch,
      `https://${opts.brokerHost}/api/cell/git/${owner}/${repo}.git`,
      CELL_WORKSPACE,
    ],
  ];
  if (opts.workBranch) {
    assertRef("work branch", opts.workBranch);
    // As on the box (provision.ts): a work branch that already exists on the
    // remote is continued, else it starts from the checkout. The clone fetched
    // every head (no --single-branch, no --depth), so origin/<ref> is local.
    argvs.push([
      "/bin/bash",
      "-c",
      CELL_CHECKOUT_WORK_BRANCH_SH,
      "workbranch",
      opts.workBranch,
    ]);
  }
  if (opts.baseBranch) {
    assertRef("base branch", opts.baseBranch);
    argvs.push([
      "git",
      "-C",
      CELL_WORKSPACE,
      "fetch",
      "origin",
      opts.baseBranch,
    ]);
  }
  return argvs;
}

/** Where gh reads its host login inside the cell (HOME is /home/agent). */
export const CELL_GH_CONFIG_DIR = "/home/agent/.config/gh";

/** The agent-facing note on GitHub access in a cell, as user-level memory. */
export const CELL_GH_NOTE = [
  "# GitHub access in this run",
  "",
  "This run is in a remote cell. `gh` is already set up for this repository",
  "through a read-only broker, so `-R` and `--hostname` are not needed:",
  "`gh issue view <N>`, `gh pr view <N>`, `gh api repos/<owner>/<repo>/...`.",
  "REST reads are limited to this repository: `gh search`, `gh api user` and",
  "`gh auth status` are refused, so use `gh issue list --search` or",
  "`gh pr list --search` instead. GitHub writes (comments,",
  "labels, reviews, creating PRs, `gh api -X POST`, GraphQL mutations) are",
  "refused with a 403 here; commit and push with git as usual.",
  "",
].join("\n");

/**
 * gh's setup for a cell (#727 B): `hosts.yml` logs the broker host in with
 * the placeholder, and the env (the settings `env` block, which the CLI hands
 * to the agent's tools) makes it gh's default host and the run's repo its
 * default repo. gh cannot read the repo from `origin`, which is the broker's
 * `/api/cell/git/<owner>/<repo>.git`. `GH_*` is a reserved repo-env prefix,
 * so the owner's env cannot override these.
 */
export function cellGhSetup(opts: {
  brokerHost: string;
  repoFullName: string;
  botLogin: string;
}): { hostsYml: string; env: Record<string, string> } {
  assertBrokerHost(opts.brokerHost);
  const [owner, repo] = plainRepo(opts.repoFullName);
  if (!/^[A-Za-z0-9-]+(\[bot\])?$/.test(opts.botLogin)) {
    throw new Error("cell bot login is not a GitHub login");
  }
  // gh looks a request's token up by the hostname without the port, so a dev
  // broker on `host:port` is logged in as `host` (GH_HOST keeps the port).
  const loginHost = opts.brokerHost.replace(/:\d+$/, "");
  const hostsYml = [
    `${loginHost}:`,
    `    oauth_token: ${CELL_GH_TOKEN_PLACEHOLDER}`,
    `    user: ${JSON.stringify(opts.botLogin)}`,
    "    git_protocol: https",
    "",
  ].join("\n");
  return {
    hostsYml,
    env: {
      GH_HOST: opts.brokerHost,
      GH_REPO: `${opts.brokerHost}/${owner}/${repo}`,
      GH_CONFIG_DIR: CELL_GH_CONFIG_DIR,
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
    },
  };
}

/** The repo-local identity that replaces the box's `GIT_CONFIG_*` env. */
export function cellGitConfigArgv(botLogin: string): string[][] {
  return botGitIdentity(botLogin).config.map(([key, value]) => [
    "git",
    "-C",
    CELL_WORKSPACE,
    "config",
    key,
    value,
  ]);
}
