import { AUDIT_RULES, type AuditCheckKind } from "../audit-rules";

/**
 * The self-heal benchmark fixture manifest (R6, phase 9).
 *
 * A manifest lists every seed the benchmark plants in a fixture repo. Each
 * seed names its audit rule, its subject (and key) exactly as the findings
 * parser would normalise them, the deterministic check that confirms it, and
 * a hidden regression test. Hidden tests live under `hidden-tests/`, outside
 * the fixture repo, so the fix agent can never read or edit them.
 *
 * Seed kinds:
 * - "seeded": a planted script-rule finding the audit should file and the fix
 *   loop should close.
 * - "rubric": a planted rubric-only finding; it is filed for a human
 *   (needs-human-approve) and never auto-fixed.
 * - "decoy": a negative control that looks like a finding but is clean (for
 *   example a SHA-pinned action). Filing it is a false positive.
 *
 * SAFETY: a rendered fixture contains deliberately vulnerable dependencies
 * and fake secrets. Push it only to a PRIVATE fixture repo; never run the
 * benchmark against the public pilot repo.
 *
 * This module imports only the rule vocabulary, so any package can use it.
 */

export type SeedKind = "seeded" | "decoy" | "rubric";

export interface Seed {
  /** "S01", "S02", ... in manifest order. */
  id: string;
  rule: string;
  /** Normalised subject: a repo-relative path, or "npm:<name>". */
  subject: string;
  key?: string;
  kind: SeedKind;
  /** The rule's deterministic check kind; null for rubric rules. */
  check: AuditCheckKind | null;
  /** Path of the hidden regression test, under hidden-tests/. */
  hiddenTest: string;
  /** Renderer inputs (versions, names); never read by the scorer. */
  params?: Readonly<Record<string, string>>;
}

export interface FixtureManifest {
  version: 1;
  seeds: readonly Seed[];
}

const SEED_ID_RE = /^S\d{2,3}$/;
/** Same alphabet as the findings parser's FINDING_KEY_RE. */
const KEY_RE = /^[a-z0-9._:/@-]{1,40}$/;
const NPM_SUBJECT_RE = /^npm:(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/;
const HIDDEN_TEST_RE = /^hidden-tests\/[A-Za-z0-9._-]+\.test\.mjs$/;

function isPathSubject(subject: string): boolean {
  if (subject === "" || subject.startsWith("/") || subject.startsWith("./")) {
    return false;
  }
  if (subject.includes("\\") || /[\u0000-\u001f\u007f]/.test(subject)) {
    return false;
  }
  const segments = subject.split("/");
  return (
    segments.every((s) => s !== "" && s !== "..") && segments[0] !== ".git"
  );
}

/**
 * The first problem with a manifest, or null when it is usable. Checks the
 * version, sequential ids, the rule vocabulary, kind/check consistency,
 * subject and key shape, hidden test paths and duplicate identities.
 */
export function findManifestError(manifest: FixtureManifest): string | null {
  if (manifest.version !== 1) return "version must be 1";
  if (!Array.isArray(manifest.seeds) || manifest.seeds.length === 0) {
    return "seeds must be a non-empty array";
  }
  const identities = new Set<string>();
  const hiddenTests = new Set<string>();
  for (const [index, seed] of manifest.seeds.entries()) {
    const at = `seed ${index + 1}`;
    if (!SEED_ID_RE.test(seed.id)) return `${at}: id must look like S01`;
    const expected = `S${String(index + 1).padStart(2, "0")}`;
    if (seed.id !== expected) return `${at}: id must be ${expected}`;
    const rule = AUDIT_RULES.find((r) => r.id === seed.rule);
    if (!rule) return `${seed.id}: rule ${seed.rule} is not in AUDIT_RULES`;
    if (seed.check !== rule.check) {
      return `${seed.id}: check must be ${String(rule.check)} for ${rule.id}`;
    }
    const wantsRubric = rule.checkKind === "rubric";
    if ((seed.kind === "rubric") !== wantsRubric) {
      return `${seed.id}: kind ${seed.kind} does not fit a ${rule.checkKind} rule`;
    }
    if (!["seeded", "decoy", "rubric"].includes(seed.kind)) {
      return `${seed.id}: unknown kind ${String(seed.kind)}`;
    }
    const subjectOk =
      rule.subjectKind === "npm"
        ? NPM_SUBJECT_RE.test(seed.subject)
        : isPathSubject(seed.subject);
    if (!subjectOk) return `${seed.id}: bad subject ${seed.subject}`;
    if (seed.key !== undefined && !KEY_RE.test(seed.key)) {
      return `${seed.id}: bad key ${seed.key}`;
    }
    if (!HIDDEN_TEST_RE.test(seed.hiddenTest)) {
      return `${seed.id}: hiddenTest must be hidden-tests/<name>.test.mjs`;
    }
    if (hiddenTests.has(seed.hiddenTest)) {
      return `${seed.id}: duplicate hiddenTest ${seed.hiddenTest}`;
    }
    hiddenTests.add(seed.hiddenTest);
    const identity = JSON.stringify([seed.rule, seed.subject, seed.key ?? ""]);
    if (identities.has(identity)) {
      return `${seed.id}: duplicate identity ${seed.rule} ${seed.subject}`;
    }
    identities.add(identity);
  }
  return null;
}
