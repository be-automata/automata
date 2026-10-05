import { getAuditRule } from "../audit-rules";
import {
  seedId,
  type FixtureManifest,
  type Seed,
  type SeedKind,
} from "./fixture-manifest";

/**
 * The self-heal benchmark seed catalog (R6, phase 9): 48 seeded script-rule
 * findings (6 for each of the 8 script rules), 4 rubric-only seeds and 8
 * negative-control decoys, in a fixed order with sequential ids. Rendered by
 * render-fixture.ts into a small Node package plus hidden regression tests.
 *
 * SAFETY: the rendered fixture declares deliberately vulnerable npm versions
 * (historically advised, named below with one advisory each) and fake
 * secrets. It is generated text only: nothing here is installed into this
 * repo, and no package.json of this repo lists these versions. Push a
 * rendered fixture only to a PRIVATE fixture repo; never run the benchmark
 * against the public pilot repo.
 *
 * Every fake sensitive file and fake secret module carries BENCH_FAKE_MARKER.
 * Fake secret values are random-looking strings with no vendor prefix, kept
 * here as two halves so no assignment of a full value appears in this repo;
 * the renderer joins them.
 */

export const BENCH_FAKE_MARKER = "BENCHMARK FAKE — not a secret";

type SeedDraft = Omit<Seed, "id" | "hiddenTest" | "check"> & {
  kind: SeedKind;
};
type DraftExtra = Pick<SeedDraft, "key" | "params">;

/** A planted finding the audit should file and the loop should close. */
function planted(rule: string, subject: string, extra: DraftExtra = {}) {
  return { rule, subject, kind: "seeded", ...extra } satisfies SeedDraft;
}

/** A negative control: looks like a finding of `rule` but is clean. */
function decoy(rule: string, subject: string, extra: DraftExtra = {}) {
  return { rule, subject, kind: "decoy", ...extra } satisfies SeedDraft;
}

/**
 * dep.vulnerable: root dependencies pinned to an advised version, each with
 * the root module that consumes it (path, import line, exported function and
 * body), so the renderer and the hidden test need no table of their own.
 */
const VULNERABLE_DEPENDENCIES: readonly SeedDraft[] = (
  [
    [
      "lodash",
      "4.17.11",
      "CVE-2019-10744",
      "src/integrations/merge-config.js",
      'import merge from "lodash/merge.js";',
      "mergeConfig",
      "export function mergeConfig(base, override) {\n  return merge({}, base, override);\n}",
    ],
    [
      "minimist",
      "1.2.0",
      "CVE-2020-7598",
      "src/integrations/parse-args.js",
      'import minimist from "minimist";',
      "parseArgs",
      "export function parseArgs(argv) {\n  return minimist(argv);\n}",
    ],
    [
      "node-fetch",
      "2.6.0",
      "CVE-2020-15168",
      "src/integrations/http-client.js",
      'import fetch from "node-fetch";',
      "getJson",
      "export async function getJson(url) {\n  const response = await fetch(url);\n  return response.json();\n}",
    ],
    [
      "ansi-regex",
      "5.0.0",
      "CVE-2021-3807",
      "src/integrations/strip-ansi.js",
      'import ansiRegex from "ansi-regex";',
      "stripAnsi",
      'export function stripAnsi(text) {\n  return text.replace(ansiRegex(), "");\n}',
    ],
    [
      "axios",
      "0.21.0",
      "CVE-2020-28168",
      "src/integrations/webhook-client.js",
      'import axios from "axios";',
      "postWebhook",
      "export async function postWebhook(url, body) {\n  const response = await axios.post(url, body);\n  return response.status;\n}",
    ],
    [
      "json5",
      "2.2.1",
      "CVE-2022-46175",
      "src/integrations/load-settings.js",
      'import JSON5 from "json5";',
      "loadSettings",
      "export function loadSettings(text) {\n  return JSON5.parse(text);\n}",
    ],
  ] as const
).map(([name, version, advisory, consumer, importLine, fn, body]) =>
  planted("dep.vulnerable", `npm:${name}`, {
    params: { version, advisory, consumer, importLine, fn, body },
  }),
);

/** Sub-packages: each declares one benign dependency and ships no lockfile. */
export const BENCH_SUB_PACKAGES: readonly {
  dir: string;
  dependency: string;
  version: string;
  /** Its README links a SECURITY.md that does not exist. */
  linksSecurityPolicy: boolean;
}[] = [
  {
    dir: "packages/report-cli",
    dependency: "picocolors",
    version: "1.1.1",
    linksSecurityPolicy: true,
  },
  {
    dir: "packages/slug-kit",
    dependency: "ms",
    version: "2.1.3",
    linksSecurityPolicy: true,
  },
  {
    dir: "packages/retry-queue",
    dependency: "yocto-queue",
    version: "1.1.1",
    linksSecurityPolicy: true,
  },
  {
    dir: "packages/date-fmt",
    dependency: "dequal",
    version: "2.0.3",
    linksSecurityPolicy: true,
  },
  {
    dir: "packages/color-log",
    dependency: "kleur",
    version: "4.1.5",
    linksSecurityPolicy: true,
  },
  {
    dir: "packages/env-check",
    dependency: "mri",
    version: "1.2.0",
    linksSecurityPolicy: false,
  },
];

const MISSING_LOCKFILES: readonly SeedDraft[] = BENCH_SUB_PACKAGES.map((pkg) =>
  planted("supply.lockfile-missing", `${pkg.dir}/package-lock.json`, {
    params: { dependency: pkg.dependency },
  }),
);

const MISSING_SECURITY_POLICIES: readonly SeedDraft[] = [
  planted("ci.security-policy-missing", "SECURITY.md"),
  ...BENCH_SUB_PACKAGES.filter((pkg) => pkg.linksSecurityPolicy)
    .slice(0, 5)
    .map((pkg) =>
      planted("ci.security-policy-missing", `${pkg.dir}/SECURITY.md`),
    ),
];

/** One workflow per seed; top-level permissions present, one tag-pinned action. */
const UNPINNED_ACTIONS: readonly SeedDraft[] = (
  [
    ["release.yml", "actions/upload-artifact", "v4"],
    ["nightly.yml", "actions/cache", "v4"],
    ["docs.yml", "actions/configure-pages", "v5"],
    ["stale.yml", "actions/stale", "v9"],
    ["labeler.yml", "actions/labeler", "v5"],
    ["coverage.yml", "actions/download-artifact", "v4"],
  ] as const
).map(([file, action, tag]) =>
  planted("ci.action-unpinned", `.github/workflows/${file}`, {
    key: action,
    params: { tag },
  }),
);

/** One workflow per seed; `run:` steps only, no top-level permissions. */
const MISSING_PERMISSIONS: readonly SeedDraft[] = [
  "lint.yml",
  "typecheck.yml",
  "audit.yml",
  "smoke.yml",
  "bundle-size.yml",
  "changelog.yml",
].map((file) =>
  planted("ci.workflow-permissions-missing", `.github/workflows/${file}`),
);

/**
 * Sensitive-file .gitignore lines (keys use the parser alphabet). The fixture
 * omits exactly the seeded ones and carries the rest, so a shard plants no
 * gitignore finding it does not score.
 */
export const BENCH_GITIGNORE_PATTERNS = [
  ".env",
  ".env.local",
  ".env.production",
  ".npmrc",
  "id_rsa",
  "terraform.tfstate",
] as const;

const MISSING_GITIGNORE_PATTERNS: readonly SeedDraft[] =
  BENCH_GITIGNORE_PATTERNS.map((pattern) =>
    planted("files.gitignore-missing-pattern", ".gitignore", { key: pattern }),
  );

/** Committed fake sensitive files; `sibling` must survive the fix. */
const SENSITIVE_FILES: readonly SeedDraft[] = (
  [
    ["id_rsa", "README.md"],
    ["deploy/id_ed25519", "deploy/README.md"],
    [".npmrc", "package.json"],
    ["infra/terraform.tfstate", "infra/main.tf"],
    [".htpasswd", "README.md"],
    ["config/.pgpass", "config/app.json"],
  ] as const
).map(([path, sibling]) =>
  planted("files.sensitive-committed", path, { params: { sibling } }),
);

/**
 * Modules with a hardcoded fake credential; `<service>AuthHeader` (the
 * renderer's name for it) must keep working.
 */
const HARDCODED_SECRETS: readonly SeedDraft[] = (
  [
    ["payments", "q7Zr2LxV9m", "Te4WkP8sJd", "PAYMENTS_API_KEY"],
    ["mailer", "Hb3nY8cQ1v", "Rk6TzM2pWx", "MAILER_API_TOKEN"],
    ["storage", "uF5jN0aGs7", "Lq9VbE3yCt", "STORAGE_SECRET_KEY"],
    ["analytics", "Pz8mK2wRd4", "Xh6JvS1nBf", "ANALYTICS_WRITE_KEY"],
    ["search", "Ce1TqW7yLo", "Gu4ZpA9rMk", "SEARCH_ADMIN_KEY"],
    ["sms", "Ns6DxH3bVa", "Jy2FeQ8tKw", "SMS_AUTH_TOKEN"],
  ] as const
).map(([service, head, tail, envVar]) =>
  planted("secret.hardcoded", `src/services/${service}.js`, {
    params: { envVar, head, tail },
  }),
);

/** Rubric-only: review automation the fixture lacks. */
const RUBRIC: readonly SeedDraft[] = [
  ".github/CODEOWNERS",
  ".github/dependabot.yml",
  ".github/pull_request_template.md",
  ".github/workflows/codeql.yml",
].map(
  (subject): SeedDraft => ({
    rule: "automation.review-process",
    subject,
    kind: "rubric",
  }),
);

/**
 * Pinned commits of well-known actions, as the decoy workflows reference them.
 * The decoys only need the 40-hex shape; ci.yml is the one workflow that runs
 * on push and pull_request, so its checkout pin must resolve.
 */
export const BENCH_PINNED_ACTIONS = {
  "actions/checkout": {
    sha: "b4ffde65f46336ab88eb53be808477a3936bae11",
    tag: "v4.1.1",
  },
  "actions/setup-node": {
    sha: "60edb5dd545a775178f52524783378180af0d1f8",
    tag: "v4.0.2",
  },
} as const;

/** Clean workflows: every action SHA-pinned and top-level permissions set. */
const DECOY_WORKFLOWS: readonly [string, keyof typeof BENCH_PINNED_ACTIONS][] =
  [
    ["ci.yml", "actions/checkout"],
    ["release-notes.yml", "actions/checkout"],
    ["pages-preview.yml", "actions/setup-node"],
    ["dependency-review.yml", "actions/checkout"],
  ];

const DECOYS: readonly SeedDraft[] = DECOY_WORKFLOWS.flatMap(
  ([file, action]) => [
    decoy("ci.action-unpinned", `.github/workflows/${file}`, { key: action }),
    decoy("ci.workflow-permissions-missing", `.github/workflows/${file}`),
  ],
);

function buildCatalog(drafts: readonly SeedDraft[]): FixtureManifest {
  return {
    version: 1,
    seeds: drafts.map((draft, index): Seed => {
      const id = seedId(index);
      return {
        id,
        rule: draft.rule,
        subject: draft.subject,
        ...(draft.key !== undefined && { key: draft.key }),
        kind: draft.kind,
        check: getAuditRule(draft.rule)?.check ?? null,
        hiddenTest: `hidden-tests/${id}.test.mjs`,
        ...(draft.params !== undefined && { params: draft.params }),
      };
    }),
  };
}

export const SEED_CATALOG: FixtureManifest = buildCatalog([
  ...VULNERABLE_DEPENDENCIES,
  ...MISSING_LOCKFILES,
  ...MISSING_SECURITY_POLICIES,
  ...UNPINNED_ACTIONS,
  ...MISSING_PERMISSIONS,
  ...MISSING_GITIGNORE_PATTERNS,
  ...SENSITIVE_FILES,
  ...HARDCODED_SECRETS,
  ...RUBRIC,
  ...DECOYS,
]);

/**
 * The benchmark shards (generate-fixture --seeds), one private fixture repo
 * each. A full-catalog audit reports 52 findings, over MAX_FINDINGS_PER_RUN
 * (25), and an over-cap run is incomplete and records no sightings; each
 * shard plants at most 20 non-decoy seeds (maxOpenIssues is at most 20).
 * Every seeded seed and every decoy is in exactly one shard. The 4 rubric
 * seeds are in every shard: the fixture always lacks that review automation,
 * so every shard's audit may report them.
 */
export const BENCH_SHARD_PLAN = [
  "S01-S16,S49-S54",
  "S17-S32,S49-S52,S55-S56",
  "S33-S52,S57-S60",
] as const;
