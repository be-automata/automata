/**
 * Shareable org-scoped links: `/o/<orgSlug>/<path>` switches the session to
 * that org (after a membership check) and redirects to `/<path>`.
 *
 * The redirect target is built only from path segments, so it can never leave
 * the app's origin; safeReturnPath (the shared open-redirect fence) checks it
 * once more before it is returned.
 */

import { safeReturnPath } from "./safe-return-path";

/** Where an `/o/<slug>` link with no path lands. */
export const ORG_LINK_DEFAULT_TARGET = "/dashboard";

/** The path prefix of an org link. A target under it would loop. */
export const ORG_LINK_PREFIX = "o";

const UNSAFE_SEGMENT = /[\\/:\u0000-\u001f\u007f]/;

/**
 * The same-origin path an org link redirects to, or null when the segments
 * cannot be turned into one safely.
 *
 * `segments` are the already-decoded catch-all segments after the slug; each
 * one is re-encoded, so nothing in a segment can become a path separator, a
 * scheme or a second leading slash. Rejected outright: empty, `.` and `..`
 * segments, separators (`/`, `\`) and colons smuggled in through encoding,
 * control characters, and a target that is itself an org link.
 */
export function buildOrgLinkTarget(
  segments: readonly string[] | undefined,
  search: string,
): string | null {
  const parts = segments ?? [];
  if (parts.length === 0) {
    return `${ORG_LINK_DEFAULT_TARGET}${normalizeSearch(search)}`;
  }
  if (parts[0] === ORG_LINK_PREFIX) {
    return null;
  }
  for (const segment of parts) {
    if (segment === "" || segment === "." || segment === "..") {
      return null;
    }
    if (UNSAFE_SEGMENT.test(segment)) {
      return null;
    }
  }
  const path = `/${parts.map(encodeURIComponent).join("/")}`;
  if (safeReturnPath(path) === null) {
    return null;
  }
  return `${path}${normalizeSearch(search)}`;
}

/**
 * The link that opens `pathname` in the org with `slug`. The root path and
 * an org-link path (which would nest prefixes) fall back to the bare
 * `/o/<slug>`, which lands on the dashboard.
 */
export function buildOrgLink({
  origin,
  slug,
  pathname,
}: {
  origin: string;
  slug: string;
  pathname: string;
}): string {
  const path =
    pathname === "/" ||
    pathname === "" ||
    pathname.startsWith(`/${ORG_LINK_PREFIX}/`)
      ? ""
      : pathname;
  return `${origin}/${ORG_LINK_PREFIX}/${encodeURIComponent(slug)}${path}`;
}

function normalizeSearch(search: string): string {
  if (search === "" || search === "?") {
    return "";
  }
  return search.startsWith("?") ? search : `?${search}`;
}
