/**
 * Scrub credential material out of free text before it leaves a process —
 * the worker's failure reasons posted to www (persisted on the thread), log
 * lines, error messages that echo a command line, and www's own warn lines
 * about a failed token mint. The ONE redactor for both planes. Conservative
 * patterns: anything that looks like a token is replaced, never partially kept.
 */
const PATTERNS: RegExp[] = [
  // `AUTHORIZATION: basic <b64>` as passed via `git -c http.extraHeader=…`
  /(\bbasic\s+)[A-Za-z0-9+/=]{8,}/gi,
  /(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  // GitHub token families (installation, personal, OAuth, user-to-server…)
  /\bgh[pousr]_[A-Za-z0-9_]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  // `x-access-token:<token>@` in a URL
  /(x-access-token:)[^@\s]+/g,
  // `scheme://user:<password>@` in any URL (a Postgres/Redis connection
  // string in a client error). No `/` in the password, so `host:port/a@b` is
  // left alone; a real password is percent-encoded and has none. The scheme is
  // bounded (#743): unbounded, every word boundary in a long `a-a-a-…` run
  // rescanned to the end, which is quadratic.
  /(\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/]+:)[^\s@/]+(?=@)/gi,
  // A bare JWT (an engine API token in a CLI's output). Anchored on the
  // base64url JSON header, which always starts `eyJ`, so dotted names in
  // ordinary log text never match.
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of PATTERNS) {
    out = out.replace(re, (_m, prefix?: string) =>
      typeof prefix === "string" ? `${prefix}<redacted>` : "<redacted>",
    );
  }
  return out;
}

/**
 * A redactor that also blanks exact values (an owner's repo env) before the
 * pattern pass. A value counts from `minLength` characters: below that it is
 * too short to be a credential and too common to blank without mangling the
 * text. Each value is blanked raw and JSON-escaped (an echoed request body
 * carries a quote, a backslash or a newline escaped), longest first, so a
 * value that contains another is never half-blanked.
 */
export function createValueRedactor(
  values: Iterable<string>,
  minLength = 4,
): (text: string) => string {
  const plain = [...values].filter((v) => v.length >= minLength);
  const blanks = [
    ...new Set(plain.flatMap((v) => [v, JSON.stringify(v).slice(1, -1)])),
  ].sort((a, b) => b.length - a.length);
  // One pass over one alternation: a value that occurs inside a marker
  // already written (`dact`) can never garble it.
  const any =
    blanks.length > 0
      ? new RegExp(
          blanks.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
          "g",
        )
      : null;
  return (text) => redactSecrets(any ? text.replace(any, "<redacted>") : text);
}
