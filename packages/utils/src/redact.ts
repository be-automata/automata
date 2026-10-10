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
  // left alone; a real password is percent-encoded and has none.
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(?=@)/gi,
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
