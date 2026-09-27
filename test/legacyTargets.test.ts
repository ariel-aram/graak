import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	ALL_TARGETS,
	BinaryPackager,
	createLauncherSource,
	PortablePackager,
	TARGET_METADATA_MAP,
	TargetDevice,
} from "../dist/index.js";

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "graak-legacy-"));
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "legacy-bot" }));
	writeFileSync(join(root, "src/index.js"), 'console.log("ok");');
	return root;
}

async function buildPortable(target: TargetDevice) {
	const root = fixture();
	const result = await BinaryPackager.compile({
		entrypoint: join(root, "src/index.js"),
		target,
		strategy: "portable",
		packageManager: "npm",
		offline: true,
	});
	return { result, boot: readFileSync(join(result.outputPath, "boot.cjs"), "utf-8") };
}

test("every legacy and 32-bit target gets the native shim and the SIMD opt-out", async () => {
	// Not WinXpX86: it now defaults to the Graak native host, which produces no boot.cjs at
	// all (see quickJsPackager.test.ts). WinX86 is equally 32-bit and still on the Node.js path
	// these flags apply to. IosIshX86 and LinuxX86 stay here too, for the same reason.
	for (const target of [TargetDevice.WinX86, TargetDevice.IosIshX86, TargetDevice.LinuxX86]) {
		const { boot } = await buildPortable(target);
		assert.match(boot, /installGraakNativeShim/, `${target}: native shim must be installed`);
		assert.match(boot, /UNDICI_NO_WASM_SIMD/, `${target}: old CPUs need undici's SIMD parser disabled`);
		assert.match(boot, /"simdUnsafe":true/, `${target}: simdUnsafe flag must be set from the target metadata`);
	}
});

test("Windows XP counts as legacy Windows even though its id has no 'legacy' in it", () => {
	// Direct createLauncherSource rather than buildPortable: WinXpX86 now defaults to the
	// Graak native host (no boot.cjs at all), but the classification this test checks --
	// that XP's metadata carries os:"windows-legacy" despite the id containing no "legacy" --
	// is a property of the target's metadata, not of which backend happens to package it.
	const meta = TARGET_METADATA_MAP[TargetDevice.WinXpX86];
	const boot = createLauncherSource({
		name: "bot",
		entry: "index.js",
		hash: "0".repeat(64),
		minNode: null,
		target: TargetDevice.WinXpX86,
		mode: "portable",
		windowsLegacy: meta.os === "windows-legacy",
		simdUnsafe: meta.is32BitOrLegacy,
		nativeShim: meta.is32BitOrLegacy,
		bunCompat: false,
		legacyPolyfills: null,
	});
	assert.match(boot, /"windowsLegacy":true/);
	assert.match(boot, /use-system-ca/, "the outdated-certificate-store warning must apply to XP too");
});

test("modern 64-bit targets carry none of the legacy workarounds", async () => {
	// Not LinuxModernX64: that target now runs on the Graak native host and produces no
	// boot.cjs at all (see quickJsPackager.test.ts). LinuxModernArm64 is equally modern and still
	// on the Node.js portable path this test is checking.
	const { boot } = await buildPortable(TargetDevice.LinuxModernArm64);
	assert.doesNotMatch(boot, /installGraakNativeShim/);
	assert.match(boot, /"simdUnsafe":false/);
	assert.match(boot, /"windowsLegacy":false/);
});

test("launcher flags are derived from metadata for every target", () => {
	for (const target of ALL_TARGETS) {
		const meta = TARGET_METADATA_MAP[target];
		const source = createLauncherSource({
			name: "bot",
			entry: "index.js",
			hash: "0".repeat(64),
			minNode: null,
			target,
			mode: "portable",
			windowsLegacy: meta.os === "windows-legacy",
			simdUnsafe: meta.is32BitOrLegacy,
			nativeShim: meta.is32BitOrLegacy,
			bunCompat: false,
			legacyPolyfills: null,
		});
		assert.equal(
			/installGraakNativeShim/.test(source),
			meta.is32BitOrLegacy,
			`${target}: shim presence must follow is32BitOrLegacy`
		);
	}
});

test("the Bun compatibility layer is independent of the target's legacy status", () => {
	for (const target of [TargetDevice.LinuxModernX64, TargetDevice.WinXpX86]) {
		const meta = TARGET_METADATA_MAP[target];
		const source = createLauncherSource({
			name: "bot",
			entry: "index.js",
			hash: "0".repeat(64),
			minNode: null,
			target,
			mode: "portable",
			windowsLegacy: meta.os === "windows-legacy",
			simdUnsafe: meta.is32BitOrLegacy,
			nativeShim: meta.is32BitOrLegacy,
			bunCompat: true,
			legacyPolyfills: null,
		});
		assert.match(source, /installGraakBunCompat/, `${target}: bunCompat must install regardless of legacy status`);
	}
});

test("the Windows launcher finds node without where.exe, which Windows XP lacks", () => {
	const cmd = PortablePackager.windowsLauncher();
	assert.doesNotMatch(cmd, /\bwhere\b/, "where.exe does not exist on Windows XP");
	assert.match(cmd, /%~\$PATH:i/, "PATH lookup must use the cmd.exe expansion available since NT 4");
	assert.match(cmd, /\r\n/, "Windows batch files need CRLF line endings");
});
