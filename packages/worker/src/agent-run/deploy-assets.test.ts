import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Rot guards for the execution-plane deploy templates. These are pure file
 * reads (plus `bash -n` / shellcheck): no sudo, no network — they pass on
 * Linux CI.
 *
 * They exist because the templates encode decisions that are expensive to get
 * wrong on a live box and cheap to "tidy" back out during an unrelated edit.
 */

const workerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const repoRoot = path.resolve(workerRoot, "..", "..");
const read = (p: string) => fs.readFileSync(p, "utf8");
/** A file under packages/worker/deploy/. */
const deployFile = (...segments: string[]) =>
  read(path.join(workerRoot, "deploy", ...segments));

describe("deploy/egress-pf.conf", () => {
  const conf = read(path.join(repoRoot, "deploy", "egress-pf.conf"));

  it("no longer tells the operator to fence the worker's own uid", () => {
    // The pre-#108 text said the uid "on a single-user pilot box is the
    // worker's own uid". Following that now kills the control-plane poll, the
    // git broker's upstream fetch and the credential pull — every run on the box.
    expect(conf).not.toMatch(/which also fences the worker process/);
    expect(conf).not.toMatch(/acceptable for the pilot/);
    expect(conf).toContain("_automata-agent");
    expect(conf).toMatch(/NEVER be the worker's own uid/);
  });

  it("still blocks tcp AND udp on 80/443 for the agent uid, and passes lo0", () => {
    expect(conf).toMatch(/pass out quick on lo0 all/);
    expect(conf).toMatch(
      /block out quick proto \{tcp, udp\}.*port \{80, 443\} user __AGENT_UID__/,
    );
  });

  it("ships the full-port follow-up COMMENTED OUT with its DNS carve-out", () => {
    const followUp = conf
      .split("\n")
      .filter((l) => l.includes("port 1:65535") || l.includes("port 53"));
    for (const line of followUp) {
      expect(line.trim().startsWith("#"), line).toBe(true);
    }
    expect(conf).toMatch(/#\s*pass\s+out quick proto udp .* port 53/);
  });
});

describe("packages/worker/deploy — PF wrapper, scripts and LaunchDaemon", () => {
  it("the wrapper conf INCLUDES /etc/pf.conf rather than editing it", () => {
    // /etc/pf.conf is rewritten by OS updates; an edit there silently vanishes.
    const wrapper = deployFile("automata-pf.conf");
    expect(wrapper).toMatch(/^include "\/etc\/pf\.conf"$/m);
    expect(wrapper).toMatch(/anchor "automata-egress"/);
    expect(wrapper).toMatch(
      /load anchor "automata-egress" from "\/etc\/pf\.anchors\/automata-egress"/,
    );
  });

  it("the LaunchDaemon loads the WRAPPER with -E, never -e", () => {
    const plist = deployFile("com.automata.pf.plist");
    expect(plist).toContain("<string>-E</string>");
    expect(plist).not.toContain("<string>-e</string>");
    expect(plist).toContain("<string>/etc/automata-pf.conf</string>");
    expect(plist).not.toContain("<string>/etc/pf.conf</string>");
  });

  it("the preflight script refuses uid 501, an unsubstituted placeholder, and parses first", () => {
    const preflight = deployFile("pf-preflight.sh");
    expect(preflight).toContain("__AGENT_UID__");
    expect(preflight).toMatch(/= "501" \] && fail/);
    expect(preflight).toMatch(/pfctl -n -f/);
    // The parse check must come BEFORE the load.
    expect(preflight.indexOf("pfctl -n -f")).toBeLessThan(
      preflight.indexOf("pfctl -E -f"),
    );
    expect(preflight).not.toMatch(/pfctl -e\b/);
  });

  it("the verify script checks BOTH that PF is enabled and that the anchor has rules", () => {
    const verify = deployFile("pf-verify.sh");
    expect(verify).toMatch(/pfctl -s info/);
    expect(verify).toMatch(/Status: Enabled/);
    expect(verify).toMatch(/pfctl -a automata-egress -sr/);
  });
});

describe("#183: single worker unit", () => {
  it("no deploy asset entry names the retired second unit", () => {
    const entries = fs.readdirSync(path.join(workerRoot, "deploy"));
    expect(entries.some((entry) => /worker-2/.test(entry))).toBe(false);
  });

  it("the runbook no longer mentions the second unit", () => {
    expect(deployFile("README.md")).not.toContain("worker-2");
  });

  it("the concurrency-cap citation points at definition.ts, not workflow.ts", () => {
    const readme = deployFile("README.md");
    expect(readme).not.toContain("src/agent-run/workflow.ts");
    const paragraphs = readme.split(/\n{2,}/);
    const capParagraph = paragraphs.find((p) => p.includes("GLOBAL_MAX_RUNS"));
    expect(capParagraph, readme).toBeTruthy();
    expect(capParagraph).toContain("definition.ts");
  });

  it("only the single worker unit plist remains, and it declares the right label", () => {
    const plist = deployFile("com.automata.worker.plist");
    expect(plist).toContain("com.automata.worker</string>");
  });
});

describe("packages/worker/docker-compose.hatchet.prod.yml (#192)", () => {
  const overlay = read(
    path.join(workerRoot, "docker-compose.hatchet.prod.yml"),
  );
  const base = read(path.join(workerRoot, "docker-compose.hatchet.yml"));

  it("binds both engine ports to loopback", () => {
    // The base file publishes them with no host prefix, i.e. 0.0.0.0. That was
    // survivable behind a home router; on a public VM it is the engine
    // dashboard, the REST API and engine gRPC open to the internet. www reaches
    // the engine through the named tunnel and the worker over loopback, so an
    // external binding serves nothing.
    expect(overlay).toContain('"127.0.0.1:8888:8888"');
    expect(overlay).toContain('"127.0.0.1:7077:7077"');
    expect(base).toContain('"8888:8888"'); // the thing being overridden
  });

  it("REPLACES the base ports list instead of appending to it", () => {
    // Load-bearing, and the reason this test exists. Compose MERGES
    // list-valued keys: without `!override` the loopback mappings are appended
    // to the base file's world-facing ones and 0.0.0.0 stays published
    // alongside. Deleting the tag looks like tidying and silently re-exposes
    // the engine, with no error anywhere.
    expect(overlay).toMatch(/ports:\s*!override/);
  });

  it("caps engine memory, and forbids the containers from leaking into swap", () => {
    // Invisible on the 48 GB pilot laptop, dangerous on the 8 GB box where the
    // engine shares the machine with the worker and the agent runs. The
    // capacity model assumes the engine stays near what the pilot measured
    // (hatchet-lite ~66 MB, Postgres ~474 MB); nothing enforced it, and the
    // failure mode is a box-wide fork ENOMEM, not a tidy per-process OOM.
    expect(overlay).toMatch(/mem_limit:\s*1g/);
    expect(overlay).toMatch(/mem_limit:\s*512m/);

    // memswap_limit must equal mem_limit on every capped service, or the
    // container swaps instead of being capped and spends the worker's budget.
    const caps = [...overlay.matchAll(/mem_limit:\s*(\S+)/g)].map((m) => m[1]);
    const swaps = [...overlay.matchAll(/memswap_limit:\s*(\S+)/g)].map(
      (m) => m[1],
    );
    expect(swaps, overlay).toEqual(caps);
  });

  it("is an overlay, never a standalone stack", () => {
    // Applied alone it would define services with no image and no environment.
    // The header says so; this asserts the header keeps saying so.
    expect(overlay).toContain("docker-compose.hatchet.yml");
    expect(overlay).not.toContain("image:");
  });

  it("restricts dashboard sign-up and login to the operator's domain, and warns to rename the seed admin first", () => {
    // hatchet-lite ships with open self-registration; behind the public tunnel
    // that was a public login to the production engine (2026-10-18). The same
    // knob refuses an out-of-domain seed admin's login, so the doc order is
    // part of the control: rename, then apply.
    expect(overlay).toMatch(
      /SERVER_AUTH_RESTRICTED_EMAIL_DOMAINS:\s*beautomata\.com/,
    );
    expect(overlay).toMatch(/rename.*seed admin/i);
    expect(overlay).not.toMatch(/SERVER_AUTH_BASIC_AUTH_ENABLED/);
  });
});

describe("packages/worker/deploy/linux/cloud-init.yaml (#192)", () => {
  const cloudInit = deployFile("linux", "cloud-init.yaml");

  it("provisions from ONE fail-fast script, not a list of runcmd entries", () => {
    // The first box built from this file came up with Node 18 and no pnpm
    // while cloud-init reported `status: done` and `errors: []`. cloud-init
    // ignores each runcmd entry's exit code, so a failed step is invisible and
    // the NEXT step happily works on the broken state. Going back to a list
    // reintroduces exactly that, silently.
    expect(cloudInit).toMatch(/set -euo pipefail/);
    const runcmd = cloudInit.slice(cloudInit.indexOf("\nruncmd:"));
    const entries = runcmd.split("\n").filter((l) => l.trim().startsWith("- "));
    expect(entries.length, runcmd).toBe(1);
    expect(entries[0]).toContain("automata-provision.sh");
  });

  it("waits for the dpkg/apt lock instead of racing it", () => {
    // This is the root cause of the Node 18 box: `package_upgrade` and
    // apt-daily still held the lock, the NodeSource repo script lost the race,
    // and nothing checked. Every apt call goes through the waiter.
    expect(cloudInit).toMatch(/wait_for_apt\(\)/);
    expect(cloudInit).toMatch(/lock-frontend/);
    expect(cloudInit).toMatch(/apt_get\(\)\s*\{\s*wait_for_apt;/);
  });

  it("detects a failed NodeSource repo add by CONTENT, not by filename", () => {
    // Two ways to get this wrong, both observed here:
    //   - no check at all -> Ubuntu's nodejs 18 installs and looks like success
    //   - a check pinned to `nodesource.list` -> false alarm on 24.04, which
    //     emits deb822 `nodesource.sources`
    expect(cloudInit).toMatch(
      /grep -rqs nodesource \/etc\/apt\/sources\.list\.d\//,
    );
    expect(cloudInit).not.toMatch(/sources\.list\.d\/nodesource\.list/);
    expect(cloudInit).toMatch(/FATAL: NodeSource repo was not configured/);
  });

  it("pins ONE exact Node build and holds it", () => {
    // A floor let a box drift to whatever NodeSource shipped that hour, and the
    // harness batteries' native prebuilds are built for one Node ABI. The exact
    // version, the hold, and an exact-major assertion travel together: drop the
    // hold and unattended-upgrades moves node under the installed batteries.
    expect(cloudInit).toMatch(/^\s*NODE_MAJOR=24$/m);
    expect(cloudInit).toMatch(
      /^\s*NODE_DEB_VERSION=24\.\d+\.\d+-1nodesource1$/m,
    );
    expect(cloudInit).toContain('"nodejs=${NODE_DEB_VERSION}"');
    expect(cloudInit).toMatch(/^\s*apt-mark hold nodejs$/m);
    expect(cloudInit).toContain("setup_${NODE_MAJOR}.x");
    expect(cloudInit).not.toMatch(/setup_22\.x/);
  });

  it("writes the sentinel only AFTER the assertions", () => {
    // `/usr/local/automata/.provisioned` is the contract downstream checks
    // instead of cloud-init's own status. Hoisting it above the assertions
    // would make it mean nothing while still appearing to work.
    // Anchored on the line that WRITES it — the path is also named in the
    // header comment, and matching that instead would pass no matter where
    // the write actually sits.
    const floorCheck = cloudInit.indexOf("FATAL: nodejs is not held");
    const sentinel = cloudInit.indexOf(
      "date -uIseconds > /usr/local/automata/.provisioned",
    );
    expect(floorCheck).toBeGreaterThan(-1);
    expect(sentinel).toBeGreaterThan(-1);
    expect(sentinel).toBeGreaterThan(floorCheck);
  });

  // card: protects=ADR-013 P3: a fresh box provisions no host-uid machinery — no slot accounts, no harness build account, no host battery prerequisites, no host agent CLI — and points at the provisioning script for the container runtime; fails_when=any of those steps comes back; no_claim=what provision-execution-box.sh installs (its own tests)
  it("provisions no host-uid machinery: no slot accounts, battery steps or host agent", () => {
    for (const gone of [
      /AGENT_SLOTS/,
      /automata-agent/,
      /automata-build/,
      /CHROMIUM_RUNTIME_PACKAGES/,
      /@anthropic-ai\/claude-code/,
      /^\s+- acl$/m,
      /^\s+- nftables$/m,
      /setfacl|\bnft\b/,
    ]) {
      expect(cloudInit, String(gone)).not.toMatch(gone);
    }
    expect(cloudInit).toContain("deploy/provision-execution-box.sh");
  });
});

/**
 * The hygiene every deploy bash script keeps: tracked executable, bash with
 * strict mode on line 2, parses with `bash -n`, shellcheck clean. bash and
 * shellcheck are local static checkers (no network, no sudo); shellcheck is
 * skipped where it is not installed.
 */
function describeBashScriptHygiene(relPath: string): void {
  describe(`${path.basename(relPath)}: bash script hygiene`, () => {
    const scriptPath = path.join(repoRoot, relPath);

    it("is tracked as an executable bash script in strict mode", () => {
      const mode = execFileSync("git", ["ls-files", "-s", relPath], {
        cwd: repoRoot,
        encoding: "utf8",
      }).slice(0, 6);
      expect(mode).toBe("100755");
      const lines = read(scriptPath).split("\n");
      expect(lines[0]).toBe("#!/bin/bash");
      expect(lines[1]).toBe("set -euo pipefail");
    });

    it("parses with bash -n", () => {
      expect(() =>
        execFileSync("bash", ["-n", scriptPath], { stdio: "pipe" }),
      ).not.toThrow();
    });

    // A long script takes shellcheck seconds on a shared CI runner, past the
    // 5s default.
    it("is shellcheck clean", { timeout: 30_000 }, (ctx) => {
      if (
        spawnSync("shellcheck", ["--version"], { stdio: "ignore" }).status !== 0
      ) {
        ctx.skip();
      }
      const result = spawnSync("shellcheck", ["-s", "bash", scriptPath], {
        encoding: "utf8",
      });
      expect(result.stdout + result.stderr).toBe("");
      expect(result.status).toBe(0);
    });
  });
}

describeBashScriptHygiene(
  "packages/worker/deploy/linux/orchestrated-review-acceptance.sh",
);
describeBashScriptHygiene(
  "packages/worker/deploy/linux/self-heal-acceptance.sh",
);
describeBashScriptHygiene(
  "packages/worker/deploy/linux/install-test-postgres.sh",
);
describeBashScriptHygiene(
  "packages/worker/deploy/linux/test-postgres-sweep.sh",
);

/** The quoted `echo|log|fail|printf "…"` arguments of a bash script. */
function printedStrings(script: string): string[] {
  return [...script.matchAll(/\b(?:echo|log|fail|printf)\s+"([^"]*)"/g)].map(
    (m) => m[1] ?? "",
  );
}

/** Every heredoc fed to psql starts by keeping failed statements out of the log. */
function expectPsqlHeredocsQuietOnError(script: string): void {
  const heredocs = [...script.matchAll(/psql[^\n]*<<SQL\n([^\n]*)/g)];
  expect(heredocs.length).toBeGreaterThan(0);
  for (const m of heredocs) {
    expect(m[1]).toBe("SET log_min_error_statement = panic;");
  }
}

describe("packages/worker/deploy/linux — test Postgres (no-Docker test suites)", () => {
  const script = deployFile("linux", "install-test-postgres.sh");

  it("refuses to run as anyone but root", () => {
    expect(script).toMatch(
      /\[ "\$\(id -u\)" = "0" \] \|\| fail "must run as root"/,
    );
  });

  it("listens on loopback only, on 25432 (not docker-up-tests' 15432), and verifies it", () => {
    // Agent runs share the box: the test cluster must never be reachable off it.
    expect(script).toMatch(/^listen_addresses = '127\.0\.0\.1'$/m);
    expect(script).not.toMatch(/listen_addresses = '(\*|0\.0\.0\.0)'/);
    expect(script).toMatch(/^PORT=25432$/m);
    expect(script).not.toMatch(/^PORT=15432$/m);
    expect(script).toMatch(/listening beyond loopback/);
  });

  it("lets only automata_test in, from 127.0.0.1/32 with scram-sha-256", () => {
    const hostLines = script
      .split("\n")
      .filter((l) => /^host(ssl|nossl)?\s/.test(l));
    expect(hostLines).toHaveLength(1);
    expect(hostLines[0]).toMatch(
      /^host\s+all\s+\$\{ROLE\}\s+127\.0\.0\.1\/32\s+scram-sha-256"?$/,
    );
    expect(script).toMatch(/^ROLE=automata_test$/m);
    expect(script).not.toMatch(/\btrust\b\s*"?$/m);
  });

  it("creates the role with CREATEDB and NOSUPERUSER, and checks it is not super", () => {
    expect(script).toMatch(
      /ALTER ROLE \$\{ROLE\} LOGIN CREATEDB NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 40/,
    );
    expect(script).not.toMatch(/(^|[^O])SUPERUSER PASSWORD/);
    expect(script).toMatch(/is a superuser/);
    expectPsqlHeredocsQuietOnError(script);
  });

  it("keeps the password root-only and out of argv and stdout", () => {
    expect(script).toMatch(
      /^PW_FILE=\/etc\/automata\/test-postgres\.password$/m,
    );
    expect(script).toMatch(/umask 077/);
    expect(script).toMatch(/chmod 0600 "\$PW_FILE"/);
    // Never echoed/logged, never passed as PGPASSWORD or a psql -c argument:
    // the client check reads it from a temp PGPASSFILE written by printf.
    const printed = printedStrings(script);
    expect(printed.length).toBeGreaterThan(5);
    for (const text of printed) {
      // `${PW_FILE}` (the path) is fine; `$PW` / `${PW}` (the secret) is not.
      expect(text, text).not.toMatch(/\$\{?PW(\}|\b)/);
    }
    expect(script).toMatch(
      /printf '127\.0\.0\.1:%s:\*:%s:%s\\n'[^\n]*>"\$PGPASSFILE"/,
    );
    expect(script).not.toMatch(/PGPASSWORD/);
    expect(script).not.toMatch(/-c "[^"]*\$\{?PW\b/);
    expect(script).toMatch(/PGPASSFILE/);
  });

  it("stays small, and bounds sessions in the conf file (not the role)", () => {
    expect(script).toMatch(/^shared_buffers = 64MB$/m);
    expect(script).toMatch(/^max_connections = 50$/m);
    expect(script).toMatch(/^temp_file_limit = 2GB$/m);
    expect(script).toMatch(/^client_connection_check_interval = 2s$/m);
    expect(script).toMatch(/^idle_in_transaction_session_timeout = 10min"?$/m);
  });

  it("caps the server's memory and CPU with a systemd drop-in on the cluster unit", () => {
    // The server runs outside every run's cgroup: `SET work_mem = '4GB'` would
    // otherwise escape the run's 1500M ceiling.
    expect(script).toMatch(
      /^LIMITS="\/etc\/systemd\/system\/\$\{UNIT\}\.service\.d\/automata-limits\.conf"$/m,
    );
    expect(script).toMatch(/^UNIT="postgresql@\$\{PG_VERSION\}-main"$/m);
    expect(script).toMatch(/^MemoryHigh=768M$/m);
    expect(script).toMatch(/^MemoryMax=1G$/m);
    expect(script).toMatch(/^CPUQuota=200%"?$/m);
    expect(script).toMatch(/systemctl daemon-reload/);
  });

  it("will not restart under a running test unless FORCE=1, and reloads for pg_hba only", () => {
    expect(script).toMatch(/pg_stat_activity WHERE usename = '\$\{ROLE\}'/);
    expect(script).toMatch(
      /if \[ "\$ACTIVE" != "0" \] && \[ "\$FORCE" != "1" \]; then\n\s+fail /,
    );
    // The guard runs before any file is written, so a refused run leaves the
    // change pending for the next one.
    const guard = script.indexOf('[ "$FORCE" != "1" ]');
    expect(guard).toBeGreaterThan(0);
    expect(script.indexOf('write_file "$DROPIN"')).toBeGreaterThan(guard);
    expect(script.indexOf('write_file "$LIMITS"')).toBeGreaterThan(guard);
    expect(script).toMatch(
      /elif \[ "\$NEED_RELOAD" = "1" \]; then[^]*?systemctl reload "\$UNIT"/,
    );
  });

  it("writes the worker's env file: URL + repo scope, root:<worker group> 0640, compare-then-write, never printed", () => {
    expect(script).toMatch(
      /^AGENT_ENV_FILE=\/etc\/automata\/agent-test-services\.env$/m,
    );
    expect(script).toMatch(/^WORKER_GROUP="\$\{WORKER_GROUP:-automata\}"$/m);
    expect(script).toMatch(/getent group "\$WORKER_GROUP" >\/dev\/null \|\|/);
    // Two lines: the URL the test harness reads, and the repos whose runs
    // the worker may hand it to (the login is shared, so it is scoped).
    expect(script).toMatch(
      /^AGENT_ENV_CONTENT="TEST_DATABASE_ADMIN_URL=postgresql:\/\/\$\{ROLE\}:\$\{PW\}@127\.0\.0\.1:\$\{PORT\}\/postgres\nTEST_SERVICES_REPOS=\$\{TEST_SERVICES_REPOS\}"$/m,
    );
    expect(script).toMatch(
      /^TEST_SERVICES_REPOS="\$\{TEST_SERVICES_REPOS:-be-automata\/automata\}"$/m,
    );
    // Validated before anything is written: owner/repo(,owner/repo)*.
    expect(script).toMatch(
      /^REPO_RE='\[A-Za-z0-9\._-\]\+\/\[A-Za-z0-9\._-\]\+'$/m,
    );
    expect(script).toMatch(
      /\[\[ "\$TEST_SERVICES_REPOS" =~ \^\$\{REPO_RE\}\(,\$\{REPO_RE\}\)\*\$ \]\] \|\|\n\s+fail /,
    );
    expect(script.indexOf("must be comma-separated owner/repo")).toBeLessThan(
      script.indexOf('write_file "$DROPIN"'),
    );
    // Idempotent: written only when the content differs, via write_file
    // (mktemp 0600 + mv), and its mode/owner re-asserted every run.
    expect(script).toMatch(
      /if differs "\$AGENT_ENV_FILE" "\$AGENT_ENV_CONTENT"; then\n\s+write_file "\$AGENT_ENV_FILE" "root:\$\{WORKER_GROUP\}" 0640 "\$AGENT_ENV_CONTENT"\nfi/,
    );
    expect(script).toMatch(
      /^chown "root:\$\{WORKER_GROUP\}" "\$AGENT_ENV_FILE"$/m,
    );
    expect(script).toMatch(/^chmod 0640 "\$AGENT_ENV_FILE"$/m);
    expect(script).not.toMatch(/0644 "\$AGENT_ENV_CONTENT"/);
    // Written only after the server is proven (the verify block runs first).
    expect(script.indexOf('write_file "$AGENT_ENV_FILE"')).toBeGreaterThan(
      script.indexOf("listening beyond loopback"),
    );
    // The content variable is never echoed/logged.
    for (const text of printedStrings(script)) {
      expect(text, text).not.toMatch(/AGENT_ENV_CONTENT/);
    }
  });

  it("installs, enables and runs the sweep", () => {
    expect(script).toMatch(/test-postgres-sweep\.sh" "\$SWEEP_BIN"/);
    expect(script).toMatch(
      /systemctl enable --quiet --now "\$\{SWEEP_UNIT\}\.timer"/,
    );
    expect(script).toMatch(/^"\$SWEEP_BIN"$/m);
  });
});

describe("packages/worker/deploy/linux — test Postgres sweep", () => {
  const sweep = deployFile("linux", "test-postgres-sweep.sh");

  it("is root-only and talks to the cluster as postgres on 25432", () => {
    expect(sweep).toMatch(
      /\[ "\$\(id -u\)" = "0" \] \|\| fail "must run as root"/,
    );
    expect(sweep).toMatch(/^PORT=25432$/m);
    expect(sweep).toMatch(
      /runuser -u postgres -- psql -X -q -At -v ON_ERROR_STOP=1 -p "\$PORT" -d postgres <<SQL/,
    );
    expectPsqlHeredocsQuietOnError(sweep);
  });

  it("resets what the role can change about itself", () => {
    expect(sweep).toMatch(/^ALTER ROLE \$\{ROLE\} RESET ALL;$/m);
    expect(sweep).toMatch(
      /^ALTER ROLE \$\{ROLE\} LOGIN CREATEDB NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 40 PASSWORD '\$\{PW\}';$/m,
    );
    expect(sweep).toMatch(/\[\[ "\$PW" =~ \^\[0-9a-f\]\{32,\}\$ \]\]/);
    // It re-asserts the SAME password and never rotates it: the worker's
    // agent-test-services.env embeds it and would otherwise go stale.
    expect(sweep).toMatch(/^PW="\$\(cat "\$PW_FILE"\)"$/m);
    expect(sweep).not.toMatch(/urandom|>\s*"?\$PW_FILE/);
    for (const text of printedStrings(sweep)) {
      expect(text, text).not.toMatch(/\$\{?PW(\}|\b)/);
    }
  });

  it("sweeps sessions and databases older than 3h, only the role's own", () => {
    expect(sweep).toMatch(/backend_start < now\(\) - interval '3 hours'/);
    expect(sweep).toMatch(
      /pg_stat_file\('base\/' \|\| d\.oid \|\| '\/PG_VERSION', true\)\)\.modification\s+< now\(\) - interval '3 hours'/,
    );
    expect(sweep).toMatch(/WHERE r\.rolname = '\$\{ROLE\}'/);
    expect(sweep).toMatch(/format\('DROP DATABASE %I WITH \(FORCE\)'/);
    expect(sweep).toMatch(/^\\gexec$/m);
  });

  it("runs every 15 minutes from a oneshot unit that fails loudly", () => {
    const unit = deployFile("linux", "automata-test-postgres-sweep.service");
    expect(unit).toMatch(/^Type=oneshot$/m);
    expect(unit).not.toMatch(/^Restart=/m);
    expect(unit).toMatch(/^TimeoutStartSec=\d+$/m);
    expect(unit).toMatch(
      /^ExecStart=\/usr\/local\/sbin\/automata-test-postgres-sweep\.sh$/m,
    );
    const timer = deployFile("linux", "automata-test-postgres-sweep.timer");
    expect(timer).toMatch(/^OnCalendar=\*:0\/15$/m);
    expect(timer).toMatch(/^Unit=automata-test-postgres-sweep\.service$/m);
    expect(timer).toMatch(/^WantedBy=timers\.target$/m);
  });
});

describe("packages/worker/deploy/linux — systemd unit + launcher (#192)", () => {
  it("the launcher ends in `exec node`, with nothing wrapping it", () => {
    // A `pnpm run` chain swallows SIGTERM at the top pnpm layer, so the signal
    // never reaches the worker and the drain silently breaks — live-verified on
    // macOS 2026-07-25, and systemd's MainPID has the same problem. The exec
    // must be the LAST line, not merely present somewhere.
    const script = deployFile("linux", "run-worker.sh.template");
    const lines = script.trimEnd().split("\n");
    expect(lines[lines.length - 1]).toBe(
      "exec node --import tsx src/hello/worker.ts",
    );
    expect(script).not.toMatch(/exec\s+pnpm/);
  });

  it("the launcher gates on auth and rebuilds the daemon BEFORE exec'ing", () => {
    // A `-dev` hatchet-lite image embeds a publicly known JWT signing key, so a
    // worker must never attach to one; and the worker consumes the daemon dist
    // at runtime, so a stale bundle is a wrong-code run, not a missing file.
    const script = deployFile("linux", "run-worker.sh.template");
    const gate = script.indexOf("assert-auth-enabled.sh");
    const build = script.indexOf("pnpm run daemon:build");
    // lastIndexOf on the FULL command: the header comment also says "exec node"
    // while explaining the signal contract, and matching that instead puts the
    // exec at the top of the file and inverts every ordering below.
    const exec = script.lastIndexOf(
      "exec node --import tsx src/hello/worker.ts",
    );
    expect(gate).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(gate);
    expect(exec).toBeGreaterThan(build);
  });

  // card: protects=UAT #229 F1 under ADR-013: the launcher stages the daemon bundle where the rootless daemon can read it (it bind-mounts it into every run container) and exports exactly that path, after the install and before the exec, on every start of a provisioned box — never keyed on a host agent account; fails_when=the export is missing, names another path, precedes the install, is keyed on WORKER_AGENT_USER, or the runbook snippet drifts; no_claim=the bind mount itself (container-argv tests)
  it("the launcher points WORKER_DAEMON_DIST at the bundle it stages (UAT #229 F1)", () => {
    const script = deployFile("linux", "run-worker.sh.template");
    expect(script).not.toMatch(/WORKER_AGENT_USER/);
    const block = script.match(
      /^if \[ -d \/usr\/local\/automata\/daemon \]; then\n([\s\S]*?)^fi$/m,
    );
    expect(block, "daemon staging block not found").toBeTruthy();
    const body = block![1]!;
    const install = body.match(/install -m 0444 \S+ (\S+)/);
    const exported = body.match(/^\s*export WORKER_DAEMON_DIST=(\S+)$/m);
    expect(install, body).toBeTruthy();
    expect(exported, body).toBeTruthy();
    expect(exported![1]).toBe(install![1]);
    expect(body.indexOf("export WORKER_DAEMON_DIST")).toBeGreaterThan(
      body.indexOf("install -m 0444"),
    );
    expect(script.indexOf(block![0])).toBeLessThan(
      script.lastIndexOf("exec node --import tsx src/hello/worker.ts"),
    );
    expect(script.match(/export WORKER_DAEMON_DIST=/g)).toHaveLength(1);

    // The runbook's launcher snippet carries the same contract.
    const readme = deployFile("README.md");
    expect(readme).toMatch(
      /install -m 0444 \S+ \/usr\/local\/automata\/daemon\/index\.js[^\n]*\n(?:\s*#[^\n]*\n)*\s*export WORKER_DAEMON_DIST=\/usr\/local\/automata\/daemon\/index\.js\n/,
    );
  });

  it("the launcher defaults the run-terminal ledger to a durable dir under ReadWritePaths (#386)", () => {
    // /tmp — the code default — is wiped at boot by Ubuntu's tmpfiles, so a
    // reboot mid-drain lost the ledger and let a redelivery re-execute a run
    // that already ended. The launcher names the durable default (worker-box.env
    // may still override it), creates it worker-only, and does so before exec.
    const script = deployFile("linux", "run-worker.sh.template");
    const exported = script.match(
      /^export WORKER_RUN_TERMINAL_ROOT="\$\{WORKER_RUN_TERMINAL_ROOT:-(\S+)\}"$/m,
    );
    expect(
      exported,
      "launcher does not default WORKER_RUN_TERMINAL_ROOT",
    ).toBeTruthy();
    const root = exported![1]!;
    expect(root).toBe("/usr/local/automata/state");
    expect(script).toMatch(/install -d -m 0700 "\$WORKER_RUN_TERMINAL_ROOT"/);
    const exec = script.lastIndexOf(
      "exec node --import tsx src/hello/worker.ts",
    );
    expect(script.indexOf(exported![0])).toBeGreaterThan(
      script.indexOf("source __HOME__/.automata/worker-box.env"),
    );
    expect(script.indexOf(exported![0])).toBeLessThan(exec);

    // The unit can write it, and a fresh box has it before the first boot.
    const unit = deployFile("linux", "automata-worker.service");
    const rw = [...unit.matchAll(/^ReadWritePaths=(.+)$/gm)].flatMap((m) =>
      m[1] ? m[1].trim().split(/\s+/) : [],
    );
    expect(rw.some((p) => root === p || root.startsWith(`${p}/`))).toBe(true);
    const ci = deployFile("linux", "cloud-init.yaml");
    expect(ci).toMatch(
      /install -d -m 0700 -o automata -g automata \/usr\/local\/automata\/state$/m,
    );
  });

  it("the safe restart drains before it restarts, and never restarts after a failed drain (#386)", () => {
    // A bare `systemctl restart` SIGTERMs a busy worker; with two boxes the
    // engine hands the drained run to the other box mid-run. The wrapper must
    // run the drain FIRST and exit before `systemctl restart` when it fails.
    const script = deployFile("linux", "automata-worker-safe-restart");
    expect(script.startsWith("#!/bin/bash\n")).toBe(true);
    const drain = script.indexOf("scripts/drain-for-restart.ts");
    const bail = script.search(/if \[ "\$rc" != 0 \]; then[\s\S]*?exit "\$rc"/);
    const restart = script.lastIndexOf('systemctl restart "$UNIT"');
    expect(drain).toBeGreaterThan(-1);
    expect(bail).toBeGreaterThan(drain);
    expect(restart).toBeGreaterThan(bail);
    const restartLines = script
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .filter((l) => l.includes("systemctl restart"));
    expect(restartLines).toHaveLength(1);
    // The drain runs as the service account with the box env, never as root.
    expect(script).toMatch(/runuser -u "\$WORKER_USER" --/);
    expect(script).toMatch(/\. "\$1"/);
    const mode = fs.statSync(
      path.join(workerRoot, "deploy", "linux", "automata-worker-safe-restart"),
    ).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  it("every stop drains first: ExecStop= pauses the worker and waits before the SIGTERM (#386)", () => {
    const unit = deployFile("linux", "automata-worker.service");
    const stops = [...unit.matchAll(/^ExecStop=(.+)$/gm)].map((m) => m[1]!);
    expect(stops).toHaveLength(1);
    const cmd = stops[0]!;
    expect(cmd).toContain("scripts/drain-for-restart.ts --for-stop");
    // Nothing to drain when the worker already exited on its own.
    expect(cmd).toMatch(/\[ -n "\$MAINPID" \] \|\| exit 0;/);
    // The box env (engine token) the worker itself runs with.
    expect(cmd).toContain(". __HOME__/.automata/worker-box.env;");
    // systemd kills an ExecStop= at TimeoutStopSec: the drain's own deadline
    // must come first, so it ends on its terms (worker left paused).
    const drainS = Number(cmd.match(/--timeout-s (\d+)/)?.[1]);
    const stopS = Number(unit.match(/^TimeoutStopSec=(\d+)$/m)?.[1]);
    expect(drainS).toBeGreaterThan(0);
    expect(drainS).toBeLessThan(stopS);
  });

  it("the stop-time drain never fails the stop, while the restart wrapper's drain fails closed", () => {
    // Without an engine token the drain cannot even start: exit 4 normally,
    // but 0 under --for-stop, so a broken engine never wedges a shutdown.
    const env = { PATH: process.env.PATH ?? "", HOME: os.tmpdir() };
    const run = (args: string[]) =>
      spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/drain-for-restart.ts", ...args],
        { cwd: workerRoot, env, encoding: "utf8", timeout: 60_000 },
      );
    const strict = run([]);
    expect(strict.status, strict.stdout + strict.stderr).toBe(4);
    const forStop = run(["--for-stop"]);
    expect(forStop.status, forStop.stdout + forStop.stderr).toBe(0);
    expect(forStop.stdout).toMatch(/the stop proceeds to SIGTERM/);
  });

  it("the unit signals only MainPID, so the SDK owns the drain", () => {
    // KillMode=control-group SIGTERMs the agent and its daemon directly and
    // drops the in-flight review. `mixed` sends SIGTERM to MainPID alone and
    // lets the worker decide when its children die.
    const unit = deployFile("linux", "automata-worker.service");
    expect(unit).toMatch(/^KillMode=mixed$/m);
    expect(unit).not.toMatch(/^KillMode=control-group$/m);
    expect(unit).toMatch(/^KillSignal=SIGTERM$/m);

    // The stop budget must clear a real agent run. Anything small silently
    // reintroduces the mid-run SIGKILL under a different name.
    const stop = unit.match(/^TimeoutStopSec=(\d+)$/m);
    expect(stop, unit).toBeTruthy();
    expect(Number(stop![1])).toBeGreaterThanOrEqual(1800);
  });

  // card: protects=ADR-013 P3 keeps the unit's privilege posture unchanged (NoNewPrivileges off) so reverting the release PR is a pure redeploy on a box that still has the host provisioning; fails_when=the posture is tightened in the same PR (a revert would then break the restored sudo spawn); no_claim=the P4 tightening
  it("keeps NoNewPrivileges as it was until P4 (a revert stays a pure redeploy)", () => {
    const unit = deployFile("linux", "automata-worker.service");
    expect(unit).toMatch(/^NoNewPrivileges=no$/m);
    expect(unit).not.toMatch(/^NoNewPrivileges=(yes|true)$/m);
  });

  // card: protects=ADR-013 P3: the unit no longer loads the #367 loopback fence, delegates no cgroup subtree and keeps ProtectControlGroups on (run limits are the containers' own, on the rootless daemon), and no host-path drop-in ships beside it; fails_when=an ExecStartPre=+ loader, a Delegate=, ProtectControlGroups=no or an automata-worker.service.d drop-in comes back; no_claim=what an older box still has installed (removed in P4)
  it("loads no loopback fence, delegates no cgroup and ships no drop-in", () => {
    const unit = deployFile("linux", "automata-worker.service");
    expect(unit).not.toMatch(/^ExecStartPre=\+/m);
    expect(unit).not.toMatch(/nft-loopback-load|loopback-nft/);
    expect(unit).not.toMatch(/^Delegate=/m);
    expect(unit).toMatch(/^ProtectControlGroups=yes$/m);
    expect(
      fs.existsSync(
        path.join(workerRoot, "deploy", "linux", "automata-worker.service.d"),
      ),
    ).toBe(false);
  });

  it("runs as a service account, never root, and relaunches rate-limited", () => {
    const unit = deployFile("linux", "automata-worker.service");
    expect(unit).toMatch(/^User=__USER__$/m);
    expect(unit).not.toMatch(/^User=root$/m);
    expect(unit).toMatch(/^Restart=always$/m);
    expect(unit).toMatch(/^RestartSec=15$/m);
  });
});

describe("#192: the unit waits for the engine before the auth gate runs", () => {
  const unit = deployFile("linux", "automata-worker.service");

  it("gates start on engine readiness over loopback", () => {
    // `After=docker.service` orders against the daemon, not the compose stack's
    // readiness. Without this wait the launcher's fail-closed auth gate probes a
    // socket that is not listening and refuses curl's `000` — observed on the
    // first reboot drill. It self-heals, and that is the trap: it also stamps a
    // line indistinguishable from a real auth failure on every single boot.
    expect(unit).toMatch(/^ExecStartPre=.*api\/ready/m);
    expect(unit).toMatch(/127\.0\.0\.1:8888/);
  });

  it("bounds the wait — a dead engine must fail visibly, not hang", () => {
    // An unbounded wait parks the unit in `activating` forever, where
    // Restart=always never fires and nothing alerts.
    const pre = unit.match(/^ExecStartPre=.*$/m)?.[0] ?? "";
    expect(pre).toMatch(/seq 1 \d+/);
    expect(pre).not.toMatch(/while true|until .*; do .*done *'?$/);
    expect(pre).toMatch(/exit 1/);
  });

  it("runs the readiness wait BEFORE the launcher", () => {
    expect(unit.indexOf("ExecStartPre=")).toBeLessThan(
      unit.indexOf("ExecStart=/bin/bash"),
    );
  });
});

describe("#192: the unit's sandbox must not fence out the launcher's own writes", () => {
  it("every /usr path the launcher writes to is in ReadWritePaths", () => {
    // The bug this exists for: ProtectSystem=full remounts /usr read-only
    // inside the unit's namespace, and /usr/local/automata is under /usr. The
    // launcher stages the daemon bundle there on every start, so without the
    // exception the install fails "Read-only file system" — which survived
    // review of both files read separately once already. Only comparing them
    // catches it.
    const unit = deployFile("linux", "automata-worker.service");
    const script = deployFile("linux", "run-worker.sh.template");

    const protectsUsr = /^ProtectSystem=(full|strict|yes|true)$/m.test(unit);
    if (!protectsUsr) return;

    const rw = [...unit.matchAll(/^ReadWritePaths=(.+)$/gm)].flatMap((m) =>
      m[1] ? m[1].trim().split(/\s+/) : [],
    );

    // Destinations the launcher writes to, not every path it mentions.
    const written = [
      ...script.matchAll(/^\s*install\s+[^\n]*?\s(\/usr\/\S+)/gm),
      ...script.matchAll(/^\s*(?:cp|mv|tee)\s+[^\n]*?\s(\/usr\/\S+)/gm),
      ...script.matchAll(/>\s*(\/usr\/\S+)/gm),
    ].flatMap((m) => (m[1] ? [m[1]] : []));

    expect(
      written.length,
      "launcher writes nothing under /usr",
    ).toBeGreaterThan(0);
    for (const target of written) {
      const covered = rw.some(
        (p) => target === p || target.startsWith(p.replace(/\/$/, "") + "/"),
      );
      expect(
        covered,
        `${target} is written by run-worker.sh but no ReadWritePaths= covers it, ` +
          `and ProtectSystem makes /usr read-only`,
      ).toBe(true);
    }
  });

  it("the exception stays narrow — never all of /usr or /usr/local", () => {
    // Widening it hands the unit every other thing installed there.
    const unit = deployFile("linux", "automata-worker.service");
    const rw = [...unit.matchAll(/^ReadWritePaths=(.+)$/gm)].flatMap((m) =>
      m[1] ? m[1].trim().split(/\s+/) : [],
    );
    for (const p of rw) {
      expect(["/usr", "/usr/local", "/"]).not.toContain(p.replace(/\/$/, ""));
    }
  });

  it("cloud-init gives the runtime tree to the service account, not root", () => {
    // cloud-init runs as root, so a bare `install -d` leaves root:root and the
    // non-root worker gets EACCES — a second, independent cause of the same
    // failure, which survives fixing ReadWritePaths alone.
    const ci = deployFile("linux", "cloud-init.yaml");
    const treeInstall = ci.match(
      /install -d[^\n]*(?:\\\n\s*)?[^\n]*\/usr\/local\/automata\b[^\n]*/,
    );
    if (!treeInstall) {
      throw new Error("no install of /usr/local/automata found in cloud-init");
    }
    expect(treeInstall[0]).toMatch(/-o \S+/);
    expect(treeInstall[0]).not.toMatch(/-o root\b/);
  });
});

describe("packages/worker/deploy/linux — engine backup (#192)", () => {
  const script = deployFile("linux", "automata-engine-backup.sh");

  it("verifies the dump before keeping it, and writes via a temp name", () => {
    // The classic silent failure is a job that "succeeds" for months into a
    // zero-byte file and is discovered on the one day it is needed. Both guards
    // must survive: a size floor AND a real archive read.
    expect(script).toMatch(/pg_restore --list/);
    expect(script).toMatch(/MIN_BYTES/);
    // Dump to .partial, rename only after verification — a crash mid-write must
    // never leave a half-file wearing a good name.
    expect(script).toMatch(/\.partial/);
    const verify = script.indexOf("pg_restore --list");
    const rename = script.indexOf('mv -f "$TMP" "$FINAL"');
    expect(rename).toBeGreaterThan(verify);
  });

  it("dumps in a format pg_restore can actually read back", () => {
    // Plain SQL cannot be verified with `pg_restore --list`, so -Fc is what
    // makes the verification step above possible at all.
    expect(script).toMatch(/pg_dump[^\n]*-Fc/);
  });

  it("never prunes the last surviving dump", () => {
    // A fortnight of failures followed by a successful prune is how a backup
    // story ends with no backups.
    expect(script).toMatch(/REMAINING.*-gt 1|-gt 1/);
    expect(script).toMatch(/mtime "\+\$\{KEEP_DAYS\}"/);
  });

  it("keeps dumps unreadable by the agent and the worker accounts", () => {
    // A dump is the whole execution history, including the tenant the worker's
    // token is scoped to.
    expect(script).toMatch(/install -d -m 0700/);
    expect(script).toMatch(/chmod 0600/);
  });

  it("the unit fails loudly rather than retrying into silence", () => {
    const unit = deployFile("linux", "automata-engine-backup.service");
    expect(unit).toMatch(/^Type=oneshot$/m);
    expect(unit).not.toMatch(/^Restart=/m);
    expect(unit).toMatch(/^TimeoutStartSec=\d+$/m);
  });

  it("the timer catches up a run missed while the box was down", () => {
    const timer = deployFile("linux", "automata-engine-backup.timer");
    expect(timer).toMatch(/^Persistent=true$/m);
    expect(timer).toMatch(/^OnCalendar=/m);
  });
});

describe("ADR-013 P3: the host-uid execution path stays deleted", () => {
  /** Every file under `dir` (recursive), relative to the repo root. */
  function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : [path.relative(repoRoot, p)];
    });
  }
  // Assembled, so this file does not match its own guard.
  const j = (...parts: string[]) => parts.join("");
  const FORBIDDEN = [
    j("agent", "-uid"),
    j("uid", "-reaper"),
    j("batteries", "-seed"),
    j("harness", "-seed"),
    j("install", "-batteries"),
    j("meta ", "skuid"),
    j("reapAgent", "UidEscapees"),
    j("WORKER_DEV_", "CONTAINER_RUNS"),
  ];

  // card: protects=epic #427 AC8 + plan P3: none of the FORBIDDEN host-uid terms (the AC8 grep list, the uid-scan kill, the nft uid match and the retired dev switch) reappears in packages/worker/src or packages/worker/deploy; fails_when=any file there names one; no_claim=history docs outside those trees (ADRs, UAT evidence)
  it("no file in packages/worker/src or packages/worker/deploy names a host-uid term", () => {
    const files = [
      ...walk(path.join(workerRoot, "src")),
      ...walk(path.join(workerRoot, "deploy")),
    ];
    expect(files.length).toBeGreaterThan(50);
    // The rootless installer's own test asserts the installer never writes the
    // retired switch: that one negative assertion may name it.
    const switchGuard = path.join(
      "packages/worker/src/agent-run",
      "container-deploy-assets.test.ts",
    );
    const hits: string[] = [];
    for (const rel of files) {
      const text = read(path.join(repoRoot, rel));
      for (const term of FORBIDDEN) {
        if (rel === switchGuard && term === FORBIDDEN.at(-1)) continue;
        if (text.includes(term)) hits.push(`${rel}: ${term}`);
      }
    }
    expect(hits).toEqual([]);
  });

  // card: protects=the ADR-013 "Deleted in the release PR" files stay gone, and the image's lockfiles live next to its Dockerfile; fails_when=a deleted module, manifest, fence, loader, drop-in or provisioning doc is restored, or the lockfiles move back under the worker's deploy dir; no_claim=the box, which keeps them until P4
  it("the deleted modules and deploy assets are absent; the image lockfiles sit by the Dockerfile", () => {
    const gone = [
      "src/agent-run/spawn-as-user.ts",
      j("src/agent-run/agent", "-uid-fs.ts"),
      "src/agent-run/run-cgroup.ts",
      "src/agent-run/daemon-process.ts",
      "src/agent-run/batteries-manifest.ts",
      "src/agent-run/harness-manifest.ts",
      "src/agent-run/harness-layout.ts",
      "deploy/batteries.json",
      "deploy/harness.json",
      "deploy/sudoers.d-automata",
      "deploy/batteries",
      "deploy/linux/sudoers.d-automata",
      "deploy/linux/automata-batteries",
      "deploy/linux/batteries-dry-run.sh",
      "deploy/linux/harness-mcp-filter.mjs",
      "deploy/linux/harness-mcp-probe.mjs",
      "deploy/linux/egress-nft.conf",
      "deploy/linux/automata-egress.service",
      "deploy/linux/nft-preflight.sh",
      "deploy/linux/nft-verify.sh",
      "deploy/linux/loopback-nft.conf",
      "deploy/linux/nft-loopback-load.sh",
    ];
    for (const rel of gone) {
      expect(fs.existsSync(path.join(workerRoot, rel)), rel).toBe(false);
    }
    for (const lock of [
      "gsd/package-lock.json",
      "ruflo/package-lock.json",
      "somnio-cli/pubspec.lock",
    ]) {
      expect(
        fs.existsSync(
          path.join(repoRoot, "deploy", "images", "batteries", lock),
        ),
        lock,
      ).toBe(true);
    }
    const dockerfile = read(
      path.join(repoRoot, "deploy", "images", "batteries", "Dockerfile"),
    );
    expect(dockerfile).not.toMatch(/COPY batteries\//);
  });
});
