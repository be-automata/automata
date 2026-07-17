/**
 * redactSecrets — pure walker that strips token-shaped strings from audit
 * payloads before persistence (NFR-7, Helper H5).
 *
 * The pattern set mirrors `DEFAULT_SECRET_PATTERNS` from
 * `src/review/review-gate.ts:262-269`. Per Phase 3 §2 row 12, the regex
 * set is COPIED here rather than imported, preserving bounded-context
 * independence between `src/audit/` and `src/review/`.
 */

const REDACTED = "<REDACTED>";

const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9_]{36}/,
  /gho_[A-Za-z0-9_]{36}/,
  /ghs_[A-Za-z0-9_]{36}/,
  /-----BEGIN\s+(?:RSA|EC|DSA|OPENSSH)?\s*PRIVATE KEY-----/,
  /(?:secret|password|api[_-]?key)\s*[:=]\s*['"][^'"]{8,}['"]/i,
  /(?:secret|password|api[_-]?key)\s*[:=]\s*\S{8,}/i,
];

function leafIsSecret(value: string): boolean {
  for (const re of SECRET_PATTERNS) {
    // RegExps in this file are not declared global; `.test` is safe to call
    // repeatedly without lastIndex side-effects.
    if (re.test(value)) return true;
  }
  return false;
}

/**
 * Walk a payload tree, returning a deep copy with any leaf string matching
 * a known secret pattern replaced by `<REDACTED>`. Preserves non-string
 * primitives (number, boolean, null, undefined). Does not mutate input.
 */
export function redactSecrets(payload: unknown): unknown {
  return walk(payload);
}

function walk(value: unknown): unknown {
  if (typeof value === "string") {
    return leafIsSecret(value) ? REDACTED : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => walk(item));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v);
    }
    return out;
  }
  return value;
}
