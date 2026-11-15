// psl@1.15.0 ships types, but its `exports` map has no `types` condition, so
// bundler resolution cannot find them. This declaration travels with
// cell-egress.ts (triple-slash reference), so every package that compiles it
// type-checks without a tsconfig `paths` entry. Only what we call is declared.
declare module "psl" {
  /** The registrable domain of `domain`, or null when it is a public suffix. */
  export function get(domain: string): string | null;
}
