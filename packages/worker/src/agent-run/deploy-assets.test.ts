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
});
