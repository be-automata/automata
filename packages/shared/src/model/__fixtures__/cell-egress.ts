import type { CellEgressCatalog } from "../cell-egress";

/** Test-only fixtures shared by the cell egress suites (the `__fixtures__` convention, as in self-heal/bench). */
export const BROKER = "broker.automata.test";

export const CATALOG: CellEgressCatalog = {
  "test/npm@1": { id: "test/npm@1", allow: ["registry.npmjs.org"] },
  "test/pypi@1": { id: "test/pypi@1", allow: ["pypi.org"] },
  "test/wild@1": { id: "test/wild@1", allow: ["*.example.org"] },
  "test/gh@1": { id: "test/gh@1", allow: ["*.github.com"] },
};
