import { Kind, OperationTypeNode, parse } from "graphql";

/**
 * True iff the GraphQL document is not a plain read: the reference parser
 * (`graphql`) decides, so strings, block strings and `#` comments are handled
 * as the GraphQL grammar defines them. Fail closed:
 *  - a document that does not parse is refused (true);
 *  - a document with no operation definition (fragments only, or empty) is
 *    refused (true);
 *  - a `mutation` or a `subscription` operation anywhere in the document is
 *    refused (true), since neither is a read.
 * Only a document that parses and whose operations are all queries passes. A
 * field that happens to be named `mutation` is a field, not an operation.
 */
export function graphqlHasMutation(query: string): boolean {
  let document;
  try {
    document = parse(query, { noLocation: true });
  } catch {
    return true;
  }
  const operations = document.definitions.filter(
    (definition) => definition.kind === Kind.OPERATION_DEFINITION,
  );
  if (operations.length === 0) return true;
  return operations.some(
    (operation) => operation.operation !== OperationTypeNode.QUERY,
  );
}
