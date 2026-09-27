import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LegacyTranspiler, Prebuilt, QuickJsPackager, spawnOutput, Win7Compat } from "../dist/index.js";

const root = join(import.meta.dirname, "..");

test("every native host has a prebuilt copy built from the sources on disk", () => {
	const sourceHash = QuickJsPackager.nativeSourceHash(root);
	const manifest = Prebuilt.manifest(root);
	assert.ok(manifest, "quickjs/prebuilt/hosts/manifest.json is missing");
	assert.equal(
		manifest.sourceHash,
		sourceHash,
		"quickjs/native changed since the prebuilt hosts were built: run `pnpm build && node tools/build-prebuilts.js`"
	);
	for (const target of QuickJsPackager.hostBuildTargets()) {
		const bytes = Prebuilt.host(root, target, sourceHash);
		assert.ok(bytes, `no valid prebuilt host for ${target}`);
		assert.ok(bytes.length > 1_000_000, `${target} host looks truncated`);
		const magic = bytes.subarray(0, 4);
		if (target.startsWith("win-")) assert.equal(magic.subarray(0, 2).toString("latin1"), "MZ");
		else assert.equal(magic.toString("latin1"), "\x7fELF");
	}
});

test("a stale manifest is not trusted", () => {
	assert.equal(Prebuilt.host(root, "linux-x64", "0".repeat(64)), null);
	assert.equal(Prebuilt.host(root, "no-such-target", QuickJsPackager.nativeSourceHash(root)), null);
});

test("the Windows 7 compatibility DLLs ship prebuilt, so building them needs no shell", () => {
	const hash = Win7Compat.shimSourceHash(root);
	for (const arch of ["x64", "x86"]) {
		const dir = join(root, "quickjs/prebuilt/win-compat", arch);
		assert.equal(readFileSync(join(dir, ".source"), "utf-8"), hash, `${arch} DLLs are older than their sources`);
		for (const name of Win7Compat.shimNames()) assert.ok(existsSync(join(dir, name)), `${arch}/${name}`);
	}
	assert.equal(Win7Compat.ensureShims("x64"), join(root, "quickjs/prebuilt/win-compat/x64"));
	assert.equal(Win7Compat.ensureShims("ia32"), join(root, "quickjs/prebuilt/win-compat/x86"));
});

test("source digests ignore line endings, as a Windows checkout has CRLF", () => {
	const dir = mkdtempSync(join(tmpdir(), "graak-digest-"));
	writeFileSync(join(dir, "lf.c"), "int a;\nint b;\n");
	writeFileSync(join(dir, "crlf.c"), "int a;\r\nint b;\r\n");
	assert.equal(Prebuilt.digest([["x.c", join(dir, "lf.c")]]), Prebuilt.digest([["x.c", join(dir, "crlf.c")]]));
});

test("a program that cannot be started reports why instead of throwing", () => {
	const result = spawnSync("graak-no-such-program", [], { encoding: "utf-8" });
	assert.equal(result.stderr, undefined);
	assert.doesNotThrow(() => spawnOutput(result));
	assert.match(spawnOutput(result), /graak-no-such-program/);
	assert.equal(spawnOutput({ status: 3, signal: null, stderr: "", stdout: "" }), "exit status 3");
	assert.equal(spawnOutput({ status: 1, signal: null, stderr: " boom \n", stdout: "x" }), "boom");
});

test("converted ES modules are cached and a second build reuses them", async () => {
	const cacheDir = mkdtempSync(join(tmpdir(), "graak-esm-cache-"));
	const entries = [
		{ path: "index.mjs", source: Buffer.from("import { a } from './a.mjs';\nconsole.log(a);\n"), mode: 0o644 },
		{ path: "a.mjs", source: Buffer.from("export const a = 1;\n"), mode: 0o644 },
		{ path: "plain.js", source: Buffer.from("module.exports = 1;\n"), mode: 0o644 },
	];
	const first: string[] = [];
	const one = await LegacyTranspiler.toCommonJs(entries, { cacheDir, onLog: (m) => first.push(m) });
	assert.equal(one.converted, 2);
	assert.ok(!first.some((m) => m.includes("conversion cache")));
	const second: string[] = [];
	const two = await LegacyTranspiler.toCommonJs(entries, { cacheDir, onLog: (m) => second.push(m) });
	assert.ok(
		second.some((m) => m.includes("2 from the conversion cache")),
		second.join("\n")
	);
	assert.deepEqual(
		two.entries.map((e) => [e.path, Buffer.from(e.source as Buffer).toString()]),
		one.entries.map((e) => [e.path, Buffer.from(e.source as Buffer).toString()])
	);
});
