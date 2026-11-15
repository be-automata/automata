import type { CellEgressCatalog } from "./cell-egress";

/** Test-only fixtures shared by the cell egress suites. */
export const BROKER = "broker.automata.test";

export const CATALOG: CellEgressCatalog = {
  "test/npm@1": { id: "test/npm@1", allow: ["registry.npmjs.org"] },
  "test/wild@1": { id: "test/wild@1", allow: ["*.example.org"] },
  "test/gh@1": { id: "test/gh@1", allow: ["*.github.com"] },
};
