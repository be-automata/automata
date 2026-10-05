import type { FixtureManifest, Seed } from "./fixture-manifest";
import {
  BENCH_FAKE_MARKER,
  BENCH_PINNED_ACTIONS,
  BENCH_SUB_PACKAGES,
} from "./seed-catalog";

/**
 * Deterministic renderer of the self-heal benchmark fixture (R6, phase 9).
 *
 * renderFixture(manifest) returns two file maps (path -> UTF-8 text):
 * - repoFiles: a small Node package (ESM, Node >= 18, no build step) holding
 *   every seed: vulnerable root dependencies, sub-packages without lockfiles,
 *   README links to missing SECURITY.md files, tag-pinned actions, workflows
 *   without permissions, a .gitignore missing sensitive patterns, committed
 *   fake sensitive files and modules with a hardcoded fake credential.
 * - hiddenTests: one node:test script per seed under hidden-tests/, asserting
 *   behaviour a correct fix preserves (a dependency is bumped, not removed; a
 *   credential moves to the environment and the function still works; a
 *   workflow keeps its jobs). They pass on the unfixed fixture and are run by
 *   verify-fixes on each fix PR head:
 *     BENCH_REPO_ROOT=<checkout> node --test hidden-tests/S01.test.mjs
 *
 * Pure and deterministic: no clock, no randomness, no IO; keys are sorted.
 * The root lockfile is NOT rendered (no network here): the operator generates
 * it once in the private fixture repo.
 *
 * SAFETY: push a rendered fixture only to a PRIVATE repo; never run the
 * benchmark against the public pilot repo.
 */

export interface RenderedFixture {
  repoFiles: Record<string, string>;
  hiddenTests: Record<string, string>;
}

const ROOT_PACKAGE_NAME = "bench-fixture-app";
const ROOT_TEST_SCRIPT = "node --test test/*.test.js";
/** Patterns the fixture's .gitignore always carries. */
const GITIGNORE_BASE = [
  "node_modules/",
  "dist/",
  "coverage/",
  "*.log",
  "*.pem",
  "*.key",
  "*.p12",
];
/** The directory patterns every gitignore fix must keep. */
const GITIGNORE_KEPT = GITIGNORE_BASE.filter((line) => line.endsWith("/"));
const SECURITY_LINK =
  "Report vulnerabilities as described in [SECURITY.md](SECURITY.md).";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function joinPath(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function jobIdOf(workflowPath: string): string {
  return baseName(workflowPath).replace(/\.ya?ml$/, "");
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sorted(files: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of [...files.keys()].sort()) {
    out[path] = files.get(path) ?? "";
  }
  return out;
}

/** The root module consuming a dep.vulnerable seed (catalog params). */
function consumerOf(seed: Seed): {
  path: string;
  importLine: string;
  fn: string;
  body: string;
} {
  const name = seed.subject.slice("npm:".length);
  const p = seed.params ?? {};
  const path = p.consumer ?? `src/integrations/${name}.js`;
  return p.importLine !== undefined &&
    p.fn !== undefined &&
    p.body !== undefined
    ? { path, importLine: p.importLine, fn: p.fn, body: p.body }
    : {
        path,
        importLine: `import * as dependency from "${name}";`,
        fn: "dependencyExports",
        body: "export function dependencyExports() {\n  return Object.keys(dependency);\n}",
      };
}

interface SecretModule {
  envVar: string;
  fn: string;
  value: string;
}

function secretOf(seed: Seed): SecretModule {
  const stem = baseName(seed.subject).replace(/\.[cm]?js$/, "");
  const ident = stem.replace(/[^A-Za-z0-9]/g, "");
  return {
    envVar: seed.params?.envVar ?? `${ident.toUpperCase()}_API_KEY`,
    fn: seed.params?.fn ?? `${ident}AuthHeader`,
    value: `${seed.params?.head ?? "Bx4"}${seed.params?.tail ?? "Kq7"}`,
  };
}

// ---------------------------------------------------------------- workflows

interface WorkflowPlan {
  unpinned: { action: string; tag: string }[];
  pinned: (keyof typeof BENCH_PINNED_ACTIONS)[];
  permissions: boolean;
}

function isPinnedAction(
  action: string | undefined,
): action is keyof typeof BENCH_PINNED_ACTIONS {
  return action !== undefined && action in BENCH_PINNED_ACTIONS;
}

function planWorkflows(seeds: readonly Seed[]): Map<string, WorkflowPlan> {
  const plans = new Map<string, WorkflowPlan>();
  const planFor = (subject: string): WorkflowPlan => {
    const existing = plans.get(subject);
    if (existing) return existing;
    const created: WorkflowPlan = {
      unpinned: [],
      pinned: [],
      permissions: true,
    };
    plans.set(subject, created);
    return created;
  };
  planFor(".github/workflows/ci.yml").pinned.push("actions/checkout");
  for (const seed of seeds) {
    if (seed.rule === "ci.action-unpinned") {
      const plan = planFor(seed.subject);
      if (seed.kind === "decoy") {
        const action = isPinnedAction(seed.key) ? seed.key : "actions/checkout";
        if (!plan.pinned.includes(action)) plan.pinned.push(action);
      } else {
        plan.unpinned.push({
          action: seed.key ?? "actions/checkout",
          tag: seed.params?.tag ?? "v4",
        });
      }
    }
    if (seed.rule === "ci.workflow-permissions-missing") {
      const plan = planFor(seed.subject);
      if (seed.kind !== "decoy") plan.permissions = false;
    }
  }
  return plans;
}

function renderWorkflow(path: string, plan: WorkflowPlan): string {
  const job = jobIdOf(path);
  const isCi = path === ".github/workflows/ci.yml";
  const lines = [
    `name: ${job}`,
    "on:",
    ...(isCi
      ? ["  push:", "    branches: [main]", "  pull_request:"]
      : ["  workflow_dispatch:"]),
  ];
  if (plan.permissions) lines.push("permissions:", "  contents: read");
  lines.push("jobs:", `  ${job}:`, "    runs-on: ubuntu-latest", "    steps:");
  for (const action of plan.pinned) {
    const pin = BENCH_PINNED_ACTIONS[action];
    lines.push(`      - uses: ${action}@${pin.sha} # ${pin.tag}`);
  }
  for (const { action, tag } of plan.unpinned) {
    lines.push(`      - uses: ${action}@${tag}`);
  }
  lines.push(
    isCi
      ? `      - run: ${ROOT_TEST_SCRIPT}`
      : `      - run: echo "${job} step"`,
  );
  return `${lines.join("\n")}\n`;
}

// ------------------------------------------------------------ fake contents

function fakeSensitiveContent(path: string): string {
  const name = baseName(path);
  if (name === ".npmrc") {
    // Scoped to an unresolvable host: an auth line for the public registry
    // would make every `npm audit` (the worker's dependency check) fail.
    return [
      `# ${BENCH_FAKE_MARKER}`,
      "@bench-private:registry=https://npm.bench.invalid/",
      "//npm.bench.invalid/:_authToken=BENCHMARK-FAKE-PLACEHOLDER",
      "",
    ].join("\n");
  }
  if (name.endsWith(".tfstate")) {
    return json({
      version: 4,
      terraform_version: "1.5.7",
      serial: 1,
      lineage: "benchmark-fake",
      description: BENCH_FAKE_MARKER,
      outputs: {
        db_password: {
          value: "BENCHMARK-FAKE-PLACEHOLDER",
          type: "string",
          sensitive: true,
        },
      },
      resources: [],
    });
  }
  if (name === ".htpasswd") {
    return `# ${BENCH_FAKE_MARKER}\nbench:BENCHMARK-FAKE-PLACEHOLDER\n`;
  }
  if (name === ".pgpass") {
    return `# ${BENCH_FAKE_MARKER}\nlocalhost:5432:bench:bench:BENCHMARK-FAKE-PLACEHOLDER\n`;
  }
  return `${BENCH_FAKE_MARKER}\nThis placeholder stands in for a private key that was committed by mistake.\n`;
}

function siblingContent(path: string): string {
  if (path.endsWith(".json")) {
    return json({ name: ROOT_PACKAGE_NAME, logLevel: "info" });
  }
  if (path.endsWith(".tf")) {
    return '# Benchmark fixture infrastructure (no real resources).\nterraform {\n  required_version = ">= 1.5.0"\n}\n';
  }
  if (path.endsWith(".md")) {
    return `# ${dirOf(path) || ROOT_PACKAGE_NAME}\n\nNotes for the benchmark fixture.\n`;
  }
  return "benchmark fixture file\n";
}

// ---------------------------------------------------------------- repo files

function renderRepoFiles(manifest: FixtureManifest): Map<string, string> {
  const files = new Map<string, string>();
  const seeds = manifest.seeds;
  const ofRule = (rule: string) => seeds.filter((s) => s.rule === rule);

  // Root package: vulnerable dependencies and their consumers.
  const dependencies = new Map<string, string>();
  for (const seed of ofRule("dep.vulnerable")) {
    const name = seed.subject.slice("npm:".length);
    dependencies.set(name, seed.params?.version ?? "1.0.0");
    const consumer = consumerOf(seed);
    files.set(consumer.path, `${consumer.importLine}\n\n${consumer.body}\n`);
  }
  files.set(
    "package.json",
    json({
      name: ROOT_PACKAGE_NAME,
      version: "1.0.0",
      private: true,
      type: "module",
      scripts: { test: ROOT_TEST_SCRIPT },
      dependencies: sorted(dependencies),
    }),
  );
  files.set(
    "README.md",
    `# ${ROOT_PACKAGE_NAME}\n\nA small service used as the self-heal benchmark fixture.\n\n## Security\n\n${SECURITY_LINK}\n`,
  );

  // Visible tests the fixture CI runs (dependency free).
  files.set(
    "src/util/slugify.js",
    'export function slugify(text) {\n  return text\n    .toLowerCase()\n    .trim()\n    .replace(/[^a-z0-9]+/g, "-")\n    .replace(/^-+|-+$/g, "");\n}\n',
  );
  files.set(
    "src/util/retry-delay.js",
    "export function retryDelay(attempt, baseMs = 100) {\n  return Math.min(baseMs * 2 ** attempt, 10000);\n}\n",
  );
  files.set(
    "test/slugify.test.js",
    'import assert from "node:assert/strict";\nimport { test } from "node:test";\n\nimport { slugify } from "../src/util/slugify.js";\n\ntest("slugify lowercases and joins words", () => {\n  assert.equal(slugify("  Hello, World! "), "hello-world");\n});\n',
  );
  files.set(
    "test/retry-delay.test.js",
    'import assert from "node:assert/strict";\nimport { test } from "node:test";\n\nimport { retryDelay } from "../src/util/retry-delay.js";\n\ntest("retryDelay doubles and caps", () => {\n  assert.equal(retryDelay(0), 100);\n  assert.equal(retryDelay(3), 800);\n  assert.equal(retryDelay(20), 10000);\n});\n',
  );

  // Sub-packages without lockfiles; READMEs link SECURITY.md where seeded.
  const policyDirs = new Set(
    ofRule("ci.security-policy-missing")
      .filter((s) => s.kind !== "decoy")
      .map((s) => dirOf(s.subject)),
  );
  for (const pkg of BENCH_SUB_PACKAGES) {
    const name = `@bench/${baseName(pkg.dir)}`;
    files.set(
      `${pkg.dir}/package.json`,
      json({
        name,
        version: "1.0.0",
        type: "module",
        main: "index.js",
        publishConfig: { access: "public" },
        dependencies: { [pkg.dependency]: pkg.version },
      }),
    );
    files.set(
      `${pkg.dir}/index.js`,
      `import * as dependency from "${pkg.dependency}";\n\nexport { dependency };\n`,
    );
    const links = pkg.linksSecurityPolicy || policyDirs.has(pkg.dir);
    files.set(
      `${pkg.dir}/README.md`,
      `# ${name}\n\nA small utility package of the benchmark fixture.\n${links ? `\n## Security\n\n${SECURITY_LINK}\n` : ""}`,
    );
  }
  for (const dir of policyDirs) {
    const readme = joinPath(dir, "README.md");
    if (!files.has(readme)) {
      files.set(readme, `# ${dir}\n\n## Security\n\n${SECURITY_LINK}\n`);
    }
  }

  // Workflows.
  for (const [path, plan] of planWorkflows(seeds)) {
    files.set(path, renderWorkflow(path, plan));
  }

  // .gitignore without the seeded patterns.
  const missing = new Set(
    ofRule("files.gitignore-missing-pattern")
      .filter((s) => s.kind !== "decoy")
      .map((s) => s.key ?? ""),
  );
  const present = ofRule("files.gitignore-missing-pattern")
    .filter((s) => s.kind === "decoy" && s.key !== undefined)
    .map((s) => s.key ?? "");
  const gitignore = [...GITIGNORE_BASE, ...present].filter(
    (line) => !missing.has(line),
  );
  files.set(".gitignore", `${gitignore.join("\n")}\n`);

  // Committed fake sensitive files and the siblings a fix must keep.
  for (const seed of ofRule("files.sensitive-committed")) {
    files.set(seed.subject, fakeSensitiveContent(seed.subject));
    const sibling = seed.params?.sibling;
    if (sibling !== undefined && !files.has(sibling)) {
      files.set(sibling, siblingContent(sibling));
    }
  }

  // Modules with a hardcoded fake credential.
  for (const seed of ofRule("secret.hardcoded")) {
    const secret = secretOf(seed);
    files.set(
      seed.subject,
      [
        `// ${BENCH_FAKE_MARKER}: the value below is a benchmark fixture, not a credential.`,
        `const ${secret.envVar} = "${secret.value}";`,
        "",
        `export function ${secret.fn}() {`,
        `  return \`Bearer \${${secret.envVar}}\`;`,
        "}",
        "",
      ].join("\n"),
    );
  }

  return files;
}

// -------------------------------------------------------------- hidden tests

const HIDDEN_PRELUDE = [
  'import assert from "node:assert/strict";',
  'import { existsSync, readFileSync } from "node:fs";',
  'import { join } from "node:path";',
  'import { test } from "node:test";',
  'import { pathToFileURL } from "node:url";',
  "",
  "const ROOT = process.env.BENCH_REPO_ROOT ?? process.cwd();",
  "const exists = (path) => existsSync(join(ROOT, path));",
  'const read = (path) => readFileSync(join(ROOT, path), "utf8");',
  "const moduleUrl = (path) => pathToFileURL(join(ROOT, path)).href;",
  "",
].join("\n");

function hiddenBody(seed: Seed): string[] {
  const subject = JSON.stringify(seed.subject);
  switch (seed.rule) {
    case "dep.vulnerable": {
      const name = seed.subject.slice("npm:".length);
      const consumer = consumerOf(seed);
      const importRe = `/["']${escapeRegExp(name)}(\\/[^"']*)?["']/`;
      return [
        `test("${seed.id} keeps ${name} as a dependency and its consumer", () => {`,
        '  const pkg = JSON.parse(read("package.json"));',
        `  assert.ok(pkg.dependencies && ${JSON.stringify(name)} in pkg.dependencies, "dependency removed");`,
        `  const source = read(${JSON.stringify(consumer.path)});`,
        `  assert.match(source, ${importRe});`,
        `  assert.match(source, /export (async )?function ${consumer.fn}\\(/);`,
        "});",
      ];
    }
    case "supply.lockfile-missing": {
      const dir = dirOf(seed.subject);
      const dependency = seed.params?.dependency ?? "";
      return [
        `test("${seed.id} keeps the ${dir || "root"} package intact", () => {`,
        `  const pkg = JSON.parse(read(${JSON.stringify(joinPath(dir, "package.json"))}));`,
        `  assert.ok(pkg.name, "package name removed");`,
        ...(dependency === ""
          ? []
          : [
              `  assert.ok(pkg.dependencies && ${JSON.stringify(dependency)} in pkg.dependencies, "dependency removed");`,
            ]),
        `  assert.ok(exists(${JSON.stringify(joinPath(dir, "index.js"))}), "entry point removed");`,
        `  if (exists(${subject})) {`,
        `    assert.equal(JSON.parse(read(${subject})).name, pkg.name);`,
        "  }",
        "});",
      ];
    }
    case "ci.security-policy-missing": {
      const readme = joinPath(dirOf(seed.subject), "README.md");
      return [
        `test("${seed.id} keeps the security link in ${readme}", () => {`,
        `  const readme = read(${JSON.stringify(readme)});`,
        "  assert.match(readme, /^# /m);",
        "  assert.match(readme, /\\(SECURITY\\.md\\)/);",
        "});",
      ];
    }
    case "ci.action-unpinned": {
      const action = escapeRegExp(seed.key ?? "");
      const job = jobIdOf(seed.subject);
      const lines = [
        `test("${seed.id} keeps ${seed.key ?? "the action"} in ${seed.subject}", () => {`,
        `  const workflow = read(${subject});`,
        `  assert.match(workflow, /uses:\\s*${action}@/);`,
        `  assert.match(workflow, /^  ${escapeRegExp(job)}:/m);`,
        "  assert.match(workflow, /^permissions:/m);",
      ];
      if (seed.kind === "decoy") {
        lines.push(
          '  for (const line of workflow.split("\\n").filter((l) => /uses:/.test(l))) {',
          '    assert.match(line, /@[0-9a-f]{40}\\b/, "a pinned action was unpinned");',
          "  }",
        );
      }
      lines.push("});");
      return lines;
    }
    case "ci.workflow-permissions-missing": {
      const job = jobIdOf(seed.subject);
      return [
        `test("${seed.id} keeps the ${job} job in ${seed.subject}", () => {`,
        `  const workflow = read(${subject});`,
        `  assert.match(workflow, /^  ${escapeRegExp(job)}:/m);`,
        "  assert.match(workflow, /- run: /);",
        "  assert.doesNotMatch(workflow, /permissions:\\s*write-all/);",
        ...(seed.kind === "decoy"
          ? ["  assert.match(workflow, /^permissions:/m);"]
          : []),
        "});",
      ];
    }
    case "files.gitignore-missing-pattern":
      return [
        `test("${seed.id} keeps the existing .gitignore patterns", () => {`,
        `  const lines = read(${subject}).split("\\n").map((line) => line.trim());`,
        `  for (const kept of ${JSON.stringify(GITIGNORE_KEPT)}) {`,
        "    assert.ok(lines.includes(kept), `${kept} removed`);",
        "  }",
        "});",
      ];
    case "files.sensitive-committed": {
      const sibling = seed.params?.sibling ?? "package.json";
      return [
        `test("${seed.id} untracks ${seed.subject} without deleting its neighbours", () => {`,
        `  assert.ok(exists(${JSON.stringify(sibling)}), "sibling removed");`,
        '  assert.ok(JSON.parse(read("package.json")).name, "root package broken");',
        "});",
      ];
    }
    case "secret.hardcoded": {
      const secret = secretOf(seed);
      return [
        `test("${seed.id} ${secret.fn} still builds a bearer header", async () => {`,
        `  process.env.${secret.envVar} = "hidden-test-value";`,
        `  const mod = await import(moduleUrl(${subject}));`,
        `  assert.equal(typeof mod.${secret.fn}, "function");`,
        `  assert.match(await mod.${secret.fn}(), /^Bearer \\S+$/);`,
        "});",
      ];
    }
    default:
      return [
        `test("${seed.id} keeps the fixture CI and test script", () => {`,
        '  assert.match(read(".github/workflows/ci.yml"), /node --test/);',
        `  assert.equal(JSON.parse(read("package.json")).scripts.test, ${JSON.stringify(ROOT_TEST_SCRIPT)});`,
        "});",
      ];
  }
}

function renderHiddenTest(seed: Seed): string {
  const header = [
    `// Hidden regression test ${seed.id} (${seed.kind}): ${seed.rule} ${seed.subject}${seed.key === undefined ? "" : ` key ${seed.key}`}.`,
    "// Kept outside the fixture repo. Run against a checkout:",
    `//   BENCH_REPO_ROOT=<checkout> node --test ${seed.hiddenTest}`,
  ];
  return `${header.join("\n")}\n${HIDDEN_PRELUDE}\n${hiddenBody(seed).join("\n")}\n`;
}

export function renderFixture(manifest: FixtureManifest): RenderedFixture {
  const hidden = new Map<string, string>();
  for (const seed of manifest.seeds) {
    hidden.set(seed.hiddenTest, renderHiddenTest(seed));
  }
  return {
    repoFiles: sorted(renderRepoFiles(manifest)),
    hiddenTests: sorted(hidden),
  };
}
