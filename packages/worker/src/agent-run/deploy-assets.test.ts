import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { REVIEW_BATTERY_PACK_IDS } from "../../../shared/src/model/review-agent-settings";
import {
  BATTERIES_MANIFEST_REPO_PATH,
  BATTERIES_OVERLAY_DIR,
  isBatteriesManifest,
  type BatteriesManifest,
} from "./batteries-manifest";

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

/**
 * Lines between the first two `---` lines, or [] when the file has no leading
 * frontmatter block.
 */
function frontmatterLines(md: string): string[] {
  const lines = md.split("\n");
  if (lines[0] !== "---") return [];
  const end = lines.indexOf("---", 1);
  return end === -1 ? [] : lines.slice(1, end);
}

function readBatteriesManifest(): BatteriesManifest {
  const parsed: unknown = JSON.parse(
    read(path.join(repoRoot, BATTERIES_MANIFEST_REPO_PATH)),
  );
  if (!isBatteriesManifest(parsed)) {
    throw new Error(
      `${BATTERIES_MANIFEST_REPO_PATH} is not a valid batteries manifest`,
    );
  }
  return parsed;
}

describe("#batteries (phase 3): batteries.json", () => {
  // The box installs exactly what this file pins (install-batteries.sh), and
  // Phase 5 seeds runs from it. Every assertion here is a decision that was
  // expensive to research and cheap to undo in an unrelated edit.
  const manifest = readBatteriesManifest();
  const packById = (id: string) => {
    const found = manifest.packs.find((p) => p.id === id);
    if (found === undefined) throw new Error(`no pack ${id} in the manifest`);
    return found;
  };

  it("is schemaVersion 1 and passes the strict guard", () => {
    expect(manifest.schemaVersion).toBe(1);
  });

  it("lists exactly the shared REVIEW_BATTERY_PACK_IDS, in order", () => {
    // The admin panel (Phase 4) offers these ids; a pack the box does not
    // install, or an install the panel cannot select, is a silent no-op.
    expect(manifest.packs.map((p) => p.id)).toEqual([
      ...REVIEW_BATTERY_PACK_IDS,
    ]);
  });

  it("pins every pack, path and CLI by a full content address", () => {
    for (const pack of manifest.packs) {
      expect(pack.sha, pack.id).toMatch(/^[0-9a-f]{40}$/);
      expect(pack.license.trim(), pack.id).not.toBe("");
      for (const sub of pack.subpaths) {
        expect(sub.gitId, `${pack.id} ${sub.src}`).toMatch(/^[0-9a-f]{40}$/);
      }
    }
    for (const cli of manifest.clis) {
      expect(cli.sha256, cli.name).toMatch(/^[0-9a-f]{64}$/);
      expect(cli.license.trim(), cli.name).not.toBe("");
    }
  });

  it("keeps the researched pins", () => {
    expect(packById("gstack-review").sha).toBe(
      "fe6d1ae62a42e67bfb12b7f8e6143c705f375f38",
    );
    expect(packById("gsd-reviewers").sha).toBe(
      "7dfeb7ad8acbd6febd2c8c6cf7d3dcb7d1aeb7b9",
    );
    const somnio = packById("somnio-review");
    expect(somnio.repo).toBe("self");
    expect(somnio.sha).toBe("e2716a48d0528a42cbb343307280069b2556680c");
    expect(somnio.subpaths.map((s) => s.gitId)).toEqual([
      "4d97eeeafb6c9f46ad62e3ed71d47416816f5341",
    ]);
  });

  it("installs exactly shellcheck, actionlint and gitleaks; semgrep is dropped", () => {
    expect(manifest.clis.map((c) => c.name)).toEqual([
      "shellcheck",
      "actionlint",
      "gitleaks",
    ]);
    expect(manifest.clis.map((c) => c.name)).not.toContain("semgrep");
    expect(manifest.dropped.map((d) => d.name)).toContain("semgrep");
  });

  it("vendors no hook, bin, plugin, settings, cso, sections or upstream review SKILL.md", () => {
    // Upstream review/SKILL.md's preamble can fall back to executing a
    // PR-supplied script from the checkout; cso needs a native launcher.
    const forbidden =
      /(^|\/)(hooks|bin|\.claude-plugin|cso|sections)(\/|$)|(^|\/)(settings(\.local)?\.json|\.mcp\.json|plugin\.json)$|review\/SKILL\.md/;
    for (const pack of manifest.packs) {
      for (const sub of pack.subpaths) {
        expect(sub.src, pack.id).not.toMatch(forbidden);
        expect(sub.dest, pack.id).not.toMatch(forbidden);
      }
    }
  });

  it("selects only the knowledge files of each pack", () => {
    expect(
      [...new Set(packById("gstack-review").subpaths.map((s) => s.src))].sort(),
    ).toEqual(["LICENSE", "review/checklist.md", "review/specialists"]);
    expect(packById("gsd-reviewers").subpaths.map((s) => s.src)).toEqual([
      "agents/gsd-code-reviewer.md",
      "agents/gsd-security-auditor.md",
      "LICENSE",
    ]);
    const somnio = packById("somnio-review");
    const excluded = somnio.subpaths.flatMap((s) => s.exclude ?? []);
    expect(excluded).toContain("references/gemini-analysis.md");
    expect(excluded).toContain("agents/gemini-analyzer.md");
    // The skill's internal agents (model: opus, Write tools) must stay inside
    // the skill dir; under agents/ they would register as user agents.
    for (const sub of somnio.subpaths) {
      expect(sub.dest).not.toMatch(/^agents\//);
    }
  });

  it("ships every overlay from this repo", () => {
    for (const pack of manifest.packs) {
      for (const overlay of pack.overlays ?? []) {
        expect(overlay.from.startsWith(BATTERIES_OVERLAY_DIR)).toBe(true);
        expect(
          fs.existsSync(path.join(repoRoot, overlay.from)),
          overlay.from,
        ).toBe(true);
      }
    }
  });
});

describe("#batteries (phase 3): gstack-review adapter skill", () => {
  // The upstream interactive review skill is never installed; this adapter is
  // what the review lane reads instead. It must stay read-only, helper-free
  // and fence-free, and it must override two hazards in the pinned files.
  const adapterPath = path.join(
    workerRoot,
    "deploy",
    "batteries",
    "gstack-review",
    "SKILL.md",
  );
  const adapter = fs.existsSync(adapterPath) ? read(adapterPath) : "";
  const front = frontmatterLines(adapter);
  const body = adapter
    .split("\n")
    .slice(front.length + 2)
    .join("\n");

  it("has a minimal frontmatter: name + description only, no grants", () => {
    // allowed-tools in a skill GRANTS tools for the invoking turn in -p mode.
    expect(front).toContain("name: gstack-review");
    expect(front.some((l) => /^description:\s*\S/.test(l))).toBe(true);
    for (const key of [
      "allowed-tools:",
      "hooks:",
      "model:",
      "context:",
      "permissionMode:",
      "mcpServers:",
      "disable-model-invocation:",
    ]) {
      expect(
        front.some((l) => l.startsWith(key)),
        key,
      ).toBe(false);
    }
  });

  it("names no gstack helper, interactive-question tool or JSON fence", () => {
    // Phase 2 Q7: a sub-agent's fenced JSON can become the last fence the
    // review-intent parser reads, hijacking the lead's verdict.
    for (const token of [
      "gstack/bin",
      "gstack-skill-start",
      "gstack-decision-search",
      "AskUserQuestion",
      "```json",
    ]) {
      expect(adapter, token).not.toContain(token);
    }
  });

  it("reads the vendored checklist and specialists from its own dir", () => {
    expect(body).toContain("${CLAUDE_SKILL_DIR}/checklist.md");
    expect(body).toContain("${CLAUDE_SKILL_DIR}/specialists/");
  });

  it("is read-only and reports to the lead", () => {
    expect(body).toMatch(/read-only/i);
    expect(body).toMatch(/never (write|edit)/i);
    expect(body).toMatch(/lead/);
  });

  it("treats decision-ledger markers as UNVERIFIED and never runs vendored commands", () => {
    // checklist.md (blob 7692f35) tells the reader to resolve these markers
    // with a gstack helper that is not, and must never be, installed.
    expect(body).toMatch(/gstack-shortcut/);
    expect(body).toMatch(/UNVERIFIED/);
    expect(body).toMatch(/never run[^\n]*command[^\n]*(checklist|specialist)/i);
  });

  it("supersedes the specialists' JSON output format", () => {
    // Every specialists/*.md line 4 says "Output: JSON objects … Schema:".
    expect(body).toMatch(/(ignore|supersede)[^\n]*(output|schema)/i);
  });
});

/** Text from `name() {` to the next line that is exactly `}`. */
function fnBody(script: string, name: string): string {
  const start = script.indexOf(`\n${name}() {\n`);
  if (start === -1) throw new Error(`function ${name}() not found`);
  const end = script.indexOf("\n}\n", start + 1);
  if (end === -1) throw new Error(`function ${name}() is not closed`);
  return script.slice(start + 1, end + 2);
}

/** The script without its full-line `#` comments. */
function code(script: string): string {
  return script
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

describe("#batteries (phase 3): install-batteries.sh", () => {
  // The installer runs as root against a worker-writable checkout and
  // fetches from the internet. Each assertion pins a safety property in the
  // function that owns it, so a refactor cannot quietly move it out.
  const scriptPath = path.join(
    workerRoot,
    "deploy",
    "linux",
    "install-batteries.sh",
  );
  const script = fs.existsSync(scriptPath) ? read(scriptPath) : "";
  const src = code(script);
  const body = (name: string) => fnBody(script, name);

  it("is an executable bash script with strict mode, umask and a neutral cwd", () => {
    expect(fs.statSync(scriptPath).mode & 0o100).not.toBe(0);
    const lines = script.split("\n");
    expect(lines[0]).toBe("#!/bin/bash");
    expect(lines[1]).toBe("set -euo pipefail");
    expect(lines[2]).toBe("umask 022");
    expect(src).toMatch(/^cd \/$/m);
    expect(src).toContain("unset GIT_DIR");
  });

  it("refuses non-root, and dry-run knobs for root or the real prefix", () => {
    expect(src).toContain("id -u");
    expect(src).toContain("must run as root");
    expect(src).toContain("dry-run knobs are refused for root");
    expect(src).toContain("require a non-default PREFIX");
    expect(src).toContain("pwd -P");
  });

  it("reads the manifest from the checkout's HEAD commit and re-checks its shapes", () => {
    expect(src).toContain("packages/worker/deploy/batteries.json");
    expect(src).toContain('cat-file blob "$HEAD_SHA:');
    expect(src).toContain("jq -e");
    expect(src).toContain(".clis[]");
    expect(src).toContain(".packs[]");
    const preflight = body("preflight");
    expect(preflight).toContain("[a-z0-9][a-z0-9-]*");
    expect(preflight).toContain("-{0,2}[a-z]+");
    expect(preflight).toContain("licenseMember");
    expect(preflight).toContain("safe_rel_path");
    expect(body("safe_rel_path")).toContain("..");
  });

  it("is generic over the manifest: no pack or CLI is named in code", () => {
    const generic = src
      .split("\n")
      .filter((l) => !/^ALLOWED_HELPER_REF(_FILE)?=/.test(l))
      .join("\n");
    for (const name of [
      "shellcheck",
      "actionlint",
      "gitleaks",
      "gstack-review",
      "somnio",
      "gsd-",
    ]) {
      expect(generic, name).not.toContain(name);
    }
  });

  it("allowlists exactly one helper reference in exactly one file", () => {
    // gstack checklist.md (blob 7692f35) names the decision-ledger helper
    // once; the adapter declares that ledger unavailable. Any other
    // occurrence, or a different count after a pin bump, must fail.
    const fileLines = script
      .split("\n")
      .filter((l) => l.startsWith("ALLOWED_HELPER_REF_FILE="));
    const refLines = script
      .split("\n")
      .filter((l) => l.startsWith("ALLOWED_HELPER_REF="));
    expect(fileLines).toEqual([
      'ALLOWED_HELPER_REF_FILE="skills/gstack-review/checklist.md"',
    ]);
    expect(refLines).toEqual([
      "ALLOWED_HELPER_REF='~/.claude/skills/gstack/bin/gstack-decision-search'",
    ]);
    const verify = body("verify_staging");
    expect(verify).toContain("$ALLOWED_HELPER_REF_FILE");
    expect(verify).toContain('$ALLOWED_HELPER_REF"');
    expect(verify).toMatch(/-ne 1|!= 1|-eq 1/);
  });

  it("materialises content only through git object plumbing", () => {
    // The checkout is worker-writable: porcelain honours .gitattributes and
    // repo config, so its bytes need not match the pinned object ids.
    const extract = body("extract_object");
    expect(extract).toContain("ls-tree -r -z");
    expect(extract).toContain("cat-file blob");
    expect(extract).toContain("120000");
    expect(extract).toContain("160000");
    const pack = body("install_pack");
    expect(pack.match(/extract_object /g)?.length ?? 0).toBeGreaterThanOrEqual(
      1,
    );
    expect(pack).toContain("git_repo");
    expect(pack).toContain("git_fetch");
    expect(src).not.toContain("git archive");
    expect(src).not.toContain("archive ");
    expect(src).not.toMatch(/\bcp\b[^\n]*AUTOMATA_REPO/);
    expect(pack).toContain('cat-file blob "$HEAD_SHA:');
    expect(src).toContain("SOURCE checkout");
  });

  it("hardens every git call against the automata-owned checkout", () => {
    const gitRepo = body("git_repo");
    expect(gitRepo).toContain("safe.directory");
    expect(gitRepo).toContain("core.fsmonitor=false");
    expect(gitRepo).toContain("core.hooksPath=/dev/null");
  });

  it("checks a CLI's sha256 before anything reaches the bin dir", () => {
    const cli = body("install_cli");
    expect(cli).toContain("sha256sum -c");
    expect(cli).toContain("curl -fsSL");
    expect(cli).toContain("--proto '=https'");
    expect(cli).toContain("tar -xzf");
    expect(cli.indexOf("$BIN_DIR")).toBeGreaterThan(
      cli.indexOf("sha256sum -c"),
    );
    expect(cli).toContain("mv -f");
  });

  it("fetches packs by sha, checks object ids before publishing, never prunes", () => {
    const pack = body("install_pack");
    expect(pack).toContain("fetch");
    expect(pack).toContain("--depth 1");
    expect(pack).toContain("FETCH_HEAD");
    expect(pack).toContain("rev-parse");
    expect(pack.indexOf("extract_object")).toBeLessThan(
      pack.indexOf("publish_dir"),
    );
    expect(body("extract_object")).toContain("rev-parse");
    expect(src).toContain("STALE");
    expect(src).not.toMatch(/rm -rf "?\$\{?ROOT\}?\/[^"\n]*@/);
  });

  it("publishes atomically when it can and documents the fallback window", () => {
    const publish = body("publish_dir");
    expect(publish).toContain("--exchange");
    expect(publish).toMatch(/#[^\n]*run in flight/);
  });

  it("strips grant keys and re-verifies the staged tree", () => {
    const strip = body("strip_frontmatter");
    const verify = body("verify_staging");
    for (const key of [
      "allowed-tools",
      "hooks",
      "permissionMode",
      "mcpServers",
    ]) {
      expect(strip, key).toContain(key);
      expect(verify, key).toContain(key);
    }
    for (const token of [
      ".mcp.json",
      "settings",
      "plugin.json",
      "gstack/bin",
      "gstack-skill-start",
      "-type l",
    ]) {
      expect(verify, token).toContain(token);
    }
  });

  it("forces root ownership and read-only modes", () => {
    expect(src).toContain("chmod 0644");
    expect(src).toContain("chmod 0755");
    expect(src).toContain("chown -R root:root");
  });

  it("verifies through the real worker → sudo → agent spawn shape, values via env only", () => {
    const verify = body("verify_as_agent") + body("as_agent");
    expect(verify).toMatch(/runuser -u "?\$\{?WORKER_USER\}?"? --/);
    expect(verify).toMatch(
      /\/usr\/bin\/sudo -n -u "?\$\{?AGENT_USER\}?"? -E -- \/bin\/sh -c/,
    );
    for (const token of [
      "bash -lc",
      "command -v",
      "</dev/null",
      "mktemp -d",
      "BATTERIES_CHECK_NAME",
    ]) {
      expect(verify, token).toContain(token);
    }
    expect(verify).not.toMatch(
      /bash -lc[^\n]*\$\{?(name|cli|args|path|pack)\b/,
    );
    expect(script).toContain('AGENT_USER="${AGENT_USER:-automata-agent}"');
  });

  it("invalidates manifest.sha256 first and rewrites it only on a clean run", () => {
    const main = body("main");
    const invalidate = main.indexOf("invalidate_manifest_hash");
    const firstCli = main.indexOf("install_cli");
    const verifyCall = main.indexOf("verify_as_agent");
    const write = main.indexOf("write_manifest_hash");
    expect(invalidate).toBeGreaterThan(-1);
    expect(invalidate).toBeLessThan(firstCli);
    expect(write).toBeGreaterThan(verifyCall);
    expect(main.slice(verifyCall, write)).toMatch(/FAILURES"? -eq 0/);
    expect(body("invalidate_manifest_hash")).toContain(
      "manifest.sha256.invalid",
    );
  });

  it("counts a FAIL line by its first word, whatever the argument split", () => {
    // Dry-run finding: callers pass the whole line as ONE argument, so a
    // `case "$1" in FAIL)` never matched — every failure was silently
    // dropped, the run printed RESULT: PASS and wrote manifest.sha256.
    const record = body("record");
    expect(record).toContain('case "$*" in');
    expect(record).toContain('"FAIL "*)');
    expect(record).not.toMatch(/case "\$1" in/);
  });

  it("iterates object lists compactly, one entry per line", () => {
    // Dry-run finding: `jq -r` pretty-prints objects across many lines, so
    // reading `.subpaths[]` / overlays line by line split every entry.
    expect(src).not.toMatch(/jf "\$[a-z_]+" '\.(subpaths|overlays)/);
    expect(body("jl")).toContain("jq -c");
    expect(body("preflight")).toContain("control character");
  });

  it("ends with a PASS/FAIL result and installs nothing from PyPI", () => {
    expect(script).toContain("RESULT: PASS");
    expect(script).toContain("RESULT: FAIL");
    expect(src).toContain("exit 1");
    expect(script).not.toContain("semgrep");
    expect(script).not.toContain("pip install");
  });

  // The only two tests in this file that spawn a process: bash and
  // shellcheck are local static checkers (no network, no sudo).
  it("parses with bash -n", () => {
    expect(() =>
      execFileSync("bash", ["-n", scriptPath], { stdio: "pipe" }),
    ).not.toThrow();
  });

  const hasShellcheck =
    spawnSync("shellcheck", ["--version"], { stdio: "ignore" }).status === 0;
  it.skipIf(!hasShellcheck)("is shellcheck clean", () => {
    const result = spawnSync("shellcheck", ["-s", "bash", scriptPath], {
      encoding: "utf8",
    });
    expect(result.status, result.stdout).toBe(0);
  });
});

describe("#batteries (phase 3): cloud-init + runbook", () => {
  const cloudInit = read(
    path.join(workerRoot, "deploy", "linux", "cloud-init.yaml"),
  );
  const runbook = read(path.join(repoRoot, "deploy", "PILOT-RUNBOOK.md"));
  const agentUidDoc = read(
    path.join(workerRoot, "deploy", "AGENT-UID-PROVISIONING.md"),
  );

  it("calls install-batteries.sh only when the checkout's manifest exists", () => {
    // On first boot /opt/automata-platform is the empty dir created above;
    // the call must skip with a message, not fail provisioning.
    expect(cloudInit).toContain("install-batteries.sh");
    expect(cloudInit).toMatch(
      /\[ -f \/opt\/automata-platform\/packages\/worker\/deploy\/batteries\.json \]/,
    );
    expect(cloudInit).toContain("batteries: SKIPPED");
  });

  it("installs batteries only AFTER the base-provisioned sentinel", () => {
    // Batteries must never block base provisioning: the sentinel means the
    // box is usable, and manifest.sha256 is the separate batteries contract.
    const sentinel = cloudInit.indexOf(
      "date -uIseconds > /usr/local/automata/.provisioned",
    );
    const call = cloudInit.indexOf(
      "bash /opt/automata-platform/packages/worker/deploy/linux/install-batteries.sh",
    );
    expect(sentinel).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(sentinel);
  });

  it("documents the production step: a verified root-owned copy, never the stale provision script", () => {
    for (const token of [
      "install-batteries.sh",
      "safe.directory",
      "--ff-only",
      "ls-remote",
      "cat-file blob",
      "manifest.sha256",
      "RESULT: PASS",
    ]) {
      expect(runbook, token).toContain(token);
    }
    expect(runbook).toMatch(/do not re-run[^\n]*automata-provision\.sh/i);
    expect(runbook).toMatch(/no worker restart/i);
    expect(runbook).toMatch(/verify_as_agent[^\n]*(finding|bug)/i);
    expect(runbook).toMatch(/semgrep[^\n]*dropped|dropped[^\n]*semgrep/i);
  });

  it("points Linux operators from the agent-uid doc to the battery install", () => {
    expect(agentUidDoc).toContain("install-batteries.sh");
  });
});

describe("packages/worker/deploy/linux — systemd unit + launcher (#192)", () => {
  const linux = (f: string) =>
    read(path.join(workerRoot, "deploy", "linux", f));

  it("the launcher ends in `exec node`, with nothing wrapping it", () => {
    // A `pnpm run` chain swallows SIGTERM at the top pnpm layer, so the signal
    // never reaches the worker and the drain silently breaks — live-verified on
    // macOS 2026-07-25, and systemd's MainPID has the same problem. The exec
    // must be the LAST line, not merely present somewhere.
    const script = linux("run-worker.sh.template");
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
    const script = linux("run-worker.sh.template");
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

  it("the launcher points WORKER_DAEMON_DIST at the bundle it stages (UAT #229 F1)", () => {
    // The launcher used to stage the daemon into /usr/local/automata/daemon on
    // every agent-uid boot while the worker, with WORKER_DAEMON_DIST unset,
    // spawned the checkout's packages/daemon/dist instead. The staged snapshot
    // is the one pinned to this boot's revision; a later build in the checkout
    // must not change what the running worker's agents execute. Pin that the
    // block which writes the file also exports its path — same path, after the
    // install, inside the agent-uid branch, before the exec.
    const script = linux("run-worker.sh.template");
    const block = script.match(
      /^if \[ -n "\$\{WORKER_AGENT_USER:-\}" \]; then\n([\s\S]*?)^fi$/m,
    );
    expect(block, "agent-uid staging block not found").toBeTruthy();
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
    // Exported nowhere else: outside agent-uid mode the checkout's dist is
    // correct (the agent is this worker's own child and can read it).
    expect(script.match(/export WORKER_DAEMON_DIST=/g)).toHaveLength(1);

    // The macOS runbook's launcher snippet carries the same contract.
    const readme = read(path.join(workerRoot, "deploy", "README.md"));
    expect(readme).toMatch(
      /install -m 0444 \S+ \/usr\/local\/automata\/daemon\/index\.js[^\n]*\n(?:\s*#[^\n]*\n)*\s*export WORKER_DAEMON_DIST=\/usr\/local\/automata\/daemon\/index\.js\n/,
    );
  });

  it("the unit signals only MainPID, so the SDK owns the drain", () => {
    // KillMode=control-group SIGTERMs the agent and its daemon directly and
    // drops the in-flight review. `mixed` sends SIGTERM to MainPID alone and
    // lets the worker decide when its children die.
    const unit = linux("automata-worker.service");
    expect(unit).toMatch(/^KillMode=mixed$/m);
    expect(unit).not.toMatch(/^KillMode=control-group$/m);
    expect(unit).toMatch(/^KillSignal=SIGTERM$/m);

    // The stop budget must clear a real agent run. Anything small silently
    // reintroduces the mid-run SIGKILL under a different name.
    const stop = unit.match(/^TimeoutStopSec=(\d+)$/m);
    expect(stop, unit).toBeTruthy();
    expect(Number(stop![1])).toBeGreaterThanOrEqual(1800);
  });

  it("keeps NoNewPrivileges OFF — the agent-uid drop depends on it", () => {
    // The worker spawns the agent under a DIFFERENT uid via sudo. Turning this
    // on reads like hardening and instead breaks the uid boundary the whole
    // egress fence is keyed on.
    const unit = linux("automata-worker.service");
    expect(unit).toMatch(/^NoNewPrivileges=no$/m);
    expect(unit).not.toMatch(/^NoNewPrivileges=(yes|true)$/m);
  });

  it("runs as a service account, never root, and relaunches rate-limited", () => {
    const unit = linux("automata-worker.service");
    expect(unit).toMatch(/^User=__USER__$/m);
    expect(unit).not.toMatch(/^User=root$/m);
    expect(unit).toMatch(/^Restart=always$/m);
    expect(unit).toMatch(/^RestartSec=15$/m);
  });
});

describe("#192: the unit waits for the engine before the auth gate runs", () => {
  const unit = read(
    path.join(workerRoot, "deploy", "linux", "automata-worker.service"),
  );

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
  const linux = (f: string) =>
    read(path.join(workerRoot, "deploy", "linux", f));

  it("every /usr path the launcher writes to is in ReadWritePaths", () => {
    // The bug this exists for: ProtectSystem=full remounts /usr read-only
    // inside the unit's namespace, and /usr/local/automata is under /usr. The
    // launcher stages the daemon bundle there on every agent-uid run, so the
    // install fails "Read-only file system" the moment WORKER_AGENT_USER is
    // set — and never before, which is why it survived review of both files
    // read separately. Only comparing them catches it.
    const unit = linux("automata-worker.service");
    const script = linux("run-worker.sh.template");

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
    const unit = linux("automata-worker.service");
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
    const ci = linux("cloud-init.yaml");
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

describe("packages/worker/deploy/linux — egress fence + sudoers (#192 P7/P9)", () => {
  const linux = (f: string) =>
    read(path.join(workerRoot, "deploy", "linux", f));

  it("the ruleset owns ONE table and never flushes the kernel's", () => {
    // Ubuntu's stock /etc/nftables.conf opens with `flush ruleset`, and Docker
    // keeps 34 chains in the kernel ruleset that it does NOT rebuild on demand.
    // A global flush here takes container networking — and on this box that is
    // the Hatchet engine and its Postgres — down with it.
    const conf = linux("egress-nft.conf");
    expect(conf).not.toMatch(/^\s*flush ruleset/m);
    expect(conf).toMatch(/^table inet automata_egress$/m);
    expect(conf).toMatch(/^delete table inet automata_egress$/m);
  });

  it("fences tcp AND udp, so QUIC is not a hole", () => {
    // udp/443 is HTTP-3. A tcp-only rule leaves an https path that never meets
    // the cooperative proxy.
    const conf = linux("egress-nft.conf");
    expect(conf).toMatch(/meta skuid __AGENT_UID__ tcp dport \{ 80, 443 \}/);
    expect(conf).toMatch(/meta skuid __AGENT_UID__ udp dport \{ 80, 443 \}/);
  });

  it("accepts loopback and never sets a drop policy on output", () => {
    // The per-run proxy, both brokers and the engine are all on 127.0.0.1. A
    // drop policy on the output hook fences the whole box, sshd included.
    const conf = linux("egress-nft.conf");
    expect(conf).toMatch(/oif "lo" accept/);
    expect(conf).toMatch(/policy accept;/);
    expect(conf).not.toMatch(/policy drop;/);
    // Loopback must be accepted BEFORE the skuid rejects.
    expect(conf.indexOf('oif "lo" accept')).toBeLessThan(
      conf.indexOf("meta skuid"),
    );
  });

  it("the preflight refuses uid 0 and the worker's own uid before loading", () => {
    // Fencing either kills the control-plane poll, the git broker's upstream
    // fetch and the credential pull — every run on the box — and both are one
    // typo from the agent uid.
    const pre = linux("nft-preflight.sh");
    expect(pre).toMatch(/refusing to fence uid 0/);
    expect(pre).toMatch(/refusing to fence the worker's own uid/);
    expect(pre).toMatch(/__AGENT_UID__.*unrendered|unrendered/);
    // Parse-check must precede the load.
    expect(pre.indexOf("nft -c -f")).toBeLessThan(pre.indexOf("nft -f"));
  });

  it("the sudoers rule drops to the role account, never root or ALL", () => {
    const sudoers = linux("sudoers.d-automata");
    const rules = sudoers
      .split("\n")
      .filter((l) => !l.startsWith("#") && l.includes("NOPASSWD"));
    expect(rules.length).toBe(2);
    for (const rule of rules) {
      expect(rule, rule).toContain("(AGENT)");
      expect(rule, rule).not.toContain("(root)");
      expect(rule, rule).not.toContain("(ALL)");
    }
    expect(sudoers).toMatch(/Runas_Alias AGENT = __AGENT_USER__/);
    // SETENV on the daemon rule, or `sudo -E` is refused and every spawn dies.
    expect(sudoers).toMatch(/NOPASSWD:\s*SETENV:\s*AUTOMATA_DAEMON/);
  });

  it("uses the usr-merged command paths Linux actually resolves", () => {
    // /bin is a symlink to /usr/bin on Ubuntu, and /usr/bin/kill is procps'
    // binary — `command -v kill` reports the shell builtin and misleads.
    const sudoers = linux("sudoers.d-automata");
    expect(sudoers).toMatch(/AUTOMATA_DAEMON = \/usr\/bin\/sh/);
    expect(sudoers).toMatch(/AUTOMATA_KILL\s+= \/usr\/bin\/kill/);
  });
});

describe("packages/worker/deploy/linux — engine backup (#192)", () => {
  const linux = (f: string) =>
    read(path.join(workerRoot, "deploy", "linux", f));
  const script = linux("automata-engine-backup.sh");

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
    const unit = linux("automata-engine-backup.service");
    expect(unit).toMatch(/^Type=oneshot$/m);
    expect(unit).not.toMatch(/^Restart=/m);
    expect(unit).toMatch(/^TimeoutStartSec=\d+$/m);
  });

  it("the timer catches up a run missed while the box was down", () => {
    const timer = linux("automata-engine-backup.timer");
    expect(timer).toMatch(/^Persistent=true$/m);
    expect(timer).toMatch(/^OnCalendar=/m);
  });
});

describe("#192: cloud-init installs the agent the runs actually need", () => {
  const ci = () =>
    read(path.join(workerRoot, "deploy", "linux", "cloud-init.yaml"));

  it("installs the claude CLI system-wide, not into a user home", () => {
    // Omitted originally, and the box looked healthy for hours: dispatch worked,
    // the ceiling applied, the daemon started, runs "completed" — while every
    // review came back "intent could not be parsed" because the agent had died
    // at `claude: command not found`. That string appears ONLY in the thread's
    // error_message_info in the production database, never on the box.
    //
    // /usr/local because the AGENT uid runs it and cannot traverse the service
    // account's home.
    const s = ci();
    // PINNED, like node and pnpm: an unpinned global install means two boxes
    // provisioned an hour apart run different agent builds.
    expect(s).toMatch(/CLAUDE_CODE_VERSION=\d+\.\d+\.\d+/);
    expect(s).toMatch(
      /npm install -g "@anthropic-ai\/claude-code@\$\{CLAUDE_CODE_VERSION\}"/,
    );
    expect(s).toMatch(/NPM_CONFIG_PREFIX=\/usr\/local/);
  });

  it("asserts the AGENT uid can run it, not merely that it exists", () => {
    // `command -v claude` as root proves nothing about the account that invokes
    // it — the whole failure was a PATH/permission question for a different uid.
    const s = ci();
    expect(s).toMatch(
      /runuser -u "\$AGENT_USER" -- \/usr\/local\/bin\/claude --version/,
    );
  });
});

describe("#192: the egress fence is loaded at boot, not by hand", () => {
  const linux = (f: string) =>
    read(path.join(workerRoot, "deploy", "linux", f));

  it("ships a unit, because `nft -f` does not survive a reboot", () => {
    // The fence was loaded by hand and nothing reloaded it at boot, so a reboot
    // would have left the agent uid with unrestricted egress while every log
    // line still said the box was fenced. Found by checking, not by an incident.
    const unit = linux("automata-egress.service");
    expect(unit).toMatch(/^Type=oneshot$/m);
    expect(unit).toMatch(/^RemainAfterExit=yes$/m);
    expect(unit).toMatch(/nft-preflight\.sh/);
    expect(unit).toMatch(/^WantedBy=multi-user\.target$/m);
  });

  it("comes up BEFORE the worker accepts work", () => {
    // A worker that takes a run before the fence exists runs that one unfenced.
    expect(linux("automata-egress.service")).toMatch(
      /^Before=automata-worker\.service$/m,
    );
  });

  it("tears down only OUR table, never the ruleset", () => {
    // `flush ruleset` here would take Docker's chains — and with them the engine
    // and its Postgres. Same trap the ruleset file itself documents.
    // Anchored to the ExecStop LINE, not the file: the header comment names
    // `flush ruleset` precisely to explain why it must not be used, and a
    // whole-file match reads that explanation as the thing it warns about.
    // (Third time this session a comment mentioning the forbidden string broke
    // one of my own assertions.)
    const unit = linux("automata-egress.service");
    const execStop = unit.match(/^ExecStop=.*$/m)?.[0] ?? "";
    expect(execStop).toMatch(/delete table inet automata_egress/);
    expect(execStop).not.toMatch(/flush ruleset/);
  });
});

describe("#204: the unit delegates a cgroup subtree, narrowly", () => {
  const linux = (f: string) =>
    read(path.join(workerRoot, "deploy", "linux", f));

  it("delegates exactly the two controllers, and ONLY from the opt-in drop-in", () => {
    // `Delegate=yes` would hand the worker every controller for no gain. The
    // narrow form is the whole reason this needs no privilege elsewhere.
    //
    // And it lives in the drop-in, not the base unit: delegation is useless
    // without relaxing ProtectControlGroups, so shipping it in the base would
    // mean relaxing hardening on every box, including ones that never cap a run.
    const dropin = linux("automata-worker.service.d/10-ceiling.conf");
    expect(dropin).toMatch(/^Delegate=memory pids$/m);
    expect(dropin).not.toMatch(/^Delegate=(yes|true)$/m);
    expect(linux("automata-worker.service")).not.toMatch(/^Delegate=/m);
  });

  it("records why a transient scope was not used, WITH the delegation", () => {
    // Someone will propose `systemd-run --scope` again, because #193 specified
    // it. The measurement that killed it belongs next to the line that replaced
    // it, or the next person repeats the polkit discovery from scratch — so it
    // travelled into the drop-in with `Delegate=`, not left behind in the unit.
    const dropin = linux("automata-worker.service.d/10-ceiling.conf");
    expect(dropin).toMatch(/polkit/i);
    expect(dropin).toMatch(/systemd-run/);
  });
});

describe("#204: hardening must not fence out the delegated subtree", () => {
  const unitFile = () =>
    read(path.join(workerRoot, "deploy", "linux", "automata-worker.service"));

  it("the base unit KEEPS ProtectControlGroups; only the drop-in relaxes it", () => {
    // `ProtectControlGroups=yes` remounts /sys/fs/cgroup read-only inside the
    // unit's namespace, so a delegated subtree is correctly OWNED and totally
    // unwritable. The worker then reports a missing `Delegate=` that is in fact
    // present — a one-line cause with a maximally misleading symptom. Isolated on
    // the box: this setting alone breaks it; ProtectKernelTunables and
    // ProtectSystem=full do not.
    //
    // The pair is what matters, so assert BOTH halves. A box that never enables
    // the ceiling must not pay for it: the base unit stays hardened, and the
    // relaxation is confined to the drop-in that a ceiling-enabled box installs.
    expect(unitFile()).toMatch(/^ProtectControlGroups=yes$/m);
    const dropin = read(
      path.join(
        workerRoot,
        "deploy",
        "linux",
        "automata-worker.service.d",
        "10-ceiling.conf",
      ),
    );
    expect(dropin).toMatch(/^ProtectControlGroups=no$/m);
    // Delegation is inert without the relaxation, so they must travel together.
    expect(dropin).toMatch(/^Delegate=memory pids$/m);
  });

  it("a ceiling-enabled box that forgets the drop-in fails LOUDLY, not uncapped", () => {
    // The base unit alone cannot arm the ceiling. That is only safe because the
    // boot step refuses to start rather than running every job uncapped — the
    // whole point of the fail-closed path. Pin the pairing so neither half can
    // drift away from the other.
    const boot = read(path.join(workerRoot, "src", "hello", "worker.ts"));
    expect(boot).toMatch(/refusing to start/);
    expect(unitFile()).toMatch(/10-ceiling\.conf/);
  });

  it("keeps the hardening that does NOT conflict", () => {
    // The fix is one line, not the whole block — removing more than necessary
    // would be the wrong trade.
    const unit = unitFile();
    expect(unit).toMatch(/^ProtectKernelTunables=yes$/m);
    expect(unit).toMatch(/^ProtectSystem=full$/m);
  });
});
