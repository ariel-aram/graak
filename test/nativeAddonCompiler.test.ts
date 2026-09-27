import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BinaryPackager, NativeAddonCompiler, TargetDevice } from "../dist/index.js";

const hasGcc = spawnSync("gcc", ["--version"]).status === 0;
const fixture = join(process.cwd(), "test/fixtures/napi/addon.c");
const runScript = join(process.cwd(), "test/fixtures/napi/run.js");

test("a dependency that ships only binding.gyp and .c source (no prebuilt .node for any platform) is compiled from source and runs with no Node.js", {
	skip: !hasGcc && "gcc is not installed",
	timeout: 300_000,
}, async () => {
	// The oracle: the same Node-API source, compiled directly and run under real Node.js. This is the
	// baseline every other addon test in this repo compares against.
	const oracleDir = mkdtempSync(join(tmpdir(), "graak-srcaddon-oracle-"));
	const oracleAddon = join(oracleDir, "addon.node");
	const build = spawnSync(
		"gcc",
		[
			"-shared",
			"-fPIC",
			"-O1",
			"-I",
			join(process.cwd(), "quickjs/native/include"),
			"-o",
			oracleAddon,
			fixture,
			"-lpthread",
		],
		{ encoding: "utf-8" }
	);
	assert.equal(build.status, 0, build.stderr);
	copyFileSync(runScript, join(oracleDir, "run.js"));
	const expected = spawnSync(process.execPath, [join(oracleDir, "run.js")], { cwd: oracleDir, encoding: "utf-8" });
	assert.equal(expected.status, 0, `Node baseline failed: ${expected.stderr}`);

	// The project under test: a dependency with a binding.gyp and .c source next to it, and no
	// build/Release anywhere -- exactly what a package looks like right after being cloned or vendored
	// without ever having been through `npm install`'s node-gyp step.
	const root = mkdtempSync(join(tmpdir(), "graak-srcaddon-project-"));
	const pkg = join(root, "node_modules/gyp-fixture");
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "gyp-bot", dependencies: { "gyp-fixture": "1" } }));
	writeFileSync(
		join(pkg, "package.json"),
		JSON.stringify({ name: "gyp-fixture", version: "1.0.0", main: "index.js", gypfile: true })
	);
	writeFileSync(join(pkg, "index.js"), 'module.exports = require("./build/Release/addon.node");');
	writeFileSync(join(pkg, "binding.gyp"), "{ 'targets': [ { 'target_name': 'addon', 'sources': [ 'addon.c' ] } ] }");
	copyFileSync(fixture, join(pkg, "addon.c"));

	const script = readFileSync(runScript, "utf-8").replace('require("./addon.node")', 'require("gyp-fixture")');
	writeFileSync(join(root, "index.js"), script);

	const result = await BinaryPackager.compile({
		entrypoint: join(root, "index.js"),
		target: TargetDevice.LinuxModernX64,
		packageManager: "npm",
		offline: true,
	});
	assert.equal(result.strategy, "quickjs");
	assert.ok(
		result.warnings.some((w) => /gyp-fixture ships only source/.test(w)),
		`expected a warning about compiling from source, got: ${result.warnings.join(" | ")}`
	);

	const built = join(result.outputPath, "app/node_modules/gyp-fixture/build/Release/addon.node");
	assert.ok(existsSync(built), "the compiled addon was placed where the package's own index.js loads it");

	const run = spawnSync(result.launcherPath, [], { cwd: result.outputPath, encoding: "utf-8", timeout: 60_000 });
	assert.equal(run.status, 0, run.stderr);
	assert.equal(run.stdout.trim(), expected.stdout.trim(), "the host must produce what Node.js produces");
});

test("a target with no C toolchain wired up says exactly that, not a linker error", () => {
	const root = mkdtempSync(join(tmpdir(), "graak-srcaddon-notool-"));
	writeFileSync(join(root, "binding.gyp"), "{ 'targets': [ { 'target_name': 'addon', 'sources': [ 'addon.c' ] } ] }");
	copyFileSync(fixture, join(root, "addon.c"));

	assert.throws(
		() =>
			NativeAddonCompiler.build({
				addon: { archiveDir: "node_modules/gyp-fixture", sourceDir: root, name: "gyp-fixture" },
				target: TargetDevice.DarwinArm64,
			}),
		/gyp-fixture ships only source.*not wired up for.*yet/s
	);
});
