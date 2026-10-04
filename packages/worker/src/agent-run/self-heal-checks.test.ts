import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AUDIT_CHECK_KINDS } from "../../../shared/src/self-heal/audit-rules";
import type { AgentCommandResult, RunAsAgent } from "./agent-command";
import {
  FILE_EXISTS_SCRIPT,
  AUDIT_PNPM_ENV,
  AUDIT_PNPM_PATH,
  isSafeSubject,
  parseNpmAuditJson,
  parsePnpmAuditJson,
  runSelfHealChecks,
  SELF_HEAL_CHECK_KINDS,
  workflowActionsPinned,
  workflowHasPermissions,
} from "./self-heal-checks";
import type { SelfHealCheckShape } from "./types";

interface Call {
  script: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function res(
  exitCode: number | null,
  stdout = "",
  extra: Partial<AgentCommandResult> = {},
): AgentCommandResult {
  return { exitCode, stdout, timedOut: false, truncated: false, ...extra };
}

function harness(handler: (call: Call) => AgentCommandResult): {
  run: RunAsAgent;
  calls: Call[];
} {
  const calls: Call[] = [];
  const run: RunAsAgent = async (a) => {
    const call = { script: a.script, args: a.args, env: a.env };
    calls.push(call);
    return handler(call);
  };
  return { run, calls };
}

function exec(
  checks: SelfHealCheckShape[],
  run: RunAsAgent,
  extra: { budgetMs?: number; now?: () => number } = {},
) {
  return runSelfHealChecks({
    checks,
    run,
    agentUser: "automata-agent",
    workdir: "/wd",
    env: { PATH: "/usr/bin" },
    ...extra,
  });
}

const chk = (
  check: string,
  subject: string,
  key?: string,
  fingerprint = "fp",
): SelfHealCheckShape => ({
  fingerprint,
  check,
  subject,
  ...(key ? { key } : {}),
});

describe("audit json parsers", () => {
  it("parses pnpm advisories and vulnerabilities", () => {
    expect(
      parsePnpmAuditJson(
        JSON.stringify({ advisories: { "1": { module_name: "lodash" } } }),
      ),
    ).toEqual(new Set(["lodash"]));
    expect(parsePnpmAuditJson(JSON.stringify({ advisories: {} }))).toEqual(
      new Set(),
    );
  });
  it("parses npm vulnerabilities", () => {
    expect(
      parseNpmAuditJson(JSON.stringify({ vulnerabilities: { minimist: {} } })),
    ).toEqual(new Set(["minimist"]));
  });
  it("throws on garbage", () => {
    expect(() => parsePnpmAuditJson("not json")).toThrow();
    expect(() => parsePnpmAuditJson('{"error":{}}')).toThrow();
    expect(() => parseNpmAuditJson("[]")).toThrow();
  });
});

describe("npm-audit-clean", () => {
  const pnpmHandler = (c: Call): AgentCommandResult => {
    if (c.args[0] === "pnpm-lock.yaml") return res(0);
    return res(
      1,
      JSON.stringify({ advisories: { "1": { module_name: "lodash" } } }),
    );
  };
  it("fails when present, passes when absent, with ONE audit for two checks", async () => {
    const { run, calls } = harness(pnpmHandler);
    const out = await exec(
      [
        chk("npm-audit-clean", "npm:lodash", undefined, "a"),
        chk("npm-audit-clean", "npm:left-pad", undefined, "b"),
      ],
      run,
    );
    expect(out).toEqual([
      { fingerprint: "a", outcome: "fail" },
      { fingerprint: "b", outcome: "pass" },
    ]);
    expect(calls.filter((c) => c.script.includes("audit --prod"))).toHaveLength(
      1,
    );
  });
  it("runs the pinned absolute pnpm with the no-self-switch env, script constant", async () => {
    const { run, calls } = harness(pnpmHandler);
    await exec([chk("npm-audit-clean", "npm:lodash")], run);
    const audit = calls.find((c) => c.script.includes("audit --prod"));
    expect(audit?.args).toEqual([AUDIT_PNPM_PATH]);
    expect(audit?.script).toBe(
      'test -x "$1" || exit 3; exec "$1" audit --prod --json 2>/dev/null',
    );
    expect(AUDIT_PNPM_PATH).toMatch(/^\/usr\/local\/lib\/automata-batteries\//);
    expect(audit?.env).toMatchObject({
      PATH: "/usr/bin",
      npm_config_manage_package_manager_versions: "false",
      COREPACK_ENABLE_STRICT: "0",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    });
    expect(AUDIT_PNPM_ENV).toEqual({
      npm_config_manage_package_manager_versions: "false",
      COREPACK_ENABLE_STRICT: "0",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    });
    // The no-self-switch env is for the audit only; other commands keep theirs.
    expect(
      calls
        .filter((c) => c !== audit)
        .every((c) => !("COREPACK_ENABLE_STRICT" in c.env)),
    ).toBe(true);
  });
  it("honours an injected pnpm path", async () => {
    const { run, calls } = harness(pnpmHandler);
    await runSelfHealChecks({
      checks: [chk("npm-audit-clean", "npm:lodash")],
      run,
      agentUser: "",
      workdir: "/wd",
      env: {},
      pnpmPath: "/opt/pnpm",
    });
    expect(calls.find((c) => c.script.includes("audit --prod"))?.args).toEqual([
      "/opt/pnpm",
    ]);
  });
  it("reports error with a distinct note when the pinned pnpm is absent", async () => {
    const notes: string[] = [];
    const { run } = harness((c) =>
      c.args[0] === "pnpm-lock.yaml" ? res(0) : res(3),
    );
    const out = await runSelfHealChecks({
      checks: [chk("npm-audit-clean", "npm:lodash")],
      run,
      agentUser: "",
      workdir: "/wd",
      env: {},
      note: (m) => notes.push(m),
    });
    expect(out[0]?.outcome).toBe("error");
    expect(notes).toEqual([
      "npm-audit-clean: pinned pnpm is not installed on this box",
    ]);
  });
  it("falls back to npm when only package-lock.json exists", async () => {
    const { run, calls } = harness((c) => {
      if (c.args[0] === "pnpm-lock.yaml") return res(1);
      if (c.args[0] === "package-lock.json") return res(0);
      return res(1, JSON.stringify({ vulnerabilities: { lodash: {} } }));
    });
    const out = await exec([chk("npm-audit-clean", "npm:lodash")], run);
    expect(out[0]?.outcome).toBe("fail");
    expect(calls.some((c) => c.script.startsWith("npm audit"))).toBe(true);
  });
  it("errors without a lockfile or on unparseable output", async () => {
    const none = harness(() => res(1));
    expect(
      (await exec([chk("npm-audit-clean", "npm:x")], none.run))[0]?.outcome,
    ).toBe("error");
    const bad = harness((c) =>
      c.args[0] === "pnpm-lock.yaml" ? res(0) : res(0, "garbage"),
    );
    expect(
      (await exec([chk("npm-audit-clean", "npm:x")], bad.run))[0]?.outcome,
    ).toBe("error");
  });
});

describe("workflow checks", () => {
  const sha = "a".repeat(40);
  it("detects unpinned and pinned actions", () => {
    expect(
      workflowActionsPinned(
        "steps:\n  - uses: actions/checkout@v4\n",
        "actions/checkout",
      ),
    ).toBe(false);
    expect(
      workflowActionsPinned(
        `steps:\n  - uses: actions/checkout@${sha} # v4\n`,
        "actions/checkout",
      ),
    ).toBe(true);
    expect(
      workflowActionsPinned("  - uses: other/thing@v1\n", "actions/checkout"),
    ).toBe(true);
  });
  it("detects top-level permissions only", () => {
    expect(
      workflowHasPermissions("name: x\npermissions:\n  contents: read\n"),
    ).toBe(true);
    expect(
      workflowHasPermissions(
        "jobs:\n  a:\n    permissions:\n      contents: read\n",
      ),
    ).toBe(false);
  });
  it("maps files through the runner; absent file passes", async () => {
    const { run } = harness((c) => {
      if (c.args[0] === "missing.yml") return res(3);
      return res(0, "steps:\n  - uses: actions/checkout@v4\n");
    });
    const out = await exec(
      [
        chk(
          "workflow-actions-pinned",
          ".github/workflows/ci.yml",
          "actions/checkout",
          "a",
        ),
        chk("workflow-actions-pinned", "missing.yml", "actions/checkout", "b"),
        chk(
          "workflow-has-permissions",
          ".github/workflows/ci.yml",
          undefined,
          "c",
        ),
      ],
      run,
    );
    expect(out.map((o) => o.outcome)).toEqual(["fail", "pass", "fail"]);
  });
});

describe("simple kinds", () => {
  it("file-exists", async () => {
    const codes = [0, 1, 2];
    const { run } = harness(() => res(codes.shift() ?? 2));
    const out = await exec(
      [
        chk("file-exists", "a", undefined, "1"),
        chk("file-exists", "b", undefined, "2"),
        chk("file-exists", "c", undefined, "3"),
      ],
      run,
    );
    expect(out.map((o) => o.outcome)).toEqual(["pass", "fail", "error"]);
  });
  it("path-untracked: tracked fails, unmatched passes, git failure errors", async () => {
    const codes = [0, 1, 128];
    const { run } = harness(() => res(codes.shift() ?? 128));
    const out = await exec(
      [
        chk("path-untracked", "a", undefined, "1"),
        chk("path-untracked", "b", undefined, "2"),
        chk("path-untracked", "c", undefined, "3"),
      ],
      run,
    );
    expect(out.map((o) => o.outcome)).toEqual(["fail", "pass", "error"]);
  });
  it("gitignore-has-pattern", async () => {
    const { run } = harness(() => res(0, "node_modules\n.env\n"));
    const out = await exec(
      [
        chk("gitignore-has-pattern", ".gitignore", ".env", "1"),
        chk("gitignore-has-pattern", ".gitignore", "*.pem", "2"),
      ],
      run,
    );
    expect(out.map((o) => o.outcome)).toEqual(["pass", "fail"]);
  });
  it("gitleaks: exit mapping and output never surfaces", async () => {
    const codes = [0, 1, 2];
    const { run, calls } = harness(() =>
      res(codes.shift() ?? 2, "SECRET=abc123"),
    );
    const out = await exec(
      [
        chk("gitleaks-clean", "a", undefined, "1"),
        chk("gitleaks-clean", "b", undefined, "2"),
        chk("gitleaks-clean", "c", undefined, "3"),
      ],
      run,
    );
    expect(out.map((o) => o.outcome)).toEqual(["pass", "fail", "error"]);
    expect(JSON.stringify(out)).not.toContain("abc123");
    expect(calls[0]?.script).toContain(">/dev/null");
  });
});

describe("safety", () => {
  it("rejects unsafe subjects without running a command", async () => {
    const { run, calls } = harness(() => res(0));
    const out = await exec(
      ["/etc/passwd", "a/../b", ".git/config", "a\u0000b"].map((s, i) =>
        chk("file-exists", s, undefined, String(i)),
      ),
      run,
    );
    expect(out.every((o) => o.outcome === "error")).toBe(true);
    expect(calls).toHaveLength(0);
    expect(isSafeSubject("src/a.ts")).toBe(true);
    expect(isSafeSubject(".github/workflows/ci.yml")).toBe(true);
  });
  it("keeps a hostile key out of the command", async () => {
    const { run, calls } = harness(() => res(0, ".env\n"));
    await exec([chk("gitignore-has-pattern", ".gitignore", "; rm -rf /")], run);
    expect(JSON.stringify(calls)).not.toContain("rm -rf");
  });
  it("reports error for timeouts and unknown kinds", async () => {
    const { run } = harness(() => res(null, "", { timedOut: true }));
    const out = await exec(
      [
        chk("file-exists", "a", undefined, "1"),
        chk("nope", "a", undefined, "2"),
      ],
      run,
    );
    expect(out.map((o) => o.outcome)).toEqual(["error", "error"]);
  });
  it("errors the remaining checks once the budget is exhausted", async () => {
    let t = 0;
    const { run } = harness(() => {
      t += 100;
      return res(0);
    });
    const out = await exec(
      [
        chk("file-exists", "a", undefined, "1"),
        chk("file-exists", "b", undefined, "2"),
      ],
      run,
      { budgetMs: 100, now: () => t },
    );
    expect(out.map((o) => o.outcome)).toEqual(["pass", "error"]);
  });
});

describe("cross-plane drift", () => {
  it("SELF_HEAL_CHECK_KINDS equals shared AUDIT_CHECK_KINDS", () => {
    expect([...SELF_HEAL_CHECK_KINDS].sort()).toEqual(
      [...AUDIT_CHECK_KINDS].sort(),
    );
  });
});

describe("FILE_EXISTS_SCRIPT (real /bin/sh)", () => {
  it("exits 0 for an existing file and 1 for a missing one — never 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "fe-"));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    const run = (name: string) =>
      spawnSync("/bin/sh", ["-c", FILE_EXISTS_SCRIPT, "sh", name], {
        cwd: dir,
      }).status;
    expect(run("pnpm-lock.yaml")).toBe(0);
    expect(run("missing.yaml")).toBe(1);
  });
});
