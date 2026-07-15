/**
 * Tests for review/diff-review-parser.ts
 *
 * Covers JSON extraction, finding mapping, finding parsing (JSON/markdown/fallback),
 * deduplication, and confidence score parsing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  tryExtractJson,
  toFinding,
  parseFindings,
  deduplicateFindings,
  parseConfidenceScores,
} from '../../src/review/diff-review-parser';

// ---------------------------------------------------------------------------
// tryExtractJson
// ---------------------------------------------------------------------------

describe('tryExtractJson', () => {
  it('extracts JSON from fenced code block', () => {
    const text = 'Here is the result:\n```json\n{"findings": []}\n```\nDone.';
    const result = tryExtractJson(text);
    assert.deepStrictEqual(result, { findings: [] });
  });

  it('extracts JSON from fenced block without trailing newline', () => {
    const text = '```json\n{"key": "value"}```';
    const result = tryExtractJson(text);
    assert.deepStrictEqual(result, { key: 'value' });
  });

  it('extracts JSON from raw text using brace matching', () => {
    const text = 'Some preamble {"findings": [{"severity": "error"}]} trailing';
    const result = tryExtractJson(text);
    assert.deepStrictEqual(result, { findings: [{ severity: 'error' }] });
  });

  it('handles nested braces correctly', () => {
    const text = '{"outer": {"inner": "value"}}';
    const result = tryExtractJson(text);
    assert.deepStrictEqual(result, { outer: { inner: 'value' } });
  });

  it('handles strings with escaped quotes', () => {
    const text = '{"msg": "he said \\"hello\\""}';
    const result = tryExtractJson(text);
    assert.deepStrictEqual(result, { msg: 'he said "hello"' });
  });

  it('handles strings with braces inside', () => {
    const text = '{"msg": "not {a} real {brace}"}';
    const result = tryExtractJson(text);
    assert.deepStrictEqual(result, { msg: 'not {a} real {brace}' });
  });

  it('returns undefined for text with no JSON', () => {
    assert.strictEqual(tryExtractJson('no json here'), undefined);
  });

  it('returns undefined for empty string', () => {
    assert.strictEqual(tryExtractJson(''), undefined);
  });

  it('returns undefined for invalid JSON in fenced block', () => {
    const text = '```json\n{invalid json}\n```';
    assert.strictEqual(tryExtractJson(text), undefined);
  });

  it('returns array for JSON array in fenced block (typeof object)', () => {
    const text = '```json\n[1, 2, 3]\n```';
    const result = tryExtractJson(text);
    assert.deepStrictEqual(result, [1, 2, 3]);
  });

  it('returns undefined for non-object JSON (string)', () => {
    const text = '```json\n"hello"\n```';
    assert.strictEqual(tryExtractJson(text), undefined);
  });

  it('prefers fenced block over raw text', () => {
    const text = '{"raw": true}\n```json\n{"fenced": true}\n```';
    const result = tryExtractJson(text);
    assert.deepStrictEqual(result, { fenced: true });
  });
});

// ---------------------------------------------------------------------------
// toFinding
// ---------------------------------------------------------------------------

describe('toFinding', () => {
  it('converts a valid raw object to Finding', () => {
    const raw = {
      id: 'f1',
      severity: 'error',
      category: 'security',
      message: 'SQL injection risk',
      location: 'src/db.ts:42',
    };
    const finding = toFinding(raw);
    assert.strictEqual(finding.id, 'f1');
    assert.strictEqual(finding.severity, 'error');
    assert.strictEqual(finding.category, 'security');
    assert.strictEqual(finding.message, 'SQL injection risk');
    assert.strictEqual(finding.location, 'src/db.ts:42');
  });

  it('normalizes severity to lowercase', () => {
    const finding = toFinding({ severity: 'WARNING', message: 'test' });
    assert.strictEqual(finding.severity, 'warning');
  });

  it('defaults severity to info for unknown values', () => {
    const finding = toFinding({ severity: 'UNKNOWN', message: 'test' });
    assert.strictEqual(finding.severity, 'info');
  });

  it('defaults category to diff-review', () => {
    const finding = toFinding({ message: 'test' });
    assert.strictEqual(finding.category, 'diff-review');
  });

  it('generates UUID when id is missing', () => {
    const finding = toFinding({ message: 'test' });
    assert.ok(finding.id.length > 0);
    assert.ok(finding.id.includes('-')); // UUID format
  });

  it('omits location when not provided', () => {
    const finding = toFinding({ message: 'test' });
    assert.strictEqual(finding.location, undefined);
  });

  it('handles null input', () => {
    const finding = toFinding(null);
    assert.strictEqual(finding.severity, 'info');
    assert.strictEqual(finding.category, 'diff-review');
    assert.strictEqual(finding.message, 'null');
  });

  it('handles non-object input (string)', () => {
    const finding = toFinding('some string');
    assert.strictEqual(finding.message, 'some string');
    assert.strictEqual(finding.severity, 'info');
  });

  it('handles non-object input (number)', () => {
    const finding = toFinding(42);
    assert.strictEqual(finding.message, '42');
  });

  it('defaults missing message to empty string', () => {
    const finding = toFinding({});
    assert.strictEqual(finding.message, '');
  });

  it('extracts structured filePath and lineNumber from explicit fields', () => {
    const finding = toFinding({
      severity: 'warning',
      message: 'Unused variable',
      filePath: 'src/foo.ts',
      lineNumber: 42,
    });
    assert.strictEqual(finding.filePath, 'src/foo.ts');
    assert.strictEqual(finding.lineNumber, 42);
  });

  it('extracts file_path and line_number (snake_case variants)', () => {
    const finding = toFinding({
      severity: 'error',
      message: 'Bug',
      file_path: 'src/bar.ts',
      line_number: 10,
    });
    assert.strictEqual(finding.filePath, 'src/bar.ts');
    assert.strictEqual(finding.lineNumber, 10);
  });

  it('parses filePath and lineNumber from location string "path:line"', () => {
    const finding = toFinding({
      severity: 'error',
      message: 'SQL injection',
      location: 'src/db.ts:42',
    });
    assert.strictEqual(finding.filePath, 'src/db.ts');
    assert.strictEqual(finding.lineNumber, 42);
  });

  it('prefers explicit filePath over location parsing', () => {
    const finding = toFinding({
      severity: 'error',
      message: 'Bug',
      location: 'src/old.ts:1',
      filePath: 'src/new.ts',
      lineNumber: 99,
    });
    assert.strictEqual(finding.filePath, 'src/new.ts');
    assert.strictEqual(finding.lineNumber, 99);
  });

  it('extracts commitSha from raw object', () => {
    const finding = toFinding({
      severity: 'info',
      message: 'Note',
      commitSha: 'abc123',
    });
    assert.strictEqual(finding.commitSha, 'abc123');
  });
});

// ---------------------------------------------------------------------------
// parseFindings
// ---------------------------------------------------------------------------

describe('parseFindings', () => {
  it('parses JSON findings from fenced block', () => {
    const output = '```json\n{"findings": [{"severity": "error", "category": "logic", "message": "Off by one"}]}\n```';
    const findings = parseFindings(output);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].severity, 'error');
    assert.strictEqual(findings[0].category, 'logic');
    assert.strictEqual(findings[0].message, 'Off by one');
  });

  it('parses JSON findings from raw text', () => {
    const output = 'Review:\n{"findings": [{"severity": "warning", "message": "unused var"}]}';
    const findings = parseFindings(output);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].severity, 'warning');
  });

  it('parses markdown-style findings', () => {
    const output = [
      '[ERROR] security: SQL injection in query builder',
      '[WARNING] style: unused import',
      '[INFO] test-coverage: missing edge case test',
    ].join('\n');
    const findings = parseFindings(output);
    assert.strictEqual(findings.length, 3);
    assert.strictEqual(findings[0].severity, 'error');
    assert.strictEqual(findings[0].category, 'security');
    assert.strictEqual(findings[1].severity, 'warning');
    assert.strictEqual(findings[2].severity, 'info');
  });

  it('parses CRITICAL severity in markdown format', () => {
    const output = '[CRITICAL] security: Remote code execution vulnerability';
    const findings = parseFindings(output);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].severity, 'critical');
  });

  it('returns fallback finding for empty string', () => {
    const findings = parseFindings('');
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].severity, 'info');
    assert.ok(findings[0].message.includes('could not be parsed'));
  });

  it('returns fallback finding for whitespace-only string', () => {
    const findings = parseFindings('   \n  ');
    assert.strictEqual(findings.length, 1);
    assert.ok(findings[0].message.includes('could not be parsed'));
  });

  it('returns fallback finding for unstructured text', () => {
    const findings = parseFindings('This is just plain text with no structure.');
    assert.strictEqual(findings.length, 1);
    assert.ok(findings[0].message.includes('could not be parsed'));
  });

  it('handles empty findings array in JSON', () => {
    const output = '{"findings": []}';
    const findings = parseFindings(output);
    assert.strictEqual(findings.length, 0);
  });

  it('handles multiple findings in JSON', () => {
    const output = JSON.stringify({
      findings: [
        { severity: 'error', message: 'bug 1' },
        { severity: 'warning', message: 'bug 2' },
        { severity: 'info', message: 'note' },
      ],
    });
    const findings = parseFindings(output);
    assert.strictEqual(findings.length, 3);
  });
});

// ---------------------------------------------------------------------------
// deduplicateFindings
// ---------------------------------------------------------------------------

describe('deduplicateFindings', () => {
  it('removes exact duplicates (same message + location)', () => {
    const findings = [
      { id: '1', severity: 'error' as const, category: 'logic', message: 'bug', location: 'a.ts:1' },
      { id: '2', severity: 'error' as const, category: 'logic', message: 'bug', location: 'a.ts:1' },
    ];
    const result = deduplicateFindings(findings);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, '1'); // first occurrence wins
  });

  it('keeps findings with same message but different location', () => {
    const findings = [
      { id: '1', severity: 'error' as const, category: 'logic', message: 'bug', location: 'a.ts:1' },
      { id: '2', severity: 'error' as const, category: 'logic', message: 'bug', location: 'b.ts:5' },
    ];
    const result = deduplicateFindings(findings);
    assert.strictEqual(result.length, 2);
  });

  it('keeps findings with different messages at same location', () => {
    const findings = [
      { id: '1', severity: 'error' as const, category: 'logic', message: 'bug A', location: 'a.ts:1' },
      { id: '2', severity: 'warning' as const, category: 'style', message: 'bug B', location: 'a.ts:1' },
    ];
    const result = deduplicateFindings(findings);
    assert.strictEqual(result.length, 2);
  });

  it('treats missing location as same for dedup', () => {
    const findings = [
      { id: '1', severity: 'info' as const, category: 'test', message: 'same' },
      { id: '2', severity: 'info' as const, category: 'test', message: 'same' },
    ];
    const result = deduplicateFindings(findings);
    assert.strictEqual(result.length, 1);
  });

  it('returns empty array for empty input', () => {
    assert.deepStrictEqual(deduplicateFindings([]), []);
  });
});

// ---------------------------------------------------------------------------
// parseConfidenceScores
// ---------------------------------------------------------------------------

describe('parseConfidenceScores', () => {
  it('parses scores from JSON', () => {
    const output = '{"scores": [0.9, 0.5, 0.2]}';
    const scores = parseConfidenceScores(output);
    assert.deepStrictEqual(scores, [0.9, 0.5, 0.2]);
  });

  it('parses scores from fenced JSON block', () => {
    const output = '```json\n{"scores": [1.0, 0.0]}\n```';
    const scores = parseConfidenceScores(output);
    assert.deepStrictEqual(scores, [1.0, 0.0]);
  });

  it('returns empty array when no scores found', () => {
    const scores = parseConfidenceScores('no json here');
    assert.deepStrictEqual(scores, []);
  });

  it('returns empty array for empty string', () => {
    assert.deepStrictEqual(parseConfidenceScores(''), []);
  });

  it('defaults NaN values to 1.0', () => {
    const output = '{"scores": ["not-a-number", 0.5]}';
    const scores = parseConfidenceScores(output);
    assert.deepStrictEqual(scores, [1.0, 0.5]);
  });

  it('returns empty array when scores is not an array', () => {
    const output = '{"scores": "not-array"}';
    const scores = parseConfidenceScores(output);
    assert.deepStrictEqual(scores, []);
  });
});
