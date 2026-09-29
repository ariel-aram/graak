"use strict";
/**
 * A minimal WebAssembly binary reader: just enough of the format (type, import, function and export sections) to know
 * a module's exported functions, their signatures, and whether it needs anything besides WASI to run. No execution,
 * no validation beyond what is needed to walk the sections -- `WebAssembly.validate` is the real check, run separately.
 *
 * https://webassembly.github.io/spec/core/binary/modules.html
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseWasmModule = parseWasmModule;
class Reader {
    bytes;
    i = 0;
    constructor(bytes) {
        this.bytes = bytes;
    }
    eof() {
        return this.i >= this.bytes.length;
    }
    u8() {
        return this.bytes[this.i++];
    }
    bytesOf(n) {
        const out = this.bytes.subarray(this.i, this.i + n);
        this.i += n;
        return out;
    }
    u32() {
        // LEB128, unsigned.
        let result = 0;
        let shift = 0;
        for (;;) {
            const byte = this.u8();
            result |= (byte & 0x7f) << shift;
            if ((byte & 0x80) === 0)
                return result >>> 0;
            shift += 7;
        }
    }
    name() {
        const len = this.u32();
        return Buffer.from(this.bytesOf(len)).toString("utf-8");
    }
    skip(n) {
        this.i += n;
    }
    pos() {
        return this.i;
    }
    seek(pos) {
        this.i = pos;
    }
}
const VALTYPE = {
    127: "i32",
    126: "i64",
    125: "f32",
    124: "f64",
    123: "v128",
    112: "funcref",
    111: "externref",
};
const EXPORT_KIND = ["func", "table", "mem", "global"];
/** Parses the sections `WasmModuleInfo` needs from a `.wasm` binary; throws if the header is not a valid module. */
function parseWasmModule(bytes) {
    if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
        throw new Error("not a WebAssembly binary (bad magic)");
    }
    const r = new Reader(bytes);
    r.skip(8); // magic + version
    const types = [];
    const imports = [];
    const funcTypeIndices = []; // one per function defined in this module (not imported)
    const exports = [];
    while (!r.eof()) {
        const id = r.u8();
        const size = r.u32();
        const sectionEnd = r.pos() + size;
        if (id === 1) {
            // Type section.
            const count = r.u32();
            for (let i = 0; i < count; i++) {
                if (r.u8() !== 0x60)
                    throw new Error("unsupported type form (expected func type 0x60)");
                const paramCount = r.u32();
                const params = [];
                for (let p = 0; p < paramCount; p++)
                    params.push(VALTYPE[r.u8()] ?? "i32");
                const resultCount = r.u32();
                const results = [];
                for (let p = 0; p < resultCount; p++)
                    results.push(VALTYPE[r.u8()] ?? "i32");
                types.push({ params, results });
            }
        }
        else if (id === 2) {
            // Import section.
            const count = r.u32();
            for (let i = 0; i < count; i++) {
                const mod = r.name();
                const name = r.name();
                const descKind = r.u8();
                if (descKind === 0x00) {
                    const typeIdx = r.u32();
                    imports.push({ module: mod, name, kind: "func", type: types[typeIdx] });
                }
                else if (descKind === 0x01) {
                    r.u8(); // elemtype
                    readLimits(r);
                    imports.push({ module: mod, name, kind: "table" });
                }
                else if (descKind === 0x02) {
                    readLimits(r);
                    imports.push({ module: mod, name, kind: "mem" });
                }
                else if (descKind === 0x03) {
                    r.u8(); // valtype
                    r.u8(); // mutability
                    imports.push({ module: mod, name, kind: "global" });
                }
            }
        }
        else if (id === 3) {
            // Function section.
            const count = r.u32();
            for (let i = 0; i < count; i++)
                funcTypeIndices.push(r.u32());
        }
        else if (id === 7) {
            // Export section.
            const count = r.u32();
            for (let i = 0; i < count; i++) {
                const name = r.name();
                const kindByte = r.u8();
                const index = r.u32();
                const kind = EXPORT_KIND[kindByte] ?? "func";
                const entry = { name, kind, index };
                if (kind === "func") {
                    const importedFuncCount = imports.filter((imp) => imp.kind === "func").length;
                    const type = index < importedFuncCount
                        ? imports.filter((imp) => imp.kind === "func")[index]?.type
                        : types[funcTypeIndices[index - importedFuncCount]];
                    if (type)
                        entry.type = type;
                }
                exports.push(entry);
            }
        }
        // Anything else (custom, table, memory, global, start, element, code, data, data count): skip whole.
        r.seek(sectionEnd);
    }
    return { imports, exports, hasMemory: exports.some((e) => e.kind === "mem") };
}
function readLimits(r) {
    const flags = r.u8();
    r.u32(); // min
    if (flags & 1)
        r.u32(); // max
}
//# sourceMappingURL=WasmModuleInfo.js.map