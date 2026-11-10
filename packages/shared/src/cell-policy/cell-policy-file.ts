import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Node-only: the committed `cell.wasm` as bytes (tests, `next dev`, scripts).
 * On Cloudflare Workers the module comes from the Worker entry instead
 * (`registeredCellPolicyModule`), because workerd refuses to compile WASM
 * from bytes.
 */
export async function readCellPolicyWasm(): Promise<Uint8Array> {
  const here = dirname(fileURLToPath(import.meta.url));
  return new Uint8Array(await readFile(join(here, "cell.wasm")));
}
