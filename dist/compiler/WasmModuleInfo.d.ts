/**
 * A minimal WebAssembly binary reader: just enough of the format (type, import, function and export sections) to know
 * a module's exported functions, their signatures, and whether it needs anything besides WASI to run. No execution,
 * no validation beyond what is needed to walk the sections -- `WebAssembly.validate` is the real check, run separately.
 *
 * https://webassembly.github.io/spec/core/binary/modules.html
 */
export type WasmValType = "i32" | "i64" | "f32" | "f64" | "v128" | "funcref" | "externref";
export interface WasmFuncType {
    params: WasmValType[];
    results: WasmValType[];
}
export interface WasmImport {
    module: string;
    name: string;
    kind: "func" | "table" | "mem" | "global";
    /** For a function import, its signature; undefined for the other kinds. */
    type?: WasmFuncType;
}
export interface WasmExport {
    name: string;
    kind: "func" | "table" | "mem" | "global";
    index: number;
    /** For a function export, its signature. */
    type?: WasmFuncType;
}
export interface WasmModuleInfo {
    imports: WasmImport[];
    exports: WasmExport[];
    /** True when the module exports its own linear memory (name usually "memory"). */
    hasMemory: boolean;
}
/** Parses the sections `WasmModuleInfo` needs from a `.wasm` binary; throws if the header is not a valid module. */
export declare function parseWasmModule(bytes: Uint8Array): WasmModuleInfo;
//# sourceMappingURL=WasmModuleInfo.d.ts.map