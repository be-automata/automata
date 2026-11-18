// The `main` ruleset (deploy/github/ruleset-main.json) and .github/CODEOWNERS
// against the tree they protect (#697). A CODEOWNERS pattern that matches no
// file silently drops the protection, and a required check that CI does not
// produce blocks every PR, so both are checked here rather than by eye.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

const ROOT = join(import.meta.dirname, "..", "..");
const WORKFLOWS = join(ROOT, ".github/workflows");
const GITHUB_ACTIONS_APP_ID = 15368;
const GATE_JOB = "ci-gate";
const OWNER = "@espinozasenior";

interface Rule {
  type: string;
  parameters?: Record<string, unknown>;
}

interface Ruleset {
  name: string;
  target: string;
  enforcement: string;
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  bypass_actors: {
    actor_id: number;
    actor_type: string;
    bypass_mode: string;
  }[];
  rules: Rule[];
}

const ruleset = JSON.parse(
  readFileSync(join(import.meta.dirname, "ruleset-main.json"), "utf8"),
) as Ruleset;

function rule(type: string): Rule {
  const found = ruleset.rules.find((r) => r.type === type);
  assert.ok(found, `ruleset has no ${type} rule`);
  return found;
}

/** Top-level job ids of a workflow (2-space keys after `jobs:`). */
function jobIds(text: string): string[] {
  const jobs = text.slice(text.search(/^jobs:\s*$/m));
  return [...jobs.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]!);
}

const ciText = readFileSync(join(WORKFLOWS, "ci.yml"), "utf8");

describe("ruleset-main.json", () => {
  test("targets main only, enforced", () => {
    assert.equal(ruleset.target, "branch");
    assert.equal(ruleset.enforcement, "active");
    assert.deepEqual(ruleset.conditions.ref_name, {
      include: ["refs/heads/main"],
      exclude: [],
    });
    assert.ok(ruleset.name.length > 0);
  });

  test("uses only the rule types it means to (incl. no deletion, no force push)", () => {
    assert.deepEqual(ruleset.rules.map((r) => r.type).sort(), [
      "deletion",
      "non_fast_forward",
      "pull_request",
      "required_status_checks",
    ]);
  });

  test("requires a PR with a code-owner approval, dismissed on push", () => {
    assert.deepEqual(rule("pull_request").parameters, {
      // 0 on purpose: a code owner's approval is still required whenever a
      // code-owned file changes; other PRs keep merging on Automata's
      // approval (enforced by the harness, not GitHub) and green CI (#697 AC 2).
      required_approving_review_count: 0,
      require_code_owner_review: true,
      dismiss_stale_reviews_on_push: true,
      require_last_push_approval: false,
      required_review_thread_resolution: false,
    });
  });

  test(`requires only CI's ${GATE_JOB} job, from GitHub Actions`, () => {
    assert.deepEqual(rule("required_status_checks").parameters, {
      strict_required_status_checks_policy: false,
      do_not_enforce_on_create: false,
      required_status_checks: [
        { context: GATE_JOB, integration_id: GITHUB_ACTIONS_APP_ID },
      ],
    });
  });

  test("the only bypass is the org-admin break-glass, through a PR", () => {
    assert.deepEqual(ruleset.bypass_actors, [
      {
        actor_id: 1,
        actor_type: "OrganizationAdmin",
        bypass_mode: "pull_request",
      },
    ]);
  });
});

describe(`ci.yml ${GATE_JOB}`, () => {
  const gate = ciText.slice(
    ciText.search(new RegExp(`^ {2}${GATE_JOB}:`, "m")),
  );

  test("needs every other CI job and runs even when one failed", () => {
    const needs = /^ {4}needs: \[([^\]]*)\]/m.exec(gate)?.[1];
    assert.ok(needs, `${GATE_JOB} has no one-line needs: [...]`);
    assert.deepEqual(
      needs
        .split(",")
        .map((s) => s.trim())
        .sort(),
      jobIds(ciText)
        .filter((id) => id !== GATE_JOB)
        .sort(),
      `a CI job missing from ${GATE_JOB}'s needs is not required`,
    );
    assert.match(gate, /^ {4}if: always\(\)$/m);
    assert.match(gate, /all\(\.\[\]; \.result == "success"\)/);
  });

  test("no other workflow has a job with the required name", () => {
    for (const workflow of readdirSync(WORKFLOWS)) {
      if (workflow === "ci.yml") continue;
      const ids = jobIds(readFileSync(join(WORKFLOWS, workflow), "utf8"));
      assert.ok(!ids.includes(GATE_JOB), `${workflow} shadows ${GATE_JOB}`);
    }
  });
});

describe(".github/CODEOWNERS", () => {
  const entries = readFileSync(join(ROOT, ".github/CODEOWNERS"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [pattern, ...owners] = line.split(/\s+/);
      return { pattern: pattern!, owners };
    });

  /**
   * Tracked files matching the patterns, by git's own gitignore matcher (the
   * syntax CODEOWNERS follows), one git call for all patterns.
   */
  function matching(patterns: string[]): Set<string> {
    const dir = mkdtempSync(join(tmpdir(), "codeowners-"));
    try {
      const file = join(dir, "patterns");
      writeFileSync(file, patterns.join("\n") + "\n");
      const out = execFileSync(
        "git",
        ["ls-files", "-z", "--cached", "--ignored", `--exclude-from=${file}`],
        { cwd: ROOT, encoding: "utf8" },
      );
      return new Set(out.split("\0").filter(Boolean));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const owned = matching(entries.map((e) => e.pattern));

  test("has entries, each anchored and owned by the TL only", () => {
    assert.ok(entries.length > 0);
    for (const { pattern, owners } of entries) {
      assert.ok(
        pattern.startsWith("/"),
        `${pattern}: anchor it with a leading /`,
      );
      assert.deepEqual(owners, [OWNER], pattern);
    }
  });

  test("every pattern matches at least one tracked file", () => {
    for (const { pattern } of entries) {
      assert.ok(
        matching([pattern]).size > 0,
        `${pattern} matches no tracked file: protection silently skipped`,
      );
    }
  });

  test("covers the sensitive paths named in #697", () => {
    for (const file of [
      ".github/CODEOWNERS",
      ".github/workflows/ci.yml",
      "deploy/migrations/0000-baseline.sql",
      "deploy/github/ruleset-main.json",
      "packages/shared/src/db/schema.ts",
      "packages/migrate/src/runner.ts",
      "apps/www/src/lib/daemon-token.ts",
      "apps/www/src/lib/daemon-api-key.ts",
      "apps/www/src/lib/auth.ts",
      "packages/cell-broker/src/git.ts",
      "apps/www/src/server-lib/credential-broker/resolve-credential-broker.ts",
      "packages/shared/src/model/agent-provider-credentials.ts",
      "apps/www/wrangler.jsonc",
      "apps/broadcast/wrangler.jsonc",
      ".claude/settings.json",
      ".claude/hooks/deny-destructive-cloud.py",
    ]) {
      assert.ok(
        owned.has(file),
        `${file} has no code owner (or is not tracked)`,
      );
    }
  });

  test("a * stays inside one path segment", () => {
    // Test fixtures named *.wrangler.jsonc are not the Workers config.
    assert.ok(
      !owned.has(
        "apps/www/src/server-lib/compute/__fixtures__/cell-policy-workerd.wrangler.jsonc",
      ),
    );
  });
});
