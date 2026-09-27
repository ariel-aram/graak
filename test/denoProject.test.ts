import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	BinaryPackager,
	DENO_COMPILE_TARGETS,
	DenoProject,
	PACKAGE_MANAGERS,
	PolicyEnforcer,
	parseJsonc,
	parseNpmSpecifier,
	TargetDevice,
} from "../dist/index.js";

function project(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "graak-denoproj-"));
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(join(root, name, ".."), { recursive: true });
		writeFileSync(join(root, name), text);
	}
	return root;
}

test("deno is a package manager, detected from deno.lock and from deno.json", () => {
	assert.ok((PACKAGE_MANAGERS as readonly string[]).includes("deno"));
	assert.equal(PolicyEnforcer.parsePackageManager("Deno"), "deno");
	assert.equal(PolicyEnforcer.detectPackageManager(project({ "deno.lock": "{}" })), "deno");
	assert.equal(PolicyEnforcer.detectPackageManager(project({ "deno.json": "{}" })), "deno");
	assert.equal(PolicyEnforcer.detectPackageManager(project({ "deno.jsonc": "{ /* c */ }" })), "deno");
	assert.equal(PolicyEnforcer.resolvePackageManager("deno", project({})), "deno");
});

test("a lockfile of another manager beats a bare deno.json, and package.json's declaration beats both", () => {
	// Node projects sometimes keep a deno.json for Deno Deploy.
	assert.equal(PolicyEnforcer.detectPackageManager(project({ "deno.json": "{}", "package-lock.json": "{}" })), "npm");
	assert.equal(PolicyEnforcer.detectPackageManager(project({ "deno.json": "{}", "pnpm-lock.yaml": "" })), "pnpm");
	// deno.lock is Deno's own, and ranks with bun.lock.
	assert.equal(PolicyEnforcer.detectPackageManager(project({ "deno.lock": "{}", "package.json": "{}" })), "deno");
	assert.equal(
		PolicyEnforcer.detectPackageManager(
			project({ "deno.json": "{}", "package.json": JSON.stringify({ packageManager: "pnpm@9.0.0" }) })
		),
		"pnpm"
	);
});

test("deno.jsonc is read with comments and trailing commas", () => {
	assert.deepEqual(parseJsonc('{ // one\n "a": [1, 2,], /* two */ "b": "// not a comment", }'), {
		a: [1, 2],
		b: "// not a comment",
	});
	const root = project({
		"deno.jsonc": `{
  // import map
  "name": "@me/app",
  "version": "1.2.3",
  "imports": { "chalk": "npm:chalk@5", "lib/": "./lib/" },
  "scopes": { "./x/": { "a": "./y.ts" } },
  "compilerOptions": { "jsx": "react-jsx" },
  "nodeModulesDir": "auto",
  "workspace": ["./a", "./b"],
}`,
	});
	const config = DenoProject.readConfig(join(root, "deno.jsonc"));
	assert.equal(config.name, "@me/app");
	assert.equal(config.version, "1.2.3");
	assert.deepEqual(config.imports, { chalk: "npm:chalk@5", "lib/": "./lib/" });
	assert.deepEqual(config.scopes, { "./x/": { a: "./y.ts" } });
	assert.equal(config.compilerOptions.jsx, "react-jsx");
	assert.equal(config.nodeModulesDir, "auto");
	assert.deepEqual(config.workspace, ["./a", "./b"]);
	assert.equal(DenoProject.findConfig(join(root, "sub", "deeper")), join(root, "deno.jsonc"), "found from below");
	assert.equal(DenoProject.findConfig(mkdtempSync(join(tmpdir(), "graak-noconfig-"))), null);
});

test("Graak builds what deno compile cannot: the five targets Deno makes itself, and the rest", () => {
	assert.deepEqual(Object.keys(DENO_COMPILE_TARGETS).sort(), [
		TargetDevice.DarwinArm64,
		TargetDevice.DarwinX64,
		TargetDevice.LinuxModernArm64,
		TargetDevice.LinuxModernX64,
		TargetDevice.WinModernX64,
	]);
	assert.equal(DenoProject.denoTarget(TargetDevice.LinuxModernX64), "x86_64-unknown-linux-gnu");
	assert.equal(DenoProject.denoTarget(TargetDevice.WinModernX64), "x86_64-pc-windows-msvc");
	for (const target of [
		TargetDevice.WinXpX86,
		TargetDevice.WinVistaX64,
		TargetDevice.WinLegacyX64,
		TargetDevice.WinLegacyX86,
		TargetDevice.IosIshX86,
		TargetDevice.LinuxX86,
		TargetDevice.LinuxArmV7,
		TargetDevice.FreeBsdX86,
	]) {
		assert.equal(DenoProject.canDenoCompile(target), false, `${target} is Graak's`);
	}
});

test("npm specifiers from Deno's graph split into package, version and subpath", () => {
	assert.deepEqual(parseNpmSpecifier("npm:/chalk@5.3.0"), { name: "chalk", version: "5.3.0", subpath: "" });
	assert.deepEqual(parseNpmSpecifier("npm:/@scope/pkg@1.0.0-beta.1/lib/x.js"), {
		name: "@scope/pkg",
		version: "1.0.0-beta.1",
		subpath: "/lib/x.js",
	});
	assert.equal(parseNpmSpecifier("https://jsr.io/@std/path/1.0.0/mod.ts"), null);
});

test("a Deno project needs no package.json: the root is where its deno.json is", () => {
	const root = project({ "deno.json": "{}", "src/main.ts": "console.log(1)" });
	assert.equal(BinaryPackager.findRoot(join(root, "src/main.ts")), root);
	const both = project({ "deno.json": "{}", "package.json": "{}", "main.ts": "" });
	assert.equal(BinaryPackager.findRoot(join(both, "main.ts")), both);
});

test("without deno on PATH the build says how to fix it instead of failing obscurely", async () => {
	const root = project({ "deno.json": "{}", "main.ts": "console.log(1)" });
	const saved = process.env.PATH;
	process.env.PATH = mkdtempSync(join(tmpdir(), "graak-nopath-"));
	try {
		await assert.rejects(
			BinaryPackager.compile({ entrypoint: join(root, "main.ts"), target: TargetDevice.LinuxModernX64, offline: true }),
			/'deno' is not on PATH.*https:\/\/deno\.com.*--pm npm/s
		);
	} finally {
		process.env.PATH = saved;
	}
});
