/**
 * BreakGlassMatcher — pure parser for the `break glass` comment grammar.
 *
 * Implements Phase 2 §FR-9 / Helper H3 / Phase 3 §2 row 4.
 *
 * Grammar (case-sensitive, anchored start-and-end-of-body):
 *   ^break glass(:\s*(.+))?$
 *
 * Reason text is truncated at 500 characters. Trailing `\n` or `\r\n` from
 * GitHub web UI is stripped before matching.
 */

import type { BreakGlassMatch } from './types';

const MAX_REASON_LENGTH = 500;
const PREFIX_BARE = 'break glass';
const PREFIX_WITH_COLON = 'break glass:';

export interface BreakGlassMatcher {
  match(commentBody: string): BreakGlassMatch;
}

export function createBreakGlassMatcher(): BreakGlassMatcher {
  return {
    match(commentBody) {
      return matchBreakGlass(commentBody);
    },
  };
}

function matchBreakGlass(rawBody: string): BreakGlassMatch {
  if (typeof rawBody !== 'string' || rawBody.length === 0) {
    return { matched: false, reason: null };
  }

  const body = stripSingleTrailingNewline(rawBody);

  // Bare "break glass" — exact match.
  if (body === PREFIX_BARE) {
    return { matched: true, reason: null };
  }

  // "break glass:..." form. Case-sensitive, no leading whitespace.
  if (!body.startsWith(PREFIX_WITH_COLON)) {
    return { matched: false, reason: null };
  }

  const remainder = body.slice(PREFIX_WITH_COLON.length);

  // The remainder must match `\s*(.+)` where `.` does NOT span newlines —
  // multi-line bodies fail the grammar.
  if (remainder.includes('\n') || remainder.includes('\r')) {
    return { matched: false, reason: null };
  }

  const reasonTrimmed = remainder.replace(/^\s+/, '');
  if (reasonTrimmed.length === 0) {
    return { matched: false, reason: null };
  }

  const truncated =
    reasonTrimmed.length > MAX_REASON_LENGTH
      ? reasonTrimmed.slice(0, MAX_REASON_LENGTH)
      : reasonTrimmed;

  return { matched: true, reason: truncated };
}

function stripSingleTrailingNewline(s: string): string {
  if (s.endsWith('\r\n')) return s.slice(0, -2);
  if (s.endsWith('\n')) return s.slice(0, -1);
  return s;
}
