/**
 * severity-policy — the pure approve-floor kernel.
 *
 * Table-driven tests over the neutral tier classifier, the two adapters, and
 * `applyApproveSeverityFloor` (only-act-on-approve invariant, draft cap, and
 * policy overrides). node:test + node:assert/strict only.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEVERITY_ORDER,
  DEFAULT_SEVERITY,
  DEFAULT_APPROVE_SEVERITY_POLICY,
  GATE_SEVERITY_POLICY,
  BLOCK_TOLERANCES,
  isBlockTolerance,
  toleranceToPolicy,
  isBlockingUnderPolicy,
  classifySeverities,
  tierToGateStatus,
  tierToVerdict,
  applyApproveSeverityFloor,
  type ApproveSeverityPolicy,
  type BlockTolerance,
  type Severity,
  type SeverityTier,
} from '../../src/review/severity-policy';

// ---------------------------------------------------------------------------
// Ordering + defaults
// ---------------------------------------------------------------------------

describe('severity-policy — ordering + defaults', () => {
  test('SEVERITY_ORDER is info < warning < error < critical', () => {
    assert.deepEqual(SEVERITY_ORDER, ['info', 'warning', 'error', 'critical']);
  });

  test('DEFAULT_SEVERITY is info', () => {
    assert.equal(DEFAULT_SEVERITY, 'info');
  });

  test('locked default policy = block:warning surface:warning (no withhold-only band; info is non-gating)', () => {
    assert.deepEqual(DEFAULT_APPROVE_SEVERITY_POLICY, { blockSeverity: 'warning', surfaceSeverity: 'warning' });
  });

  test('gate policy = block:warning surface:warning (aligned — warning is a hard fail)', () => {
    assert.deepEqual(GATE_SEVERITY_POLICY, { blockSeverity: 'warning', surfaceSeverity: 'warning' });
  });
});

// ---------------------------------------------------------------------------
// classifySeverities — table-driven over the locked default policy
// ---------------------------------------------------------------------------

describe('severity-policy — classifySeverities (default policy)', () => {
  const cases: Array<{ name: string; severities: Severity[]; tier: SeverityTier }> = [
    { name: 'empty → clean', severities: [], tier: 'clean' },
    { name: '[info] → clean (non-gating under the default policy)', severities: ['info'], tier: 'clean' },
    { name: '[warning] → block', severities: ['warning'], tier: 'block' },
    { name: '[error] → block', severities: ['error'], tier: 'block' },
    { name: '[critical] → block', severities: ['critical'], tier: 'block' },
    { name: 'mixed [info, warning] → block (max wins)', severities: ['info', 'warning'], tier: 'block' },
    { name: 'mixed [info, info] → clean', severities: ['info', 'info'], tier: 'clean' },
    { name: 'mixed [warning, error] → block', severities: ['warning', 'error'], tier: 'block' },
  ];
  for (const c of cases) {
    test(c.name, () => {
      assert.equal(classifySeverities(c.severities, DEFAULT_APPROVE_SEVERITY_POLICY), c.tier);
    });
  }
});

describe('severity-policy — classifySeverities (gate policy)', () => {
  // Aligned with the approve floor: warning+ → block (hard fail), info → clean.
  const cases: Array<{ severities: Severity[]; tier: SeverityTier }> = [
    { severities: [], tier: 'clean' },
    { severities: ['info'], tier: 'clean' },
    { severities: ['warning'], tier: 'block' },
    { severities: ['error'], tier: 'block' },
    { severities: ['critical'], tier: 'block' },
    { severities: ['error', 'warning', 'info'], tier: 'block' },
  ];
  for (const c of cases) {
    test(`${JSON.stringify(c.severities)} → ${c.tier}`, () => {
      assert.equal(classifySeverities(c.severities, GATE_SEVERITY_POLICY), c.tier);
    });
  }
});

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

describe('severity-policy — adapters', () => {
  test('tierToGateStatus: block→fail surface→conditional clean→pass', () => {
    assert.equal(tierToGateStatus('block'), 'fail');
    assert.equal(tierToGateStatus('surface'), 'conditional');
    assert.equal(tierToGateStatus('clean'), 'pass');
  });

  test('tierToVerdict: block→request_changes surface→comment clean→approve', () => {
    assert.equal(tierToVerdict('block'), 'request_changes');
    assert.equal(tierToVerdict('surface'), 'comment');
    assert.equal(tierToVerdict('clean'), 'approve');
  });
});

// ---------------------------------------------------------------------------
// applyApproveSeverityFloor
// ---------------------------------------------------------------------------

describe('severity-policy — applyApproveSeverityFloor', () => {
  const P = DEFAULT_APPROVE_SEVERITY_POLICY;

  test('approve + [] → approve (clean, unchanged reference)', () => {
    const intent = { verdict: 'approve' as const, body: 'x' };
    const out = applyApproveSeverityFloor(intent, P);
    assert.equal(out.verdict, 'approve');
    assert.equal(out, intent, 'no-op returns the same object');
  });

  test('approve + [info] → approve', () => {
    const out = applyApproveSeverityFloor({ verdict: 'approve' as const, comments: [{ severity: 'info' as const }] }, P);
    assert.equal(out.verdict, 'approve');
  });

  test('approve + [warning] → request_changes', () => {
    const out = applyApproveSeverityFloor({ verdict: 'approve' as const, comments: [{ severity: 'warning' as const }] }, P);
    assert.equal(out.verdict, 'request_changes');
  });

  test('approve + [error] → request_changes', () => {
    const out = applyApproveSeverityFloor({ verdict: 'approve' as const, comments: [{ severity: 'error' as const }] }, P);
    assert.equal(out.verdict, 'request_changes');
  });

  test('approve + untagged comment (defaults to info) → approve', () => {
    const out = applyApproveSeverityFloor({ verdict: 'approve' as const, comments: [{}] }, P);
    assert.equal(out.verdict, 'approve');
  });

  test('approve + mixed → max severity decides (info+error → request_changes)', () => {
    const out = applyApproveSeverityFloor(
      { verdict: 'approve' as const, comments: [{ severity: 'info' as const }, { severity: 'error' as const }] },
      P,
    );
    assert.equal(out.verdict, 'request_changes');
  });

  test('INVARIANT: an LLM comment is never upgraded, even with critical findings', () => {
    const intent = { verdict: 'comment' as const, comments: [{ severity: 'critical' as const }] };
    const out = applyApproveSeverityFloor(intent, P);
    assert.equal(out.verdict, 'comment');
    assert.equal(out, intent, 'non-approve returns the same object untouched');
  });

  test('INVARIANT: an LLM request_changes is never touched, even with only info findings', () => {
    const intent = { verdict: 'request_changes' as const, comments: [{ severity: 'info' as const }] };
    const out = applyApproveSeverityFloor(intent, P);
    assert.equal(out.verdict, 'request_changes');
    assert.equal(out, intent);
  });

  test('draft cap: approve + error on a draft → comment (never request_changes)', () => {
    const out = applyApproveSeverityFloor(
      { verdict: 'approve' as const, comments: [{ severity: 'error' as const }] },
      P,
      { isDraft: true },
    );
    assert.equal(out.verdict, 'comment');
  });

  test('draft cap: approve + only info on a draft → approve (cap only affects a block)', () => {
    const out = applyApproveSeverityFloor(
      { verdict: 'approve' as const, comments: [{ severity: 'info' as const }] },
      P,
      { isDraft: true },
    );
    assert.equal(out.verdict, 'approve');
  });

  test('override (block=error, surface=warning): approve+warning → surface → comment (withhold, not block)', () => {
    const out = applyApproveSeverityFloor(
      { verdict: 'approve' as const, comments: [{ severity: 'warning' as const }] },
      { blockSeverity: 'error', surfaceSeverity: 'warning' },
    );
    assert.equal(out.verdict, 'comment');
  });

  test('override blockSeverity: with block=critical, approve+error is surface → comment', () => {
    const out = applyApproveSeverityFloor(
      { verdict: 'approve' as const, comments: [{ severity: 'error' as const }] },
      { blockSeverity: 'critical', surfaceSeverity: 'info' },
    );
    assert.equal(out.verdict, 'comment');
  });

  test('preserves extra intent fields (body, comments) when rewriting the verdict', () => {
    const intent = {
      kind: 'review-verdict' as const,
      verdict: 'approve' as const,
      body: 'the summary',
      comments: [{ path: 'a.ts', line: 3, body: 'fix', severity: 'error' as const }],
    };
    const out = applyApproveSeverityFloor(intent, P);
    assert.equal(out.verdict, 'request_changes');
    assert.equal(out.kind, 'review-verdict');
    assert.equal(out.body, 'the summary');
    assert.deepEqual(out.comments, intent.comments);
  });
});

// ---------------------------------------------------------------------------
// Per-repo tolerance — isBlockTolerance
// ---------------------------------------------------------------------------

describe('severity-policy — isBlockTolerance', () => {
  test('BLOCK_TOLERANCES is exactly [info, warning, error]', () => {
    assert.deepEqual(BLOCK_TOLERANCES, ['info', 'warning', 'error']);
  });

  test('accepts exactly info / warning / error', () => {
    for (const t of ['info', 'warning', 'error']) {
      assert.equal(isBlockTolerance(t), true, `${t} is a valid tolerance`);
    }
  });

  test('rejects critical (deliberately not offered)', () => {
    assert.equal(isBlockTolerance('critical'), false);
  });

  test('rejects empty string, wrong case, and arbitrary / non-string values', () => {
    assert.equal(isBlockTolerance(''), false);
    assert.equal(isBlockTolerance('INFO'), false);
    assert.equal(isBlockTolerance('Warning'), false);
    assert.equal(isBlockTolerance('block'), false);
    assert.equal(isBlockTolerance(undefined), false);
    assert.equal(isBlockTolerance(null), false);
    assert.equal(isBlockTolerance(1), false);
    assert.equal(isBlockTolerance({}), false);
  });
});

// ---------------------------------------------------------------------------
// Per-repo tolerance — toleranceToPolicy mapping table
// ---------------------------------------------------------------------------

describe('severity-policy — toleranceToPolicy', () => {
  const cases: Array<{ tolerance: BlockTolerance; policy: ApproveSeverityPolicy }> = [
    { tolerance: 'error', policy: { blockSeverity: 'error', surfaceSeverity: 'warning' } },
    { tolerance: 'warning', policy: { blockSeverity: 'warning', surfaceSeverity: 'warning' } },
    { tolerance: 'info', policy: { blockSeverity: 'info', surfaceSeverity: 'info' } },
  ];
  for (const c of cases) {
    test(`${c.tolerance} → ${JSON.stringify(c.policy)}`, () => {
      assert.deepEqual(toleranceToPolicy(c.tolerance), c.policy);
    });
  }

  test('warning maps bit-for-bit to the locked default policy', () => {
    assert.deepEqual(toleranceToPolicy('warning'), DEFAULT_APPROVE_SEVERITY_POLICY);
  });

  test('every policy is well-formed (surface rank <= block rank)', () => {
    for (const t of BLOCK_TOLERANCES) {
      const p = toleranceToPolicy(t);
      assert.ok(
        SEVERITY_ORDER.indexOf(p.surfaceSeverity) <= SEVERITY_ORDER.indexOf(p.blockSeverity),
        `surface <= block for ${t}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Per-repo tolerance — isBlockingUnderPolicy
// ---------------------------------------------------------------------------

describe('severity-policy — isBlockingUnderPolicy', () => {
  test('info policy: even an untagged (undefined) finding blocks', () => {
    const P = toleranceToPolicy('info');
    assert.equal(isBlockingUnderPolicy(undefined, P), true);
    assert.equal(isBlockingUnderPolicy('info', P), true);
    assert.equal(isBlockingUnderPolicy('warning', P), true);
  });

  test('default (warning) policy: info is non-blocking, warning+ blocks', () => {
    const P = toleranceToPolicy('warning');
    assert.equal(isBlockingUnderPolicy('info', P), false);
    assert.equal(isBlockingUnderPolicy(undefined, P), false);
    assert.equal(isBlockingUnderPolicy('warning', P), true);
    assert.equal(isBlockingUnderPolicy('error', P), true);
    assert.equal(isBlockingUnderPolicy('critical', P), true);
  });

  test('error policy: only error+ blocks; warning is non-blocking', () => {
    const P = toleranceToPolicy('error');
    assert.equal(isBlockingUnderPolicy('warning', P), false);
    assert.equal(isBlockingUnderPolicy('error', P), true);
    assert.equal(isBlockingUnderPolicy('critical', P), true);
  });
});

// ---------------------------------------------------------------------------
// classifySeverities — under the info tolerance policy
// ---------------------------------------------------------------------------

describe('severity-policy — classifySeverities (info tolerance)', () => {
  const P = toleranceToPolicy('info');

  test('blockSeverity=info blocks a lone info finding', () => {
    assert.equal(classifySeverities(['info'], P), 'block');
  });

  test('an untagged set represented as [info] still blocks', () => {
    assert.equal(classifySeverities(['info', 'info'], P), 'block');
  });

  test('empty set is still clean (no findings, nothing to block)', () => {
    assert.equal(classifySeverities([], P), 'clean');
  });
});

// ---------------------------------------------------------------------------
// applyApproveSeverityFloor — per-tolerance behavior + suppressGating exclusion
// ---------------------------------------------------------------------------

describe('severity-policy — applyApproveSeverityFloor (per-tolerance)', () => {
  test('info tolerance: approve + a single info finding → request_changes', () => {
    const out = applyApproveSeverityFloor(
      { verdict: 'approve' as const, comments: [{ severity: 'info' as const }] },
      toleranceToPolicy('info'),
    );
    assert.equal(out.verdict, 'request_changes');
  });

  test('error tolerance: approve + a warning finding → comment (surfaced, not blocked)', () => {
    const out = applyApproveSeverityFloor(
      { verdict: 'approve' as const, comments: [{ severity: 'warning' as const }] },
      toleranceToPolicy('error'),
    );
    assert.equal(out.verdict, 'comment');
  });

  test('error tolerance: approve + an error finding → request_changes', () => {
    const out = applyApproveSeverityFloor(
      { verdict: 'approve' as const, comments: [{ severity: 'error' as const }] },
      toleranceToPolicy('error'),
    );
    assert.equal(out.verdict, 'request_changes');
  });

  test('only-downgrade invariant holds under all three tolerances', () => {
    for (const t of BLOCK_TOLERANCES) {
      const policy = toleranceToPolicy(t);
      // A comment / request_changes is never upgraded, whatever the tolerance.
      const comment = { verdict: 'comment' as const, comments: [{ severity: 'critical' as const }] };
      assert.equal(applyApproveSeverityFloor(comment, policy).verdict, 'comment', `comment untouched (${t})`);
      const rc = { verdict: 'request_changes' as const, comments: [{ severity: 'info' as const }] };
      assert.equal(
        applyApproveSeverityFloor(rc, policy).verdict,
        'request_changes',
        `request_changes untouched (${t})`,
      );
    }
  });

  test('draft cap under info tolerance: approve + info finding on a draft → comment (never request_changes)', () => {
    const out = applyApproveSeverityFloor(
      { verdict: 'approve' as const, comments: [{ severity: 'info' as const }] },
      toleranceToPolicy('info'),
      { isDraft: true },
    );
    assert.equal(out.verdict, 'comment');
  });

  test('suppressGating comment is excluded from the severity set (approve stays approve under info tolerance)', () => {
    // A single warning finding that failed verify-before-block: were it counted,
    // an info tolerance would block it — the suppressGating flag must remove it
    // from the set entirely so the approve survives.
    const out = applyApproveSeverityFloor(
      {
        verdict: 'approve' as const,
        comments: [{ severity: 'warning' as const, suppressGating: true }],
      },
      toleranceToPolicy('info'),
    );
    assert.equal(out.verdict, 'approve');
  });

  test('a suppressGating finding is excluded, but a sibling non-suppressed one still gates', () => {
    const out = applyApproveSeverityFloor(
      {
        verdict: 'approve' as const,
        comments: [
          { severity: 'critical' as const, suppressGating: true },
          { severity: 'info' as const },
        ],
      },
      toleranceToPolicy('info'),
    );
    // The critical is suppressed; the info remains and blocks under info tolerance.
    assert.equal(out.verdict, 'request_changes');
  });
});
