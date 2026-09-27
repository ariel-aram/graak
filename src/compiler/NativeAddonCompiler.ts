import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";
import { RuntimeError, TARGET_METADATA_MAP, type TargetDevice } from "../structures";
import { NodeRuntime } from "./NodeRuntime";
import type { SourceOnlyAddon } from "./ProjectCollector";
import { spawnOutput } from "./SpawnOutput";
import {
	type GypDict,
	type GypTargetSettings,
	hasTool,
	MUSL_TOOLCHAINS,
	parseGyp,
	TOOLCHAINS,
	type Toolchain,
	V8AddonBuilder,
} from "./V8AddonBuilder";

/**
 * Compiles a Node-API native addon straight from source, for a package that ships none of its own
 * `build/Release/*.node` -- only a `binding.gyp` and `.c`/`.cpp` files, meant to be built by whatever
 * installs it (node-gyp, normally, on a machine with Python and a C++ toolchain).
 *
 * WHY. `ProjectCollector` places every file a package ships, but a source-only package's own `index.js`
 * still does `require('./build/Release/foo.node')`, and nothing was ever put there: the archive would
 * load fine and then fail exactly where the addon is first used. Unlike V8AddonBuilder (which *rebuilds*
 * an existing prebuilt binary compiled against V8, because a Node.js-shaped `.node` cannot run outside
 * Node.js at all), this addon was never built for anything: there is no ABI mismatch to fix, only a
 * missing artifact. The source is already written against Node-API (or it could not run on any Node.js
 * version either), so it needs nothing V8-shaped -- just the same headers `quickjs/native/napi.c`
 * implements, and a compiler for the target.
 *
 * STRATEGY. `node-gyp` is tried first, but only for a *native* build (the host's own OS/arch): node-gyp
 * downloads Node.js's own headers and drives whatever C++ toolchain is already configured for the
 * *building* machine, not Graak's cross toolchains, so it cannot honour `target` when that differs from
 * the host. Everywhere else -- cross builds, or node-gyp/Python simply not being installed -- this reads
 * `binding.gyp` itself (reusing V8AddonBuilder's gyp reader and per-target toolchains) and invokes the
 * target's `cc`/`c++` directly against the vendored Node-API headers, exactly as
 * `quickjs/native/include/README.md` describes and as `test/quickJsPackager.test.ts` proves works for a
 * hand-compiled addon.
 *
 * SCOPE. Same subset of gyp as V8AddonBuilder: targets, sources, include_dirs, defines, cflags,
 * libraries, dependent static-library targets, conditions on OS/arch. Linux (glibc and musl) and the
 * Windows targets mingw already cross-compiles for are supported; a target with no toolchain wired up
 * (see V8AddonBuilder's TOOLCHAINS) is reported as such rather than silently skipped.
 */
export interface NativeAddonBuildResult {
	/** Built addon, on disk. */
	file: string;
	/** Where the addon belongs inside the package (`build/Release/<target>.node`). */
	relativePath: string;
}

export class NativeAddonCompiler {
	/** Whether a from-source Node-API addon can be built for this target at all (needs its cross toolchain). */
	public static supports(target: TargetDevice, libc?: "musl-dynamic" | string): boolean {
		return libc === "musl-dynamic" ? target in MUSL_TOOLCHAINS : target in TOOLCHAINS;
	}

	/** Compiles `addon` for `target`. Throws, naming the reason, when it cannot. */
	public static build(options: {
		addon: SourceOnlyAddon;
		target: TargetDevice;
		/** "musl-dynamic" builds for a musl host (Alpine, iSH); anything else uses the target's default. */
		libc?: string;
		onLog?: (message: string) => void;
	}): NativeAddonBuildResult {
		const { addon, target } = options;
		const log = options.onLog ?? (() => {});
		const meta = TARGET_METADATA_MAP[target];
		const toolchain = options.libc === "musl-dynamic" ? MUSL_TOOLCHAINS[target] : TOOLCHAINS[target];
		if (!toolchain) {
			throw new RuntimeError(
				`${addon.name} ships only source (a binding.gyp, no prebuilt .node for any platform), and Graak ` +
					`compiles those with the target's own C/C++ toolchain, which is not wired up for ${meta.name} yet.`
			);
		}
		for (const tool of [toolchain.cc, toolchain.cxx, ...(toolchain.dlltool ? [toolchain.dlltool] : [])]) {
			if (!hasTool(tool)) {
				throw new RuntimeError(`Building ${addon.name} for ${meta.name} needs ${tool}, which is not installed.`);
			}
		}

		const gypFile = join(addon.sourceDir, "binding.gyp");
		if (!existsSync(gypFile)) {
			throw new RuntimeError(`${addon.name} has no binding.gyp at ${addon.sourceDir}; nothing to compile.`);
		}
		const gyp = parseGyp(readFileSync(gypFile, "utf-8"));
		const vars = {
			OS: toolchain.os,
			target_arch: toolchain.arch,
			module_root_dir: addon.sourceDir,
			node_root_dir: addon.sourceDir,
			library: "static_library",
			...V8AddonBuilder.topLevelVariables(gyp),
		};
		const targets = (Array.isArray(gyp.targets) ? gyp.targets : []) as GypDict[];
		const main = targets.find((t) => String(t.target_name) === addon.name) ?? targets[0];
		if (!main) throw new RuntimeError(`${addon.name}: binding.gyp defines no targets.`);
		const settings = V8AddonBuilder.resolveTarget(main, gypFile, vars, addon.sourceDir);

		const cacheKey = NativeAddonCompiler.cacheKey(settings, `${target}:${options.libc ?? ""}`);
		const cacheDir = join(NodeRuntime.cacheDir(), "native-addons", cacheKey);
		const outFile = join(cacheDir, `${settings.name}.node`);
		const relativePath = `build/Release/${settings.name}.node`;
		if (existsSync(outFile)) return { file: outFile, relativePath };

		// node-gyp only makes sense for a native build: it configures whatever toolchain the *building*
		// machine already has for its *own* OS/arch, not Graak's cross toolchains for other targets.
		const buildingNative =
			options.libc !== "musl-dynamic" &&
			toolchain.os === (process.platform === "win32" ? "win" : "linux") &&
			toolchain.arch === (process.arch === "x64" ? "x64" : "ia32");
		if (buildingNative && hasTool("node-gyp") && (hasTool("python3") || hasTool("python"))) {
			const viaNodeGyp = NativeAddonCompiler.buildWithNodeGyp(addon, settings, log);
			if (viaNodeGyp) {
				mkdirSync(cacheDir, { recursive: true });
				copyFileSync(viaNodeGyp, outFile);
				return { file: outFile, relativePath };
			}
		}

		log(`Compiling ${addon.name} from source against Node-API for ${meta.name} (it ships no prebuilt .node)`);
		return NativeAddonCompiler.compileDirect(addon, settings, toolchain, target, cacheDir, outFile, relativePath);
	}

	/**
	 * `node-gyp rebuild` in the package's own directory, for a native (non-cross) build. Returns the
	 * built file, or null when node-gyp itself failed (offline, no matching Node headers cached, an
	 * unsupported gyp feature) so the caller falls back to compiling directly.
	 */
	private static buildWithNodeGyp(
		addon: SourceOnlyAddon,
		settings: GypTargetSettings,
		log: (m: string) => void
	): string | null {
		log(`Trying node-gyp for ${addon.name} (a native build: it cannot target another platform/arch)`);
		const res = spawnSync("node-gyp", ["rebuild"], { cwd: addon.sourceDir, encoding: "utf-8", timeout: 300_000 });
		if (res.status !== 0) {
			log(
				`node-gyp did not build ${addon.name} (${spawnOutput(res).split("\n")[0] ?? "unknown error"}); compiling directly instead`
			);
			return null;
		}
		const built = join(addon.sourceDir, "build/Release", `${settings.name}.node`);
		return existsSync(built) ? built : null;
	}

	/** Direct `cc`/`c++` invocation against the vendored Node-API headers, using the target's own toolchain. */
	private static compileDirect(
		addon: SourceOnlyAddon,
		settings: GypTargetSettings,
		toolchain: Toolchain,
		target: TargetDevice,
		cacheDir: string,
		outFile: string,
		relativePath: string
	): NativeAddonBuildResult {
		const meta = TARGET_METADATA_MAP[target];
		const repoRoot = dirname(require.resolve("../../package.json"));
		const apiDir = join(repoRoot, "quickjs/native/include");
		const work = mkdtempSync(join(tmpdir(), "graak-napi-addon-"));
		try {
			const objects: string[] = [];
			const vars = { OS: toolchain.os, target_arch: toolchain.arch };
			const dependencies = settings.dependencies.map((dep) =>
				V8AddonBuilder.resolveDependency(dep, addon.sourceDir, vars)
			);
			const inherited = {
				includeDirs: dependencies.flatMap((d) => d.dependentIncludeDirs),
				defines: dependencies.flatMap((d) => d.dependentDefines),
			};
			const compileTarget = (t: GypTargetSettings, isMain: boolean) => {
				const includes = [apiDir, ...t.includeDirs, ...(isMain ? inherited.includeDirs : [])];
				const defines = [
					...t.defines,
					...(isMain ? inherited.defines : []),
					`NODE_GYP_MODULE_NAME=${settings.name}`,
					"BUILDING_NODE_EXTENSION",
					...(toolchain.windows ? ["WIN32_LEAN_AND_MEAN", "NOMINMAX", "_WIN32_WINNT=0x0600"] : []),
				];
				for (const source of t.sources) {
					const ext = extname(source).toLowerCase();
					if (![".c", ".cc", ".cpp", ".cxx"].includes(ext)) continue;
					const cxx = ext !== ".c";
					const object = join(work, `${objects.length}-${basename(source)}.o`);
					const args = [
						"-c",
						"-O2",
						"-fPIC",
						...(cxx ? ["-std=gnu++17"] : []),
						"-fvisibility=hidden",
						"-w",
						...(cxx ? t.cflagsCc : t.cflagsC),
						...t.cflags,
						...includes.map((d) => `-I${d}`),
						...defines.map((d) => `-D${d}`),
						source,
						"-o",
						object,
					];
					// gyp files often add flags for one compiler family; drop the ones ours does not accept.
					const filtered = args.filter((a) => !/^-flto|^-Wl,-rpath/.test(a));
					const res = spawnSync(cxx ? toolchain.cxx : toolchain.cc, filtered, { encoding: "utf-8" });
					if (res.status !== 0) {
						throw new RuntimeError(
							`Compiling ${relative(addon.sourceDir, source)} of ${addon.name} for ${meta.name} failed:\n` +
								`${spawnOutput(res).split("\n").slice(0, 25).join("\n")}`
						);
					}
					objects.push(object);
				}
			};

			for (const dep of dependencies) compileTarget(dep, false);
			compileTarget(settings, true);

			mkdirSync(cacheDir, { recursive: true });
			const linkArgs = [
				"-shared",
				"-o",
				outFile,
				...objects,
				...settings.ldflags.filter((f) => !/^-Wl,-rpath|^-flto/.test(f)),
			];
			if (toolchain.windows) {
				const importLib = V8AddonBuilder.writeImportLibrary(work, toolchain, apiDir);
				linkArgs.push(importLib, "-static", "-static-libgcc", "-static-libstdc++");
			} else {
				linkArgs.push("-static-libstdc++", "-static-libgcc", "-lpthread");
			}
			linkArgs.push(...settings.libraries.filter((l) => l.startsWith("-l")));
			const link = spawnSync(toolchain.cxx, linkArgs, { encoding: "utf-8" });
			if (link.status !== 0) {
				throw new RuntimeError(
					`Linking ${addon.name} for ${meta.name} failed:\n${spawnOutput(link).split("\n").slice(0, 25).join("\n")}`
				);
			}
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
		return { file: outFile, relativePath };
	}

	private static cacheKey(settings: GypTargetSettings, target: string): string {
		const hash = createHash("sha256");
		hash.update(target);
		for (const source of settings.sources) {
			if (existsSync(source) && statSync(source).isFile()) hash.update(source).update(readFileSync(source));
		}
		hash.update(
			JSON.stringify([settings.defines, settings.cflags, settings.cflagsCc, settings.libraries, settings.dependencies])
		);
		return hash.digest("hex").slice(0, 24);
	}
}
