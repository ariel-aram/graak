import { type WasmModuleInfo } from "./WasmModuleInfo";
/**
 * Builds the shim source for a parsed module, or `null` when it needs imports the shim cannot supply (the caller
 * should fall back to writing the loader by hand for those, and say so).
 */
export declare function generateShimSource(info: WasmModuleInfo, wasmFileName: string): string | null;
/** Parses `wasmBytes` and returns the generated shim source, or `null` when the module needs imports the shim
 * cannot supply on its own (an arbitrary `env` import object the caller would have to provide). `wasmFileName` is
 * the relative path the shim will `import.meta.url`-resolve the `.wasm` from (normally its own file name, since the
 * shim is written next to it). */
export declare function generateWasmShim(wasmBytes: Uint8Array, wasmFileName: string): string | null;
//# sourceMappingURL=WasmShimGenerator.d.ts.map