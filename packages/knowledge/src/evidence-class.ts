// Evidence classes decide how a pinned span's identity is computed.
//   prose: doc://, ticket:// and repo:// files with a prose extension (PROSE_EXTENSIONS). Whitespace is
//          layout, so it is collapsed before hashing: a re-wrapped paragraph is the same evidence.
//   exact: every other repo:// file, including unknown or missing extensions. Whitespace can carry
//          meaning (Python indentation, YAML nesting), so the span is hashed byte for byte.
// Unknown formats default to exact: a false "changed" costs a review, a missed change costs correctness.
// Only the classification lives here; the hashing itself lives in claims.ts (node:crypto is not allowed
// in the fs-free core).

export type EvidenceScheme = "repo" | "ticket" | "doc";
export type EvidenceClass = "prose" | "exact";

export const PROSE_EXTENSIONS = [
  "md",
  "mdx",
  "markdown",
  "txt",
  "rst",
  "adoc",
  "asciidoc",
] as const;

const PROSE_SET: ReadonlySet<string> = new Set(PROSE_EXTENSIONS);

/** The lowercase extension of a path's basename, or null when it has none (`Makefile`, `.env`). */
function extensionOf(target: string): string | null {
  const base = target.slice(target.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : null;
}

export function classifyEvidence(
  scheme: EvidenceScheme,
  target: string,
): EvidenceClass {
  if (scheme === "doc" || scheme === "ticket") return "prose";
  const ext = extensionOf(target);
  return ext !== null && PROSE_SET.has(ext) ? "prose" : "exact";
}
