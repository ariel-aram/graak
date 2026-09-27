#!/usr/bin/env node
/**
 * Rebuilds everything under quickjs/prebuilt/: the native hosts (one gzip per build target, plus a
 * manifest carrying the digest of the sources they came from) and the Windows 7 compatibility DLLs.
 *
 * Run it after any change under quickjs/native/ or quickjs/winxp-compat.patch, with `pnpm build` done
 * and the cross toolchains on PATH (musl.cc x86_64/i686 cross compilers, mingw-w64):
 *
 *   node tools/build-prebuilts.js [buildTarget...]
 *
 * `test/prebuilt.test.ts` fails while the committed manifest does not match the sources.
 */
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { gzipSync } = require("node:zlib");
const { NodeRuntime, QuickJsPackager, Win7Compat } = require("../dist/index.js");

const root = resolve(__dirname, "..");
const out = join(root, "quickjs/prebuilt");
const hostsDir = join(out, "hosts");
mkdirSync(hostsDir, { recursive: true });

const wanted = process.argv.slice(2);
const targets = wanted.length ? wanted : QuickJsPackager.hostBuildTargets();
const sourceHash = QuickJsPackager.nativeSourceHash(root);
const manifestPath = join(hostsDir, "manifest.json");
const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf-8")) : null;
// Hosts built from other sources than this one are stale, so they are all rebuilt unless asked for one.
const hosts = previous && previous.sourceHash === sourceHash ? previous.hosts : {};

for (const target of targets) {
	const cacheDir = join(NodeRuntime.cacheDir(), "native-host", target);
	const exeName = target.startsWith("win-") ? "graak-c.exe" : "graak-c";
	rmSync(join(cacheDir, exeName), { force: true });
	console.log(`[prebuilt] building ${target}`);
	const exe = QuickJsPackager.compileHost(root, target, cacheDir, console.log);
	const bytes = readFileSync(exe);
	const gz = gzipSync(bytes, { level: 9 });
	writeFileSync(join(hostsDir, `${target}.gz`), gz);
	hosts[target] = {
		file: `${target}.gz`,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		size: bytes.length,
	};
	console.log(`[prebuilt] ${target}: ${bytes.length} -> ${gz.length} bytes`);
}
writeFileSync(manifestPath, `${JSON.stringify({ sourceHash, hosts }, null, "\t")}\n`);

if (!wanted.length) {
	const shimHash = Win7Compat.shimSourceHash(root);
	for (const [arch, folder] of [
		["x64", "x64"],
		["x86", "x86"],
	]) {
		const dir = join(out, "win-compat", folder);
		mkdirSync(dir, { recursive: true });
		const res = spawnSync("sh", [join(root, "quickjs/native/win-compat/build.sh"), arch, dir], { stdio: "inherit" });
		if (res.status !== 0) throw new Error(`building the Windows 7 compatibility DLLs for ${arch} failed`);
		writeFileSync(join(dir, ".source"), shimHash);
	}
}
console.log("[prebuilt] done");
