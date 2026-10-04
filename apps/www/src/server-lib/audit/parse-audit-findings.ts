import {
  AUDIT_IDS,
  AUDIT_SECTIONS,
  MAX_FINDINGS_PER_RUN,
  getAuditRule,
  type AuditId,
} from "@terragon/shared/self-heal/audit-rules";
import type { DBMessage } from "@terragon/shared/db/db-message";
import { z } from "zod";

import { buildTaggedFence } from "../review/tagged-fence";
import { findLastLeadAgentText } from "../review/lead-text";
import {
  FINDING_KEY_RE,
  fingerprintFinding,
  normalizeSubject,
} from "./fingerprint";

/**
 * Tagged-only, fail-closed parser for the audit lane's terminal output. Only a
 * block opened by ```json audit-findings is ever read; there is no untagged
 * fallback. Pure: no IO. Vocabulary violations are dropped and counted, never
 * fatal; only an unusable envelope fails the whole block.
 */

export const AUDIT_FINDINGS_FENCE_INFO = "audit-findings";
const SCHEMA_VERSION = 1;
const MAX_FILES = 10;

const FENCE = buildTaggedFence(AUDIT_FINDINGS_FENCE_INFO);

export const DROP_REASONS = [
  "unknown_rule",
  "rule_audit_mismatch",
  "bad_subject",
  "bad_section",
  "over_cap",
  "schema",
] as const;
export type DropReason = (typeof DROP_REASONS)[number];

export type FindingSeverity = "low" | "medium" | "high";
const SEVERITY_RANK: Record<FindingSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export interface ParsedFinding {
  rule: string;
  subject: string;
  key?: string;
  severity: FindingSeverity;
  section: string;
  title: string;
  files: string[];
  plan: string;
  acceptance: string;
  effort: "S" | "M" | "L";
  fingerprint: string;
}

export interface ParsedAuditBlock {
  audit: AuditId;
  complete: boolean;
  report: { score?: number; label?: string };
  sections: { id: string; name: string; score?: number }[];
  findings: ParsedFinding[];
}

export type ParseAuditFindingsResult =
  | {
      ok: true;
      block: ParsedAuditBlock;
      dropped: Record<DropReason, number>;
    }
  | { ok: false; reason: string };

export function hasTaggedAuditFindingsOpener(text: string): boolean {
  return FENCE.hasOpener(text);
}

/** The lead's last message that carries the tagged opener, or "". */
export function selectAuditTerminalText(messages: DBMessage[] | null): string {
  return findLastLeadAgentText(messages, hasTaggedAuditFindingsOpener) ?? "";
}

/** Length limits truncate; they never reject. */
const clipped = (max: number) =>
  z.string().transform((value) => value.slice(0, max));

const envelopeSchema = z.object({
  kind: z.literal(AUDIT_FINDINGS_FENCE_INFO),
  schemaVersion: z.literal(SCHEMA_VERSION),
  audit: z.enum(AUDIT_IDS),
  complete: z.boolean(),
  report: z
    .object({
      score: z.number().finite().optional(),
      label: clipped(80).optional(),
    })
    .optional(),
  sections: z.array(z.unknown()).optional(),
  findings: z.array(z.unknown()),
});

const sectionSchema = z.object({
  id: z.string(),
  name: clipped(120).default(""),
  score: z.number().finite().optional(),
});

const findingSchema = z.object({
  rule: z.string().min(1),
  subject: z.string().min(1),
  key: z.string().optional(),
  severity: z.enum(["low", "medium", "high"]),
  section: z.string().min(1),
  title: z
    .string()
    .min(1)
    .transform((value) => value.slice(0, 140)),
  files: z.array(z.unknown()).optional(),
  plan: clipped(6000),
  acceptance: clipped(1500),
  effort: z.enum(["S", "M", "L"]),
});

function emptyDropped(): Record<DropReason, number> {
  return {
    unknown_rule: 0,
    rule_audit_mismatch: 0,
    bad_subject: 0,
    bad_section: 0,
    over_cap: 0,
    schema: 0,
  };
}

export function parseAuditFindings(
  text: string,
  options: { repoFullName: string },
): ParseAuditFindingsResult {
  const extracted = FENCE.extractLast(text);
  if (extracted === null) {
    return {
      ok: false,
      reason: `no tagged "json ${AUDIT_FINDINGS_FENCE_INFO}" block found`,
    };
  }
  if (!extracted.ok) return { ok: false, reason: extracted.reason };

  let raw: unknown;
  try {
    raw = JSON.parse(extracted.payload);
  } catch {
    // The engine's message can quote the payload; keep the reason generic.
    return { ok: false, reason: "audit-findings block is not valid JSON" };
  }

  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return { ok: false, reason: "audit-findings envelope failed validation" };
  }
  const { audit } = envelope.data;
  const knownSections: readonly string[] = AUDIT_SECTIONS[audit];
  const dropped = emptyDropped();

  const sections: ParsedAuditBlock["sections"] = [];
  for (const entry of envelope.data.sections ?? []) {
    const parsed = sectionSchema.safeParse(entry);
    if (!parsed.success) {
      dropped.schema += 1;
    } else if (!knownSections.includes(parsed.data.id)) {
      dropped.bad_section += 1;
    } else {
      sections.push({
        id: parsed.data.id,
        name: parsed.data.name,
        ...(parsed.data.score !== undefined && { score: parsed.data.score }),
      });
    }
  }

  const candidates: ParsedFinding[] = [];
  const seen = new Set<string>();
  for (const entry of envelope.data.findings) {
    const parsed = findingSchema.safeParse(entry);
    if (!parsed.success) {
      dropped.schema += 1;
      continue;
    }
    const f = parsed.data;
    const rule = getAuditRule(f.rule);
    if (!rule) {
      dropped.unknown_rule += 1;
      continue;
    }
    if (rule.audit !== audit) {
      dropped.rule_audit_mismatch += 1;
      continue;
    }
    if (!knownSections.includes(f.section)) {
      dropped.bad_section += 1;
      continue;
    }
    const subject = normalizeSubject(f.subject, rule.subjectKind);
    if (
      subject === null ||
      (f.key !== undefined && !FINDING_KEY_RE.test(f.key))
    ) {
      dropped.bad_subject += 1;
      continue;
    }
    const files: string[] = [];
    for (const file of f.files ?? []) {
      if (typeof file !== "string") continue;
      const normalised = normalizeSubject(file, "path");
      if (normalised !== null) files.push(normalised);
      if (files.length === MAX_FILES) break;
    }
    // The rule owns the section, so a drifting label cannot change identity.
    const fingerprint = fingerprintFinding({
      repoFullName: options.repoFullName,
      audit,
      section: rule.section,
      rule: rule.id,
      subject,
      key: f.key,
    });
    if (seen.has(fingerprint)) {
      dropped.schema += 1;
      continue;
    }
    seen.add(fingerprint);
    candidates.push({
      rule: rule.id,
      subject,
      ...(f.key !== undefined && { key: f.key }),
      severity: f.severity,
      section: rule.section,
      title: f.title,
      files,
      plan: f.plan,
      acceptance: f.acceptance,
      effort: f.effort,
      fingerprint,
    });
  }

  // Array.prototype.sort is stable, so equal severities keep input order.
  const ranked = [...candidates].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );
  const findings = ranked.slice(0, MAX_FINDINGS_PER_RUN);
  dropped.over_cap += ranked.length - findings.length;

  return {
    ok: true,
    block: {
      audit,
      complete: envelope.data.complete,
      report: {
        ...(envelope.data.report?.score !== undefined && {
          score: envelope.data.report.score,
        }),
        ...(envelope.data.report?.label !== undefined && {
          label: envelope.data.report.label,
        }),
      },
      sections,
      findings,
    },
    dropped,
  };
}
