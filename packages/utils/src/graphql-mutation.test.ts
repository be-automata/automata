import { describe, expect, it } from "vitest";

import { graphqlHasMutation } from "./graphql-mutation";

describe("graphqlHasMutation", () => {
  it("refuses the quote-in-a-comment bypass", () => {
    expect(
      graphqlHasMutation(
        'query Q { viewer { login } } # "\nmutation M { addStar(input:{starrableId:"x"}) { clientMutationId } } # "',
      ),
    ).toBe(true);
  });

  it("refuses a mutation on the line after a comment holding a quote", () => {
    expect(graphqlHasMutation('query { a } # it"s\nmutation { b }')).toBe(true);
  });

  it("refuses a mutation after an unterminated string", () => {
    expect(graphqlHasMutation('query { f(q: "abc\nmutation M { x } }')).toBe(
      true,
    );
  });

  it("ignores the word in a regular string, a block string argument and a comment", () => {
    expect(graphqlHasMutation('query { f(q: """mutation docs""") }')).toBe(
      false,
    );
    expect(graphqlHasMutation('query { f(q: "mutation") }')).toBe(false);
    expect(graphqlHasMutation('query { f(q: "a \\" mutation") }')).toBe(false);
    expect(graphqlHasMutation("# mutation comment\nquery { a }")).toBe(false);
  });

  it("accepts a plain query and refuses a plain mutation", () => {
    expect(graphqlHasMutation("query { viewer { login } }")).toBe(false);
    expect(graphqlHasMutation("mutation { x }")).toBe(true);
    expect(graphqlHasMutation("query A { a } mutation B { b }")).toBe(true);
  });
});

describe("graphqlHasMutation (reference parser)", () => {
  it("passes a field named `mutation`: the parser sees a query, so the old fail-closed superset is gone", () => {
    expect(graphqlHasMutation("query{mutation}")).toBe(false);
  });

  it("refuses a subscription, which is not a read", () => {
    expect(graphqlHasMutation("subscription { a }")).toBe(true);
  });

  it("refuses a document that does not parse", () => {
    expect(graphqlHasMutation("query { a")).toBe(true);
    expect(graphqlHasMutation("not graphql at all {")).toBe(true);
    // A description before an operation is a syntax error in GraphQL.
    expect(graphqlHasMutation('"""mutation docs""" query { a }')).toBe(true);
  });

  it("refuses a document with two operations when one is a mutation", () => {
    expect(
      graphqlHasMutation("query A { a } query B { b } mutation C { c }"),
    ).toBe(true);
    expect(graphqlHasMutation("query A { a } query B { b }")).toBe(false);
  });

  it("refuses a document with no operation (fragments only, or empty)", () => {
    expect(graphqlHasMutation("fragment F on User { login }")).toBe(true);
    expect(graphqlHasMutation("")).toBe(true);
  });

  it("passes the shorthand query and a query with variables and fragments", () => {
    expect(graphqlHasMutation("{ viewer { login } }")).toBe(false);
    expect(
      graphqlHasMutation(
        'query($n: Int!) { repository(owner: "o", name: "r") { issues(first: $n) { ...F } } } fragment F on IssueConnection { totalCount }',
      ),
    ).toBe(false);
  });
});
