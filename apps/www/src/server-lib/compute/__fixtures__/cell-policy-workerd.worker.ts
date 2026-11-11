// The same two lines apps/www/worker-entry.ts runs: a static `.wasm` import
// that wrangler precompiles, registered on the global the resolver reads.
import cellPolicyWasm from "@terragon/shared/cell-policy/cell.wasm";
import {
  CELL_POLICY_WASM_GLOBAL,
  registeredCellPolicyModule,
} from "@terragon/shared/cell-policy/cell-policy-global";
import {
  loadCellPolicy,
  type CellPolicy,
  type CellPolicyInput,
} from "@terragon/shared/cell-policy/cell-policy";

(globalThis as Record<symbol, unknown>)[CELL_POLICY_WASM_GLOBAL] =
  cellPolicyWasm;

/**
 * Test-only Cloudflare Worker for cell-policy.workerd.test.ts: loads the
 * committed cell.wasm the way www does on Workers and evaluates the posted
 * input. `compileBytes` shows why the module must be a static import: workerd
 * refuses to compile WASM from bytes at runtime. Not deployed.
 */

type Body =
  | { op: "evaluate"; input: CellPolicyInput }
  | { op: "compileBytes"; base64: string };

let policy: Promise<CellPolicy> | null = null;

export default {
  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as Body;
    try {
      if (body.op === "compileBytes") {
        const bytes = Uint8Array.from(atob(body.base64), (c) =>
          c.charCodeAt(0),
        );
        await WebAssembly.compile(bytes);
        return Response.json({ ok: true, compiled: true });
      }
      const module = registeredCellPolicyModule();
      if (!module) {
        return Response.json({ ok: false, message: "no registered module" });
      }
      policy ??= loadCellPolicy(module);
      const decision = (await policy).evaluate(body.input);
      return Response.json({
        ok: true,
        decision,
        runtime: navigator.userAgent,
      });
    } catch (e) {
      return Response.json({
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },
};
