/**
 * Property tests for breakGlassMatcher.
 *
 * Invariants:
 *   • A `matched=true` result implies the body either equals "break glass"
 *     (after trailing-newline strip) or starts with "break glass:" followed
 *     by non-empty reason text.
 *   • `reason` length is always ≤ 500 when matched.
 *
 * Covers FR-9.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBreakGlassMatcher } from '../../../src/review/state/break-glass-matcher';

const matcher = createBreakGlassMatcher();
const TRIALS = 500;

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const PREFIXES = [
  'break glass',
  'BREAK GLASS',
  'Break Glass',
  ' break glass',
  '# break glass',
  'please break glass',
  'breakglass',
  'break  glass', // double space
];

const SUFFIXES = [
  '',
  ':',
  ': ',
  ': hotfix',
  ': ' + 'a'.repeat(700),
  '\n',
  '\r\n',
  ' extra',
  '\nfollow-up',
  ': "with quotes"',
];

function stripTrailingNewline(s: string): string {
  return s.replace(/\r?\n$/, '');
}

describe('breakGlassMatcher property', () => {
  it(`reason is always ≤ 500 chars when matched (${TRIALS} trials)`, () => {
    const rng = makeRng(0xb00b1ee5);
    for (let i = 0; i < TRIALS; i++) {
      const prefix = PREFIXES[Math.floor(rng() * PREFIXES.length)];
      const suffix = SUFFIXES[Math.floor(rng() * SUFFIXES.length)];
      const body = prefix + suffix;
      const r = matcher.match(body);
      if (r.matched && r.reason !== null) {
        assert.ok(r.reason.length <= 500, `trial=${i}: reason length ${r.reason.length} > 500: ${body}`);
      }
    }
  });

  it(`matched=true implies the (newline-stripped) body satisfies the grammar (${TRIALS} trials)`, () => {
    const rng = makeRng(0xfacefeed);
    for (let i = 0; i < TRIALS; i++) {
      const prefix = PREFIXES[Math.floor(rng() * PREFIXES.length)];
      const suffix = SUFFIXES[Math.floor(rng() * SUFFIXES.length)];
      const body = prefix + suffix;
      const r = matcher.match(body);
      if (r.matched) {
        const stripped = stripTrailingNewline(body);
        const ok =
          stripped === 'break glass' ||
          /^break glass:\s*\S/.test(stripped);
        assert.ok(ok, `trial=${i}: matched but stripped body fails grammar: ${JSON.stringify(stripped)}`);
      }
    }
  });

  it('non-matching cases never produce a non-null reason', () => {
    const cases = [
      'random text',
      'BREAK GLASS',
      'break glass extra',
      ' break glass',
      '',
    ];
    for (const c of cases) {
      const r = matcher.match(c);
      if (!r.matched) assert.equal(r.reason, null);
    }
  });
});
