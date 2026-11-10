/**
 * Where apps/www's Worker entry (worker-entry.ts) leaves the WASM module that
 * wrangler bundled. A global registry, because the Worker entry and the
 * OpenNext server bundle are separate module graphs in one isolate. No
 * imports here, so the Worker entry does not pull the OPA SDK in twice.
 */
export const CELL_POLICY_WASM_GLOBAL = Symbol.for("automata.cell-policy.wasm");

/** The `WebAssembly.Module` the Worker entry registered, if any. */
export function registeredCellPolicyModule(): WebAssembly.Module | undefined {
  const value = (globalThis as Record<symbol, unknown>)[
    CELL_POLICY_WASM_GLOBAL
  ];
  return value instanceof WebAssembly.Module ? value : undefined;
}
