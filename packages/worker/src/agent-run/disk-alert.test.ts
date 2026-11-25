import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../deploy/linux/disk-alert.sh",
);
const URL = "https://hooks.slack.com/services/T000/B000/fake-not-a-secret";

/**
 * Runs disk-alert.sh against a fake `df` (prints the usage in `pct`) and a fake
 * `curl` (records its argv and stdin config, fails while `curl-fails` exists).
 */
describe("disk-alert.sh (2026-11-24: the disk hit 100% and nobody was told)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "disk-alert-"));
    fs.writeFileSync(
      path.join(dir, "df"),
      `#!/bin/bash\necho "Use% Avail"\necho " $(cat ${dir}/pct)% 7G"\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(dir, "curl"),
      `#!/bin/bash
[ -e ${dir}/curl-fails ] && exit 22
{ echo "ARGV $*"; echo "STDIN $(cat)"; } >> ${dir}/curl.log
`,
      { mode: 0o755 },
    );
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function tick(pct: number, opts: { url?: string | null } = {}) {
    fs.writeFileSync(path.join(dir, "pct"), String(pct));
    const urlFile = path.join(dir, "url");
    if (opts.url === null) fs.rmSync(urlFile, { force: true });
    else fs.writeFileSync(urlFile, `${opts.url ?? URL}\n`, { mode: 0o600 });
    const r = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        DISK_ALERT_DF: path.join(dir, "df"),
        DISK_ALERT_CURL: path.join(dir, "curl"),
        DISK_ALERT_URL_FILE: urlFile,
        DISK_ALERT_STATE_DIR: path.join(dir, "state"),
        DISK_ALERT_MOUNT: dir,
        DISK_ALERT_BOX: "automata-exec-1",
        DISK_ALERT_SKIP_ROOT_CHECK: "1",
      },
    });
    const log = path.join(dir, "curl.log");
    const posts = fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .split("\n")
          .filter((l) => l.startsWith("ARGV"))
      : [];
    return {
      ...r,
      posts,
      log: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "",
    };
  }

  // card: protects=one Slack message when the disk crosses 85% and one when it drops under 80%, never one per tick in between; fails_when=a tick at 86% posts again, 82% posts a recovery, or the crossing does not post; no_claim=Slack's delivery
  it("posts once on crossing 85% and once on recovering under 80%", () => {
    expect(tick(70).posts).toHaveLength(0);
    const high = tick(86);
    expect(high.status).toBe(0);
    expect(high.posts).toHaveLength(1);
    expect(high.log).toMatch(/automata-exec-1\* disk is 86% full \(7G free/);
    expect(tick(90).posts).toHaveLength(1);
    expect(tick(82).posts).toHaveLength(1);
    const back = tick(79);
    expect(back.posts).toHaveLength(2);
    expect(back.log).toMatch(/disk is back to 79%/);
  });

  // card: protects=the webhook URL (a secret) never reaches curl's argv or the journal, only its stdin config; fails_when=the URL appears in argv or stdout; no_claim=root-only file mode on the box (install step)
  it("keeps the webhook URL out of argv and the log", () => {
    const r = tick(95);
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0]).not.toContain("hooks.slack.com");
    expect(r.log).toContain(`STDIN url = "${URL}"`);
    expect(r.stdout).not.toContain("hooks.slack.com");
  });

  it("without a webhook file it logs and keeps the state, so the alert posts once a file exists", () => {
    const none = tick(95, { url: null });
    expect(none.status).toBe(0);
    expect(none.posts).toHaveLength(0);
    expect(none.stdout).toMatch(/no webhook/);
    expect(tick(95).posts).toHaveLength(1);
  });

  it("a failed post keeps the state, so the next tick retries", () => {
    fs.writeFileSync(path.join(dir, "curl-fails"), "");
    expect(tick(95).stdout).toMatch(/post failed/);
    fs.rmSync(path.join(dir, "curl-fails"));
    expect(tick(95).posts).toHaveLength(1);
  });

  // card: protects=the script's df flags work with the real GNU coreutils df the box runs (a fake df hid `-P` + `--output` being refused); fails_when=the real df rejects the flags or its output does not parse; no_claim=macOS (BSD df has no --output: skipped there, runs on Linux CI)
  it.skipIf(process.platform !== "linux")("reads the real GNU df", () => {
    fs.writeFileSync(path.join(dir, "url"), `${URL}\n`);
    const r = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        DISK_ALERT_CURL: path.join(dir, "curl"),
        DISK_ALERT_URL_FILE: path.join(dir, "url"),
        DISK_ALERT_STATE_DIR: path.join(dir, "state"),
        DISK_ALERT_MOUNT: dir,
        DISK_ALERT_BOX: "ci",
        DISK_ALERT_SKIP_ROOT_CHECK: "1",
      },
    });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/disk \d+% used, \d+G free on /);
  });

  it("refuses a URL that is not a Slack webhook", () => {
    const r = tick(95, { url: "https://example.com/x" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not a Slack webhook/);
    expect(r.posts).toHaveLength(0);
  });
});
