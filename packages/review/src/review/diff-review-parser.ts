/**
 * Pure parsing functions for Claude diff review output.
 *
 * Extracted from claude-diff-reviewer.ts to keep files under 500 lines.
 * All functions are pure (no side effects, no dependencies on external state).
 *
 * Bounded context: Review
 */

import { randomUUID } from 'node:crypto';
import type { Finding } from '../types';

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

/**
 * Try to extract a JSON object containing a "findings" array from text.
 */
export function tryExtractJson(text: string): Record<string, unknown> | undefined {
  // Try fenced code block first
  const fenced = text.match(/```json\s*\n?([\s\S]*?)```/);
  if (fenced?.[1]) {
    try {
      const parsed = JSON.parse(fenced[1].trim());
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch { /* not valid JSON */ }
  }

  // Try balanced brace extraction
  const start = text.indexOf('{');
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const jsonStr = text.slice(start, i + 1);
        try {
          const parsed = JSON.parse(jsonStr);
          if (typeof parsed === 'object' && parsed !== null) return parsed;
        } catch { /* not valid JSON */ }
        break;
      }
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Finding mapping
// ---------------------------------------------------------------------------

/**
 * Map a raw JSON object to a typed Finding with generated id.
 * Normalizes severity to lowercase.
 */
export function toFinding(raw: unknown): Finding {
  if (typeof raw !== 'object' || raw === null) {
    return {
      id: randomUUID(),
      severity: 'info',
      category: 'diff-review',
      message: String(raw),
    };
  }

  const obj = raw as Record<string, unknown>;
  const rawSeverity = String(obj.severity ?? 'info').toLowerCase();
  const severity = (['info', 'warning', 'error', 'critical'].includes(rawSeverity)
    ? rawSeverity
    : 'info') as Finding['severity'];

  const finding: Finding = {
    id: obj.id ? String(obj.id) : randomUUID(),
    severity,
    category: String(obj.category ?? 'diff-review'),
    message: String(obj.message ?? ''),
    ...(obj.location ? { location: String(obj.location) } : {}),
  };

  // Extract structured file/line from explicit fields or parse from location
  if (obj.filePath || obj.file_path || obj.file || obj.path) {
    finding.filePath = String(obj.filePath ?? obj.file_path ?? obj.file ?? obj.path);
  }
  if (obj.lineNumber != null || obj.line_number != null || obj.line != null) {
    const rawLine = Number(obj.lineNumber ?? obj.line_number ?? obj.line);
    if (!isNaN(rawLine) && rawLine > 0) finding.lineNumber = rawLine;
  }
  if (obj.commitSha || obj.commit_sha) {
    finding.commitSha = String(obj.commitSha ?? obj.commit_sha);
  }

  // Fallback: try to parse "path:line" from location string
  if (!finding.filePath && finding.location) {
    const locMatch = finding.location.match(/^([^\s:]+):(\d+)/);
    if (locMatch) {
      finding.filePath = locMatch[1];
      finding.lineNumber = parseInt(locMatch[2], 10);
    }
  }

  return finding;
}

// ---------------------------------------------------------------------------
// Finding parsing
// ---------------------------------------------------------------------------

/**
 * Parse Claude's raw output into Finding[].
 *
 * Strategy:
 * 1. Try JSON: look for {"findings": [...]}
 * 2. Try markdown: lines matching [SEVERITY] category: message
 * 3. Fallback: single info finding indicating unparseable output
 */
export function parseFindings(rawOutput: string): Finding[] {
  if (!rawOutput || rawOutput.trim().length === 0) {
    return [{
      id: randomUUID(),
      severity: 'info',
      category: 'diff-review',
      message: 'Review completed but output could not be parsed into structured findings',
    }];
  }

  // Attempt 1: JSON parsing
  const json = tryExtractJson(rawOutput);
  if (json?.findings && Array.isArray(json.findings)) {
    return json.findings.map((f: unknown) => toFinding(f));
  }

  // Attempt 2: Markdown parsing
  const lines = rawOutput.split('\n');
  const findings: Finding[] = [];
  for (const line of lines) {
    const match = line.match(/\[(INFO|WARNING|ERROR|CRITICAL)\]\s*(\w[\w-]*):\s*(.+)/i);
    if (match) {
      const finding: Finding = {
        id: randomUUID(),
        severity: match[1].toLowerCase() as Finding['severity'],
        category: match[2],
        message: match[3].trim(),
      };
      // Try to extract file:line from the message (e.g., "src/foo.ts:42 — description")
      const locMatch = match[3].match(/^([^\s:]+):(\d+)\s/);
      if (locMatch) {
        finding.filePath = locMatch[1];
        finding.lineNumber = parseInt(locMatch[2], 10);
      }
      findings.push(finding);
    }
  }

  if (findings.length > 0) return findings;

  // Attempt 3: Unstructured fallback
  return [{
    id: randomUUID(),
    severity: 'info',
    category: 'diff-review',
    message: 'Review completed but output could not be parsed into structured findings',
  }];
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Remove duplicate findings (same message + location).
 * First occurrence wins.
 */
export function deduplicateFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const result: Finding[] = [];

  for (const f of findings) {
    const key = `${f.message}::${f.location ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(f);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Confidence score parsing
// ---------------------------------------------------------------------------

/**
 * Parse confidence scores from Haiku classification output.
 */
export function parseConfidenceScores(rawOutput: string): number[] {
  const json = tryExtractJson(rawOutput);
  if (json?.scores && Array.isArray(json.scores)) {
    return json.scores.map((s: unknown) => {
      const num = Number(s);
      return isNaN(num) ? 1.0 : num;
    });
  }
  return [];
}
