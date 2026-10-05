import { getAuditRule } from "../audit-rules";
import type { FixtureManifest, Seed, SeedKind } from "./fixture-manifest";

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

/** dep.vulnerable: root dependencies pinned to an advised version. */
const VULNERABLE_DEPENDENCIES: readonly SeedDraft[] = [
  ["lodash", "4.17.11", "CVE-2019-10744", "src/integrations/merge-config.js"],
  ["minimist", "1.2.0", "CVE-2020-7598", "src/integrations/parse-args.js"],
  ["node-fetch", "2.6.0", "CVE-2020-15168", "src/integrations/http-client.js"],
  ["ansi-regex", "5.0.0", "CVE-2021-3807", "src/integrations/strip-ansi.js"],
  ["axios", "0.21.0", "CVE-2020-28168", "src/integrations/webhook-client.js"],
  ["json5", "2.2.1", "CVE-2022-46175", "src/integrations/load-settings.js"],
].map(
  ([name, version, advisory, consumer]): SeedDraft => ({
    rule: "dep.vulnerable",
    subject: `npm:${name}`,
    kind: "seeded",
    params: {
      name: name ?? "",
      version: version ?? "",
      advisory: advisory ?? "",
      consumer: consumer ?? "",
    },
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

const MISSING_LOCKFILES: readonly SeedDraft[] = BENCH_SUB_PACKAGES.map(
  (pkg): SeedDraft => ({
    rule: "supply.lockfile-missing",
    subject: `${pkg.dir}/package-lock.json`,
    kind: "seeded",
    params: { dir: pkg.dir, dependency: pkg.dependency },
  }),
);

const MISSING_SECURITY_POLICIES: readonly SeedDraft[] = [
  {
    rule: "ci.security-policy-missing",
    subject: "SECURITY.md",
    kind: "seeded",
  },
  ...BENCH_SUB_PACKAGES.filter((pkg) => pkg.linksSecurityPolicy)
    .slice(0, 5)
    .map(
      (pkg): SeedDraft => ({
        rule: "ci.security-policy-missing",
        subject: `${pkg.dir}/SECURITY.md`,
        kind: "seeded",
      }),
    ),
];

/** One workflow per seed; top-level permissions present, one tag-pinned action. */
const UNPINNED_ACTIONS: readonly SeedDraft[] = [
  ["release.yml", "actions/upload-artifact", "v4"],
  ["nightly.yml", "actions/cache", "v4"],
  ["docs.yml", "actions/configure-pages", "v5"],
  ["stale.yml", "actions/stale", "v9"],
  ["labeler.yml", "actions/labeler", "v5"],
  ["coverage.yml", "actions/download-artifact", "v4"],
].map(
  ([file, action, tag]): SeedDraft => ({
    rule: "ci.action-unpinned",
    subject: `.github/workflows/${file}`,
    key: action,
    kind: "seeded",
    params: { tag: tag ?? "" },
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
].map(
  (file): SeedDraft => ({
    rule: "ci.workflow-permissions-missing",
    subject: `.github/workflows/${file}`,
    kind: "seeded",
  }),
);

/** Literal .gitignore lines the fixture omits (keys use the parser alphabet). */
const MISSING_GITIGNORE_PATTERNS: readonly SeedDraft[] = [
  ".env",
  ".env.local",
  ".env.production",
  ".npmrc",
  "id_rsa",
  "terraform.tfstate",
].map(
  (pattern): SeedDraft => ({
    rule: "files.gitignore-missing-pattern",
    subject: ".gitignore",
    key: pattern,
    kind: "seeded",
  }),
);

/** Committed fake sensitive files; `sibling` must survive the fix. */
const SENSITIVE_FILES: readonly SeedDraft[] = [
  ["id_rsa", "README.md"],
  ["deploy/id_ed25519", "deploy/README.md"],
  [".npmrc", "package.json"],
  ["infra/terraform.tfstate", "infra/main.tf"],
  [".htpasswd", "README.md"],
  ["config/.pgpass", "config/app.json"],
].map(
  ([path, sibling]): SeedDraft => ({
    rule: "files.sensitive-committed",
    subject: path ?? "",
    kind: "seeded",
    params: { sibling: sibling ?? "" },
  }),
);

/** Modules with a hardcoded fake credential; `fn` must keep working. */
const HARDCODED_SECRETS: readonly SeedDraft[] = [
  [
    "payments",
    "paymentsAuthHeader",
    "q7Zr2LxV9m",
    "Te4WkP8sJd",
    "PAYMENTS_API_KEY",
  ],
  [
    "mailer",
    "mailerAuthHeader",
    "Hb3nY8cQ1v",
    "Rk6TzM2pWx",
    "MAILER_API_TOKEN",
  ],
  [
    "storage",
    "storageAuthHeader",
    "uF5jN0aGs7",
    "Lq9VbE3yCt",
    "STORAGE_SECRET_KEY",
  ],
  [
    "analytics",
    "analyticsAuthHeader",
    "Pz8mK2wRd4",
    "Xh6JvS1nBf",
    "ANALYTICS_WRITE_KEY",
  ],
  [
    "search",
    "searchAuthHeader",
    "Ce1TqW7yLo",
    "Gu4ZpA9rMk",
    "SEARCH_ADMIN_KEY",
  ],
  ["sms", "smsAuthHeader", "Ns6DxH3bVa", "Jy2FeQ8tKw", "SMS_AUTH_TOKEN"],
].map(
  ([service, fn, head, tail, envVar]): SeedDraft => ({
    rule: "secret.hardcoded",
    subject: `src/services/${service}.js`,
    kind: "seeded",
    params: {
      envVar: envVar ?? "",
      fn: fn ?? "",
      head: head ?? "",
      tail: tail ?? "",
    },
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
  ([file, action]): SeedDraft[] => [
    {
      rule: "ci.action-unpinned",
      subject: `.github/workflows/${file}`,
      key: action,
      kind: "decoy",
    },
    {
      rule: "ci.workflow-permissions-missing",
      subject: `.github/workflows/${file}`,
      kind: "decoy",
    },
  ],
);

function buildCatalog(drafts: readonly SeedDraft[]): FixtureManifest {
  return {
    version: 1,
    seeds: drafts.map((draft, index): Seed => {
      const id = `S${String(index + 1).padStart(2, "0")}`;
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
