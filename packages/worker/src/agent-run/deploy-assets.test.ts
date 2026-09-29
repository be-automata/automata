import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Rot guards for the #108 deploy templates. These are pure file reads: no sudo,
 * no pfctl, no visudo, no network — they pass on Linux CI.
 *
 * They exist because the templates encode decisions that are expensive to get
 * wrong on a live box (fencing the operator's own uid; a sudo rule that makes
 * `-E` fail; enabling PF in a way any system component can silently undo) and
 * cheap to "tidy" back out during an unrelated edit.
 */

const workerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const repoRoot = path.resolve(workerRoot, "..", "..");
const read = (p: string) => fs.readFileSync(p, "utf8");

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

describe("packages/worker/deploy/sudoers.d-automata", () => {
  const sudoers = read(path.join(workerRoot, "deploy", "sudoers.d-automata"));

  it("carries SETENV on the daemon rule (without it sudo -E is refused)", () => {
    expect(sudoers).toMatch(/NOPASSWD:\s*SETENV:\s*AUTOMATA_DAEMON/);
  });

  it("disables use_pty and I/O logging", () => {
    const defaults = sudoers
      .split("\n")
      .filter((l) => l.startsWith("Defaults!"));
    expect(defaults.length).toBeGreaterThan(0);
    expect(defaults.some((l) => l.includes("!use_pty"))).toBe(true);
    expect(defaults.some((l) => l.includes("!log_output"))).toBe(true);
    expect(defaults.some((l) => l.includes("!log_input"))).toBe(true);
  });

  it("runs as the role account — never root, never ALL", () => {
    const rules = sudoers
      .split("\n")
      .filter((l) => !l.startsWith("#") && l.includes("NOPASSWD"));
    expect(rules.length).toBe(2);
    for (const rule of rules) {
      expect(rule, rule).toContain("(AGENT)");
      expect(rule, rule).not.toContain("(root)");
      expect(rule, rule).not.toContain("(ALL)");
    }
    expect(sudoers).toMatch(/Runas_Alias AGENT = _automata-agent/);
  });

  it("documents the grant as a uid drop, NOT a command fence", () => {
    // sudoers(5): a bare command path permits any arguments, so argv scoping is
    // not a fence and must never be described as one.
    // Comment markers and wrapping are noise here — normalise before matching.
    const prose = sudoers.replace(/\n#?\s*/g, " ");
    expect(prose).toMatch(/NOT a command fence/i);
    expect(prose).toMatch(/UID-DROP CAPABILITY/i);
  });
});

describe("packages/worker/deploy — PF wrapper, scripts and LaunchDaemon", () => {
  const deploy = (f: string) => read(path.join(workerRoot, "deploy", f));

  it("the wrapper conf INCLUDES /etc/pf.conf rather than editing it", () => {
    // /etc/pf.conf is rewritten by OS updates; an edit there silently vanishes.
    const wrapper = deploy("automata-pf.conf");
    expect(wrapper).toMatch(/^include "\/etc\/pf\.conf"$/m);
    expect(wrapper).toMatch(/anchor "automata-egress"/);
    expect(wrapper).toMatch(
      /load anchor "automata-egress" from "\/etc\/pf\.anchors\/automata-egress"/,
    );
  });

  it("the LaunchDaemon loads the WRAPPER with -E, never -e", () => {
    const plist = deploy("com.automata.pf.plist");
    expect(plist).toContain("<string>-E</string>");
    expect(plist).not.toContain("<string>-e</string>");
    expect(plist).toContain("<string>/etc/automata-pf.conf</string>");
    expect(plist).not.toContain("<string>/etc/pf.conf</string>");
  });

  it("the preflight script refuses uid 501, an unsubstituted placeholder, and parses first", () => {
    const preflight = deploy("pf-preflight.sh");
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
    const verify = deploy("pf-verify.sh");
    expect(verify).toMatch(/pfctl -s info/);
    expect(verify).toMatch(/Status: Enabled/);
    expect(verify).toMatch(/pfctl -a automata-egress -sr/);
  });

  it("the provisioning doc states the PF limits instead of overclaiming", () => {
    const doc = deploy("AGENT-UID-PROVISIONING.md");
    expect(doc).toMatch(/TN3165/);
    expect(doc).toMatch(/15\.0–15\.3\.1|15\.0-15\.3\.1/);
    expect(doc).toMatch(/forwarded packets/);
    expect(doc).toMatch(/NetworkExtension/);
    // and the honest scope of the uid boundary
    expect(doc).toMatch(/does \*\*not\*\* buy|Does \*\*not\*\* buy/i);
    expect(doc).toMatch(/Per-run isolation/);
  });

  it("the provisioning doc fixes what sysadminctl gets wrong", () => {
    // Both were found by running the real command on a real box, and both are
    // silent: sysadminctl reports success either way. Without the `staff`
    // removal the uid split is COSMETIC — macOS home dirs are drwxr-x--- <user>
    // staff, so a staff member traverses the operator's home and lists ~/.ssh,
    // ~/.claude and ~/Library/Keychains. If this assertion ever fails because
    // someone trimmed the doc, the boundary silently stops existing.
    const doc = deploy("AGENT-UID-PROVISIONING.md");
    expect(doc).toMatch(/dseditgroup -o edit -d _automata-agent -t user staff/);
    expect(doc).toMatch(/dseditgroup -o create/);
    expect(doc).toMatch(/STILL IN STAFF/);
    // the uid must be chosen on the box: 300 collides with Apple's _aonsensed
    expect(doc).toMatch(/_aonsensed/);
    expect(doc).not.toMatch(/-UID 300\b/);
  });
});

describe("#183: single worker unit", () => {
  const deploy = (f: string) => read(path.join(workerRoot, "deploy", f));

  it("no deploy asset entry names the retired second unit", () => {
    const entries = fs.readdirSync(path.join(workerRoot, "deploy"));
    expect(entries.some((entry) => /worker-2/.test(entry))).toBe(false);
  });

  it("the runbook and provisioning doc no longer mention the second unit", () => {
    expect(deploy("README.md")).not.toContain("worker-2");
    expect(deploy("AGENT-UID-PROVISIONING.md")).not.toContain("worker-2");
  });

  it("the concurrency-cap citation points at definition.ts, not workflow.ts", () => {
    const readme = deploy("README.md");
    expect(readme).not.toContain("src/agent-run/workflow.ts");
    const paragraphs = readme.split(/\n{2,}/);
    const capParagraph = paragraphs.find((p) => p.includes("GLOBAL_MAX_RUNS"));
    expect(capParagraph, readme).toBeTruthy();
    expect(capParagraph).toContain("definition.ts");
  });

  it("only the single worker unit plist remains, and it declares the right label", () => {
    const plist = deploy("com.automata.worker.plist");
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
});

describe("packages/worker/deploy/linux/cloud-init.yaml (#192)", () => {
  const cloudInit = read(
    path.join(workerRoot, "deploy", "linux", "cloud-init.yaml"),
  );

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

  it("writes the sentinel only AFTER the assertions", () => {
    // `/usr/local/automata/.provisioned` is the contract downstream checks
    // instead of cloud-init's own status. Hoisting it above the assertions
    // would make it mean nothing while still appearing to work.
    // Anchored on the line that WRITES it — the path is also named in the
    // header comment, and matching that instead would pass no matter where
    // the write actually sits.
    const floorCheck = cloudInit.indexOf("is below");
    const sentinel = cloudInit.indexOf(
      "date -uIseconds > /usr/local/automata/.provisioned",
    );
    expect(floorCheck).toBeGreaterThan(-1);
    expect(sentinel).toBeGreaterThan(-1);
    expect(sentinel).toBeGreaterThan(floorCheck);
  });

  it("installs acl, which the Linux agent-uid fence needs to exist at all", () => {
    // setfacl/getfacl are how the fence works on Linux. Absent, it degrades
    // silently — the precise failure #192 exists to remove on this platform.
    expect(cloudInit).toMatch(/^\s+- acl$/m);
    expect(cloudInit).toMatch(/command -v setfacl/);
  });
});
