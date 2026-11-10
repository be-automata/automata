// wrangler bundles a `.wasm` import as a precompiled WebAssembly.Module
// (CompiledWasm rule). Only worker-entry.ts and workerd fixtures import one.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
