import { getAuditRule, type AuditCheckKind } from "../audit-rules";
import { FINDING_KEY_RE, normalizeSubject } from "../fingerprint";
import { recordOf } from "./narrow";

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
 *   (needs-human-review) and never auto-fixed.
 * - "decoy": a negative control that looks like a finding but is clean (for
 *   example a SHA-pinned action). Filing it is a false positive.
 *
 * SAFETY: a rendered fixture contains deliberately vulnerable dependencies
 * and fake secrets. Push it only to a PRIVATE fixture repo; never run the
 * benchmark against the public pilot repo.
 *
 * This module imports only the rule vocabulary and the findings parser's
 * subject/key normalisation, so a seed is valid exactly when the parser would
 * have produced its subject and key unchanged.
 */

export type SeedKind = "seeded" | "decoy" | "rubric";

export interface Seed {
  /** "S01", "S02", ... (seedId), strictly increasing in manifest order. */
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
const HIDDEN_TEST_RE = /^hidden-tests\/[A-Za-z0-9._-]+\.test\.mjs$/;

/** The id of the seed at catalog position `index` (0-based): S01, S02, ... */
export function seedId(index: number): string {
  return `S${String(index + 1).padStart(2, "0")}`;
}

/**
 * The first problem with a manifest, or null when it is usable. Checks the
 * version, unique strictly increasing ids (the full catalog is S01..Snn; a
 * shard keeps its catalog ids), the rule vocabulary, kind/check consistency,
 * that subject and key are already in the findings parser's normal form,
 * hidden test paths and duplicate identities.
 */
export function findManifestError(manifest: FixtureManifest): string | null {
  if (manifest.version !== 1) return "version must be 1";
  if (!Array.isArray(manifest.seeds) || manifest.seeds.length === 0) {
    return "seeds must be a non-empty array";
  }
  const identities = new Set<string>();
  const hiddenTests = new Set<string>();
  let previous = 0;
  for (const [index, seed] of manifest.seeds.entries()) {
    const at = `seed ${index + 1}`;
    if (!SEED_ID_RE.test(seed.id)) return `${at}: id must look like S01`;
    const number = Number(seed.id.slice(1));
    if (seed.id !== seedId(number - 1)) {
      return `${at}: id must be written ${seedId(number - 1)}`;
    }
    if (number <= previous) {
      return `${at}: id ${seed.id} must be greater than ${seedId(previous - 1)}`;
    }
    previous = number;
    const rule = getAuditRule(seed.rule);
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
    if (normalizeSubject(seed.subject, rule.subjectKind) !== seed.subject) {
      return `${seed.id}: bad subject ${seed.subject}`;
    }
    if (seed.key !== undefined && !FINDING_KEY_RE.test(seed.key)) {
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

const SELECTION_ITEM_RE = /^(S\d{2,3})(?:-(S\d{2,3}))?$/;

/**
 * The seeds a selection names, in manifest order, as a manifest of their own
 * (ids unchanged). A selection is a comma list of ids and inclusive ranges:
 * "S01-S20" or "S01-S16,S49-S54". Throws on a malformed item, an empty
 * range or an id the manifest does not hold.
 */
export function selectSeeds(
  manifest: FixtureManifest,
  selection: string,
): FixtureManifest {
  const wanted = new Set<number>();
  for (const item of selection.split(",").map((part) => part.trim())) {
    const match = SELECTION_ITEM_RE.exec(item);
    if (!match) throw new Error(`bad seed selection item: ${item}`);
    const from = Number(match[1]?.slice(1));
    const to = Number((match[2] ?? match[1])?.slice(1));
    if (to < from) throw new Error(`empty seed range: ${item}`);
    for (let n = from; n <= to; n += 1) wanted.add(n);
  }
  const known = new Set(manifest.seeds.map((seed) => seed.id));
  for (const n of wanted) {
    if (!known.has(seedId(n - 1))) {
      throw new Error(`seed ${seedId(n - 1)} is not in the manifest`);
    }
  }
  return {
    version: manifest.version,
    seeds: manifest.seeds.filter((seed) =>
      wanted.has(Number(seed.id.slice(1))),
    ),
  };
}

const SEED_STRING_FIELDS = ["id", "rule", "subject", "kind", "hiddenTest"];

/**
 * Narrows a parsed manifest.json and validates it with findManifestError.
 * Throws on the first problem.
 */
export function parseFixtureManifest(value: unknown): FixtureManifest {
  const root = recordOf(value, "manifest");
  if (!Array.isArray(root.seeds)) throw new Error("manifest.seeds is missing");
  const seeds = root.seeds.map((raw, index): Seed => {
    const entry = recordOf(raw, `manifest.seeds[${index}]`);
    for (const name of SEED_STRING_FIELDS) {
      if (typeof entry[name] !== "string") {
        throw new Error(`manifest.seeds[${index}].${name} must be a string`);
      }
    }
    if (entry.key !== undefined && typeof entry.key !== "string") {
      throw new Error(`manifest.seeds[${index}].key must be a string`);
    }
    const params: Record<string, string> = {};
    if (entry.params !== undefined) {
      if (typeof entry.params !== "object" || entry.params === null) {
        throw new Error(`manifest.seeds[${index}].params must be an object`);
      }
      for (const [k, v] of Object.entries(entry.params)) {
        if (typeof v !== "string") {
          throw new Error(
            `manifest.seeds[${index}].params.${k} must be a string`,
          );
        }
        params[k] = v;
      }
    }
    return {
      id: entry.id as string,
      rule: entry.rule as string,
      subject: entry.subject as string,
      ...(typeof entry.key === "string" && { key: entry.key }),
      kind: entry.kind as SeedKind,
      check: (entry.check ?? null) as AuditCheckKind | null,
      hiddenTest: entry.hiddenTest as string,
      ...(entry.params !== undefined && { params }),
    };
  });
  const manifest: FixtureManifest = {
    version: root.version as FixtureManifest["version"],
    seeds,
  };
  const problem = findManifestError(manifest);
  if (problem !== null) throw new Error(`manifest is invalid: ${problem}`);
  return manifest;
}
