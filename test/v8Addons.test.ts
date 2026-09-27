import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BinaryPackager, isV8Addon, parseGyp, TargetDevice } from "../dist/index.js";

const hasGxx =
	spawnSync("g++", ["--version"]).status === 0 && spawnSync("x86_64-linux-gnu-g++", ["--version"]).status === 0;
const shim = join(process.cwd(), "quickjs/native/v8");
const api = join(process.cwd(), "quickjs/native/include");
const fixtures = join(process.cwd(), "test/fixtures/v8");

test("parseGyp reads what real binding.gyp files contain", () => {
	const gyp = parseGyp(`
# a comment
{
  'variables': { 'enable%': 'yes', },
  "targets": [
    {
      'target_name': 'thing',
      'sources': [ 'a.cc', "b.cc", ],  # trailing comma
      'defines': [ 'ONE=1' 'TWO' ],    # adjacent literals concatenate
      'conditions': [ ['OS=="win"', { 'defines': [ 'WIN' ] }, { 'defines': [ 'POSIX' ] }] ],
      'flag': True, 'n': 3, 'none': None,
    },
  ],
}`);
	const target = (gyp.targets as Array<Record<string, unknown>>)[0];
	assert.equal(target.target_name, "thing");
	assert.deepEqual(target.sources, ["a.cc", "b.cc"]);
	assert.deepEqual(target.defines, ["ONE=1TWO"]);
	assert.equal(target.flag, true);
	assert.equal(target.none, null);
	assert.throws(() => parseGyp("{ 'a': "), /binding\.gyp/);
});

test("isV8Addon tells a V8 binary from a Node-API one", () => {
	const dir = mkdtempSync(join(tmpdir(), "graak-v8sig-"));
	const write = (name: string, text: string) => {
		const file = join(dir, name);
		writeFileSync(file, Buffer.concat([Buffer.from("\x7fELF"), Buffer.from(text)]));
		return file;
	};
	assert.equal(isV8Addon(write("v8.node", "..._ZN2v87Isolate10GetCurrentEv...")), true);
	assert.equal(isV8Addon(write("msvc.node", "?GetCurrent@Isolate@v8@@SAPEAV12@XZ")), true);
	assert.equal(isV8Addon(write("napi.node", "napi_register_module_v1 napi_create_function")), false);
	assert.equal(
		isV8Addon(write("both.node", "_ZN2v8 napi_register_module_v1")),
		false,
		"a Node-API addon wins if it is both"
	);
	assert.equal(isV8Addon(write("plain.node", "just a library")), false);
});

function compileFixture(source: string, out: string, extra: string[] = []): void {
	const res = spawnSync(
		"g++",
		[
			"-std=c++14",
			"-shared",
			"-fPIC",
			"-O1",
			"-fvisibility=hidden",
			"-Wno-attributes",
			`-I${shim}`,
			`-I${api}`,
			...extra,
			"-o",
			out,
			source,
		],
		{ encoding: "utf-8" }
	);
	assert.equal(res.status, 0, res.stderr);
}

test("a package that ships V8 source is rebuilt against Graak's V8 layer and runs with no Node.js", {
	skip: !hasGxx && "g++ (native and x86_64-linux-gnu) is not installed",
	timeout: 600_000,
}, async () => {
	// The fixture uses the V8 API directly: FunctionTemplate, ObjectWrap, Persistent, TryCatch, Buffer,
	// accessors, exceptions. Node.js itself runs the same source, built against the same layer, which is
	// what the host's output is compared to.
	const work = mkdtempSync(join(tmpdir(), "graak-v8-"));
	const oracleAddon = join(work, "oracle.node");
	compileFixture(join(fixtures, "raw.cc"), oracleAddon);
	writeFileSync(
		join(work, "oracle.js"),
		readFileSync(join(fixtures, "raw-run.js"), "utf-8").replace('"./raw.node"', '"./oracle.node"')
	);
	const expected = spawnSync(process.execPath, [join(work, "oracle.js")], { cwd: work, encoding: "utf-8" });
	assert.equal(expected.status, 0, `Node baseline failed: ${expected.stderr}`);

	// A project whose dependency ships a *prebuilt V8 binary* (recognised by its symbols) plus source.
	const root = mkdtempSync(join(tmpdir(), "graak-v8-project-"));
	const pkg = join(root, "node_modules/v8-fixture");
	mkdirSync(join(pkg, "build/Release"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "v8-bot", dependencies: { "v8-fixture": "1" } }));
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "v8-fixture", version: "1.0.0", main: "index.js" }));
	writeFileSync(join(pkg, "index.js"), 'module.exports = require("./build/Release/raw_v8.node");');
	writeFileSync(join(pkg, "binding.gyp"), "{ 'targets': [ { 'target_name': 'raw_v8', 'sources': [ 'raw.cc' ] } ] }");
	copyFileSync(join(fixtures, "raw.cc"), join(pkg, "raw.cc"));
	const elf = Buffer.alloc(64);
	elf.write("\x7fELF", 0, "latin1");
	elf[4] = 2; // 64-bit
	elf[5] = 1; // little-endian
	elf.writeUInt16LE(3, 16); // ET_DYN
	elf.writeUInt16LE(0x3e, 18); // x86-64
	writeFileSync(
		join(pkg, "build/Release/raw_v8.node"),
		Buffer.concat([elf, Buffer.from("_ZN2v87Isolate10GetCurrentEv")])
	);
	writeFileSync(
		join(root, "index.js"),
		readFileSync(join(fixtures, "raw-run.js"), "utf-8").replace('require("./raw.node")', 'require("v8-fixture")')
	);

	const result = await BinaryPackager.compile({
		entrypoint: join(root, "index.js"),
		target: TargetDevice.LinuxModernX64,
		packageManager: "npm",
		offline: true,
	});
	assert.equal(result.strategy, "quickjs");
	assert.ok(result.warnings.some((w) => /compiled against V8.*rebuilt from source/.test(w)));

	const built = join(result.outputPath, "app/node_modules/v8-fixture/build/Release/raw_v8.node");
	assert.ok(existsSync(built));
	const nm = spawnSync("nm", ["-D", "--undefined-only", built], { encoding: "utf-8" }).stdout;
	assert.match(nm, /napi_create_function/, "the rebuilt addon imports Node-API");
	assert.doesNotMatch(nm, /_ZN2v8/, "and nothing from V8 itself, which is why the host can load it");

	const run = spawnSync(result.launcherPath, [], { cwd: result.outputPath, encoding: "utf-8", timeout: 60_000 });
	assert.equal(run.status, 0, run.stderr);
	assert.equal(run.stdout.trim(), expected.stdout.trim(), "the host must produce what Node.js produces");
});

test("a package that ships only a prebuilt V8 binary says exactly that, not a linker error", {
	skip: !hasGxx && "g++ is not installed",
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "graak-v8-nosrc-"));
	const pkg = join(root, "node_modules/binary-only/build/Release");
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "bot", dependencies: { "binary-only": "1" } }));
	writeFileSync(
		join(root, "node_modules/binary-only/package.json"),
		JSON.stringify({ name: "binary-only", version: "1.0.0" })
	);
	const elf = Buffer.alloc(64);
	elf.write("\x7fELF", 0, "latin1");
	elf[4] = 2;
	elf[5] = 1;
	elf.writeUInt16LE(3, 16);
	elf.writeUInt16LE(0x3e, 18);
	writeFileSync(join(pkg, "x.node"), Buffer.concat([elf, Buffer.from("_ZN2v87Isolate10GetCurrentEv")]));
	writeFileSync(join(root, "index.js"), 'require("binary-only");');

	await assert.rejects(
		BinaryPackager.compile({
			entrypoint: join(root, "index.js"),
			target: TargetDevice.LinuxModernX64,
			packageManager: "npm",
			offline: true,
		}),
		/binary-only ships only a prebuilt addon compiled against V8/
	);
});

test("a V8 addon that ships only its binary is rebuilt from the source in its repository", {
	skip: !hasGxx && "g++ (native and x86_64-linux-gnu) is not installed",
	timeout: 600_000,
}, async () => {
	const work = mkdtempSync(join(tmpdir(), "graak-v8fetch-"));
	compileFixture(join(fixtures, "raw.cc"), join(work, "oracle.node"));
	writeFileSync(
		join(work, "oracle.js"),
		readFileSync(join(fixtures, "raw-run.js"), "utf-8").replace('"./raw.node"', '"./oracle.node"')
	);
	const expected = spawnSync(process.execPath, [join(work, "oracle.js")], { cwd: work, encoding: "utf-8" });
	assert.equal(expected.status, 0, expected.stderr);

	// The "repository": a tarball shaped like GitHub's, served from a local mirror.
	const repo = join(work, "widget-1.0.0");
	mkdirSync(repo);
	writeFileSync(join(repo, "binding.gyp"), "{ 'targets': [ { 'target_name': 'raw_v8', 'sources': [ 'raw.cc' ] } ] }");
	copyFileSync(join(fixtures, "raw.cc"), join(repo, "raw.cc"));
	const tarball = join(work, "widget.tar.gz");
	assert.equal(spawnSync("tar", ["-czf", tarball, "-C", work, "widget-1.0.0"]).status, 0);
	// A fresh owner per run keeps a source cached by an earlier run from satisfying this one.
	const owner = `acme${process.pid}${Date.now()}`;
	const requested: string[] = [];
	const server = createServer((req, res) => {
		requested.push(req.url ?? "");
		if (req.url === `/${owner}/widget/tar.gz/v1.0.0`) res.end(readFileSync(tarball));
		else {
			res.statusCode = 404;
			res.end();
		}
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const port = (server.address() as { port: number }).port;

	try {
		const root = mkdtempSync(join(tmpdir(), "graak-v8fetch-project-"));
		const pkg = join(root, "node_modules/widget");
		mkdirSync(join(pkg, "build/Release"), { recursive: true });
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "bot", dependencies: { widget: "1.0.0" } }));
		writeFileSync(
			join(pkg, "package.json"),
			JSON.stringify({
				name: "widget",
				version: "1.0.0",
				main: "index.js",
				repository: { type: "git", url: `git+https://github.com/${owner}/widget.git` },
			})
		);
		writeFileSync(join(pkg, "index.js"), 'module.exports = require("./build/Release/raw_v8.node");');
		const elf = Buffer.alloc(64);
		elf.write("\x7fELF", 0, "latin1");
		elf[4] = 2;
		elf[5] = 1;
		elf.writeUInt16LE(3, 16);
		elf.writeUInt16LE(0x3e, 18);
		writeFileSync(
			join(pkg, "build/Release/raw_v8.node"),
			Buffer.concat([elf, Buffer.from("_ZN2v87Isolate10GetCurrentEv")])
		);
		writeFileSync(
			join(root, "index.js"),
			readFileSync(join(fixtures, "raw-run.js"), "utf-8").replace('require("./raw.node")', 'require("widget")')
		);

		const offline = await BinaryPackager.compile({
			entrypoint: join(root, "index.js"),
			target: TargetDevice.LinuxModernX64,
			packageManager: "npm",
			offline: true,
		}).then(
			() => "built",
			(err: Error) => err.message
		);
		assert.match(offline, /ships only a prebuilt addon compiled against V8/, "offline, nothing may be fetched");
		assert.equal(requested.length, 0);

		const result = await BinaryPackager.compile({
			entrypoint: join(root, "index.js"),
			target: TargetDevice.LinuxModernX64,
			packageManager: "npm",
			v8SourceMirror: `http://127.0.0.1:${port}`,
		});
		assert.ok(requested.includes(`/${owner}/widget/tar.gz/v1.0.0`));
		const run = spawnSync(result.launcherPath, [], { cwd: result.outputPath, encoding: "utf-8", timeout: 60_000 });
		assert.equal(run.status, 0, run.stderr);
		assert.equal(run.stdout.trim(), expected.stdout.trim());
	} finally {
		server.close();
	}
});

test("V8 property interceptors work, as a Proxy over the plain object", {
	skip: !hasGxx && "g++ (native and x86_64-linux-gnu) is not installed",
	timeout: 300_000,
}, async () => {
	// The interceptors of a template have no Node-API equivalent, so the object is handed out behind a
	// Proxy whose traps call them. Expectations are V8's documented semantics: a callback that sets no
	// return value declines and the access falls through to the plain object.
	const work = mkdtempSync(join(tmpdir(), "graak-interceptors-"));
	compileFixture(join(fixtures, "interceptors.cc"), join(work, "interceptors.node"));
	copyFileSync(join(fixtures, "interceptors-run.js"), join(work, "run.js"));

	const { QuickJsPackager } = await import("../dist/index.js");
	const host = await QuickJsPackager.ensureNativeHost(TargetDevice.LinuxModernX64, "glibc");
	const run = spawnSync(host, [join(process.cwd(), "quickjs/runtime/node-compat.js"), join(work, "run.js")], {
		cwd: work,
		encoding: "utf-8",
		timeout: 60_000,
	});
	assert.equal(run.status, 0, run.stderr);
	assert.deepEqual(JSON.parse(run.stdout), {
		get: ["bar", "3", null],
		has: [true, false],
		keys: ["count", "foo"],
		declined: ["declined", true, 2],
		index: [9, 81, null],
		delete: [true, false, null, 1],
		proto: [true, "function", true],
		json: '{"_plain":"declined","count":"3"}',
	});
});

// NAN itself is not a dependency of this repository, so this runs only where it is installed
// (GRAAK_NAN_DIR, or a `nan` in node_modules).
const nanDir =
	process.env.GRAAK_NAN_DIR ??
	(existsSync(join(process.cwd(), "node_modules/nan/nan.h")) ? join(process.cwd(), "node_modules/nan") : "");

test("a NAN addon compiles against the V8 layer and behaves as it does under Node.js", {
	skip: (!hasGxx && "g++ is not installed") || (!nanDir && "NAN is not installed (set GRAAK_NAN_DIR)"),
	timeout: 300_000,
}, async () => {
	const work = mkdtempSync(join(tmpdir(), "graak-nan-"));
	const addon = join(work, "nan.node");
	compileFixture(join(fixtures, "nan.cc"), addon, [`-I${nanDir}`]);
	writeFileSync(join(work, "run.js"), readFileSync(join(fixtures, "nan-run.js"), "utf-8"));
	const expected = spawnSync(process.execPath, [join(work, "run.js")], { cwd: work, encoding: "utf-8" });
	assert.equal(expected.status, 0, expected.stderr);

	const { QuickJsPackager } = await import("../dist/index.js");
	const host = await QuickJsPackager.ensureNativeHost(TargetDevice.LinuxModernX64, "glibc");
	const run = spawnSync(host, [join(process.cwd(), "quickjs/runtime/node-compat.js"), join(work, "run.js")], {
		cwd: work,
		encoding: "utf-8",
		timeout: 60_000,
	});
	assert.equal(run.status, 0, run.stderr);
	assert.equal(run.stdout.trim(), expected.stdout.trim());
});
