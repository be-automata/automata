/**
 * True iff the GraphQL document contains a `mutation` operation. Block
 * strings, regular strings (with escapes; they cannot span lines) and `#`
 * comments are stripped in ONE left-to-right pass, so whichever token starts
 * first wins: a `"` inside a comment cannot open a string that hides what
 * follows, and a `#` inside a string is not a comment. A query mentioning
 * "mutation" in a literal still passes; after stripping, ANY bare `mutation`
 * keyword rejects. That is a superset of "operation position" — deliberately
 * fail-closed (GitHub's Query type has no field spelled `mutation`, so real
 * reads never trip it).
 */
export function graphqlHasMutation(query: string): boolean {
  const stripped = query.replace(
    /"""[\s\S]*?"""|"(?:\\.|[^"\\\n\r])*"|#[^\n\r]*/g,
    " ",
  );
  return /\bmutation\b/.test(stripped);
}
