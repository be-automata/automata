/**
 * True iff the GraphQL document contains a `mutation` operation. Strings
 * (block + regular, with escapes) and `#` comments are stripped first so a
 * query mentioning "mutation" in a literal still passes; after stripping, ANY
 * bare `mutation` keyword rejects. That is a superset of "operation position"
 * — deliberately fail-closed (GitHub's Query type has no field spelled
 * `mutation`, so real reads never trip it).
 */
export function graphqlHasMutation(query: string): boolean {
  const stripped = query
    .replace(/"""[\s\S]*?"""/g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, " ")
    .replace(/#[^\n\r]*/g, " ");
  return /\bmutation\b/.test(stripped);
}
