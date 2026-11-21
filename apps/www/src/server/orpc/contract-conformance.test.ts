import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cliAPIContract } from "@terragon/cli-api-contract";
import type { EgressEntryError } from "@terragon/shared/model/egress-entries";
import type { EgressEntryCode } from "@terragon/types/egress";
import { describe, expect, expectTypeOf, it } from "vitest";
import type * as z from "zod/v4";

/**
 * CLI practices rule 6, for the server (conformance matrix row 18): every
 * error a handler or middleware can throw is declared in the contract of the
 * procedure it runs under, and no undeclared `new ORPCError` exists.
 */

interface ErrorDef {
  data?: { safeParse: (value: unknown) => { success: boolean } };
}

interface ContractLike {
  "~orpc": { errorMap: Record<string, ErrorDef | undefined> };
}

function isContract(value: unknown): value is ContractLike {
  return typeof value === "object" && value !== null && "~orpc" in value;
}

function procedures(tree: unknown): ContractLike[] {
  if (isContract(tree)) return [tree];
  if (typeof tree !== "object" || tree === null) return [];
  return Object.values(tree).flatMap(procedures);
}

/** The codes declared by EVERY procedure of the tree (the strictest reading). */
function declaredByAll(tree: unknown): Set<string> {
  const lists = procedures(tree).map((p) => Object.keys(p["~orpc"].errorMap));
  const [first = [], ...rest] = lists;
  return new Set(first.filter((code) => rest.every((l) => l.includes(code))));
}

/** The error map of `egress.update`, widened to the shape this test reads. */
function updateErrorMap(): Record<string, ErrorDef | undefined> {
  return (cliAPIContract.egress.update as unknown as ContractLike)["~orpc"]
    .errorMap;
}

const DIR = __dirname;
const read = (file: string) => readFileSync(join(DIR, file), "utf8");

function thrownCodes(source: string): string[] {
  const factories = [...source.matchAll(/\berrors\.([A-Z_]+)\(/g)];
  const raw = [...source.matchAll(/new ORPCError\(\s*"([A-Z_]+)"/g)];
  return [...factories, ...raw].map((m) => m[1] as string);
}

const WALKED: { file: string; tree: unknown; label: string }[] = [
  { file: "egress-router.ts", tree: cliAPIContract.egress, label: "egress" },
  { file: "principal.ts", tree: cliAPIContract.egress, label: "egress" },
  { file: "cli-router.ts", tree: cliAPIContract, label: "every procedure" },
];

describe("contract conformance (rule 6)", () => {
  for (const { file, tree, label } of WALKED) {
    it(`${file}: every thrown code is declared by ${label}`, () => {
      const declared = declaredByAll(tree);
      const thrown = thrownCodes(read(file));
      expect(thrown.length).toBeGreaterThan(0);
      for (const code of thrown) {
        expect(declared, `${file} throws ${code}`).toContain(code);
      }
    });

    it(`${file}: builds no raw ORPCError`, () => {
      expect(read(file)).not.toMatch(/new ORPCError\(/);
    });
  }

  it("egress.update declares every error its handler and the middleware can throw, with the reasons they use", () => {
    const declared = updateErrorMap();
    for (const code of [
      "UNAUTHORIZED",
      "FORBIDDEN",
      "NOT_FOUND",
      "BAD_REQUEST",
      "CONFLICT",
      "RATE_LIMIT_EXCEEDED",
      "SERVICE_UNAVAILABLE",
    ]) {
      expect(declared, code).toHaveProperty(code);
    }
    const accepts = (code: string, data: unknown) =>
      declared[code]?.data?.safeParse(data).success;
    expect(accepts("FORBIDDEN", { reason: "origin_mismatch" })).toBe(true);
    expect(accepts("FORBIDDEN", { reason: "not_repo_admin" })).toBe(true);
    expect(
      accepts("SERVICE_UNAVAILABLE", { reason: "github_unavailable" }),
    ).toBe(true);
    expect(accepts("SERVICE_UNAVAILABLE", { reason: "auth_unavailable" })).toBe(
      true,
    );
    expect(accepts("CONFLICT", { currentUpdatedAt: null })).toBe(true);
    expect(accepts("CONFLICT", {})).toBe(false);
  });

  it("every reason literal the egress sources throw is declared", () => {
    const declared = updateErrorMap();
    const sources = read("principal.ts") + read("egress-router.ts");
    const reasons = [...sources.matchAll(/reason: "([a-z_]+)"/g)].map(
      (m) => m[1] as string,
    );
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) {
      const ok = ["FORBIDDEN", "SERVICE_UNAVAILABLE"].some(
        (code) => declared[code]?.data?.safeParse({ reason }).success,
      );
      expect(ok, `reason ${reason}`).toBe(true);
    }
  });

  it("the input-validation interceptor is the one allow-listed raw ORPCError, and it builds a declared BAD_REQUEST", () => {
    const source = read("api-version.ts");
    expect(source.match(/new ORPCError\(/g)).toHaveLength(1);
    const body = source.slice(source.indexOf("function validationFailure"));
    const end = body.indexOf("\n}\n");
    expect(body.slice(0, end)).toContain('new ORPCError("BAD_REQUEST"');
    // Every procedure, threads and auth included: the interceptor is mounted on both.
    expect(declaredByAll(cliAPIContract)).toContain("BAD_REQUEST");
  });

  it("SERVICE_UNAVAILABLE is declared on every procedure, threads and auth included", () => {
    expect(declaredByAll(cliAPIContract)).toContain("SERVICE_UNAVAILABLE");
  });

  it("the entry codes of the contract and of the classifier are one union", () => {
    type Egress = typeof cliAPIContract.egress.get;
    type BadRequest = NonNullable<
      Egress["~orpc"]["errorMap"]["BAD_REQUEST"]
    >["data"];
    type ContractCode = z.infer<
      NonNullable<BadRequest>
    >["errors"][number]["code"];
    expectTypeOf<ContractCode>().toEqualTypeOf<EgressEntryCode>();
    expectTypeOf<EgressEntryError["code"]>().toEqualTypeOf<EgressEntryCode>();
  });
});
