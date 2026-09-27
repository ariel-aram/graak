import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, posix, resolve } from "node:path";
import { FORGEDB_DRIVERS, PURE_JS_FORGEDB_DRIVERS } from "../integrations/ForgeDBIntegration";
import { createLauncherSource, IMPORT_HELPER_PATH, IMPORT_HELPER_SOURCE } from "../runtime/launcher";
import { UNSUBSTITUTABLE_NATIVE } from "../runtime/nativeShim";
import {
	executableExtension,
	is32BitOrLegacy,
	NativeAddonMismatchError,
	RuntimeError,
	TARGET_METADATA_MAP,
	TargetDevice,
	type TargetMetadata,
} from "../structures";
import { AppTrimmer } from "./AppTrimmer";
import { Archive } from "./Archive";
import { BinaryInspector } from "./BinaryInspector";
import { BUN_TRANSPILABLE_EXTENSIONS, BunTranspiler } from "./BunTranspiler";
import { DenoBundler } from "./DenoBundler";
import { DenoProject } from "./DenoProject";
import { LEGACY_ASSET_DIR, LegacyRuntimeAssets } from "./LegacyRuntimeAssets";
import { LegacyTranspiler } from "./LegacyTranspiler";
import { NativeAddonCompiler } from "./NativeAddonCompiler";
import { MIN_SEA_NODE_VERSION, NodeRuntime } from "./NodeRuntime";
import { type PackageManager, PolicyEnforcer } from "./PolicyEnforcer";
import { PortablePackager } from "./PortablePackager";
import { compareVersions, NATIVE_ONLY_ENTRY_EXTENSIONS, ProjectCollector } from "./ProjectCollector";
import { classifyNativeAddons, type IntlData, type NativeHostLibc, QuickJsPackager } from "./QuickJsPackager";
import { RuntimeRegistry } from "./RuntimeRegistry";
import { SeaPackager } from "./SeaPackager";
import { collectSeaEntries, packSeaPayload, writeSeaExecutable } from "./SeaPayload";
import { StaticSite, type StaticSiteOptions } from "./StaticSite";
import { V8AddonBuilder } from "./V8AddonBuilder";
import { Win7Compat } from "./Win7Compat";
import { YarnPnpCompat } from "./YarnPnpCompat";

export type BuildStrategy = "auto" | "sea" | "portable";
/** Which engine runs the program: Graak's native host (quickjs-ng), or a Node.js runtime. `auto` follows the target. */
export type BuildEngine = "auto" | "native" | "node";

type LauncherLegacyConfig = Parameters<typeof createLauncherSource>[0]["legacyPolyfills"];

/**
 * Runtimes below this major need their bundled code lowered and the modern platform APIs
 * supplied. Node.js 20 is the floor because that is where the last of what current discord.js
 * reaches for lands: `fetch`, Web Streams and `AbortController` are Node 18, but undici also
 * calls `String.prototype.toWellFormed`, which is Node 20.
 */
export const MIN_MODERN_API_NODE_MAJOR = 20;

/**
 * Lowest runtime the legacy pipeline can actually serve. esbuild refuses to emit below ES6
 * ("Transforming const to the configured target environment is not supported yet"), so a
 * runtime older than Node.js 6 cannot have modern code lowered for it at all. That is a real
 * ceiling, not a setting: the Windows Vista pin (Node.js 5.12.0) sits below it.
 */
export const MIN_TRANSPILABLE_NODE_MAJOR = 6;

export type LegacyRuntimePlan =
	| { kind: "modern" }
	| { kind: "lower"; jsTarget: string }
	| { kind: "unreachable"; reason: string };

export interface BuildOptions {
	entrypoint: string;
	target: TargetDevice | string;
	/** File path for SEA builds, directory path for portable builds. */
	output?: string;
	packageManager?: PackageManager | string;
	strategy?: BuildStrategy;
	/**
	 * `native` runs the program on the Graak native host and `node` on a Node.js runtime; `auto` (the default) follows
	 * the target. `strategy: "sea"` (or an output path ending in `.exe`) writes one executable that runs the application from inside itself; `portable`
	 * produces a directory bundle.
	 */
	engine?: BuildEngine;
	/** Node.js runtime for the target (required for targets without official builds). */
	nodeBinary?: string;
	/** Official Node.js version to download, e.g. "22" or "22.11.0". */
	nodeVersion?: string;
	/** Disallow network access (no runtime downloads). */
	offline?: boolean;
	includeDev?: boolean;
	includeEnv?: boolean;
	allowNativeMismatch?: boolean;
	/**
	 * Which libc the Graak native host is built against, for targets that default to it
	 * (see QuickJsPackager). Defaults to "musl": the one build that runs unmodified on both glibc
	 * and musl systems. "glibc" is an explicit opt-in, only wired up where it has actually been
	 * built and run — see NATIVE_HOST_GLIBC_BUILD_TARGET.
	 */
	nativeLibc?: NativeHostLibc;
	/** A mirror serving codeload.github.com's paths, for fetching the source of a V8 addon that ships none. */
	v8SourceMirror?: string;
	/** Windows SDK `Redist\\ucrt\\DLLs\\<arch>` folder, shipped app-local for addons that need the Universal C Runtime on Windows 7. */
	ucrtDir?: string;
	/**
	 * Package a folder of static files (a built React, Vue or plain HTML site) as a web server instead of a
	 * program. A directory or `.html` entrypoint is treated this way without this flag.
	 */
	staticSite?: boolean | StaticSiteOptions;
	/**
	 * The data behind `Intl` on the Graak engine (about 7 MB, 1.5 MB compressed): `auto` (default) ships it when the program or
	 * a package it bundles mentions `Intl`, `toLocale*String` or `localeCompare`; `all` always; `none` never.
	 */
	intl?: IntlData;
	/**
	 * On the Graak engine, ship only the files the program can load (see AppTrimmer): its own files, the modules they
	 * reach, and whole packages where loading is computed at run time. `false` ships every collected file. Default true.
	 */
	trim?: boolean;
	onLog?: (message: string) => void;
}

export interface BuildResult {
	success: true;
	strategy: "sea" | "portable" | "quickjs";
	outputPath: string;
	/** Executable to start: the SEA binary or the portable launcher script. */
	launcherPath: string;
	target: TargetDevice;
	packageManager: PackageManager;
	sizeBytes: number;
	is32BitOrLegacy: boolean;
	metadata: TargetMetadata;
	runtimeVersion: string | null;
	archiveSha256: string;
	files: number;
	packages: number;
	durationMs: number;
	warnings: string[];
}

export const DEFAULT_OUTPUT_DIR = "graak-out";

interface RuntimeSelection {
	binary: string | null;
	version: string | null;
	seaReady: boolean;
	reason: string | null;
}

const WIN7_COMPAT_TARGETS: Partial<Record<TargetDevice, "x64" | "ia32">> = {
	[TargetDevice.WinVistaX64]: "x64",
	[TargetDevice.WinLegacyX64]: "x64",
	[TargetDevice.WinVistaX86]: "ia32",
	[TargetDevice.WinLegacyX86]: "ia32",
};

export class BinaryPackager {
	/**
	 * Builds a program into a Node.js Single Executable Application when the target
	 * runtime supports it, otherwise into a portable bundle (launcher + archive + runtime).
	 */
	/**
	 * The project directory of an entry file: the closest one with a package.json, or with a deno.json(c) when a Deno
	 * project has no package.json (or keeps its config nearer to the entry).
	 */
	public static findRoot(entry: string): string {
		let node: string | null = null;
		try {
			node = ProjectCollector.findProjectRoot(entry);
		} catch {
			// A Deno project needs no package.json.
		}
		const config = DenoProject.findConfig(dirname(entry));
		const deno = config ? dirname(config) : null;
		if (deno && (!node || deno.length >= node.length)) return deno;
		if (node) return node;
		return ProjectCollector.findProjectRoot(entry);
	}

	public static async compile(options: BuildOptions): Promise<BuildResult> {
		// A folder of built files is a site, not a program: generate the server that serves it and package that.
		if (options.staticSite || StaticSite.isSiteEntry(options.entrypoint)) {
			const site = StaticSite.materialize(
				options.entrypoint,
				typeof options.staticSite === "object" ? options.staticSite : {}
			);
			try {
				options.onLog?.(`Packaging ${StaticSite.siteDirectory(options.entrypoint)} as a static site server`);
				return await BinaryPackager.compile({ ...options, entrypoint: site.entrypoint, staticSite: false });
			} finally {
				site.cleanup();
			}
		}
		const startTime = performance.now();
		const log = options.onLog ?? (() => {});
		// Says where a slow build spends its time: a stage that took 750 ms or more is reported when it ends.
		let lapStart = performance.now();
		const lap = (stage: string) => {
			const now = performance.now();
			if (now - lapStart >= 750) log(`${stage} took ${((now - lapStart) / 1000).toFixed(1)}s`);
			lapStart = now;
		};
		const strategy = options.strategy ?? "auto";
		if (!["auto", "sea", "portable"].includes(strategy)) {
			throw new RuntimeError(`Unknown strategy '${strategy}' (expected auto, sea or portable)`);
		}
		const engine = options.engine ?? "auto";
		if (!["auto", "native", "node"].includes(engine)) {
			throw new RuntimeError(`Unknown engine '${engine}' (expected auto, native or node)`);
		}

		const root = BinaryPackager.findRoot(resolve(options.entrypoint));
		const pm = PolicyEnforcer.resolvePackageManager(options.packageManager, root);
		const target = PolicyEnforcer.assertTargetAllowed(options.target, pm);
		const meta = TARGET_METADATA_MAP[target];
		const warnings: string[] = [];

		const defaultOutDir = join(root, DEFAULT_OUTPUT_DIR);
		const excludePaths = [defaultOutDir];
		if (options.output) excludePaths.push(resolve(options.output));

		// Bun projects are frequently run straight from .ts with no separate build step.
		// Node.js cannot require() that directly; transpile it with Bun's own bundler rather
		// than asking the user to pre-build, keeping installed packages external so
		// ProjectCollector resolves them from the real node_modules afterward.
		let entrypoint = resolve(options.entrypoint);
		let cleanupTranspiled: (() => void) | null = null;
		if (pm === "bun" && BUN_TRANSPILABLE_EXTENSIONS.has(extname(entrypoint))) {
			if (!BunTranspiler.isAvailable()) {
				throw new RuntimeError(
					`Entrypoint '${entrypoint}' is not plain JavaScript and 'bun' is not on PATH to transpile it. ` +
						"Run 'bun build --target=node --outdir dist' (or tsc) first and pass the built file."
				);
			}
			log(`Transpiling ${options.entrypoint} with 'bun build' (packages kept external)`);
			const transpiled = BunTranspiler.transpile(entrypoint);
			entrypoint = transpiled.entrypoint;
			cleanupTranspiled = transpiled.cleanup;
		}

		// A Yarn Plug'n'Play project has no node_modules for ProjectCollector to walk. Rather than
		// reading .pnp.cjs or the zip cache directly, Yarn itself is asked to produce a real
		// node_modules tree from the same yarn.lock, in a throwaway copy of the project -- see
		// YarnPnpCompat for why this is a materialization, not a reimplementation.
		let cleanupPnp: (() => void) | null = null;
		if (pm === "yarn" && YarnPnpCompat.isPnpProject(root)) {
			const materialized = YarnPnpCompat.materialize(root, entrypoint, {
				offline: options.offline,
				excludePaths,
				onLog: log,
			});
			entrypoint = materialized.entrypoint;
			cleanupPnp = materialized.cleanup;
		}

		// A Deno project has import maps, `jsr:`/`npm:`/`https:` specifiers and top-level await that neither engine
		// resolves. Deno itself is asked for the module graph, which becomes one bundle plus a real node_modules
		// tree -- see DenoBundler. Deno is needed here, at build time, and never on the device.
		let cleanupDeno: (() => void) | null = null;
		let denoUsesFfi = false;
		if (pm === "deno") {
			if (!DenoBundler.isAvailable()) {
				throw new RuntimeError(
					"This is a Deno project and 'deno' is not on PATH. Graak reads Deno's own module graph to build it, the way " +
						"Bun projects need 'bun' for TypeScript. Install Deno 2 from https://deno.com (build machine only), " +
						"or pass --pm npm to build the project as a Node.js one."
				);
			}
			const denoTarget = DenoProject.denoTarget(target);
			log(
				denoTarget
					? `Deno can also build ${meta.name} itself ('deno compile --target ${denoTarget}'); Graak builds it here on ${QuickJsPackager.supports(target) ? "its own engine" : "Node.js"}`
					: `${meta.name} is a target 'deno compile' cannot build: Graak builds it`
			);
			log(`Bundling ${options.entrypoint} with Deno's module graph`);
			const bundled = await DenoBundler.bundle({
				entrypoint,
				offline: options.offline,
				excludePaths,
				onLog: log,
			});
			entrypoint = bundled.entrypoint;
			cleanupDeno = bundled.cleanup;
			excludePaths.push(...bundled.bundled);
			warnings.push(...bundled.warnings);
			denoUsesFfi = bundled.usesFfi;
		}

		try {
			log(`Collecting project files from ${root} (${pm})`);
			// The transpiled file (if any) lives inside root and is walked and bundled like any
			// other project file — it is the entrypoint, so it must not be excluded.
			const project = ProjectCollector.collect({
				entrypoint,
				includeDev: options.includeDev,
				includeEnv: options.includeEnv,
				excludePaths,
			});

			lap("Collecting project files");
			if (!options.includeEnv) {
				warnings.push(".env files were not bundled; provide secrets through the environment at runtime.");
			}

			// This target defaults to the Graak native host (quickjs-ng + quickjs/native/) rather
			// than a bundled Node.js binary -- but it is a default, not a lock-in. Any of these is a
			// deliberate statement that Node.js is wanted here instead, and wins over the new default
			// the same way a registered runtime already won over the old pinned-Node fallback:
			//   - an explicit --node-binary
			//   - a runtime already registered with `graak runtimes add` for this target
			//   - an explicit --strategy portable (asking for a Node-shaped output by name)
			// An explicit engine settles it. Without one, the older rules apply.
			if (engine === "native" && !QuickJsPackager.supports(target)) {
				throw new RuntimeError(
					`There is no Graak native host build for ${meta.name} yet, so --engine native cannot be used. ` +
						"Leave the engine on auto to build it on Node.js."
				);
			}
			const explicitNodeOverride =
				engine === "native"
					? false
					: engine === "node" ||
						Boolean(options.nodeBinary) ||
						strategy === "portable" ||
						RuntimeRegistry.find(target, root).length > 0;
			if (QuickJsPackager.supports(target) && !explicitNodeOverride) {
				// bun:sqlite is provided (SQLite is built into the host); the rest of Bun is not.
				if (project.usesBunGlobals.length) {
					warnings.push(
						`Bun APIs detected (${project.usesBunGlobals.slice(0, 5).join(", ")}). The native host provides bun:sqlite ` +
							"but not the rest of Bun: anything under Bun.* or another bun:* module fails when reached. Use node: APIs, " +
							"or build with --node-binary / --engine node to get the Bun polyfills on Node.js."
					);
				}
				// Node-API is implemented by the host itself (quickjs/native/napi.c), so a native addon is
				// not an obstacle here: it loads the way it would under Node.js, provided it was built for
				// this target's architecture and the host can dlopen at all.
				const { required, optional } = classifyNativeAddons(project.nativeAddons.map((a) => a.path));
				// Deno.dlopen loads a shared library at run time, which a static host cannot do any more than an addon.
				if (denoUsesFfi) required.set("Deno FFI (Deno.dlopen)", []);
				// A dependency that ships only source is compiled below (once the libc for this build is settled),
				// but it will need to dlopen just like a prebuilt one, so it counts here already.
				for (const addon of project.sourceOnlyAddons) required.set(addon.name, [`${addon.archiveDir}/build/Release`]);
				let nativeLibc = options.nativeLibc;
				if (required.size && !QuickJsPackager.loadsAddons(target, nativeLibc ?? "musl")) {
					const names = [...required.keys()].join(", ");
					if (nativeLibc === "musl") {
						throw new RuntimeError(
							`${names} ship native addons, but --native-libc musl builds a statically linked host, and a ` +
								"static executable has no dynamic loader to load them with. Use --native-libc glibc or musl-dynamic, or drop " +
								"the flag and let Graak pick the dynamically linked host itself."
						);
					}
					const musl = QuickJsPackager.loadsAddons(target, "musl-dynamic");
					const glibc = QuickJsPackager.loadsAddons(target, "glibc");
					const requiredPaths = [...required.values()].flat();
					// A musl-linked addon cannot load into a glibc process (or the reverse), so the addon's own
					// libc picks the host when both exist; where only one does, that is the one.
					const preferMusl = musl && (!glibc || QuickJsPackager.addonsAreMusl(project.entries, requiredPaths));
					if (!nativeLibc && (preferMusl || glibc)) {
						nativeLibc = preferMusl ? "musl-dynamic" : "glibc";
						warnings.push(
							`${names} ship native addons, which a static executable cannot load, so this build uses the ` +
								`dynamically linked ${nativeLibc === "glibc" ? "glibc host, which runs on glibc systems (most Linux distributions) but not on Alpine" : "musl host, which runs on musl systems such as Alpine and iSH but not on glibc ones"} ` +
								"instead of the default static one."
						);
					} else {
						throw new RuntimeError(
							`${names} ship native addons, but ${meta.name} only has a statically linked host, and a static ` +
								"executable cannot load shared libraries. No dynamically linked host is built for this target yet."
						);
					}
				}
				if (optional.size && !QuickJsPackager.loadsAddons(target, nativeLibc ?? "musl")) {
					warnings.push(
						`${[...optional.keys()].join(", ")} ship native addons that this static host cannot load; ` +
							"their libraries fall back to pure JavaScript on their own."
					);
				}
				// The host loads CommonJS: ES modules (ES-module-only packages, .mjs) and TypeScript/JSX become CommonJS here.
				const converted = await LegacyTranspiler.toCommonJs(project.entries, {
					onLog: log,
					cacheDir: join(NodeRuntime.cacheDir(), "esm-cjs"),
				});
				project.entries = converted.entries;
				project.entry = converted.renamed.get(project.entry) ?? project.entry;
				lap("Converting ES modules and TypeScript");
				if (converted.failures.length) {
					warnings.push(
						`${converted.failures.length} file(s) could not be parsed and were kept as they are ` +
							`(they only matter if the program loads them). First: ${converted.failures[0]}`
					);
				}
				// With the host settled, addons built against V8 are rebuilt for it, then the bundle is checked.
				await BinaryPackager.rebuildV8Addons(project, target, { ...options, nativeLibc }, warnings, log);
				lap("Rebuilding V8 addons");
				BinaryPackager.compileSourceAddons(project, target, { ...options, nativeLibc }, warnings, log);
				lap("Compiling native addons that shipped only source");
				BinaryPackager.applyWin7Compat(project, target, options, warnings, log);
				lap("Patching addons for Windows 7");
				BinaryPackager.checkNativeAddons(project.nativeAddons, target, options, warnings, "native");
				if (options.trim !== false) {
					const trimmed = AppTrimmer.trim(project.entries, {
						target,
						convertedFromTypeScript: new Set(converted.renamed.values()),
					});
					project.entries = trimmed.entries;
					const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;
					log(
						`Kept the ${trimmed.after.files} of ${trimmed.before.files} files the program can load ` +
							`(${mb(trimmed.before.bytes)} -> ${mb(trimmed.after.bytes)}` +
							(trimmed.droppedPackages.length ? `, ${trimmed.droppedPackages.length} unused packages left out` : "") +
							"; --no-trim ships everything)"
					);
					lap("Trimming the application");
				}
				log(`Packaging for the Graak native host on ${meta.name} (no Node.js runtime bundled)`);
				const nativeHostBinary = await QuickJsPackager.ensureNativeHost(target, nativeLibc ?? "musl", log);
				lap("Preparing the native host");
				// strategy: "sea" (or an output path ending in .exe) is one executable; everything else is a folder.
				const isWindowsTarget = meta.nodePlatform === "win32";
				const outputEndsWithExe = options.output ? options.output.toLowerCase().endsWith(".exe") : false;
				const single = strategy === "sea" || (outputEndsWithExe && strategy !== "portable");
				const outputPath = resolve(
					options.output ?? join(defaultOutDir, `${project.name}-${target}${single && isWindowsTarget ? ".exe" : ""}`)
				);
				if (single && existsSync(outputPath) && statSync(outputPath).isDirectory()) {
					throw new RuntimeError(`SEA output '${outputPath}' is a directory; pass a file path`);
				}
				const stage = single ? mkdtempSync(join(tmpdir(), "graak-sea-")) : null;
				const res = QuickJsPackager.build({
					target,
					name: project.name,
					entry: project.entry,
					entries: project.entries,
					outputPath: stage ?? outputPath,
					nativeHostBinary,
					intl: options.intl,
				});
				lap("Writing the output");
				let finalPath = res.outputPath;
				let finalLauncher = res.launcherPath;
				let finalSize = res.sizeBytes;
				let finalSha = res.sha256;
				if (stage) {
					try {
						const payload = packSeaPayload(collectSeaEntries(stage, ["app", "runtime"]), `app/${project.entry}`);
						mkdirSync(dirname(outputPath), { recursive: true });
						finalSha = writeSeaExecutable(nativeHostBinary, payload, outputPath);
						finalPath = outputPath;
						finalLauncher = outputPath;
						finalSize = statSync(outputPath).size;
						warnings.push(
							"This is one executable that runs the application from inside itself, without unpacking it. Only " +
								"files that must exist on disk (native addons, programs it starts, SQLite databases it ships) are " +
								`extracted, beside it in ${basename(outputPath)}.graak or in the temp directory when that folder is read-only.`
						);
					} finally {
						rmSync(stage, { recursive: true, force: true });
					}
				} else {
					warnings.push(...res.warnings);
				}
				return {
					success: true,
					strategy: "quickjs",
					outputPath: finalPath,
					launcherPath: finalLauncher,
					target,
					packageManager: pm,
					sizeBytes: finalSize,
					is32BitOrLegacy: is32BitOrLegacy(target),
					metadata: meta,
					runtimeVersion: null,
					archiveSha256: finalSha,
					files: project.entries.length,
					packages: project.packages,
					durationMs: Math.round(performance.now() - startTime),
					warnings,
				};
			}

			if (NATIVE_ONLY_ENTRY_EXTENSIONS.has(extname(project.entry))) {
				throw new RuntimeError(
					`'${basename(project.entry)}' is TypeScript or JSX, which only the Graak native host converts at build time. ` +
						"For a Node.js build, compile it first (e.g. `tsc`, or `bun build --target=node --outdir dist`) and pass the built file."
				);
			}
			BinaryPackager.checkNativeAddons(project.nativeAddons, target, options, warnings);

			const runtime = await BinaryPackager.selectRuntime(target, meta, project.minNode, options, root, log);
			if (meta.pinnedLegacyNode && runtime.version === meta.pinnedLegacyNode.version) {
				warnings.push(meta.pinnedLegacyNode.warning);
			}
			const legacy = BinaryPackager.legacyRuntimePlan(runtime.version);
			if (runtime.version && project.minNode && compareVersions(runtime.version, project.minNode) < 0) {
				// A dependency's `engines.node` is that package's own statement about what it needs,
				// and lowering its code plus supplying the missing platform APIs is exactly how this
				// build intends to override it. So the floor is only fatal when nothing is going to
				// be done about it; otherwise it is reported and the build continues.
				if (legacy.kind !== "lower") {
					throw new RuntimeError(
						`The bundled dependencies require Node.js >= ${project.minNode}, but the target runtime is ${runtime.version}.`
					);
				}
				warnings.push(
					`The bundled dependencies declare they need Node.js >= ${project.minNode}, but this build targets ` +
						`${runtime.version}. Their code is being lowered and the missing APIs polyfilled, which is what makes ` +
						"that declaration surmountable — but it is an override, not a guarantee, so test the executable before " +
						"relying on it."
				);
			}

			if (project.usesBunApis.length) {
				warnings.push(
					`Bun APIs detected (${project.usesBunApis.slice(0, 5).join(", ")}). The compiled executable runs on ` +
						"Node.js: bun:sqlite and common Bun globals (env, file, write, serve, sleep, which) are polyfilled " +
						"at startup, but anything else (Bun.password, Bun.hash, FFI, Bun.spawn, ...) will fail when reached."
				);
			}

			let chosen: "sea" | "portable";
			if (strategy === "sea") {
				if (!runtime.seaReady) throw new RuntimeError(`Cannot build a SEA for ${meta.name}: ${runtime.reason}`);
				chosen = "sea";
			} else if (strategy === "portable") {
				chosen = "portable";
			} else {
				chosen = runtime.seaReady ? "sea" : "portable";
				if (!runtime.seaReady && runtime.binary) {
					warnings.push(`Falling back to a portable bundle: ${runtime.reason}`);
				}
			}

			// A runtime older than the APIs current discord.js is written against needs its code
			// lowered and the missing platform APIs supplied. Decided from the runtime actually
			// selected, not from the target: the same target built with a newer --node-binary
			// needs none of this, and doing it anyway would be pure cost.
			let entries = project.entries;
			let legacyPolyfills: LauncherLegacyConfig = null;

			if (legacy.kind === "unreachable") warnings.push(legacy.reason);
			if (legacy.kind === "lower") {
				log(`Runtime is Node.js ${runtime.version}; lowering bundled code to ${legacy.jsTarget}`);
				const transpiled = await LegacyTranspiler.transpile(entries, { jsTarget: legacy.jsTarget, onLog: log });
				entries = transpiled.entries;
				if (transpiled.failures.length) {
					warnings.push(
						`${transpiled.failures.length} bundled file(s) could not be lowered to ${legacy.jsTarget} and were ` +
							`kept as-is; they will only matter if the bot actually loads them. First: ${transpiled.failures[0]}`
					);
				}

				const assets = await LegacyRuntimeAssets.build({
					jsTarget: legacy.jsTarget,
					runtimeCodegen: true,
					onLog: log,
				});
				entries = [...entries, ...assets.entries];
				legacyPolyfills = {
					target,
					jsTarget: legacy.jsTarget,
					assetDir: LEGACY_ASSET_DIR,
					runtimeCodegen: true,
				};
				warnings.push(
					`Built for Node.js ${runtime.version}: bundled code was lowered to ${legacy.jsTarget} and missing ` +
						"platform APIs are polyfilled at startup. Text segmentation ($segmentTextSplit and friends) throws " +
						"on this runtime rather than returning wrong results, because Intl.Segmenter needs ICU data this " +
						"runtime does not ship."
				);
			}

			const archive = Archive.pack([
				...entries,
				{
					path: IMPORT_HELPER_PATH,
					source: Buffer.from(IMPORT_HELPER_SOURCE),
					mode: 0o644,
				},
			]);
			const launcherSource = createLauncherSource({
				name: project.name,
				entry: project.entry,
				hash: archive.sha256,
				// With the legacy pipeline active, the dependencies' declared floor has deliberately
				// been overridden, so enforcing it at startup would reject the very runtime this
				// build was made for. The guard is kept, just re-aimed at that runtime: running the
				// bundle on something even older than what its code was lowered for is still a
				// mistake worth stopping.
				minNode: legacyPolyfills && runtime.version ? runtime.version : project.minNode,
				target,
				mode: chosen,
				// Resolved here rather than in the launcher: matching substrings of the target id
				// misses targets (`win-xp-x86` contains no "legacy", `linux-x86` no "xp").
				windowsLegacy: meta.os === "windows-legacy",
				simdUnsafe: meta.is32BitOrLegacy,
				nativeShim: meta.is32BitOrLegacy,
				bunCompat: project.usesBunApis.length > 0,
				legacyPolyfills,
			});
			log(
				`Packed ${archive.files} files from ${project.packages} packages (${(archive.buffer.length / 1048576).toFixed(1)} MiB compressed)`
			);

			let outputPath: string;
			let launcherPath: string;
			let sizeBytes: number;

			if (chosen === "sea") {
				outputPath = resolve(
					options.output ?? join(defaultOutDir, `${project.name}-${target}${executableExtension(target)}`)
				);
				if (existsSync(outputPath) && statSync(outputPath).isDirectory()) {
					throw new RuntimeError(`SEA output '${outputPath}' is a directory; pass a file path`);
				}
				const { binary, version } = runtime;
				if (!binary || !version) {
					throw new RuntimeError("SEA builds need a runtime with a known version");
				}
				const generator = await BinaryPackager.selectGenerator(target, binary, version, options, warnings, log);
				log(`Injecting SEA blob into Node.js ${runtime.version ?? "(unknown version)"}`);
				const res = await SeaPackager.build({
					target,
					runtimeBinary: binary,
					generatorBinary: generator,
					launcherSource,
					archive: archive.buffer,
					outputPath,
				});
				warnings.push(...res.warnings);
				launcherPath = outputPath;
				sizeBytes = res.sizeBytes;
			} else {
				outputPath = resolve(options.output ?? join(defaultOutDir, `${project.name}-${target}`));
				const res = PortablePackager.build({
					target,
					name: project.name,
					launcherSource,
					archive: archive.buffer,
					outputPath,
					runtimeBinary: runtime.binary,
				});
				warnings.push(...res.warnings);
				launcherPath = res.launcherPath;
				sizeBytes = res.sizeBytes;
			}

			return {
				success: true,
				strategy: chosen,
				outputPath,
				launcherPath,
				target,
				packageManager: pm,
				sizeBytes,
				is32BitOrLegacy: is32BitOrLegacy(target),
				metadata: meta,
				runtimeVersion: runtime.version,
				archiveSha256: archive.sha256,
				files: archive.files,
				packages: project.packages,
				durationMs: Math.round(performance.now() - startTime),
				warnings,
			};
		} finally {
			cleanupTranspiled?.();
			cleanupPnp?.();
			cleanupDeno?.();
		}
	}

	/**
	 * Decides whether a build needs the legacy treatment, and which language level to lower to.
	 * `null` means the runtime is modern enough to run current code as published.
	 *
	 * The esbuild target is built from the runtime's own major and minor rather than a fixed
	 * string, so lowering is never more aggressive than the runtime requires.
	 */
	public static legacyRuntimePlan(runtimeVersion: string | null): LegacyRuntimePlan {
		if (!runtimeVersion) return { kind: "modern" };
		const [major, minor] = runtimeVersion.split(".").map((part) => Number.parseInt(part, 10) || 0);
		if (major >= MIN_MODERN_API_NODE_MAJOR) return { kind: "modern" };
		if (major < MIN_TRANSPILABLE_NODE_MAJOR) {
			return {
				kind: "unreachable",
				reason:
					`Node.js ${runtimeVersion} predates ES6, and esbuild cannot lower modern JavaScript that far ` +
					`(its floor is Node.js ${MIN_TRANSPILABLE_NODE_MAJOR}). Bundled code is shipped unchanged, so anything ` +
					"written in modern syntax — which is all of current discord.js and ForgeScript — will fail to parse " +
					"on this runtime. Only a bot whose whole dependency tree is ES5 can run here.",
			};
		}
		return { kind: "lower", jsTarget: `node${major}.${minor}` };
	}

	/**
	 * A prebuilt addon compiled against V8 cannot load outside Node.js, but the package that ships it
	 * usually ships its source too. That source is rebuilt here against Graak's V8 layer for the
	 * target -- from any build machine, whatever platform the installed prebuild was for.
	 *
	 * Packages that are only optional accelerators, with a host that cannot load addons anyway, are
	 * left alone: building them would produce something the host then could not use.
	 */
	private static async rebuildV8Addons(
		project: ReturnType<typeof ProjectCollector.collect>,
		target: TargetDevice,
		options: BuildOptions,
		warnings: string[],
		log: (message: string) => void
	): Promise<void> {
		const packages = V8AddonBuilder.find(project.entries);
		if (!packages.length) return;
		const hostLoadsAddons = QuickJsPackager.loadsAddons(target, options.nativeLibc ?? "musl");
		const needsHost = classifyNativeAddons(project.nativeAddons.map((a) => a.path)).required.size > 0;
		if (!hostLoadsAddons && !needsHost && options.nativeLibc !== "glibc") return;

		for (const pkg of packages) {
			if (!existsSync(join(pkg.packageDir, "binding.gyp"))) {
				const sourceDir = await V8AddonBuilder.fetchSource(pkg, {
					offline: options.offline,
					mirror: options.v8SourceMirror,
					onLog: log,
				});
				if (sourceDir) pkg.sourceDir = sourceDir;
			}
			const built = V8AddonBuilder.build({ pkg, target, libc: options.nativeLibc, onLog: log });
			const dir = V8AddonBuilder.archiveDirOf(pkg.addonPaths[0]);
			V8AddonBuilder.replace(project.entries, pkg, built, dir);
			project.nativeAddons = project.nativeAddons.filter((a) => !pkg.addonPaths.includes(a.path));
			const path = `${dir}/${built.relativePath}`;
			project.nativeAddons.push({ path, info: BinaryInspector.inspect(built.file) });
			warnings.push(
				`${pkg.name} was compiled against V8, which only Node.js has, so it was rebuilt from source against Graak's ` +
					`V8 layer for ${target}. The prebuilt binary it shipped was not used.`
			);
		}
	}

	/**
	 * A dependency that ships only a `binding.gyp` and C/C++ source -- no prebuilt `.node` for any
	 * platform -- cannot be `require()`d as-is: nothing was ever placed at the path its own `index.js`
	 * loads. This compiles it here, against the Node-API headers the native host itself implements
	 * (`quickjs/native/napi.c`), so the result loads exactly the way any other addon does. See
	 * NativeAddonCompiler for the toolchain and the node-gyp / direct-compile fallback it tries.
	 */
	private static compileSourceAddons(
		project: ReturnType<typeof ProjectCollector.collect>,
		target: TargetDevice,
		options: BuildOptions,
		warnings: string[],
		log: (message: string) => void
	): void {
		if (!project.sourceOnlyAddons.length) return;
		for (const addon of project.sourceOnlyAddons) {
			const built = NativeAddonCompiler.build({ addon, target, libc: options.nativeLibc, onLog: log });
			const path = `${addon.archiveDir}/${built.relativePath}`;
			project.entries.push({ path, source: built.file, mode: 0o755 });
			project.nativeAddons.push({ path, info: BinaryInspector.inspect(built.file) });
			warnings.push(
				`${addon.name} ships only source (a binding.gyp, no prebuilt .node for any platform), so it was ` +
					`compiled from source for ${target}.`
			);
		}
		project.sourceOnlyAddons = [];
	}

	/**
	 * On Windows Vista and 7, redirects the few imports a prebuilt addon (or a DLL it ships) needs that
	 * those systems lack, to compatibility DLLs shipped beside it. See Win7Compat.
	 */
	private static applyWin7Compat(
		project: ReturnType<typeof ProjectCollector.collect>,
		target: TargetDevice,
		options: BuildOptions,
		warnings: string[],
		log: (message: string) => void
	) {
		const arch = WIN7_COMPAT_TARGETS[target];
		if (!arch) return;
		const patchedDirs = new Set<string>();
		const ucrtDirs = new Set<string>();
		const cache = join(NodeRuntime.cacheDir(), "win7-patched");
		for (const entry of project.entries) {
			if (typeof entry.source !== "string" || !/\.(node|dll)$/i.test(entry.path)) continue;
			let patch: ReturnType<typeof Win7Compat.patch>;
			try {
				const bytes = readFileSync(entry.source);
				if (Win7Compat.needsUcrt(bytes)) ucrtDirs.add(posix.dirname(entry.path));
				patch = Win7Compat.patch(bytes);
			} catch {
				continue;
			}
			if (!patch) continue;
			if (patch.unresolved.length) {
				warnings.push(
					`${entry.path} imports things Windows 7 does not have that Graak cannot supply: ${patch.unresolved.join("; ")}. ` +
						"It will fail to load there with the system's own message."
				);
			}
			if (!patch.changes.length) continue;
			const digest = createHash("sha256").update(patch.buffer).digest("hex").slice(0, 24);
			const patched = join(cache, `${digest}-${basename(entry.path)}`);
			if (!existsSync(patched)) {
				mkdirSync(cache, { recursive: true });
				writeFileSync(patched, patch.buffer);
			}
			entry.source = patched;
			patchedDirs.add(posix.dirname(entry.path));
			log(`Windows 7: ${entry.path}: ${patch.changes.join(", ")}`);
		}
		BinaryPackager.bundleUcrt(project, ucrtDirs, options, warnings, log);
		if (!patchedDirs.size) return;
		const shimDir = Win7Compat.ensureShims(arch);
		for (const dir of patchedDirs) {
			for (const name of Win7Compat.shimNames()) {
				const path = `${dir}/${name}`;
				if (!project.entries.some((e) => e.path === path))
					project.entries.push({ path, source: join(shimDir, name), mode: 0o755 });
			}
		}
		warnings.push(
			"Some addons import Windows functions that Windows Vista and 7 lack (WaitOnAddress, ProcessPrng, " +
				"GetSystemTimePreciseAsFileTime). They were redirected to Graak's compatibility DLLs, which ship beside them."
		);
	}

	/**
	 * Some addons and DLLs (libvips, for sharp) link the Universal C Runtime. Windows 7 has it only with
	 * update KB2999226. Microsoft allows shipping it app-local, so when a directory of those DLLs is
	 * given (the `Redist\\ucrt\\DLLs\\<arch>` folder of a Windows SDK) they are copied beside the file
	 * that needs them; without one, the build says what will happen.
	 */
	private static bundleUcrt(
		project: ReturnType<typeof ProjectCollector.collect>,
		dirs: Set<string>,
		options: BuildOptions,
		warnings: string[],
		log: (message: string) => void
	) {
		if (!dirs.size) return;
		const source = options.ucrtDir ?? process.env.GRAAK_UCRT_DIR;
		if (!source || !existsSync(source)) {
			warnings.push(
				`${[...dirs].join(", ")} need the Universal C Runtime, which Windows 7 has only with update KB2999226. ` +
					"Install that update on the target, or pass --ucrt-dir <Windows SDK Redist\\ucrt\\DLLs\\<arch>> to ship the " +
					"runtime app-local (Microsoft permits redistributing it)."
			);
			return;
		}
		const files = readdirSync(source).filter((f) => /^(ucrtbase|api-ms-win-crt-.*)\.dll$/i.test(f));
		for (const dir of dirs) {
			for (const f of files) {
				const path = `${dir}/${f}`;
				if (!project.entries.some((e) => e.path === path))
					project.entries.push({ path, source: join(source, f), mode: 0o755 });
			}
		}
		log(`Bundled the Universal C Runtime (${files.length} DLLs) beside ${[...dirs].join(", ")}`);
	}

	private static checkNativeAddons(
		addons: ReturnType<typeof ProjectCollector.collect>["nativeAddons"],
		target: TargetDevice,
		options: BuildOptions,
		warnings: string[],
		host: "node" | "native" = "node"
	) {
		// Prebuilt packages often ship addons for several platforms: a package is fine
		// as soon as one of its addons fits the target
		const byPackage = new Map<string, { usable: boolean; mismatched: string[] }>();
		for (const addon of addons) {
			const idx = addon.path.lastIndexOf("node_modules/");
			const rest = idx === -1 ? addon.path : addon.path.slice(idx + 13);
			const pkgName =
				idx === -1
					? "(project)"
					: rest
							.split("/")
							.slice(0, rest.startsWith("@") ? 2 : 1)
							.join("/");
			const key = idx === -1 ? pkgName : addon.path.slice(0, idx + 13) + pkgName;
			const entry = byPackage.get(key) ?? { usable: false, mismatched: [] };
			byPackage.set(key, entry);

			if (!addon.info) {
				warnings.push(`Could not identify native addon '${addon.path}'.`);
			} else if (BinaryInspector.matchesTarget(addon.info, target)) {
				entry.usable = true;
			} else {
				entry.mismatched.push(`${addon.path} (${addon.info.format} ${addon.info.arch})`);
			}
		}

		const nativeForgeDbPackages = Object.values(FORGEDB_DRIVERS)
			.filter((d) => d.native)
			.map((d) => d.package);

		// Matching the target's architecture is necessary but not sufficient. A prebuilt addon for
		// win32-x64 is a perfectly valid PE for win-legacy-x64 and still fails to load there,
		// because it was compiled against a newer Node ABI and a newer Windows -- the machine
		// reports "The specified procedure could not be found". That happened on a real Windows
		// install with lmdb, and the build had said nothing, because nothing was mismatched.
		//
		// For legacy targets, warn about the packages the runtime shim deliberately will not
		// substitute: if one of those is bundled, it is the most likely thing to stop the bot, and
		// finding that out at build time beats finding out on the target machine.
		if (host === "native" && TARGET_METADATA_MAP[target].is32BitOrLegacy && byPackage.size) {
			// The Node-API layer is the host's own, so there is no Node ABI to be too new for. The addon
			// is still a native binary its authors built for some Windows or glibc, and if that is newer
			// than the target's, loading it fails with the system's own error message, not a build error.
			warnings.push(
				`Native addons are loaded by the operating system, not by Graak, so each one must itself run on ${target}. ` +
					"Prebuilt addons are usually built for a recent OS; if one is not, it fails at load time with the system's error."
			);
		} else if (host === "node" && TARGET_METADATA_MAP[target].is32BitOrLegacy) {
			const bundled = new Set([...byPackage.keys()].map((key) => key.split("node_modules/").pop() ?? key));
			const risky = UNSUBSTITUTABLE_NATIVE.filter((name) => bundled.has(name));
			if (risky.length) {
				warnings.push(
					`${risky.join(", ")} ship native addons that Graak will not replace with a stub, because a ` +
						`stub would lose data or weaken security rather than fail. Their prebuilt binaries match ` +
						`${target}'s architecture but are built for a newer Node.js ABI and a newer Windows, so they ` +
						`commonly fail to load on this target with "The specified procedure could not be found". ` +
						(nativeForgeDbPackages.some((pkg) => risky.includes(pkg as (typeof UNSUBSTITUTABLE_NATIVE)[number]))
							? `Use a pure JavaScript ForgeDB driver (${PURE_JS_FORGEDB_DRIVERS.join(", ")}) instead.`
							: "Rebuild them for this target, or drop the feature that needs them.")
				);
			}
		}

		const mismatched = [...byPackage.values()].filter((p) => !p.usable).flatMap((p) => p.mismatched);
		if (!mismatched.length) return;

		const mismatchedPackageNames = new Set(
			[...byPackage.entries()].filter(([, p]) => !p.usable).map(([key]) => key.split("/").pop() ?? key)
		);
		const hint = nativeForgeDbPackages.some((p) => mismatchedPackageNames.has(p))
			? `ForgeDB: this native database driver has no matching build for ${target}. ` +
				`Switch to a pure JavaScript driver (${PURE_JS_FORGEDB_DRIVERS.join(", ")}) instead of reinstalling ` +
				"a native one for the target."
			: undefined;

		if (options.allowNativeMismatch) {
			warnings.push(
				`Native addons that cannot run on ${target} were bundled: ${mismatched.join(", ")}${hint ? ` ${hint}` : ""}`
			);
			return;
		}
		throw new NativeAddonMismatchError(target, mismatched, hint);
	}

	private static async selectRuntime(
		target: TargetDevice,
		meta: TargetMetadata,
		minNode: string | null,
		options: BuildOptions,
		root: string,
		log: (message: string) => void
	): Promise<RuntimeSelection> {
		let binary: string | null = null;

		if (options.nodeBinary) {
			binary = resolve(options.nodeBinary);
			if (!existsSync(binary) || !statSync(binary).isFile()) {
				throw new RuntimeError(`Node.js binary not found: ${binary}`);
			}
			if (meta.os === "windows-legacy") {
				log("Make sure the supplied runtime supports Windows 7 / Vista; official Node.js >= 14 does not.");
			}
			const info = BinaryInspector.inspect(binary);
			if (!info || !BinaryInspector.matchesTarget(info, target)) {
				throw new RuntimeError(
					`'${binary}' (${info ? `${info.format} ${info.arch}` : "unknown format"}) cannot run on ${meta.name} (${meta.binaryFormat} ${meta.arch}).`
				);
			}
		} else if (meta.officialNodeFile && !options.offline) {
			const version = await NodeRuntime.resolveOfficialVersion(meta.officialNodeFile, options.nodeVersion, minNode);
			log(`Downloading official Node.js ${version} (${meta.officialNodeFile})`);
			binary = await NodeRuntime.ensureOfficial(version, meta.officialNodeFile);
		} else if (!options.offline) {
			// A user-registered runtime is their own explicit, trusted choice (e.g. a newer
			// unofficial Windows 7 build) and wins over Graak's own pinned fallback below.
			const [entry] = RuntimeRegistry.find(target, root);
			if (entry) {
				log(`Using registered community runtime for ${target}: Node.js ${entry.version} (${entry.url})`);
				binary = await RuntimeRegistry.ensure(entry);
				const info = BinaryInspector.inspect(binary);
				if (!info || !BinaryInspector.matchesTarget(info, target)) {
					throw new RuntimeError(
						`Registered runtime for '${target}' (${entry.url}) does not match the target after download ` +
							`(${info ? `${info.format} ${info.arch}` : "unrecognized format"}). ` +
							"Remove it with 'graak runtimes remove' and register a correct one."
					);
				}
			} else if (meta.pinnedLegacyNode) {
				const { version, fileKey } = meta.pinnedLegacyNode;
				log(`Downloading Node.js ${version} (${fileKey}), the last official release for ${meta.name}`);
				binary = await NodeRuntime.ensureOfficial(version, fileKey);
			}
		}

		if (!binary) {
			return {
				binary: null,
				version: null,
				seaReady: false,
				reason:
					meta.officialNodeFile || meta.pinnedLegacyNode
						? "runtime downloads are disabled (offline) and no --node-binary was given."
						: `no Node.js runtime was given and none is registered for this target. ${meta.runtimeHint} ` +
							`Or register one once with 'graak runtimes add ${target} <version> <url> --sha256 <hex>'.`,
			};
		}

		const version = NodeRuntime.readVersion(binary);
		const fuse = NodeRuntime.seaFuseState(readFileSync(binary));
		let reason: string | null = null;
		if (!version) reason = "the runtime version could not be determined.";
		else if (compareVersions(version, MIN_SEA_NODE_VERSION) < 0) {
			reason = `Node.js ${version} is older than ${MIN_SEA_NODE_VERSION}, which SEA assets require.`;
		} else if (fuse !== "ready") {
			reason = fuse === "absent" ? "the runtime was built without SEA support." : "the runtime is already a SEA.";
		}

		return { binary, version, seaReady: reason === null, reason };
	}

	/**
	 * The SEA blob should be produced by the same Node.js version it is injected into.
	 */
	private static async selectGenerator(
		target: TargetDevice,
		binary: string,
		version: string,
		options: BuildOptions,
		warnings: string[],
		log: (message: string) => void
	): Promise<string> {
		if (NodeRuntime.canRunOnHost(target)) return binary;

		if (process.versions.node === version) return process.execPath;

		const hostKey = NodeRuntime.hostFileKey();
		if (hostKey && !options.offline) {
			try {
				log(`Downloading host Node.js ${version} to generate the SEA blob`);
				return await NodeRuntime.ensureOfficial(version, hostKey);
			} catch (err) {
				warnings.push(`Could not get a host Node.js ${version} (${err instanceof Error ? err.message : String(err)}).`);
			}
		}

		if (compareVersions(process.versions.node, MIN_SEA_NODE_VERSION) < 0) {
			throw new RuntimeError(`Generating a SEA blob needs Node.js >= ${MIN_SEA_NODE_VERSION} on the build host.`);
		}
		if (process.versions.node.split(".")[0] !== version.split(".")[0]) {
			warnings.push(
				`SEA blob generated with Node.js ${process.versions.node} for a ${version} runtime; blob formats can differ between major versions. Test the executable on the target.`
			);
		}
		return process.execPath;
	}
}
