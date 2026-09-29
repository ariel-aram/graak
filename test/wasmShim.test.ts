import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BinaryPackager, generateWasmShim, TargetDevice } from "../dist/index.js";

/*
 * The WASM auto-shim generator: given a compiled `.wasm`, no hand-written loader is needed for a module that only
 * imports WASI (or nothing at all) -- `generateWasmShim` reads its own export table and writes the binding. Real
 * end-to-end use with rustc (`wasm32-unknown-unknown` and `wasm32-wasip1`) was verified by hand against real Node.js
 * 24.21.0/26.9.0 and the packaged Graak binary with no Node.js on the path; this test hand-assembles a module (the
 * same technique test/fixtures/web/wasm-corpus.cjs uses) so it needs no Rust toolchain to run in CI.
 */

const leb = (n: number): number[] => {
	const bytes: number[] = [];
	do {
		let byte = n & 0x7f;
		n >>>= 7;
		if (n) byte |= 0x80;
		bytes.push(byte);
	} while (n);
	return bytes;
};
const str = (s: string): number[] => [s.length, ...Buffer.from(s)];
const vec = (items: number[][]): number[] => [...leb(items.length), ...items.flat()];
const section = (id: number, body: number[]): number[] => [id, ...leb(body.length), ...body];
const wasm = (...sections: number[][]): Uint8Array =>
	new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...sections.flat()]);
const I32 = 0x7f;
const fn = (params: number[], results: number[]) => [
	0x60,
	...vec(params.map((p) => [p])),
	...vec(results.map((r) => [r])),
];

// add(i32, i32) -> i32, a tiny reactor with no imports.
function buildAddModule(): Uint8Array {
	const types = section(1, vec([fn([I32, I32], [I32])]));
	const funcs = section(3, vec([[0]]));
	const exports = section(7, vec([[...str("add"), 0, 0]]));
	const body = [0, 0x20, 0, 0x20, 1, 0x6a, 0x0b]; // 0 local decls; local.get 0; local.get 1; i32.add; end
	const code = section(10, vec([[...leb(body.length), ...body]]));
	return wasm(types, funcs, exports, code);
}

test("generateWasmShim produces a working binding for a module with no imports", () => {
	const shim = generateWasmShim(buildAddModule(), "add.wasm");
	assert.ok(shim);
	assert.match(shim as string, /export const add = /);
	assert.match(shim as string, /new WebAssembly\.Module/); // synchronous constructors, not top-level await
});

test("generateWasmShim refuses a module with an import it cannot satisfy", () => {
	const types = section(1, vec([fn([I32], [I32])]));
	const imports = section(2, vec([[...str("env"), ...str("double"), 0x00, 0]]));
	const bytes = wasm(types, imports);
	assert.equal(generateWasmShim(bytes, "needs-env.wasm"), null);
});

test("a project that ships a .wasm gets a ready-made binding, and it runs with no Node.js", {
	timeout: 120_000,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "graak-wasmshim-"));
	writeFileSync(join(root, "add.wasm"), buildAddModule());
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "wasmapp", private: true }));
	const entry = join(root, "use.mjs");
	writeFileSync(entry, 'import { add } from "./add.wasm.js";\nconsole.log(add(2, 3));\n');

	const out = join(root, "out", "app");
	const result = await BinaryPackager.compile({
		entrypoint: entry,
		target: TargetDevice.LinuxModernX64,
		packageManager: "npm",
		strategy: "sea",
		offline: true,
		output: out,
	});
	const run = spawnSync(result.launcherPath, [], { encoding: "utf-8", env: { PATH: "/usr/bin:/bin" } });
	assert.equal(run.status, 0, `host failed:\n${run.stdout}${run.stderr}`);
	assert.equal(run.stdout.trim(), "5");
});
