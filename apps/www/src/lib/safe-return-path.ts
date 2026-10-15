/**
 * The open-redirect fence for every "send the user back to X afterwards"
 * value that arrives from outside (a `returnUrl` query parameter, a link).
 *
 * Only a same-origin, root-relative path survives. Rejected: absolute URLs
 * (`https://evil.example`), scheme-relative ones (`//evil.example`) and the
 * backslash variants browsers read the same way (`/\evil.example`), anything
 * not starting with `/` (`javascript:…`, a still-encoded `%2F%2F…`), and
 * control characters (browsers drop tabs and newlines, which can turn
 * `/<tab>/evil.example` into `//evil.example`).
 */

const PARSE_BASE = "https://return-path.invalid";

// Backslash, ASCII control characters and DEL.
const UNSAFE_CHARACTER = /[\\\u0000-\u001f\u007f]/;

/**
 * `raw` as a same-origin path (path + query + hash, dot segments resolved),
 * or null when it is not one. Takes `unknown` because a query parameter can
 * arrive repeated (an array) or not at all.
 */
export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  if (!raw.startsWith("/") || raw.startsWith("//")) {
    return null;
  }
  if (UNSAFE_CHARACTER.test(raw)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw, PARSE_BASE);
  } catch {
    // An unparseable path is not a safe redirect target.
    return null;
  }
  if (url.origin !== PARSE_BASE) {
    return null;
  }
  const path = `${url.pathname}${url.search}${url.hash}`;
  // Resolving dot segments can produce a leading `//` ("/.//evil.example").
  return path.startsWith("//") ? null : path;
}

/** Where a sign-in lands when there is no (safe) return path. */
export const DEFAULT_RETURN_PATH = "/dashboard";
