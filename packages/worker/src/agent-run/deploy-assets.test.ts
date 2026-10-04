import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { AUDIT_PNPM_PATH } from "./self-heal-checks";

import {
  BATTERY_PACK_IDS,
  BATTERY_PACK_REQUIRES,
  BATTERY_REQUIREMENTS as SHARED_BATTERY_REQUIREMENTS,
  REVIEW_BATTERY_PACK_IDS,
} from "../../../shared/src/model/review-agent-settings";
import {
  BATTERIES_MANIFEST_REPO_PATH,
  BATTERY_REQUIREMENTS,
  DART_SDK_URL_TEMPLATE,
  FORBIDDEN_NAMES,
  findBatteriesManifestError,
  isBatteriesManifest,
  type BatteriesManifest,
  type BatteryDartAotTool,
  type BatteryDartSdkTool,
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

describe("packages/worker/deploy/sudoers.d-automata", () => {
  const sudoers = deployFile("sudoers.d-automata");

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

  it("the provisioning doc states the PF limits instead of overclaiming", () => {
    const doc = deployFile("AGENT-UID-PROVISIONING.md");
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
    const doc = deployFile("AGENT-UID-PROVISIONING.md");
    expect(doc).toMatch(/dseditgroup -o edit -d _automata-agent -t user staff/);
    expect(doc).toMatch(/dseditgroup -o create/);
    expect(doc).toMatch(/STILL IN STAFF/);
    // the uid must be chosen on the box: 300 collides with Apple's _aonsensed
    expect(doc).toMatch(/_aonsensed/);
    expect(doc).not.toMatch(/-UID 300\b/);
  });
});

describe("#183: single worker unit", () => {
  it("no deploy asset entry names the retired second unit", () => {
    const entries = fs.readdirSync(path.join(workerRoot, "deploy"));
    expect(entries.some((entry) => /worker-2/.test(entry))).toBe(false);
  });

  it("the runbook and provisioning doc no longer mention the second unit", () => {
    expect(deployFile("README.md")).not.toContain("worker-2");
    expect(deployFile("AGENT-UID-PROVISIONING.md")).not.toContain("worker-2");
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

const SOMNIO_CLI_LOCK =
  "packages/worker/deploy/batteries/somnio-cli/pubspec.lock";

/** The phase 3 review packs as merged (origin/main 846c598). */
const PHASE3_REVIEW_PACKS: Record<string, unknown> = {
  "gstack-review": {
    id: "gstack-review",
    repo: "https://github.com/garrytan/gstack",
    sha: "fe6d1ae62a42e67bfb12b7f8e6143c705f375f38",
    license: "MIT",
    subpaths: [
      {
        src: "review/checklist.md",
        dest: "skills/gstack-review/checklist.md",
        gitId: "7692f35ec845b777800704ebdd9e3d4a9a5ed88b",
      },
      {
        src: "review/specialists",
        dest: "skills/gstack-review/specialists",
        gitId: "d53a993b862bd09a13b1ff26db568f167d992319",
      },
      {
        src: "LICENSE",
        dest: "LICENSE",
        gitId: "35029511144443297cad2d26e4bac17d0e352f93",
      },
      {
        src: "LICENSE",
        dest: "skills/gstack-review/LICENSE",
        gitId: "35029511144443297cad2d26e4bac17d0e352f93",
      },
    ],
    overlays: [
      {
        from: "packages/worker/deploy/batteries/gstack-review/SKILL.md",
        dest: "skills/gstack-review/SKILL.md",
      },
    ],
    allowedHelperRefs: [
      {
        file: "skills/gstack-review/checklist.md",
        ref: "~/.claude/skills/gstack/bin/gstack-decision-search",
        count: 1,
      },
    ],
  },
  "somnio-review": {
    id: "somnio-review",
    repo: "self",
    sha: "e2716a48d0528a42cbb343307280069b2556680c",
    license:
      "internal (Somnio material vendored via the somnio-engineering-ai plugin; see .claude/harness.json)",
    subpaths: [
      {
        src: ".claude/skills/security-audit",
        dest: "skills/security-audit",
        gitId: "4d97eeeafb6c9f46ad62e3ed71d47416816f5341",
        exclude: ["references/gemini-analysis.md", "agents/gemini-analyzer.md"],
      },
    ],
  },
  "gsd-reviewers": {
    id: "gsd-reviewers",
    repo: "https://github.com/gsd-build/get-shit-done",
    sha: "7dfeb7ad8acbd6febd2c8c6cf7d3dcb7d1aeb7b9",
    license: "MIT",
    subpaths: [
      {
        src: "agents/gsd-code-reviewer.md",
        dest: "agents/gsd-code-reviewer.md",
        gitId: "17a01abec822b38bcbbab6e1ace235126dcad1a9",
      },
      {
        src: "agents/gsd-security-auditor.md",
        dest: "agents/gsd-security-auditor.md",
        gitId: "31847360fbd6554e9016f34121481bcf188fd63f",
      },
      {
        src: "LICENSE",
        dest: "LICENSE",
        gitId: "33268753639eeabc2f1b25aff79a50359152968c",
      },
    ],
  },
};

/** The 29 runtime packages of somnio CLI 3.1.1, resolved with Dart SDK 3.13.5 (07-RESEARCH). */
const SOMNIO_CLI_RUNTIME_CLOSURE: readonly (readonly [
  string,
  string,
  string,
])[] = [
  [
    "args",
    "2.7.0",
    "d0481093c50b1da8910eb0bb301626d4d8eb7284aa739614d2b394ee09e3ea04",
  ],
  [
    "async",
    "2.13.1",
    "e2eb0491ba5ddb6177742d2da23904574082139b07c1e33b8503b9f46f3e1a37",
  ],
  [
    "characters",
    "1.4.1",
    "faf38497bda5ead2a8c7615f4f7939df04333478bf32e4173fcb06d428b5716b",
  ],
  [
    "clock",
    "1.1.3",
    "e51d50bca3217c9a9fa2b41a30e4a38971133f5f9ec7a3d57bae095007f1d28e",
  ],
  [
    "collection",
    "1.19.1",
    "2f5709ae4d3d59dd8f7cd309b4e023046b57d8a6c82130785d2b0e5868084e76",
  ],
  [
    "dart_console",
    "4.1.4",
    "bf62b8016530fef83557c1f01867c281d0937dceb84204128819e6e925ddf73f",
  ],
  [
    "ffi",
    "2.2.0",
    "6d7fd89431262d8f3125e81b50d3847a091d846eafcd4fdb88dd06f36d705a45",
  ],
  [
    "file",
    "7.0.1",
    "a3b4f84adafef897088c160faf7dfffb7696046cb13ae90b508c2cbc95d3b8d4",
  ],
  [
    "http",
    "1.6.0",
    "87721a4a50b19c7f1d49001e51409bddc46303966ce89a65af4f4e6004896412",
  ],
  [
    "http_parser",
    "4.1.2",
    "178d74305e7866013777bab2c3d8726205dc5a4dd935297175b19a23a2e66571",
  ],
  [
    "interact_cli",
    "2.4.0",
    "936422743e3538ab8dc110795ecd686f1f252295679e85c3146cfa8b6c9ee98a",
  ],
  [
    "intl",
    "0.20.3",
    "1ca20c894b1717686a2319b8548763d812bc0aabdac580420a44c5178c57a867",
  ],
  [
    "io",
    "1.1.0",
    "2635216ca6a737e60de577ffa1a48a0bec76ca8a62917cfc1bb88c14c570646f",
  ],
  [
    "json_annotation",
    "4.12.0",
    "2a743920d81b7910627f68ee2c9ac1fc0bfee32b9fc3403587d7c6791ca12f80",
  ],
  [
    "mason_logger",
    "0.3.5",
    "1d46102c6f299c0df7fe986dd3dd3271d57c2ec7c00ae590660b7c3018810048",
  ],
  [
    "meta",
    "1.19.0",
    "307249ce4ff29d58a18e97f6345f539382eb9c9c29ecda628900f31de0443dd9",
  ],
  [
    "path",
    "1.9.1",
    "75cca69d1490965be98c73ceaea117e8a04dd21217b37b292c9ddbec0d955bc5",
  ],
  [
    "platform",
    "3.2.0",
    "a36d119c13416516a7b5913fbe8af8531e11633d784c550b2125f76c758524ec",
  ],
  [
    "process",
    "5.0.6",
    "4242ba3508d37e01808bdf71ad1d5bb93a8d671bf2e7450e6b1b353fb0808891",
  ],
  [
    "pub_semver",
    "2.2.1",
    "261236774e8b1d69cfc6b9eabbc96c40f25e7a2d6b171f3385d4f65d5734fb24",
  ],
  [
    "pub_updater",
    "0.5.0",
    "739a0161d73a6974c0675b864fb0cf5147305f7b077b7f03a58fa7a9ab3e7e7d",
  ],
  [
    "source_span",
    "1.10.2",
    "56a02f1f4cd1a2d96303c0144c93bd6d909eea6bee6bf5a0e0b685edbd4c47ab",
  ],
  [
    "string_scanner",
    "1.4.1",
    "921cd31725b72fe181906c6a94d987c78e3b98c2e205b397ea399d4054872b43",
  ],
  [
    "term_glyph",
    "1.2.2",
    "7f554798625ea768a7518313e58f83891c7f5024f88e46e7182a4558850a4b8e",
  ],
  [
    "tint",
    "2.0.1",
    "9652d9a589f4536d5e392cf790263d120474f15da3cf1bee7f1fdb31b4de5f46",
  ],
  [
    "typed_data",
    "1.4.0",
    "f9049c039ebfeb4cf7a7104a675823cd72dba8297f264b6637062516699fa006",
  ],
  [
    "web",
    "1.1.1",
    "868d88a33d8a87b18ffc05f9f030ba328ffefba92d6c127917a2ba740f9cfe4a",
  ],
  [
    "win32",
    "5.15.0",
    "d7cb55e04cd34096cd3a79b3330245f54cb96a370a1c27adb3c84b917de8b08e",
  ],
  [
    "yaml",
    "3.1.4",
    "f67cdd8e07d3c6329146aaef1ba043542b3134c12489f553ca9a7435d1068aea",
  ],
];

interface PubLockEntry {
  version?: string;
  sha256?: string;
  source?: string;
  url?: string;
}

/**
 * The `packages:` entries of a pubspec.lock as pub writes it. Pub's YAML
 * writer quotes a scalar only when it would otherwise parse as a non-string,
 * so a sha256 that starts with a digit is quoted and one that starts with a
 * letter is not; both forms are accepted.
 */
function parsePubspecLock(text: string): Map<string, PubLockEntry> {
  const entries = new Map<string, PubLockEntry>();
  let current: PubLockEntry | undefined;
  let inPackages = false;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) {
      inPackages = line === "packages:";
      current = undefined;
      continue;
    }
    if (!inPackages) continue;
    const pkgName = /^  ([a-z0-9_]+):$/.exec(line)?.[1];
    if (pkgName !== undefined) {
      current = {};
      entries.set(pkgName, current);
      continue;
    }
    if (current === undefined) continue;
    const field = /^ {4,6}(version|sha256|source|url): "?([^"]*)"?$/.exec(line);
    const key = field?.[1];
    if (key !== undefined) {
      Object.assign(current, { [key]: field?.[2] });
    }
  }
  return entries;
}

function readBatteriesManifest(): BatteriesManifest {
  const parsed: unknown = JSON.parse(
    read(path.join(repoRoot, BATTERIES_MANIFEST_REPO_PATH)),
  );
  const error = findBatteriesManifestError(parsed);
  if (error !== undefined || !isBatteriesManifest(parsed)) {
    throw new Error(`${BATTERIES_MANIFEST_REPO_PATH}: ${error}`);
  }
  return parsed;
}

describe("#batteries (phase 3): batteries.json", () => {
  // The box installs exactly what this file pins (install-batteries.sh), and
  // Phase 5 seeds runs from it. Reading it already runs the strict guard
  // (shapes, content-address formats, licenses, forbidden names); the
  // assertions below are the decisions the guard cannot know about, each
  // expensive to research and cheap to undo in an unrelated edit.
  const manifest = readBatteriesManifest();
  const packById = (id: string) => {
    const found = manifest.packs.find((p) => p.id === id);
    if (found === undefined) throw new Error(`no pack ${id} in the manifest`);
    return found;
  };

  it("lists exactly the shared BATTERY_PACK_IDS, in order; the review packs first", () => {
    // The admin panel offers these ids (Phase 4: the review setting offers
    // REVIEW_BATTERY_PACK_IDS; Phase 7: the task setting offers every id). A
    // pack the box does not install, or an install the panel cannot select,
    // is a silent no-op.
    expect(manifest.packs.map((p) => p.id)).toEqual([...BATTERY_PACK_IDS]);
    expect(manifest.packs.slice(0, 3).map((p) => p.id)).toEqual([
      ...REVIEW_BATTERY_PACK_IDS,
    ]);
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

  it("keeps the three review packs byte-identical to their phase 3 pins", () => {
    // Phase 7 only appends; an accidental edit to a review pack changes what
    // every orchestrated review loads.
    for (const id of REVIEW_BATTERY_PACK_IDS) {
      expect(packById(id), id).toEqual(PHASE3_REVIEW_PACKS[id]);
    }
  });

  it("somnio-skills requires a read-only GitHub token; the review packs declare nothing (phase 7)", () => {
    expect(packById("somnio-skills").requires).toEqual(["github-read-token"]);
    for (const id of REVIEW_BATTERY_PACK_IDS) {
      expect("requires" in packById(id), id).toBe(false);
    }
  });

  it("every pack's requires equals the shared BATTERY_PACK_REQUIRES (www decides from the shared map)", () => {
    for (const pack of readBatteriesManifest().packs) {
      expect(pack.requires ?? [], pack.id).toEqual([
        ...BATTERY_PACK_REQUIRES[pack.id as keyof typeof BATTERY_PACK_REQUIRES],
      ]);
    }
  });

  it("pins the somnio-skills pack (phase 7)", () => {
    const pack = packById("somnio-skills");
    expect(pack.repo).toBe(
      "https://github.com/somnio-software/somnio-ai-tools",
    );
    expect(pack.sha).toBe("aa53f071128a32bdafe4fbf77a7b0e0940b33db9");
    expect(pack.license).toBe("MIT");
    expect(pack.overlays).toBeUndefined();
    expect(pack.allowedHelperRefs).toBeUndefined();
    expect(pack.subpaths).toEqual([
      {
        src: "skills/dora-metrics",
        dest: "skills/dora-metrics",
        gitId: "33659094d6a829dc01af402d363e2576a3b1c6db",
        exclude: [
          "tests/e2e/run_e2e.py",
          "tests/test_dora_metrics.py",
          "tests/test_practice_guidance.py",
          "tests/test_troubleshooting.py",
          "evals/evals.json",
        ],
      },
      {
        src: "skills/react-health-audit",
        dest: "skills/react-health-audit",
        gitId: "8e9a07ad933408a28da2ef4b3ca25ee84e244d16",
        exclude: [".agent/workflows/react_health_audit.md"],
      },
      {
        src: "skills/security-audit",
        dest: "skills/security-audit",
        gitId: "9660e00d89d444c4d1bd505a4a628ec215158326",
        exclude: [".agent/workflows/security_audit.md"],
      },
      {
        src: "LICENSE",
        dest: "LICENSE",
        gitId: "0cdd8a5c076691ebe0980ca7e8d2f741778894d4",
      },
    ]);
  });

  it("pins a standalone pnpm for the audit checks, at the path the runner uses", () => {
    const pnpm = (manifest.tools ?? []).find((t) => t.name === "pnpm");
    expect(pnpm).toEqual({
      name: "pnpm",
      kind: "static-bin",
      version: "10.14.0",
      url: "https://github.com/pnpm/pnpm/releases/download/v10.14.0/pnpm-linuxstatic-x64",
      sha256:
        "b61ab8922a7d82794623460345964597d264c862a579b814eaa3468ac7b80375",
      license: "MIT",
    });
    // <root>/<name>@<version>/bin/<name>, mirrored by install_tool.
    expect(AUDIT_PNPM_PATH).toBe(
      `/usr/local/lib/automata-batteries/pnpm@${pnpm?.version}/bin/pnpm`,
    );
  });

  it("pins the dart-sdk and somnio-cli tools (phase 7)", () => {
    const tools = manifest.tools ?? [];
    expect(tools.map((t) => t.name)).toEqual([
      "dart-sdk",
      "somnio-cli",
      "pnpm",
    ]);
    expect(tools[0]).toEqual({
      name: "dart-sdk",
      kind: "dart-sdk",
      version: "3.13.5",
      url: DART_SDK_URL_TEMPLATE("3.13.5", "linux-x64"),
      sha256:
        "ea864bc64df30a6b8bdf30b2e32550f7717d9a890de8f40293aeabb924fe232b",
      licenseMember: "dart-sdk/LICENSE",
      license: "BSD-3-Clause",
    });
    expect(tools[0]?.kind === "dart-sdk" && tools[0].url).toBe(
      "https://storage.googleapis.com/dart-archive/channels/stable/release/3.13.5/sdk/dartsdk-linux-x64-release.zip",
    );
    const cli = tools[1];
    if (cli?.kind !== "dart-aot") throw new Error("tools[1] is not dart-aot");
    expect(cli.version).toBe("3.1.1");
    expect(cli.repo).toBe("https://github.com/somnio-software/somnio-ai-tools");
    expect(cli.sha).toBe("aa53f071128a32bdafe4fbf77a7b0e0940b33db9");
    expect(cli.subpaths).toEqual([
      {
        src: "skills",
        dest: "skills",
        gitId: "0c6874a27e61f1f112c724c787445704c8dec7b2",
      },
      {
        src: "agent-rules",
        dest: "agent-rules",
        gitId: "3db495ec60e5de6474da2be9e497f97c839945b9",
      },
      {
        src: "cli",
        dest: "cli",
        gitId: "0d49975aa94339a05bb4f150ac3f76098f24331b",
      },
      {
        src: "LICENSE",
        dest: "LICENSE",
        gitId: "0cdd8a5c076691ebe0980ca7e8d2f741778894d4",
      },
    ]);
    expect(cli.packageDir).toBe("cli");
    expect(cli.entrypoint).toBe("bin/somnio.dart");
    expect(cli.lockOverlay).toBe(SOMNIO_CLI_LOCK);
    expect(cli.sdk).toBe("dart-sdk");
    expect(cli.license).toBe("MIT");
    expect(cli.wrapper).toBe("somnio");
    expect(cli.rootEnv).toBe("SOMNIO_ROOT");
    expect(cli.versionArgs).toBe("--version");
    expect(cli.versionLine).toBe("somnio v3.1.1");
    expect(cli.smokeArgs).toEqual([
      "skills",
      "install",
      "--agent",
      "claude",
      "--project",
      "--skills",
      "dora_metrics",
    ]);
    expect(cli.smokeExpect).toBe(".claude/skills/dora-metrics/SKILL.md");
  });

  it("pins lockSha256 to the committed somnio-cli pubspec.lock", () => {
    const cli = (manifest.tools ?? []).find((t) => t.name === "somnio-cli");
    if (cli?.kind !== "dart-aot") throw new Error("no dart-aot somnio-cli");
    const digest = createHash("sha256")
      .update(fs.readFileSync(path.join(repoRoot, SOMNIO_CLI_LOCK)))
      .digest("hex");
    expect(cli.lockSha256).toBe(digest);
  });

  it("locks every researched runtime package of the somnio CLI", () => {
    // A lock bump shows up in review as a diff of this table. Every entry is
    // hosted on pub.dev and content-hashed, so `pub get --enforce-lockfile`
    // fails closed on a changed archive.
    const entries = parsePubspecLock(
      read(path.join(repoRoot, SOMNIO_CLI_LOCK)),
    );
    expect(entries.size).toBe(62);
    for (const [name, entry] of entries) {
      expect(entry.source, name).toBe("hosted");
      expect(entry.url, name).toBe("https://pub.dev");
      expect(entry.sha256, name).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const [name, version, sha256] of SOMNIO_CLI_RUNTIME_CLOSURE) {
      expect(entries.get(name), name).toMatchObject({ version, sha256 });
    }
  });

  it("installs exactly shellcheck, actionlint and gitleaks; semgrep is dropped", () => {
    expect(manifest.clis.map((c) => c.name)).toEqual([
      "shellcheck",
      "actionlint",
      "gitleaks",
    ]);
    expect(manifest.dropped.map((d) => d.name)).toContain("semgrep");
  });

  it("vendors no cso, sections or upstream review SKILL.md", () => {
    // Upstream review/SKILL.md's preamble can fall back to executing a
    // PR-supplied script from the checkout; cso needs a native launcher.
    // (Hooks, bin, plugin and settings paths are FORBIDDEN_NAMES in the guard.)
    const forbidden = /(^|\/)(cso|sections)(\/|$)|review\/SKILL\.md/;
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

  it("allowlists exactly one helper reference, in the gstack checklist", () => {
    // gstack checklist.md (blob 7692f35) names the decision-ledger helper
    // once; the adapter declares that ledger unavailable. install-batteries.sh
    // fails the pack on any other occurrence of a forbidden token, or on a
    // different count after a pin bump.
    expect(manifest.forbiddenHelperTokens).toEqual([
      "gstack/bin",
      "gstack-skill-start",
    ]);
    for (const pack of manifest.packs) {
      if (pack.id === "gstack-review") continue;
      expect(pack.allowedHelperRefs, pack.id).toBeUndefined();
    }
    expect(packById("gstack-review").allowedHelperRefs).toEqual([
      {
        file: "skills/gstack-review/checklist.md",
        ref: "~/.claude/skills/gstack/bin/gstack-decision-search",
        count: 1,
      },
    ]);
  });

  it("ships every overlay from this repo", () => {
    for (const pack of manifest.packs) {
      for (const overlay of pack.overlays ?? []) {
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
  const adapter = deployFile("batteries", "gstack-review", "SKILL.md");
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
      ...readBatteriesManifest().forbiddenHelperTokens,
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

  it("names the static CLIs in one place, the procedure", () => {
    const split = body.indexOf("## Procedure");
    expect(split).toBeGreaterThan(-1);
    for (const cli of ["shellcheck", "actionlint", "gitleaks"]) {
      expect(body.slice(split), cli).toContain(cli);
      expect(body.slice(0, split), cli).not.toContain(cli);
    }
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

/** The single `NAME=...` line of the script. */
function assignment(script: string, name: string): string {
  const lines = script.split("\n").filter((l) => l.startsWith(`${name}=`));
  if (lines.length !== 1 || lines[0] === undefined) {
    throw new Error(`expected exactly one ${name}= line`);
  }
  return lines[0];
}

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

    it("is shellcheck clean", (ctx) => {
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

describeBashScriptHygiene("packages/worker/deploy/linux/install-batteries.sh");
describeBashScriptHygiene("packages/worker/deploy/linux/batteries-dry-run.sh");
describeBashScriptHygiene(
  "packages/worker/deploy/linux/task-batteries-acceptance.sh",
);
describeBashScriptHygiene(
  "packages/worker/deploy/linux/orchestrated-review-acceptance.sh",
);
describeBashScriptHygiene(
  "packages/worker/deploy/linux/self-heal-acceptance.sh",
);

/**
 * What decides the bytes install-batteries.sh writes into a pack dir, paired
 * with the INSTALLER_OUTPUT_VERSION it was recorded for. Packs whose stamp
 * holds the current version are SKIPPED, so a change here that ships without
 * a version bump leaves boxes running packs built by the old code.
 *
 * When this test fails: if the change alters what lands in a pack dir, bump
 * INSTALLER_OUTPUT_VERSION; either way, record the new hash it prints.
 */
const RECORDED_INSTALLER_OUTPUT = {
  version: "1",
  sha256: "7c5032e6d3eb73a7906451bffa44da49ada06d416b17a82f1f327eeb1e108852",
};

describe("#batteries (phase 3): install-batteries.sh", () => {
  // The installer runs as root against a worker-writable checkout and
  // fetches from the internet. Each assertion pins a safety property in the
  // function that owns it, so a refactor cannot quietly move it out.
  const script = deployFile("linux", "install-batteries.sh");
  const src = code(script);
  const body = (name: string) => fnBody(script, name);

  it("sets a umask and a neutral cwd (hygiene: describeBashScriptHygiene)", () => {
    const lines = script.split("\n");
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
    const preflight = body("preflight");
    expect(preflight).toContain("jq -e");
    expect(assignment(script, "readonly RE_ID")).toContain(
      "[a-z0-9][a-z0-9-]*",
    );
    expect(assignment(script, "readonly RE_VERSION_ARGS")).toContain(
      "-{0,2}[a-z]+",
    );
    expect(preflight).toContain("$RE_ID");
    expect(preflight).toContain("$RE_VERSION_ARGS");
    expect(preflight).toContain("safe_rel_path");
    expect(preflight).toContain("check_vendored_path");
    expect(body("safe_rel_path")).toContain("..");
  });

  it("re-checks the rules the TS guard has, so both validators agree", () => {
    const preflight = body("preflight");
    // duplicate pack ids / CLI names
    expect(preflight).toContain("map(.id) | length == (unique | length)");
    expect(preflight).toContain("map(.name) | length == (unique | length)");
    // CLI url: the pinned version's release asset, for linux
    expect(preflight).toContain('*"/releases/download/v$version/"*');
    expect(preflight).toContain("*linux*");
    // forbidden names, the same list as the guard
    expect(body("has_forbidden_name")).toContain("FORBIDDEN_NAMES");
    expect(assignment(script, "FORBIDDEN_NAMES")).toBe(
      `FORBIDDEN_NAMES=(${FORBIDDEN_NAMES.join(" ")})`,
    );
    // helper allowlist shape, and a ref that names a forbidden token
    expect(preflight).toContain("allowedHelperRefs");
    expect(preflight).toContain("forbiddenHelperTokens");
  });

  it("rejects control characters before it reads any @tsv row", () => {
    // Dry-run finding (first form): `jq -r` printed objects across lines and
    // split every entry. Rows are now @tsv, split on tabs and newlines, so a
    // control character inside a value could forge a field: the check must
    // come FIRST.
    const preflight = code(body("preflight"));
    const controlCheck = preflight.indexOf('test("[\\u0000-\\u001f');
    expect(controlCheck).toBeGreaterThan(-1);
    expect(controlCheck).toBeLessThan(preflight.indexOf("| @tsv"));
    expect(controlCheck).toBeLessThan(preflight.indexOf("read -r"));
    expect(src).toContain("IFS=$'\\t' read -r");
    expect(src).not.toMatch(/jq -c '\.(packs|clis)\[\]'/);
  });

  it("is generic over the manifest: no pack, CLI or helper is named in code", () => {
    for (const name of [
      "shellcheck",
      "actionlint",
      "gitleaks",
      "gstack",
      "somnio",
      "gsd-",
    ]) {
      expect(src, name).not.toContain(name);
    }
  });

  it("enforces the manifest's helper allowlist: exact count, nothing else", () => {
    const verify = body("verify_staging");
    expect(verify).toContain('helper_ref_rows "$i"');
    expect(verify).toContain('[ "$n" != "$count" ]');
    expect(verify).toContain("$HELPER_TOKENS");
    expect(verify).toContain("grep -rlF");
    expect(body("helper_ref_rows")).toContain(".allowedHelperRefs");
  });

  it("materialises content only through git object plumbing", () => {
    // The checkout is worker-writable: porcelain honours .gitattributes and
    // repo config, so its bytes need not match the pinned object ids.
    const extract = body("extract_object");
    expect(extract).toContain("ls-tree -r -z");
    expect(extract).toContain("cat-file blob");
    expect(extract).toContain("120000");
    expect(extract).toContain("160000");
    const stage = body("stage_pack");
    expect(stage).toContain("extract_object ");
    expect(stage).toContain("git_repo");
    expect(stage).toContain("git_fetch");
    expect(src).not.toContain("git archive");
    // "dart-archive" (phase 7) is the Dart SDK download host's path, not git.
    expect(src.replaceAll("dart-archive", "")).not.toContain("archive ");
    expect(src).not.toMatch(/\bcp\b[^\n]*AUTOMATA_REPO/);
    expect(stage).toContain('cat-file blob "$HEAD_SHA:');
    expect(src).toContain("SOURCE checkout");
  });

  it("hardens every git call against the automata-owned checkout", () => {
    const gitRepo = body("git_repo");
    expect(gitRepo).toContain("safe.directory");
    expect(gitRepo).toContain("core.fsmonitor=false");
    expect(gitRepo).toContain("core.hooksPath=/dev/null");
  });

  it("fetch_verified checks the sha256 of a download or a cached copy before returning", () => {
    const fetch = code(body("fetch_verified"));
    const check = fetch.indexOf("sha256sum -c");
    expect(check).toBeGreaterThan(-1);
    expect(fetch).toContain("curl -fsSL --proto '=https' --tlsv1.2 --retry 3");
    // A cache hit is COPIED to <out> and checked there; a mismatch fails, and
    // only a verified download is written back to the cache.
    const cacheCopy = fetch.indexOf('cp "$cache" "$out"');
    expect(cacheCopy).toBeGreaterThan(-1);
    expect(cacheCopy).toBeLessThan(check);
    expect(fetch.indexOf('cp "$out" "$cache.tmp.')).toBeGreaterThan(check);
    expect(fetch).toContain('STEP_ERROR="sha256 mismatch');
  });

  it("checks a CLI's sha256 before anything is extracted or reaches the bin dir", () => {
    const cli = body("install_cli");
    const fetch = cli.indexOf(
      'fetch_verified "$name $version" "$url" "$sha256" "$dl"',
    );
    expect(fetch).toBeGreaterThan(-1);
    expect(cli.indexOf("tar -xzf")).toBeGreaterThan(fetch);
    expect(cli.indexOf("$BIN_DIR")).toBeGreaterThan(fetch);
    expect(cli).toContain("mv -f");
    expect(cli).toContain("write_stamp");
  });

  it("fetches packs by sha, checks object ids before publishing, never prunes", () => {
    const stage = body("stage_pack");
    // Phase 7 factored the fetch into fetch_pinned; packs keep the blobless mode.
    expect(stage).toContain('fetch_pinned "$id" "$repo" "$sha" blobless');
    expect(body("fetch_pinned")).toContain("--filter=blob:none --depth 1");
    expect(body("fetch_pinned")).toContain("FETCH_HEAD");
    expect(body("extract_object")).toContain("rev-parse");
    const pack = body("install_pack");
    expect(pack.indexOf("stage_pack")).toBeLessThan(
      pack.indexOf("publish_dir"),
    );
    expect(src).toContain("STALE");
    expect(src).not.toMatch(/rm -rf "?\$\{?ROOT\}?\/[^"\n]*@/);
  });

  it("records a pack FAIL in one place, after removing the staging dir", () => {
    const pack = body("install_pack");
    expect(pack.match(/record "FAIL pack/g)).toHaveLength(2); // mktemp + the one path
    expect(pack.indexOf('rm -rf "$stage"')).toBeLessThan(
      pack.indexOf('record "FAIL pack $id: $STEP_ERROR"'),
    );
    expect(body("stage_pack")).not.toContain("record ");
  });

  it("publishes atomically when it can and documents the fallback window", () => {
    const publish = body("publish_dir");
    expect(publish).toContain("--exchange");
    expect(publish).toMatch(/#[^\n]*run in flight/);
  });

  it("strips grant keys and re-verifies the staged tree", () => {
    const grantKeys = assignment(script, "GRANT_KEYS_RE");
    for (const key of [
      "allowed-tools",
      "hooks",
      "permissionMode",
      "mcpServers",
    ]) {
      expect(grantKeys, key).toContain(key);
    }
    const strip = body("strip_frontmatter");
    const verify = body("verify_staging");
    for (const fn of [strip, verify]) {
      expect(fn).toContain('-v grant_re="$GRANT_KEYS_RE"');
      expect(fn).toContain("line ~ grant_re");
    }
    expect(verify).toContain("FORBIDDEN_NAMES");
    expect(verify).toContain("-type l");
    expect(body("stage_pack").indexOf("strip_frontmatter")).toBeLessThan(
      body("stage_pack").indexOf("verify_staging"),
    );
  });

  it("stamps packs with INSTALLER_OUTPUT_VERSION, bumped with the code that shapes them", () => {
    expect(body("pack_stamp_hash")).toContain("$INSTALLER_OUTPUT_VERSION");
    expect(body("pack_stamp_hash")).toContain("$HELPER_TOKENS");
    expect(src).not.toContain("SCRIPT_HASH");
    expect(assignment(script, "INSTALLER_OUTPUT_VERSION")).toBe(
      `INSTALLER_OUTPUT_VERSION=${RECORDED_INSTALLER_OUTPUT.version}`,
    );
    const shaping = [
      assignment(script, "GRANT_KEYS_RE"),
      assignment(script, "FORBIDDEN_NAMES"),
      body("extract_object"),
      body("strip_frontmatter"),
      body("verify_staging"),
    ].join("\n");
    const actual = createHash("sha256").update(shaping).digest("hex");
    expect(actual, `record sha256: "${actual}"`).toBe(
      RECORDED_INSTALLER_OUTPUT.sha256,
    );
  });

  it("forces root ownership and read-only modes", () => {
    expect(src).toContain("chmod 0644");
    expect(src).toContain("chmod 0755");
    expect(src).toContain("chown -R root:root");
    expect(src).not.toContain("IS_ROOT");
  });

  it("verifies through the real worker → sudo → agent spawn shape, values via env only", () => {
    const verifyAs = body("verify_as_agent");
    const verify = verifyAs + body("as_agent");
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
      "! -readable",
      "-writable",
    ]) {
      expect(verify, token).toContain(token);
    }
    // One spawn per CLI and one per pack: one call site in each loop.
    expect(code(verifyAs).match(/\bas_agent '/g)).toHaveLength(2);
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

  it("ends with a PASS/FAIL result and installs nothing from PyPI", () => {
    expect(body("finish")).toContain("print_summary");
    expect(body("on_exit")).toContain("print_summary");
    expect(script).toContain("RESULT: PASS");
    expect(script).toContain("RESULT: FAIL");
    expect(src).toContain("exit 1");
    expect(script).not.toContain("semgrep");
    expect(script).not.toContain("pip install");
  });

  it("writes every CLI and tool stamp through write_stamp (temp file, 0644, rename)", () => {
    const stamp = body("write_stamp");
    expect(stamp).toContain('>"$stamp.tmp"');
    expect(stamp).toContain('chmod 0644 "$stamp.tmp"');
    expect(stamp).toContain('mv -f "$stamp.tmp" "$stamp"');
    expect(body("install_tool")).toContain("write_stamp");
  });

  it("pins the pack `requires` set to the TS guards' BATTERY_REQUIREMENTS (worker and shared)", () => {
    expect(assignment(script, "readonly PACK_REQUIREMENTS_JSON")).toBe(
      `readonly PACK_REQUIREMENTS_JSON='${JSON.stringify([...BATTERY_REQUIREMENTS])}'`,
    );
    expect([...SHARED_BATTERY_REQUIREMENTS]).toEqual([...BATTERY_REQUIREMENTS]);
    expect(body("preflight")).toContain(
      '--argjson allowed "$PACK_REQUIREMENTS_JSON"',
    );
  });
});

/** The host's Dart SDK platform, or undefined where no SDK is published for it. */
const HOST_DART_PLATFORM: string | undefined = (
  {
    "darwin/arm64": "macos-arm64",
    "darwin/x64": "macos-x64",
    "linux/x64": "linux-x64",
    "linux/arm64": "linux-arm64",
  } as Record<string, string>
)[`${process.platform}/${process.arch}`];

/** Placeholder replaced by a per-test temp dir in the executed guard tests. */
const GUARD_PREFIX = "<per-test temp prefix>";

function dartSdkOf(m: BatteriesManifest): BatteryDartSdkTool {
  const found = (m.tools ?? []).find((t) => t.kind === "dart-sdk");
  if (found?.kind !== "dart-sdk") throw new Error("no dart-sdk tool");
  return found;
}

function dartAotOf(m: BatteriesManifest): BatteryDartAotTool {
  const found = (m.tools ?? []).find((t) => t.kind === "dart-aot");
  if (found?.kind !== "dart-aot") throw new Error("no dart-aot tool");
  return found;
}

describe("#batteries (phase 7): tools in install-batteries.sh — preflight + SDK", () => {
  // tools[] reach a root shell (the build) and the agent's PATH (a wrapper).
  // The SDK is 238 MB of foreign bytes: its sha256 is checked before ANY
  // extraction (also of a cached dry-run copy), and a python pre-scan rejects
  // zip-slip, symlink and size-bomb entries before python3 -m zipfile runs.
  const scriptPath = path.join(
    workerRoot,
    "deploy",
    "linux",
    "install-batteries.sh",
  );
  const script = deployFile("linux", "install-batteries.sh");
  const src = code(script);
  const body = (name: string) => fnBody(script, name);

  it("stays generic: no tool name, SDK version or commit in code", () => {
    expect(src.toLowerCase()).not.toContain("somnio");
    expect(src).not.toContain("3.13.5");
    expect(src).not.toContain("aa53f071");
  });

  it("declares TOOLS_OUTPUT_VERSION exactly once", () => {
    expect(assignment(script, "TOOLS_OUTPUT_VERSION")).toBe(
      "TOOLS_OUTPUT_VERSION=1",
    );
  });

  it("treats the download cache and preflight-only knobs as dry-run knobs", () => {
    const guard = src.slice(src.indexOf("DRY_RUN=0"), src.indexOf("DRY_RUN=1"));
    expect(guard).toContain('[ -n "$BATTERIES_DOWNLOAD_CACHE" ]');
    expect(guard).toContain('[ -n "$BATTERIES_PREFLIGHT_ONLY" ]');
    expect(guard).toContain("dry-run knobs are refused for root");
    expect(guard).toContain(
      "BATTERIES_DOWNLOAD_CACHE must be an absolute path",
    );
    expect(guard).toContain("BATTERIES_PREFLIGHT_ONLY must be 1");
  });

  it.each<[string, Record<string, string>, string]>([
    [
      "the cache without SKIP_SUDO_VERIFY=1",
      { PREFIX: GUARD_PREFIX, BATTERIES_DOWNLOAD_CACHE: "/tmp/c" },
      "a dry run needs SKIP_SUDO_VERIFY=1",
    ],
    [
      "the cache with the real prefix",
      { SKIP_SUDO_VERIFY: "1", BATTERIES_DOWNLOAD_CACHE: "/tmp/c" },
      "require a non-default PREFIX",
    ],
    [
      "a relative cache dir",
      {
        PREFIX: GUARD_PREFIX,
        SKIP_SUDO_VERIFY: "1",
        BATTERIES_DOWNLOAD_CACHE: "cache",
      },
      "BATTERIES_DOWNLOAD_CACHE must be an absolute path",
    ],
    [
      "preflight-only with the real prefix",
      { SKIP_SUDO_VERIFY: "1", BATTERIES_PREFLIGHT_ONLY: "1" },
      "require a non-default PREFIX",
    ],
    [
      "preflight-only set to anything but 1",
      {
        PREFIX: GUARD_PREFIX,
        SKIP_SUDO_VERIFY: "1",
        BATTERIES_PREFLIGHT_ONLY: "yes",
      },
      "BATTERIES_PREFLIGHT_ONLY must be 1",
    ],
  ])("refuses %s (exit 2, executed)", (_name, env, message) => {
    // Guards run before anything is read or written; only bash is spawned.
    // GUARD_PREFIX lives in a fresh temp dir so a guard that let the run
    // through could not install anywhere that outlives the test.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "batteries-guard-"));
    const prefix =
      env.PREFIX === GUARD_PREFIX ? path.join(dir, "p") : undefined;
    try {
      const result = spawnSync("/bin/bash", [scriptPath], {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          ...env,
          ...(prefix === undefined ? {} : { PREFIX: prefix }),
        },
      });
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain(message);
      expect(prefix === undefined || !fs.existsSync(prefix)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-checks the tools contract in preflight, host rules included", () => {
    const preflight = body("preflight") + body("preflight_tools");
    expect(body("preflight")).toContain("preflight_tools");
    for (const token of [
      "python3",
      "dartsdk-",
      "_ROOT$",
      "pubspec.lock",
      "uname -s",
      "uname -m",
      "Linux/x86_64",
      "linux-x64",
      "host_dart_platform",
      "cannot install tools",
    ]) {
      expect(preflight, token).toContain(token);
    }
    const platform = body("host_dart_platform");
    expect(platform).toContain("Darwin/arm64) echo macos-arm64");
    expect(platform).toContain("Darwin/x86_64) echo macos-x64");
    expect(platform).toContain("Linux/x86_64) echo linux-x64");
    expect(platform).toContain("Linux/aarch64) echo linux-arm64");
  });

  it("checks the SDK zip's sha256 before any extraction, cached copies included", () => {
    const stage = code(body("stage_dart_sdk"));
    // fetch_verified checks the sha256 (of a cached copy too, copied into
    // $WORK first); nothing is extracted from the cache path itself.
    const fetch = stage.indexOf(
      'fetch_verified "$name $version" "$url" "$sha256" "$zip" "$cached" || return 1',
    );
    expect(fetch).toBeGreaterThan(-1);
    expect(fetch).toBeLessThan(stage.indexOf("zipfile"));
    // Only a dry run may name a download cache.
    expect(stage).toContain('[ "$DRY_RUN" -eq 1 ]');
  });

  it("pre-scans the zip, extracts with python3, and publishes a build-only SDK", () => {
    const stage = body("stage_dart_sdk");
    for (const token of [
      "python3 -",
      "S_ISLNK",
      'startswith("dart-sdk/")',
      '".."',
      "2 * 1024 ** 3",
      "-m zipfile -e",
      "-type l",
      "/version",
      "xargs -0 chmod 0755",
      'chmod 0700 "$stage"',
    ]) {
      expect(stage, token).toContain(token);
    }
    expect(src).not.toContain("unzip");
    // Build-only: nothing of the SDK is placed in the bin dir.
    expect(stage).not.toContain("$BIN_DIR");
  });

  it("records STALE tool dirs under their own noun, pack output unchanged", () => {
    expect(body("publish_dir")).toContain('record "STALE ${3:-pack} $aside');
  });
});

/**
 * What decides the bytes install-batteries.sh writes for a tool, paired with
 * the TOOLS_OUTPUT_VERSION it was recorded for (same rule as
 * RECORDED_INSTALLER_OUTPUT): a change here that ships without a version bump
 * leaves boxes SKIPPING tools built by the old code.
 *
 * When this test fails: if the change alters what lands on disk for a tool,
 * bump TOOLS_OUTPUT_VERSION; either way, record the new hash it prints.
 */
const RECORDED_TOOLS_OUTPUT = {
  version: "1",
  sha256: "95a326bcab98cb46995c9b2a70aa4164e299c3a9842988104c33453d3935e0a2",
};

describe("#batteries (phase 7): tools in install-batteries.sh — AOT + wrapper + verify", () => {
  // The CLI is COMPILED as root from tree-id-verified sources and a
  // sha256-pinned lock, then run by the agent through a fixed wrapper.
  const script = deployFile("linux", "install-batteries.sh");
  const body = (name: string) => fnBody(script, name);

  it("stamps tools with TOOLS_OUTPUT_VERSION, bumped with the code that shapes them", () => {
    expect(body("tool_stamp_hash")).toContain("$TOOLS_OUTPUT_VERSION");
    expect(assignment(script, "TOOLS_OUTPUT_VERSION")).toBe(
      `TOOLS_OUTPUT_VERSION=${RECORDED_TOOLS_OUTPUT.version}`,
    );
    // fetch_verified was factored out of stage_dart_sdk (no output change);
    // it stays covered so the hash still sees everything the SDK step runs.
    const shaping = [
      body("stage_dart_sdk"),
      body("fetch_verified"),
      body("stage_dart_aot"),
      body("stage_static_bin"),
      body("write_wrapper"),
    ].join("\n");
    const actual = createHash("sha256").update(shaping).digest("hex");
    expect(actual, `record sha256: "${actual}"`).toBe(
      RECORDED_TOOLS_OUTPUT.sha256,
    );
  });

  it("installs a static-bin tool sha256-verified, root-owned, off the agent PATH, and verifies it as the agent", () => {
    const stage = body("stage_static_bin");
    expect(stage).toContain('fetch_verified "$name $version" "$url" "$sha256"');
    expect(stage).toContain("chown -R root:root");
    expect(stage).not.toContain("$BIN_DIR");
    expect(body("install_tool")).toContain("stage_static_bin");
    expect(body("tool_at_pin")).toContain("static-bin)");
    expect(body("preflight_tools")).toContain("static-bin) keys=");
    const verify = body("verify_tools_as_agent");
    expect(verify).toContain(
      '"$BATTERIES_CHECK_PATH/bin/$BATTERIES_CHECK_NAME" --version',
    );
    expect(verify).toContain("-writable");
  });

  it("fetches a tool's whole pinned commit and checks FETCH_HEAD", () => {
    const fetch = body("fetch_pinned");
    expect(fetch).toContain("fetch -q --depth 1 origin");
    expect(fetch).toContain("FETCH_HEAD");
    expect(body("stage_dart_aot")).toContain(
      'fetch_pinned "$name" "$repo" "$sha" full',
    );
  });

  it("builds only from object-bound sources and the pinned lock", () => {
    const stage = code(body("stage_dart_aot"));
    expect(stage).toContain("extract_object git_fetch");
    expect(stage).toContain('cat-file blob "$HEAD_SHA:');
    const lockCheck = stage.indexOf("lock overlay sha256 mismatch");
    const pubGet = stage.indexOf("pub get --enforce-lockfile");
    expect(lockCheck).toBeGreaterThan(-1);
    expect(lockCheck).toBeLessThan(pubGet);
    expect(stage.indexOf("env -i")).toBeLessThan(pubGet);
    for (const token of [
      "--enforce-lockfile",
      "--suppress-analytics",
      "package_config.json",
      "has a build hook",
      "compile exe",
      'rm -rf "$pkg_dir/.dart_tool"',
      'PUB_CACHE="$ROOT/pub-cache"',
    ]) {
      expect(stage, token).toContain(token);
    }
    expect(stage.indexOf("has a build hook")).toBeLessThan(
      stage.indexOf("compile exe"),
    );
    // The source tree is a build input, never linked into HOME: the pack
    // scan does not apply (cli/bin is legitimate there).
    expect(stage).not.toContain("verify_staging");
    expect(body("stage_dart_aot")).toMatch(/#[^\n]*never linked into HOME/);
  });

  it("refuses an aot tool whose sdk is not at its pin in this run", () => {
    const install = body("install_tool");
    expect(install).toContain("is not installed at its pin");
    expect(install).toContain("$TOOLS_OK");
    expect(install.indexOf("is not installed at its pin")).toBeLessThan(
      install.indexOf("mktemp -d"),
    );
  });

  it("writes a fixed-text wrapper through a temp file and mv -f", () => {
    const wrapper = body("write_wrapper");
    for (const token of [
      "exec '",
      '"$@"',
      "export",
      "PUB_CACHE=",
      'tmp="$BIN_DIR/.$wrapper.new.$$"',
      'mv -f "$tmp" "$BIN_DIR/$wrapper"',
      "contains a single quote",
    ]) {
      expect(wrapper, token).toContain(token);
    }
    // tool_at_pin also requires the installed wrapper to equal the template.
    expect(body("tool_at_pin")).toContain("write_wrapper");
    expect(body("tool_at_pin")).toContain("cmp -s");
  });

  it("installs tools after packs and reports stale tool dirs as tools", () => {
    const main = body("main");
    expect(main.indexOf("install_tool")).toBeGreaterThan(
      main.indexOf("install_pack"),
    );
    expect(main.indexOf("invalidate_manifest_hash")).toBeLessThan(
      main.indexOf("install_tool"),
    );
    const stale = body("list_stale");
    expect(stale).toContain(".tools");
    expect(stale).toContain("noun=pack");
    expect(stale).toContain("noun=tool");
    expect(stale).toContain('record "STALE $noun $dir (left in place)"');
  });

  it("verifies tools as the agent, values via env only", () => {
    expect(body("verify_as_agent")).toContain("verify_tools_as_agent");
    const verify = body("verify_tools_as_agent");
    for (const token of [
      "as_agent '",
      "BATTERIES_CHECK_NAME",
      "BATTERIES_CHECK_ARGS",
      "BATTERIES_CHECK_PATH",
      "command -v",
      "${out##*$'\\n'}",
      'mktemp -d "$HOME/',
      "-writable",
      "! -w",
      "VERIFIED agent tool $name ($version_line; smoke ok)",
      "VERIFIED agent tool $name (build-only, not traversable)",
    ]) {
      expect(verify, token).toContain(token);
    }
    expect(verify).not.toMatch(
      /as_agent '[^']*\$\{?(name|wrapper|version|target|smoke|args)\b/,
    );
  });
});

describe("#batteries (phase 7): batteries-dry-run.sh (developer proof)", () => {
  // The proof needs network and is run by hand (07-02); these checks keep it
  // runnable and honest between runs.
  const proof = deployFile("linux", "batteries-dry-run.sh");

  it("refuses root, uses the shared download cache and ends with the proof line", () => {
    expect(proof).toContain(
      '[ "$(id -u)" != "0" ] || die "refuses to run as root"',
    );
    expect(proof).toContain("BATTERIES_DOWNLOAD_CACHE=");
    expect(proof).toContain("SKIP_SUDO_VERIFY=1");
    expect(proof).toContain('echo "DRY-RUN-PROOF-OK"');
    expect(proof).toContain("worktree add -q --detach");
    expect(proof).toContain("worktree remove --force");
    expect(proof).toContain("trap cleanup EXIT");
    expect(
      proof
        .split("\n")
        .filter((l) => l.startsWith("DRY_RUN_MACOS_ARM64_SDK_SHA256=")),
    ).toEqual([
      "DRY_RUN_MACOS_ARM64_SDK_SHA256=9dfe7d6f2558816c2a978aff6c80e8a4509c6cb726c0702a616c64d286f60e88",
    ]);
  });
});

describe("#batteries (phase 7): bash preflight parity with the TS guard (executed)", () => {
  // Both validators must reject the same malformed tools entry, each with the
  // rule named. Only /bin/bash install-batteries.sh is spawned, with
  // BATTERIES_PREFLIGHT_ONLY=1: it stops right after preflight, so nothing is
  // downloaded or written under PREFIX even when preflight passes.
  //
  // The committed manifest names the linux-x64 SDK, which a dry run refuses
  // on any other host; the bash base therefore rewrites ONLY that url to this
  // host's platform, while the TS guard always sees the linux-x64 base.
  const scriptPath = path.join(
    workerRoot,
    "deploy",
    "linux",
    "install-batteries.sh",
  );
  const committed = readBatteriesManifest();
  const platform = HOST_DART_PLATFORM;

  function somnioSkillsOf(m: BatteriesManifest) {
    const pack = m.packs.find((p) => p.id === "somnio-skills");
    if (!pack) throw new Error("no somnio-skills pack");
    return pack;
  }

  function based(
    targetPlatform: string,
    change: (m: BatteriesManifest, p: string) => void,
  ): BatteriesManifest {
    const m = structuredClone(committed);
    const sdk = dartSdkOf(m);
    sdk.url = DART_SDK_URL_TEMPLATE(sdk.version, targetPlatform);
    change(m, targetPlatform);
    return m;
  }

  function runPreflight(manifest: BatteriesManifest): {
    status: number | null;
    stdout: string;
    published: boolean;
  } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "batteries-parity-"));
    const prefix = path.join(dir, "prefix");
    const manifestPath = path.join(dir, "batteries.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    try {
      // The timeout bounds a script that ignores BATTERIES_PREFLIGHT_ONLY and
      // carries on into a real install (network); preflight alone is seconds.
      const result = spawnSync("/bin/bash", [scriptPath], {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: dir,
          TMPDIR: dir,
          PREFIX: prefix,
          SKIP_SUDO_VERIFY: "1",
          BATTERIES_MANIFEST: manifestPath,
          BATTERIES_PREFLIGHT_ONLY: "1",
          AUTOMATA_REPO: repoRoot,
        },
      });
      return {
        status: result.status,
        stdout: result.stdout,
        published: fs.existsSync(prefix),
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("accepts the committed manifest (TS) and its host-platform twin (bash)", (ctx) => {
    expect(findBatteriesManifestError(committed)).toBeUndefined();
    if (platform === undefined) {
      ctx.skip(); // no Dart SDK is published for this host's platform
      return;
    }
    const result = runPreflight(based(platform, () => undefined));
    expect(result.stdout).not.toContain("FAIL preflight");
    expect(result.stdout).toContain("RESULT: PASS");
    expect(result.status).toBe(0);
    expect(result.published).toBe(false);
  });

  it.each<[string, (m: BatteriesManifest, p: string) => void, string]>([
    [
      "an SDK url for another version",
      (m, p) => {
        dartSdkOf(m).url = DART_SDK_URL_TEMPLATE("3.13.4", p);
      },
      "url is not the dart-archive template for",
    ],
    [
      "an SDK url for windows-x64",
      (m) => {
        const sdk = dartSdkOf(m);
        sdk.url = DART_SDK_URL_TEMPLATE(sdk.version, "windows-x64");
      },
      "platform windows-x64 is not this host's (",
    ],
    [
      'rootEnv "PATH"',
      (m) => {
        dartAotOf(m).rootEnv = "PATH";
      },
      "rootEnv must match ^[A-Z][A-Z0-9]*_ROOT$",
    ],
    [
      "a two-word versionArgs",
      (m) => {
        dartAotOf(m).versionArgs = "--version x";
      },
      "versionArgs must be one word",
    ],
    [
      'a smoke word "$(id)"',
      (m) => {
        dartAotOf(m).smokeArgs = ["skills", "$(id)"];
      },
      "smokeArgs word is unsafe",
    ],
    [
      "a lockOverlay outside the overlay dir",
      (m) => {
        dartAotOf(m).lockOverlay = "../x/pubspec.lock";
      },
      "lockOverlay must be under packages/worker/deploy/batteries/ and end /pubspec.lock",
    ],
    [
      "an sdk listed after its tool",
      (m) => {
        m.tools?.reverse();
      },
      "sdk must name an earlier dart-sdk tool",
    ],
    [
      'a tool named "gitleaks"',
      (m) => {
        dartAotOf(m).name = "gitleaks";
      },
      "tool name collides with a pack id or CLI name",
    ],
    [
      'a wrapper named "shellcheck"',
      (m) => {
        dartAotOf(m).wrapper = "shellcheck";
      },
      "wrapper collides with a CLI name or another wrapper",
    ],
    [
      "an unknown key",
      (m) => {
        Object.assign(dartAotOf(m), { extra: "x" });
      },
      "unknown key in tools entry",
    ],
    [
      'kind "dart-jit"',
      (m) => {
        Object.assign(dartAotOf(m), { kind: "dart-jit" });
      },
      "unknown kind",
    ],
    [
      'pack requires ["github-write-token"]',
      (m) => {
        Object.assign(somnioSkillsOf(m), { requires: ["github-write-token"] });
      },
      "FAIL preflight somnio-skills: requires must be a list drawn from github-read-token",
    ],
    [
      "a duplicate pack requires entry",
      (m) => {
        Object.assign(somnioSkillsOf(m), {
          requires: ["github-read-token", "github-read-token"],
        });
      },
      "FAIL preflight somnio-skills: requires must be a list drawn from github-read-token",
    ],
    [
      "a non-array pack requires",
      (m) => {
        Object.assign(somnioSkillsOf(m), { requires: "github-read-token" });
      },
      "FAIL preflight somnio-skills: requires must be a list drawn from github-read-token",
    ],
  ])("both reject %s", (_name, change, failText) => {
    expect(
      findBatteriesManifestError(based("linux-x64", change)),
      "TS guard",
    ).toBeDefined();
    if (platform === undefined) return; // bash half needs a host SDK platform
    const result = runPreflight(based(platform, change));
    expect(result.stdout).toContain(`FAIL preflight `);
    expect(result.stdout).toContain(failText);
    expect(result.stdout).toContain("RESULT: FAIL");
    expect(result.status).toBe(1);
    expect(result.published).toBe(false);
  });
});

describe("#batteries (phase 3): cloud-init + runbook", () => {
  const cloudInit = deployFile("linux", "cloud-init.yaml");
  const runbook = read(path.join(repoRoot, "deploy", "PILOT-RUNBOOK.md"));
  const agentUidDoc = deployFile("AGENT-UID-PROVISIONING.md");
  const RUNBOOK_SECTION = "Review batteries on the execution box (phase 3)";

  it("never runs the installer at provisioning; it points at the runbook rollout", () => {
    // The installer must run from a root-owned copy taken from a commit
    // verified against the public origin, never from the worker-writable
    // checkout, and on first boot that checkout is still empty.
    expect(cloudInit).not.toMatch(/^\s*bash [^\n]*install-batteries\.sh/m);
    expect(cloudInit).toContain("deploy/PILOT-RUNBOOK.md");
    expect(cloudInit).toContain(RUNBOOK_SECTION);
    expect(runbook).toContain(`## ${RUNBOOK_SECTION}`);
  });

  it("prints the batteries note only AFTER the base-provisioned sentinel", () => {
    // The sentinel means the box is usable; manifest.sha256 is the separate
    // batteries contract, written by the operator's rollout run.
    const sentinel = cloudInit.indexOf(
      "date -uIseconds > /usr/local/automata/.provisioned",
    );
    const note = cloudInit.indexOf(RUNBOOK_SECTION);
    expect(sentinel).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(sentinel);
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
      "allowedHelperRefs",
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

  it("the launcher points WORKER_DAEMON_DIST at the bundle it stages (UAT #229 F1)", () => {
    // The launcher used to stage the daemon into /usr/local/automata/daemon on
    // every agent-uid boot while the worker, with WORKER_DAEMON_DIST unset,
    // spawned the checkout's packages/daemon/dist instead. The staged snapshot
    // is the one pinned to this boot's revision; a later build in the checkout
    // must not change what the running worker's agents execute. Pin that the
    // block which writes the file also exports its path — same path, after the
    // install, inside the agent-uid branch, before the exec.
    const script = deployFile("linux", "run-worker.sh.template");
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
    const readme = deployFile("README.md");
    expect(readme).toMatch(
      /install -m 0444 \S+ \/usr\/local\/automata\/daemon\/index\.js[^\n]*\n(?:\s*#[^\n]*\n)*\s*export WORKER_DAEMON_DIST=\/usr\/local\/automata\/daemon\/index\.js\n/,
    );
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

  it("keeps NoNewPrivileges OFF — the agent-uid drop depends on it", () => {
    // The worker spawns the agent under a DIFFERENT uid via sudo. Turning this
    // on reads like hardening and instead breaks the uid boundary the whole
    // egress fence is keyed on.
    const unit = deployFile("linux", "automata-worker.service");
    expect(unit).toMatch(/^NoNewPrivileges=no$/m);
    expect(unit).not.toMatch(/^NoNewPrivileges=(yes|true)$/m);
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
    // launcher stages the daemon bundle there on every agent-uid run, so the
    // install fails "Read-only file system" the moment WORKER_AGENT_USER is
    // set — and never before, which is why it survived review of both files
    // read separately. Only comparing them catches it.
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

describe("packages/worker/deploy/linux — egress fence + sudoers (#192 P7/P9)", () => {
  it("the ruleset owns ONE table and never flushes the kernel's", () => {
    // Ubuntu's stock /etc/nftables.conf opens with `flush ruleset`, and Docker
    // keeps 34 chains in the kernel ruleset that it does NOT rebuild on demand.
    // A global flush here takes container networking — and on this box that is
    // the Hatchet engine and its Postgres — down with it.
    const conf = deployFile("linux", "egress-nft.conf");
    expect(conf).not.toMatch(/^\s*flush ruleset/m);
    expect(conf).toMatch(/^table inet automata_egress$/m);
    expect(conf).toMatch(/^delete table inet automata_egress$/m);
  });

  it("fences tcp AND udp, so QUIC is not a hole", () => {
    // udp/443 is HTTP-3. A tcp-only rule leaves an https path that never meets
    // the cooperative proxy.
    const conf = deployFile("linux", "egress-nft.conf");
    expect(conf).toMatch(/meta skuid __AGENT_UID__ tcp dport \{ 80, 443 \}/);
    expect(conf).toMatch(/meta skuid __AGENT_UID__ udp dport \{ 80, 443 \}/);
  });

  it("accepts loopback and never sets a drop policy on output", () => {
    // The per-run proxy, both brokers and the engine are all on 127.0.0.1. A
    // drop policy on the output hook fences the whole box, sshd included.
    const conf = deployFile("linux", "egress-nft.conf");
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
    const pre = deployFile("linux", "nft-preflight.sh");
    expect(pre).toMatch(/refusing to fence uid 0/);
    expect(pre).toMatch(/refusing to fence the worker's own uid/);
    expect(pre).toMatch(/__AGENT_UID__.*unrendered|unrendered/);
    // Parse-check must precede the load.
    expect(pre.indexOf("nft -c -f")).toBeLessThan(pre.indexOf("nft -f"));
  });

  it("the sudoers rule drops to the role account, never root or ALL", () => {
    const sudoers = deployFile("linux", "sudoers.d-automata");
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
    const sudoers = deployFile("linux", "sudoers.d-automata");
    expect(sudoers).toMatch(/AUTOMATA_DAEMON = \/usr\/bin\/sh/);
    expect(sudoers).toMatch(/AUTOMATA_KILL\s+= \/usr\/bin\/kill/);
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

describe("#192: cloud-init installs the agent the runs actually need", () => {
  const ci = () => deployFile("linux", "cloud-init.yaml");

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
  it("ships a unit, because `nft -f` does not survive a reboot", () => {
    // The fence was loaded by hand and nothing reloaded it at boot, so a reboot
    // would have left the agent uid with unrestricted egress while every log
    // line still said the box was fenced. Found by checking, not by an incident.
    const unit = deployFile("linux", "automata-egress.service");
    expect(unit).toMatch(/^Type=oneshot$/m);
    expect(unit).toMatch(/^RemainAfterExit=yes$/m);
    expect(unit).toMatch(/nft-preflight\.sh/);
    expect(unit).toMatch(/^WantedBy=multi-user\.target$/m);
  });

  it("comes up BEFORE the worker accepts work", () => {
    // A worker that takes a run before the fence exists runs that one unfenced.
    expect(deployFile("linux", "automata-egress.service")).toMatch(
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
    const unit = deployFile("linux", "automata-egress.service");
    const execStop = unit.match(/^ExecStop=.*$/m)?.[0] ?? "";
    expect(execStop).toMatch(/delete table inet automata_egress/);
    expect(execStop).not.toMatch(/flush ruleset/);
  });
});

describe("#204: the unit delegates a cgroup subtree, narrowly", () => {
  it("delegates exactly the two controllers, and ONLY from the opt-in drop-in", () => {
    // `Delegate=yes` would hand the worker every controller for no gain. The
    // narrow form is the whole reason this needs no privilege elsewhere.
    //
    // And it lives in the drop-in, not the base unit: delegation is useless
    // without relaxing ProtectControlGroups, so shipping it in the base would
    // mean relaxing hardening on every box, including ones that never cap a run.
    const dropin = deployFile(
      "linux",
      "automata-worker.service.d/10-ceiling.conf",
    );
    expect(dropin).toMatch(/^Delegate=memory pids$/m);
    expect(dropin).not.toMatch(/^Delegate=(yes|true)$/m);
    expect(deployFile("linux", "automata-worker.service")).not.toMatch(
      /^Delegate=/m,
    );
  });

  it("records why a transient scope was not used, WITH the delegation", () => {
    // Someone will propose `systemd-run --scope` again, because #193 specified
    // it. The measurement that killed it belongs next to the line that replaced
    // it, or the next person repeats the polkit discovery from scratch — so it
    // travelled into the drop-in with `Delegate=`, not left behind in the unit.
    const dropin = deployFile(
      "linux",
      "automata-worker.service.d/10-ceiling.conf",
    );
    expect(dropin).toMatch(/polkit/i);
    expect(dropin).toMatch(/systemd-run/);
  });
});

describe("#204: hardening must not fence out the delegated subtree", () => {
  const unitFile = () => deployFile("linux", "automata-worker.service");

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
    const dropin = deployFile(
      "linux",
      "automata-worker.service.d",
      "10-ceiling.conf",
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

describe("#task batteries (phase 7): acceptance script", () => {
  const scriptRel = "packages/worker/deploy/linux/task-batteries-acceptance.sh";
  const scriptPath = path.join(repoRoot, scriptRel);
  const exists = fs.existsSync(scriptPath);
  const script = exists ? read(scriptPath) : "";
  const body = (name: string) => fnBody(script, name);
  const runbook = read(path.join(repoRoot, "deploy", "PILOT-RUNBOOK.md"));
  const isRoot = process.getuid?.() === 0;

  function run(args: string[]) {
    return spawnSync("/bin/bash", [scriptPath, ...args], {
      encoding: "utf8",
      timeout: 30_000,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: os.tmpdir() },
    });
  }

  it("exists (hygiene: describeBashScriptHygiene)", () => {
    expect(exists).toBe(true);
  });

  it("keeps a byte-identical copy of the installer's as_agent and AGENT_PATH", () => {
    // The installer runs as a single root-owned blob copied out of the
    // checkout (PILOT-RUNBOOK), so it cannot source a shared lib from the
    // worker-writable tree; the copies are pinned equal here instead.
    const installer = deployFile("linux", "install-batteries.sh");
    expect(body("as_agent")).toBe(fnBody(installer, "as_agent"));
    expect(assignment(script, "AGENT_PATH")).toBe(
      assignment(installer, "AGENT_PATH"),
    );
  });

  it.each<[string, string[], RegExp]>([
    ["no args", [], /usage/i],
    ["an unknown mode", ["deploy"], /usage/i],
    ["box without --since", ["box", "--repo", "a/b"], /--since/],
    ["box without --repo", ["box", "--since", "now"], /--repo/],
    [
      "box with a malformed --repo",
      ["box", "--since", "now", "--repo", "a/b;id"],
      /--repo/,
    ],
  ])("exits 2 on %s", (_name, args, message) => {
    const result = run(args);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(message);
    expect(result.stdout).not.toContain("ACCEPTANCE:");
  });

  it.skipIf(isRoot)(
    "box refuses a non-root caller with exit 2 before reading anything",
    () => {
      const result = run(["box", "--since", "now", "--repo", "a/b"]);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/root/);
      expect(result.stdout).toBe("");
    },
  );

  it("box checks uid 0 and Linux before the first box read", () => {
    const box = body("box_mode");
    const guard = box.indexOf('[ "$(id -u)" = "0" ]');
    const linux = box.indexOf('[ "$(uname -s)" = "Linux" ]');
    expect(guard).toBeGreaterThan(-1);
    expect(linux).toBeGreaterThan(-1);
    for (const read of [
      "manifest.sha256",
      "journalctl",
      "git_ro",
      "as_agent",
    ]) {
      expect(box.indexOf(read), read).toBeGreaterThan(Math.max(guard, linux));
    }
  });

  it("every git call goes through ONE hardened helper", () => {
    const helper = body("git_ro");
    for (const token of [
      "-c safe.directory=",
      "-c core.fsmonitor=false",
      "-c core.hooksPath=/dev/null",
      "--no-pager",
      "export GIT_CONFIG_NOSYSTEM=1",
      "export GIT_CONFIG_GLOBAL=/dev/null",
      "unset GIT_DIR GIT_WORK_TREE GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT",
    ]) {
      expect(helper, token).toContain(token);
    }
    const rest = code(script.replace(helper, ""));
    expect(rest).not.toMatch(/(^|[\s;&|(`$])git\s/m);
  });

  it("is read-only on the box: no restarts, installs, git writes, schema pushes or chmod/chown outside its own temp dir", () => {
    const c = code(script);
    expect(c).not.toMatch(/systemctl\s+(restart|stop|start)/);
    expect(c).not.toMatch(/install-batteries\.sh/);
    expect(c).not.toMatch(/rm -rf \//);
    expect(c).not.toMatch(
      /\bgit(_ro)?\s+(fetch|merge|pull|push|commit|checkout|switch|reset)\b/,
    );
    expect(c).not.toMatch(/drizzle/);
    const perms = c.split("\n").filter((l) => /\b(chmod|chown)\b/.test(l));
    expect(perms.length).toBeGreaterThan(0);
    for (const line of perms) {
      expect(line).toContain('"$VERIFY_HOME"');
    }
    expect(c).toContain('VERIFY_HOME="$(mktemp -d');
    expect(c).toContain("trap cleanup EXIT");
  });

  it("box mode checks the install, the agent view and the journal", () => {
    const c = code(script);
    for (const token of [
      "manifest.sha256",
      "manifest.sha256.invalid",
      "/tools/",
      "cat-file blob HEAD:packages/worker/deploy/batteries.json",
      "command -v dart",
      "import requests",
      "journalctl -u automata-worker.service",
      "--no-pager -o cat",
      "batteries: lane=task packs=",
      "] task agent: read-token=",
      "run start: lane=",
      "batteries: mode=",
    ]) {
      expect(c, token).toContain(token);
    }
  });

  it("agent checks use the Phase 3 sudo spawn shape with constant command strings", () => {
    const spawn = body("as_agent");
    for (const token of [
      'runuser -u "$WORKER_USER" -- env -i',
      '/usr/bin/sudo -n -u "$AGENT_USER" -E --',
      `/bin/sh -c 'exec bash -lc "$1"' sh`,
      "</dev/null",
    ]) {
      expect(spawn, token).toContain(token);
    }
    expect(code(script)).not.toMatch(
      /as_agent '[^']*\$\{?(wrapper|args|line|repo|since|tid|path|ROOT|BIN_DIR)\b/,
    );
  });

  it("prints the SC4 manual evidence rules exactly", () => {
    for (const token of [
      "EVIDENCE manual",
      "reports = each report's content (DORA, react-health, security) quoted or summarised in the transcript or final message — a branch is not evidence (reports/ is gitignored)",
      "somnio exit codes: record verbatim; never pass/fail evidence",
      "DORA: Deployment Frequency + Lead Time computed from GitHub in the unchanged run — no 401",
    ]) {
      expect(script, token).toContain(token);
    }
    expect(script).toContain('echo "ACCEPTANCE: PASS"');
    expect(script).toContain('echo "ACCEPTANCE: FAIL ($FAILURES)"');
  });

  it("local mode runs the phase gates and maps them to SC1-SC3", () => {
    const local = body("local_mode");
    for (const token of [
      "SC1",
      "SC2",
      "SC3",
      "NODE_OPTIONS=--max-old-space-size=12288",
      "transport.golden.json",
      "batteries-dry-run.sh",
      "--no-file-parallelism",
    ]) {
      expect(local, token).toContain(token);
    }
  });

  it("names no customer (public repo)", () => {
    expect(script).not.toMatch(/bangr/i);
    expect(runbook).not.toMatch(/bangr/i);
  });

  describe("journal analysis (sourced, fixture journal)", () => {
    const PREFIX = "0123456789ab";
    const T = "thr_task_1";
    const R = "thr_review_1";

    function analyse(journal: string, repo = "acme/admin") {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tba-journal-"));
      try {
        const file = path.join(dir, "journal.txt");
        fs.writeFileSync(file, journal);
        const result = spawnSync(
          "/bin/bash",
          [
            "-c",
            'source "$1"; FAILURES=0; analyse_journal "$2" "$3" "$4"; echo "FAILURES=$FAILURES"',
            "sh",
            scriptPath,
            file,
            repo,
            PREFIX,
          ],
          { encoding: "utf8", timeout: 30_000 },
        );
        return result.stdout + result.stderr;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    const taskRun = (extra: string[] = []) =>
      [
        `[agent-run ${T} trace=00-a-b-01] run start: lane=task repo=acme/admin branch=main`,
        `[agent-run ${T} trace=00-a-b-01] agent credential: credits (box trust: shared)`,
        `[agent-run ${T} trace=00-a-b-01] batteries: lane=task packs=somnio-skills manifest=${PREFIX}`,
        ...extra,
      ].join("\n");
    const APPLIED = `[agent-run ${T} trace=00-a-b-01] task agent: read-token=applied`;
    const reviewRun = [
      `[agent-run ${R}] run start: lane=review pr=3 repo=acme/web branch=f policy=newest-wins`,
      `[agent-run ${R}] batteries: mode=classic`,
    ].join("\n");

    it("a seeded task run with the read token and a clean review run pass", () => {
      const out = analyse(`${taskRun([APPLIED])}\n${reviewRun}\n`);
      expect(out).toContain("FAILURES=0");
      expect(out).toContain(`EVIDENCE task-run thread: ${T}`);
    });

    it("a manifest prefix that differs from manifest.sha256 fails", () => {
      const out = analyse(
        `${taskRun([APPLIED]).replace(PREFIX, "ffffffffffff")}\n`,
      );
      expect(out).not.toContain("FAILURES=0");
    });

    it("no read-token line, or any skip=<reason> line, fails (a skip sticks)", () => {
      expect(analyse(`${taskRun()}\n`)).not.toContain("FAILURES=0");
      const skip = `[agent-run ${T}] task agent: read-token=skip=not-delivered`;
      for (const lines of [[skip], [APPLIED, skip], [skip, APPLIED]]) {
        const out = analyse(`${taskRun(lines)}\n`);
        expect(out).not.toContain("FAILURES=0");
        expect(out).toContain("(read-token=skip=not-delivered)");
      }
    });

    it("a task run for another repo is not evidence", () => {
      expect(analyse(`${taskRun([APPLIED])}\n`, "acme/other")).not.toContain(
        "FAILURES=0",
      );
    });

    it("a review run with a lane= line or a read-token line fails the regression check", () => {
      const start = `[agent-run ${R}] run start: lane=review pr=3 repo=acme/web branch=f`;
      for (const bad of [
        `${start}\n[agent-run ${R}] batteries: lane=task packs=somnio-skills manifest=${PREFIX}`,
        `${start}\n[agent-run ${R}] batteries: mode=classic\n[agent-run ${R}] task agent: read-token=skip=no-requiring-pack`,
      ]) {
        expect(analyse(`${taskRun([APPLIED])}\n${bad}\n`)).not.toContain(
          "FAILURES=0",
        );
      }
    });
  });
});
