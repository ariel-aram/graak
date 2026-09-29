#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { BinaryInspector } from "./compiler/BinaryInspector";
import { BinaryPackager, type BuildEngine, type BuildStrategy } from "./compiler/BinaryPackager";
import { DENO_COMPILE_TARGETS, DenoProject } from "./compiler/DenoProject";
import { PolicyEnforcer } from "./compiler/PolicyEnforcer";
import { QuickJsPackager } from "./compiler/QuickJsPackager";
import { RuntimeRegistry } from "./compiler/RuntimeRegistry";
import { generateWasmShim } from "./compiler/WasmShimGenerator";
import { ExtensionRegistry } from "./integrations/ExtensionRegistry";
import { FORGEDB_DRIVERS, type ForgeDBDriver, ForgeDBIntegration } from "./integrations/ForgeDBIntegration";
import { ALL_TARGETS, getTargetMetadata, parseTargetDevice, TARGET_METADATA_MAP } from "./structures/TargetDevice";

const VERSION: string = require("../package.json").version;

const HELP = `Graak ${VERSION} - standalone executables for JavaScript and TypeScript programs, on every device

Usage:
  graak compile <entrypoint.js | site-folder> --target <target> [options]
  graak targets [--pm <package manager>]
  graak info <target> [--db <driver>]
  graak extensions
  graak inspect <file>
  graak wasm-shim <file.wasm> [-o out.js]
  graak runtimes list [--target <target>]
  graak runtimes add <target> <version> <url> --sha256 <hex> [--notes <text>] [--global]
  graak runtimes remove <target> <version> [--global]
  graak version

Compile options:
  -t, --target <name>        Target device (see 'graak targets')
  -o, --output <path>        Output file (single file) or directory (folder)
  -e, --engine <name>        auto (default, follows the target), native (Graak's own host) or node.
                              With native host targets, --strategy sea writes ONE executable that runs in place and
                              portable a folder
      --intl <mode>          Locale data for Intl on the Graak engine (about 7 MB): auto (default, ships it
                              when the program mentions Intl, toLocale*String or localeCompare), all or none
      --no-trim              Graak engine: ship every collected file instead of only the ones the program
                              can load (docs, type declarations, tests, unused packages and other
                              platforms' binaries are left out by default)
  -s, --strategy <name>      auto (default), sea (single executable) or portable (folder bundle).
                              sea writes a single standalone executable on native targets without Node.js.
                              portable opts back onto Node.js (or folder layout with --engine native)
      --pm <name>            Package manager override (bun, deno, pnpm, npm, yarn)
      --node-binary <path>   Node.js runtime to use instead of the target's default. Also opts a
                              native-host target (below) back onto Node.js
      --node-version <ver>   Official Node.js version to download (e.g. 22 or 22.11.0)
      --ucrt-dir <dir>       Windows SDK Redist\\ucrt\\DLLs\\<arch> folder to ship app-local, for addons
                             that need the Universal C Runtime on Windows 7 (sharp/libvips do)
      --native-libc <name>   musl (default) or glibc, for targets that build the Graak
                              native host. musl runs unmodified on both glibc and musl systems
                              (Alpine included); glibc is only wired up for linux-modern-x64
      --static               Treat the entrypoint as a folder of built static files and serve it
                             (also automatic when it is a directory or an .html file)
      --spa                  Static site: answer unknown page routes with index.html (client-side routing)
      --port <n>             Static site: default port (PORT and --port at run time override it). 8080
      --host <addr>          Static site: interface to listen on. Default 0.0.0.0
      --index <file>         Static site: entry page. Default index.html
      --offline              Never download runtimes
      --include-dev          Bundle devDependencies too
      --include-env          Bundle .env files (they usually contain secrets such as tokens)
      --allow-native-mismatch  Build even when native addons are built for another platform (a
                              trimmed Graak-engine build leaves those binaries out; --no-trim keeps them)
  -h, --help                 Show this help

Most targets default to the Graak native host (quickjs-ng + quickjs/native/), not Node.js:
every legacy Windows target (XP, Vista, "Legacy" 7), iSH, 32-bit Linux, and linux-modern-x64.
No Node.js binary is involved anywhere in that output. Native (.node) addons load there too: the
host implements Node-API itself. A static host cannot dlopen, so a program that needs an addon gets the
dynamically linked build (glibc on Linux) automatically. Addons compiled against V8 or NAN are
rebuilt from their source against Graak's V8 layer for the target (no source, no rebuild). Pass --node-binary, --engine node,
--strategy portable, or register a runtime with 'graak runtimes add', to opt a specific build back
onto Node.js instead.

Targets still on Node.js (win-x86, win-modern-x64, linux-armv7, linux-modern-arm64, darwin-x64,
darwin-arm64, freebsd-x86) handle the runtime automatically:
  - iSH, FreeBSD          : (only reached via an explicit opt-out on iSH) the compiled
                            executable installs Node.js itself on first run, using the
                            device's own package manager (apk / pkg).
  - Windows 7 / Vista     : (only reached via an explicit opt-out) Node.js 12.22.12 / 5.12.0
                            respectively, downloaded and checksum-verified automatically; see
                            'graak info win-legacy-x86' / 'win-vista-x86'.

Targeting a runtime older than Node.js 20 also rewrites the program so it can run there at all:
bundled code is lowered to that runtime's language level, ES modules are converted to
CommonJS, the missing platform APIs (Web Streams, AbortController, structuredClone, the
'node:' prefix, ...) are polyfilled at startup, and esbuild's WebAssembly build is shipped so
code the program generates at runtime can be lowered on the device. Things that cannot be done
correctly are refused rather than faked: Intl.Segmenter throws on these targets instead of
mis-splitting emoji. Your node_modules on disk is never modified.
`;

function fail(message: string): never {
	console.error(`Error: ${message}`);
	process.exit(1);
}

async function main(): Promise<void> {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse();
	} catch (err) {
		fail(err instanceof Error ? err.message : String(err));
	}
	const { values, positionals } = parsed;
	const [command, arg] = positionals;

	if (values.help || !command || command === "help") {
		console.log(HELP);
		return;
	}

	switch (command) {
		case "version":
			console.log(`graak ${VERSION}`);
			return;

		case "targets": {
			const pm = PolicyEnforcer.resolvePackageManager(values.pm);
			console.log(`Targets available for ${pm}:`);
			for (const target of PolicyEnforcer.getAllowedTargets(pm)) {
				const meta = TARGET_METADATA_MAP[target];
				const tag = meta.is32BitOrLegacy ? "[32-bit/legacy]" : "[modern 64-bit]";
				const runtime = meta.officialNodeFile
					? "sea, official"
					: meta.bootstrapInstall
						? "portable, auto-installs on device"
						: meta.pinnedLegacyNode
							? `portable, auto (Node ${meta.pinnedLegacyNode.version})`
							: "portable, --node-binary required";
				console.log(`  ${target.padEnd(20)} ${tag.padEnd(16)} ${meta.name.padEnd(32)} ${runtime}`);
			}
			if (pm === "deno") {
				const own = Object.entries(DENO_COMPILE_TARGETS)
					.map(([id]) => id)
					.join(", ");
				console.log(
					"\nDeno projects: every target above is available. Graak reads Deno's own module graph (import map, jsr:, npm: and " +
						"https: imports, top-level await) and provides the Deno namespace, so 'deno' must be on PATH at build time only. " +
						`'deno compile' builds ${own} itself; Graak is the way to build the rest (32-bit systems, Windows XP, Vista and 7, ` +
						"iSH, ARMv7, FreeBSD) and to make one file with no Deno on the device."
				);
			}
			if (pm === "bun") {
				console.log(
					"\nBun projects: every target above is available. TypeScript/JSX entrypoints are transpiled " +
						"automatically with 'bun build' (packages stay external, so your installed node_modules are " +
						"used). bun:sqlite and common Bun globals (env, file, write, serve, sleep, which) work in the " +
						"compiled executable through a Node.js compatibility layer; run 'graak compile --help' " +
						"for details, or use 'bun build --compile' directly if you only need a modern 64-bit binary."
				);
			}
			return;
		}

		case "extensions": {
			console.log(
				"ForgeScript extensions and compatibility matrix (Graak works without ForgeScript; this only reads what the project uses):"
			);
			for (const ext of ExtensionRegistry.listExtensions()) {
				console.log(`\n  ${ext.name.padEnd(16)} [${ext.package}]`);
				console.log(`    Description: ${ext.description}`);
				console.log(`    Legacy safe: ${ext.legacySafe ? "yes (polyfilled/pure-js)" : "no"}`);
				console.log(`    Notes      : ${ext.notes}`);
			}
			return;
		}

		case "info": {
			const meta = getTargetMetadata(arg);
			if (!meta) fail(`Unknown target '${arg ?? ""}'. Supported: ${ALL_TARGETS.join(", ")}`);
			console.log(`${meta.name}`);
			console.log(`  ID             : ${meta.id}`);
			console.log(`  Architecture   : ${meta.arch} (${meta.bits}-bit)`);
			console.log(`  OS             : ${meta.os}`);
			console.log(`  Binary format  : ${meta.binaryFormat}`);
			console.log(`  32-bit/legacy  : ${meta.is32BitOrLegacy ? "yes" : "no"}`);
			const native = QuickJsPackager.supports(meta.id);
			console.log(`  Engine         : ${native ? "Graak native host (quickjs-ng), no Node.js bundled" : "Node.js"}`);
			console.log(`  Official Node  : ${meta.officialNodeFile ?? "none"}`);
			const denoTarget = DenoProject.denoTarget(meta.id);
			console.log(
				`  Deno compile   : ${denoTarget ? `deno compile --target ${denoTarget} builds this itself` : "cannot build this target: Graak does"}`
			);
			if (meta.pinnedLegacyNode) {
				console.log(
					`  ${native ? "Node fallback " : "Pinned runtime"} : Node.js ${meta.pinnedLegacyNode.version} (${meta.pinnedLegacyNode.fileKey}), auto-fetched${native ? " (only with --node-binary, --engine node or --strategy portable)" : ""}`
				);
			}
			if (meta.bootstrapInstall) {
				console.log(`  Auto-install   : ${meta.bootstrapInstall.command.join(" ")} (on-device, on first run)`);
			}
			console.log(`  ${native ? "Fallback note " : "Runtime       "} : ${meta.runtimeHint}`);
			console.log(`  Description    : ${meta.description}`);
			if (meta.pinnedLegacyNode) {
				console.log(`\n  ${native ? "Warning (Node.js fallback only)" : "Warning"}: ${meta.pinnedLegacyNode.warning}`);
			}
			if (values.db) {
				const driver = ForgeDBIntegration.parseDriver(values.db);
				if (!driver)
					fail(`Unknown ForgeDB driver '${values.db}'. Supported: ${Object.keys(FORGEDB_DRIVERS).join(", ")}`);
				const res = ForgeDBIntegration.checkDriver(driver as ForgeDBDriver, meta.id);
				console.log(`  ForgeDB ${driver.padEnd(7)}: ${res.compatible ? "compatible" : "incompatible"} (${res.reason})`);
				if (!res.compatible) {
					const alt = ForgeDBIntegration.suggestAlternative(driver as ForgeDBDriver);
					if (alt) console.log(`  Suggested driver: ${alt}`);
				}
			}
			return;
		}

		case "inspect": {
			if (!arg) fail("Please provide a file to inspect");
			const info = BinaryInspector.inspect(arg);
			if (!info) fail(`'${arg}' is not an ELF, PE or Mach-O binary`);
			console.log(JSON.stringify(info, null, 2));
			const fits = ALL_TARGETS.filter((t) => BinaryInspector.matchesTarget(info, t));
			console.log(`Runs on: ${fits.length ? fits.join(", ") : "no known target"}`);
			return;
		}

		case "wasm-shim": {
			if (!arg) fail("Please provide a .wasm file");
			const bytes = readFileSync(arg);
			const outPath = (values.output as string | undefined) ?? `${arg}.js`;
			const shim = generateWasmShim(bytes, basename(arg));
			if (!shim) {
				fail(
					`'${arg}' imports something besides WASI (an arbitrary "env" object), so no shim can be generated ` +
						"automatically -- write the loader by hand and supply that import object yourself."
				);
			}
			writeFileSync(outPath, shim as string);
			console.log(`Wrote ${outPath}`);
			return;
		}

		case "runtimes": {
			const sub = positionals[1];
			const rest = positionals.slice(2);

			if (!sub || sub === "list") {
				const target = rest[0] ? parseTargetDevice(rest[0]) : null;
				if (rest[0] && !target) fail(`Unknown target '${rest[0]}'`);
				const entries = target ? RuntimeRegistry.find(target) : RuntimeRegistry.list();
				if (!entries.length) {
					console.log("No community runtimes registered. Add one with 'graak runtimes add'.");
					return;
				}
				for (const e of entries) {
					console.log(`${e.target.padEnd(20)} ${e.version.padEnd(12)} ${e.url}`);
					console.log(`  sha256: ${e.sha256}${e.notes ? `\n  notes : ${e.notes}` : ""}`);
				}
				return;
			}

			if (sub === "add") {
				const [targetInput, version, url] = rest;
				if (!targetInput || !version || !url) {
					fail("Usage: graak runtimes add <target> <version> <url> --sha256 <hex> [--notes <text>] [--global]");
				}
				const target = parseTargetDevice(targetInput);
				if (!target) fail(`Unknown target '${targetInput}'`);
				if (!values.sha256) {
					fail("--sha256 <hex> is required: Graak never downloads a community runtime without a pinned checksum");
				}
				try {
					RuntimeRegistry.add(
						{
							target,
							version,
							url,
							sha256: values.sha256,
							notes: values.notes,
						},
						{ global: values.global }
					);
				} catch (err) {
					fail(err instanceof Error ? err.message : String(err));
				}
				console.log(
					`Registered Node.js ${version} for ${target}${values.global ? " (global)" : " (project: .graak/runtimes.json)"}.`
				);
				return;
			}

			if (sub === "remove") {
				const [target, version] = rest;
				if (!target || !version) fail("Usage: graak runtimes remove <target> <version> [--global]");
				const removed = RuntimeRegistry.remove(target, version, {
					global: values.global,
				});
				console.log(removed ? "Removed." : "No matching entry found.");
				return;
			}

			fail(`Unknown 'runtimes' subcommand '${sub}'. Use list, add or remove.`);
			return;
		}

		case "compile":
		case "build": {
			if (!arg) fail("Please provide the entrypoint (a .js or .ts file, or a folder of built static files)");
			if (!values.target) fail("Please specify the target with --target <name>");
			const nativeLibc = values["native-libc"];
			if (nativeLibc && nativeLibc !== "musl" && nativeLibc !== "glibc" && nativeLibc !== "musl-dynamic") {
				fail(`--native-libc must be 'musl', 'musl-dynamic' or 'glibc', got '${nativeLibc}'`);
			}

			const result = await BinaryPackager.compile({
				entrypoint: arg,
				target: values.target,
				output: values.output,
				strategy: values.strategy as BuildStrategy | undefined,
				engine: values.engine as BuildEngine | undefined,
				intl: values.intl as "auto" | "all" | "none" | undefined,
				packageManager: values.pm,
				nodeBinary: values["node-binary"],
				nodeVersion: values["node-version"],
				ucrtDir: values["ucrt-dir"],
				nativeLibc: nativeLibc as "musl" | "musl-dynamic" | "glibc" | undefined,
				offline: values.offline,
				includeDev: values["include-dev"],
				includeEnv: values["include-env"],
				allowNativeMismatch: values["allow-native-mismatch"],
				trim: !values["no-trim"],
				staticSite:
					values.static || values.spa || values.port || values.host || values.index
						? {
								spa: values.spa,
								port: values.port === undefined ? undefined : Number(values.port),
								host: values.host,
								index: values.index,
							}
						: undefined,
				onLog: (msg) => console.log(`[Graak] ${msg}`),
			});

			for (const warning of result.warnings) console.warn(`[Graak] warning: ${warning}`);
			console.log(`[Graak] Built ${result.metadata.name} in ${result.durationMs}ms`);
			console.log(`  Strategy : ${result.strategy}`);
			console.log(`  Output   : ${result.outputPath}`);
			console.log(`  Run      : ${result.launcherPath}`);
			if (result.strategy === "quickjs") {
				console.log(`  Layout   : ${result.outputPath === result.launcherPath ? "one file" : "folder"}`);
			}
			console.log(
				`  Runtime  : ${
					result.strategy === "quickjs"
						? `Graak native host (no Node.js)`
						: result.runtimeVersion
							? `Node.js ${result.runtimeVersion}`
							: "system Node.js"
				}`
			);
			console.log(`  Size     : ${(result.sizeBytes / 1048576).toFixed(2)} MiB`);
			return;
		}

		default:
			fail(`Unknown command '${command}'. Run 'graak --help' for usage.`);
	}
}

function parse() {
	return parseArgs({
		allowPositionals: true,
		options: {
			target: { type: "string", short: "t" },
			output: { type: "string", short: "o" },
			strategy: { type: "string", short: "s" },
			engine: { type: "string", short: "e" },
			intl: { type: "string" },
			pm: { type: "string" },
			db: { type: "string" },
			"node-binary": { type: "string" },
			"node-version": { type: "string" },
			"native-libc": { type: "string" },
			"ucrt-dir": { type: "string" },
			offline: { type: "boolean" },
			"include-dev": { type: "boolean" },
			"include-env": { type: "boolean" },
			"allow-native-mismatch": { type: "boolean" },
			"no-trim": { type: "boolean" },
			static: { type: "boolean" },
			spa: { type: "boolean" },
			port: { type: "string" },
			host: { type: "string" },
			index: { type: "string" },
			sha256: { type: "string" },
			notes: { type: "string" },
			global: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
}

main().catch((err: unknown) => {
	console.error(`\n[Graak] ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
	process.exit(1);
});
