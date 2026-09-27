import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BinaryPackager, DenoBundler, TargetDevice } from "../dist/index.js";

/**
 * A Go shared library built with `go build -buildmode=c-shared` exports plain C ABI functions (cgo's own
 * `_cgo_`-prefixed runtime glue stays internal to the library; what the caller sees at the exported symbols is
 * ordinary C). That is exactly the shape Graak's Deno.dlopen already loads and calls through libffi
 * (quickjs/runtime/deno-ffi.js on quickjs/native/fg_ffi.c) for a C library, so this suite checks the claim
 * directly instead of assuming it:
 *
 *   1. A hand-written C library exporting the same three symbols as test/fixtures/go/lib.go (`add`, `greet`,
 *      `freeString`, extern "C", no name mangling) proves the FFI mechanism itself, with no Go toolchain needed.
 *   2. When `go` is on PATH, the same fixture script is also run against a real cgo `-buildmode=c-shared` build,
 *      once under real Deno and once packaged by Graak (native engine), and the two transcripts must match.
 *
 * Neither test touches quickjs/native/fg_ffi.c: it already loads any shared library and calls any C-ABI symbol
 * by name and declared type, which is all a Go c-shared export needs.
 */
const fixtures = join(import.meta.dirname, "fixtures", "go");
const hasGo = spawnSync("go", ["version"]).status === 0;
const hasGcc = spawnSync("gcc", ["--version"]).status === 0;
const hasDeno = DenoBundler.isAvailable();

function workspace(): { dir: string; entry: string } {
	const dir = mkdtempSync(join(tmpdir(), "graak-go-ffi-"));
	writeFileSync(join(dir, "deno.json"), JSON.stringify({ unstable: ["ffi"] }));
	copyFileSync(join(fixtures, "ffi.ts"), join(dir, "ffi.ts"));
	return { dir, entry: join(dir, "ffi.ts") };
}

function buildMimic(dir: string): string {
	const out = join(dir, "libmimic.so");
	const res = spawnSync("gcc", ["-shared", "-fPIC", "-O1", "-o", out, join(fixtures, "mimic.c")], {
		encoding: "utf-8",
	});
	assert.equal(res.status, 0, res.stderr);
	return out;
}

function buildGoLib(dir: string): string {
	const out = join(dir, "libgotest.so");
	const res = spawnSync("go", ["build", "-buildmode=c-shared", "-o", out, join(fixtures, "lib.go")], {
		encoding: "utf-8",
		env: { ...process.env, CGO_ENABLED: "1", GOCACHE: join(dir, "gocache") },
	});
	assert.equal(res.status, 0, res.stderr);
	return out;
}

function launcher(out: string): string {
	if (statSync(out).isFile()) return out;
	const name = readdirSync(out).find(
		(f: string) => !["app", "runtime", "graak-c", "graak-c.exe"].includes(f) && !f.endsWith(".cmd")
	);
	assert.ok(name, `no launcher in ${out}`);
	return join(out, name);
}

function underDeno(entry: string, cwd: string, args: string[]) {
	const run = spawnSync("deno", ["run", "-A", entry, ...args], { cwd, encoding: "utf-8", timeout: 120_000 });
	return { stdout: run.stdout, stderr: run.stderr, status: run.status };
}

function underGraak(out: string, cwd: string, args: string[]) {
	const run = spawnSync(launcher(out), args, { cwd, encoding: "utf-8", timeout: 120_000 });
	return { stdout: run.stdout, stderr: run.stderr, status: run.status };
}

async function build(entry: string, out: string) {
	return BinaryPackager.compile({
		entrypoint: entry,
		target: TargetDevice.LinuxModernX64,
		packageManager: "deno",
		offline: true,
		output: out,
	});
}

test("Graak's Deno.dlopen/FFI path loads and calls a hand-written cgo-shaped C library (no Go toolchain needed)", {
	skip: (!hasDeno && "deno is not installed") || (!hasGcc && "gcc is not installed"),
}, async () => {
	const { dir, entry } = workspace();
	const lib = buildMimic(dir);
	const expected = underDeno(entry, dir, [lib]);
	assert.equal(expected.status, 0, expected.stderr);
	const out = join(dir, "out");
	const result = await build(entry, out);
	assert.ok(
		result.warnings.some((w: string) => /Deno FFI/.test(w) && /dynamically linked/.test(w)),
		result.warnings.join("\n")
	);
	const actual = underGraak(out, dir, [lib]);
	assert.equal(actual.status, 0, actual.stderr);
	assert.equal(actual.stdout, expected.stdout);
	assert.equal(actual.stdout, "add 42\ngreet Hello, Graak!\nadd again 0\n");
});

test("a real Go -buildmode=c-shared library loads and calls the same way under Graak as under real Deno", {
	skip: (!hasGo && "go is not installed") || (!hasDeno && "deno is not installed"),
	timeout: 300_000,
}, async () => {
	const { dir, entry } = workspace();
	const lib = buildGoLib(dir);
	const expected = underDeno(entry, dir, [lib]);
	assert.equal(expected.status, 0, expected.stderr);
	const out = join(dir, "out");
	await build(entry, out);
	const actual = underGraak(out, dir, [lib]);
	assert.equal(actual.status, 0, actual.stderr);
	assert.equal(actual.stdout, expected.stdout);
	assert.equal(actual.stdout, "add 42\ngreet Hello, Graak!\nadd again 0\n");
});
