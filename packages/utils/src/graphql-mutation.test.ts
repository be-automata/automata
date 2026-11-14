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

  it("ignores the word in a block string, a regular string and a comment", () => {
    expect(graphqlHasMutation('"""mutation docs""" query { a }')).toBe(false);
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
