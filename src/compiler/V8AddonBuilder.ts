import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
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
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { RuntimeError, TARGET_METADATA_MAP, TargetDevice } from "../structures";
import type { ArchiveEntry } from "./Archive";
import { NodeRuntime } from "./NodeRuntime";
import { spawnOutput } from "./SpawnOutput";

/**
 * Builds native addons written against V8 or NAN from their source, for a Graak native host.
 *
 * WHY. Such an addon, as a prebuilt binary, reads V8's own object layout, which exists only inside
 * Node.js; no other host can run it. Its *source* is another matter: it is C++ written against a
 * documented API, and Graak ships an implementation of that API on top of Node-API
 * (`quickjs/native/v8/`). Compiling the same source against that implementation yields an addon that
 * imports only `napi_*` functions -- the same kind every other addon this host loads already is.
 *
 * SCOPE. It reads the package's `binding.gyp` (a subset of gyp: targets, sources, include_dirs, defines,
 * cflags, libraries, dependent static-library targets, and `conditions` on OS/arch) and compiles with
 * the target's own cross toolchain. That covers the common case, and a package whose gyp file uses
 * something outside the subset stops the build naming exactly what, rather than producing a wrong
 * binary. A package that ships no source cannot be rebuilt, and is reported as such.
 */

const V8_SIGNATURES = ["_ZN2v8", "@v8@@"];
const NAPI_SIGNATURES = ["napi_register_module_v1", "napi_module_register"];

/** Whether an addon was compiled against V8 itself (and so cannot load outside Node.js as-is). */
export function isV8Addon(file: string): boolean {
	let bytes: Buffer;
	try {
		bytes = readFileSync(file);
	} catch {
		return false;
	}
	if (NAPI_SIGNATURES.some((sig) => bytes.includes(sig))) return false;
	return V8_SIGNATURES.some((sig) => bytes.includes(sig));
}

/* ---- gyp ------------------------------------------------------------------------------------ */

export type GypValue = string | number | boolean | null | GypValue[] | { [key: string]: GypValue };
export type GypDict = { [key: string]: GypValue };

/** gyp files are Python dict literals: single or double quotes, `#` comments, trailing commas. */
export function parseGyp(text: string): GypDict {
	let i = 0;
	const fail = (message: string): never => {
		const line = text.slice(0, i).split("\n").length;
		throw new RuntimeError(`binding.gyp: ${message} (line ${line})`);
	};
	const skip = () => {
		for (;;) {
			while (i < text.length && /\s/.test(text[i])) i++;
			if (text[i] === "#") while (i < text.length && text[i] !== "\n") i++;
			else return;
		}
	};
	const string = (): string => {
		const quote = text[i++];
		let out = "";
		while (i < text.length && text[i] !== quote) {
			if (text[i] === "\\") {
				const next = text[i + 1];
				out += next === "n" ? "\n" : next === "t" ? "\t" : next;
				i += 2;
			} else out += text[i++];
		}
		if (text[i] !== quote) fail("unterminated string");
		i++;
		return out;
	};
	const value = (): GypValue => {
		skip();
		const c = text[i];
		if (c === "{") {
			i++;
			const obj: GypDict = {};
			for (;;) {
				skip();
				if (text[i] === "}") {
					i++;
					return obj;
				}
				const key = text[i] === "'" || text[i] === '"' ? string() : fail("expected a key");
				skip();
				if (text[i] !== ":") fail("expected ':'");
				i++;
				obj[key] = value();
				skip();
				if (text[i] === ",") i++;
			}
		}
		if (c === "[") {
			i++;
			const list: GypValue[] = [];
			for (;;) {
				skip();
				if (text[i] === "]") {
					i++;
					return list;
				}
				list.push(value());
				skip();
				if (text[i] === ",") i++;
			}
		}
		if (c === "'" || c === '"') {
			let s = string();
			// Adjacent literals concatenate in Python.
			for (;;) {
				skip();
				if (text[i] !== "'" && text[i] !== '"') return s;
				s += string();
			}
		}
		const word = /^-?[A-Za-z0-9_.]+/.exec(text.slice(i))?.[0];
		if (!word) return fail(`unexpected '${c}'`);
		i += word.length;
		if (word === "True") return true;
		if (word === "False") return false;
		if (word === "None") return null;
		const n = Number(word);
		return Number.isNaN(n) ? word : n;
	};
	const root = value();
	if (!root || typeof root !== "object" || Array.isArray(root)) fail("expected a dictionary at the top level");
	return root as GypDict;
}

export interface GypTargetSettings {
	name: string;
	type: string;
	sources: string[];
	includeDirs: string[];
	defines: string[];
	cflags: string[];
	cflagsC: string[];
	cflagsCc: string[];
	ldflags: string[];
	libraries: string[];
	dependencies: string[];
	dependentIncludeDirs: string[];
	dependentDefines: string[];
	gypDir: string;
}

export interface Vars {
	OS: string;
	target_arch: string;
	[key: string]: string;
}

const asList = (v: GypValue | undefined): string[] =>
	(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []) as string[];

/** Evaluates the small condition language addons use: `OS=="win"`, `target_arch!="ia32"`, `and`/`or`. */
function evalCondition(expr: string, vars: Vars): boolean {
	const clause = (part: string): boolean => {
		const m = /^\s*\(?\s*([A-Za-z_]+)\s*(==|!=)\s*['"]([^'"]*)['"]\s*\)?\s*$/.exec(part);
		if (!m) throw new RuntimeError(`binding.gyp: cannot evaluate the condition '${expr}'`);
		const actual = vars[m[1]] ?? "";
		return m[2] === "==" ? actual === m[3] : actual !== m[3];
	};
	return expr.split(/\s+or\s+/).some((orPart) => orPart.split(/\s+and\s+/).every(clause));
}

const SETTING_KEYS = [
	"sources",
	"include_dirs",
	"defines",
	"cflags",
	"cflags_c",
	"cflags_cc",
	"ldflags",
	"libraries",
	"dependencies",
	"conditions",
	"direct_dependent_settings",
	"all_dependent_settings",
] as const;

function collectSettings(
	block: GypDict,
	vars: Vars,
	into: Partial<Record<(typeof SETTING_KEYS)[number], string[]>>,
	dependent: GypDict[]
) {
	for (const key of SETTING_KEYS) {
		if (key === "conditions" || key.endsWith("dependent_settings")) continue;
		into[key] = [...(into[key] ?? []), ...asList(block[key])];
	}
	for (const key of ["direct_dependent_settings", "all_dependent_settings"]) {
		const settings = block[key];
		if (settings && typeof settings === "object" && !Array.isArray(settings)) dependent.push(settings as GypDict);
	}
	const conditions = block.conditions;
	if (!Array.isArray(conditions)) return;
	for (const condition of conditions) {
		if (!Array.isArray(condition) || typeof condition[0] !== "string") continue;
		const [expr, then, otherwise] = condition as [string, GypValue, GypValue | undefined];
		const branch = evalCondition(expr, vars) ? then : otherwise;
		if (branch && typeof branch === "object" && !Array.isArray(branch))
			collectSettings(branch as GypDict, vars, into, dependent);
	}
}

/* ---- toolchains ----------------------------------------------------------------------------- */

export interface Toolchain {
	cc: string;
	cxx: string;
	dlltool?: string;
	windows: boolean;
	os: "linux" | "win";
	arch: "x64" | "ia32";
}

export const TOOLCHAINS: Partial<Record<TargetDevice, Toolchain>> = {
	[TargetDevice.LinuxModernX64]: {
		cc: "x86_64-linux-gnu-gcc",
		cxx: "x86_64-linux-gnu-g++",
		windows: false,
		os: "linux",
		arch: "x64",
	},
	[TargetDevice.WinVistaX64]: {
		cc: "x86_64-w64-mingw32-gcc",
		cxx: "x86_64-w64-mingw32-g++-posix",
		dlltool: "x86_64-w64-mingw32-dlltool",
		windows: true,
		os: "win",
		arch: "x64",
	},
	[TargetDevice.WinLegacyX64]: {
		cc: "x86_64-w64-mingw32-gcc",
		cxx: "x86_64-w64-mingw32-g++-posix",
		dlltool: "x86_64-w64-mingw32-dlltool",
		windows: true,
		os: "win",
		arch: "x64",
	},
	[TargetDevice.WinVistaX86]: {
		cc: "i686-w64-mingw32-gcc",
		cxx: "i686-w64-mingw32-g++-posix",
		dlltool: "i686-w64-mingw32-dlltool",
		windows: true,
		os: "win",
		arch: "ia32",
	},
	[TargetDevice.WinLegacyX86]: {
		cc: "i686-w64-mingw32-gcc",
		cxx: "i686-w64-mingw32-g++-posix",
		dlltool: "i686-w64-mingw32-dlltool",
		windows: true,
		os: "win",
		arch: "ia32",
	},
	[TargetDevice.WinXpX86]: {
		cc: "i686-w64-mingw32-gcc",
		cxx: "i686-w64-mingw32-g++-posix",
		dlltool: "i686-w64-mingw32-dlltool",
		windows: true,
		os: "win",
		arch: "ia32",
	},
};

/** Where the host is musl-based (Alpine, iSH), addons are musl-linked, and are built with musl.cc's toolchains. */
export const MUSL_TOOLCHAINS: Partial<Record<TargetDevice, Toolchain>> = {
	[TargetDevice.LinuxModernX64]: {
		cc: "x86_64-linux-musl-gcc",
		cxx: "x86_64-linux-musl-g++",
		windows: false,
		os: "linux",
		arch: "x64",
	},
	[TargetDevice.LinuxX86]: {
		cc: "i686-linux-musl-gcc",
		cxx: "i686-linux-musl-g++",
		windows: false,
		os: "linux",
		arch: "ia32",
	},
	[TargetDevice.IosIshX86]: {
		cc: "i686-linux-musl-gcc",
		cxx: "i686-linux-musl-g++",
		windows: false,
		os: "linux",
		arch: "ia32",
	},
};

export function hasTool(tool: string): boolean {
	return spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf-8" }).status === 0;
}

/* ---- build ---------------------------------------------------------------------------------- */

export interface V8AddonPackage {
	/** Absolute directory of the package that owns the addon. */
	packageDir: string;
	/** Where the source to build lives, when it is not next to the addon (fetched from the package's repository). */
	sourceDir?: string;
	/** Package name as it appears under node_modules. */
	name: string;
	/** Archive paths of that package's V8 `.node` files. */
	addonPaths: string[];
}

export interface V8BuildResult {
	/** Built addon, on disk. */
	file: string;
	/** Where the addon belongs inside the package (`build/Release/<target>.node`). */
	relativePath: string;
}

const HOST_EXE_NAME = "graak-c.exe";

export class V8AddonBuilder {
	/** Whether V8 addons can be built for this target at all (needs the target's cross toolchain). */
	public static supports(target: TargetDevice, libc?: "musl-dynamic" | string): boolean {
		return libc === "musl-dynamic" ? target in MUSL_TOOLCHAINS : target in TOOLCHAINS;
	}

	/** Groups the project's V8 addons by owning package. `entries` are what the archive will contain. */
	public static find(entries: readonly ArchiveEntry[]): V8AddonPackage[] {
		const packages = new Map<string, V8AddonPackage>();
		for (const entry of entries) {
			if (!entry.path.endsWith(".node") || typeof entry.source !== "string") continue;
			if (!isV8Addon(entry.source)) continue;
			const packageDir = V8AddonBuilder.packageDirOf(entry.source);
			const key = packageDir ?? dirname(entry.source);
			const existing = packages.get(key);
			if (existing) existing.addonPaths.push(entry.path);
			else
				packages.set(key, {
					packageDir: key,
					name: packageDir ? basename(packageDir) : basename(dirname(entry.source)),
					addonPaths: [entry.path],
				});
		}
		return [...packages.values()];
	}

	/**
	 * A package that ships only its prebuilt binary usually still names its repository, and the tag for
	 * the version installed holds the source. This fetches that (from GitHub, or `mirror`, which serves
	 * codeload.github.com's paths) into the cache and returns the directory holding `binding.gyp`.
	 */
	public static async fetchSource(
		pkg: V8AddonPackage,
		options: { offline?: boolean; mirror?: string; onLog?: (message: string) => void } = {}
	): Promise<string | null> {
		if (options.offline) return null;
		let manifest: {
			name?: string;
			version?: string;
			gitHead?: string;
			repository?: string | { url?: string; directory?: string };
		};
		try {
			manifest = JSON.parse(readFileSync(join(pkg.packageDir, "package.json"), "utf-8"));
		} catch {
			return null;
		}
		const repo = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
		const directory = typeof manifest.repository === "object" ? (manifest.repository?.directory ?? "") : "";
		const match =
			/(?:github(?:\.com)?[:/])([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[#/].*)?$/i.exec(repo ?? "") ??
			/^([\w.-]+)\/([\w.-]+)$/.exec(repo ?? "");
		if (!match || !manifest.version) return null;
		const [, owner, name] = match;
		const cache = join(NodeRuntime.cacheDir(), "v8-sources", `${owner}-${name}-${manifest.version}`);
		const found = (dir: string) => (existsSync(join(dir, "binding.gyp")) ? dir : null);
		if (existsSync(cache)) return found(join(cache, directory));

		const base = (options.mirror ?? "https://codeload.github.com").replace(/\/$/, "");
		const refs = [manifest.gitHead, `v${manifest.version}`, manifest.version].filter((r): r is string => Boolean(r));
		for (const ref of refs) {
			let response: Response;
			try {
				response = await fetch(`${base}/${owner}/${name}/tar.gz/${ref}`);
			} catch {
				continue;
			}
			if (!response.ok) continue;
			options.onLog?.(`${pkg.name} ships no source: fetching ${owner}/${name}@${ref} from its repository`);
			const work = mkdtempSync(join(tmpdir(), "graak-v8src-"));
			try {
				const archive = join(work, "source.tar.gz");
				writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
				mkdirSync(cache, { recursive: true });
				const extract = spawnSync("tar", ["-xzf", archive, "-C", cache, "--strip-components=1"], { encoding: "utf-8" });
				if (extract.status !== 0) {
					rmSync(cache, { recursive: true, force: true });
					continue;
				}
			} finally {
				rmSync(work, { recursive: true, force: true });
			}
			return found(join(cache, directory));
		}
		return null;
	}

	private static packageDirOf(file: string): string | null {
		let dir = dirname(file);
		for (let depth = 0; depth < 8; depth++) {
			if (existsSync(join(dir, "package.json"))) return dir;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
		return null;
	}

	/** Compiles the package's addon for `target`. Throws, naming the reason, when it cannot. */
	public static build(options: {
		pkg: V8AddonPackage;
		target: TargetDevice;
		/** "musl-dynamic" builds for a musl host (Alpine, iSH); anything else uses the target's default. */
		libc?: string;
		onLog?: (message: string) => void;
	}): V8BuildResult {
		const { pkg, target } = options;
		const log = options.onLog ?? (() => {});
		const toolchain = options.libc === "musl-dynamic" ? MUSL_TOOLCHAINS[target] : TOOLCHAINS[target];
		const meta = TARGET_METADATA_MAP[target];
		if (!toolchain) {
			throw new RuntimeError(
				`${pkg.name} is a native addon compiled against V8, and Graak builds those from source with the ` +
					`target's own C++ toolchain, which is not wired up for ${meta.name} yet.`
			);
		}
		const root = pkg.sourceDir ?? pkg.packageDir;
		const gypFile = join(root, "binding.gyp");
		if (!existsSync(gypFile)) {
			throw new RuntimeError(
				`${pkg.name} ships only a prebuilt addon compiled against V8 -- there is no binding.gyp or source next to it -- ` +
					"and a V8 binary cannot load outside Node.js. Graak looks for the source in the package's " +
					"repository too (a GitHub tag matching its version); that found nothing or was not allowed (offline). " +
					"Use a version of the package that ships its source, or a Node-API build of it."
			);
		}
		for (const tool of [toolchain.cc, toolchain.cxx, ...(toolchain.dlltool ? [toolchain.dlltool] : [])]) {
			if (!hasTool(tool)) {
				throw new RuntimeError(`Building ${pkg.name} for ${meta.name} needs ${tool}, which is not installed.`);
			}
		}

		const repoRoot = dirname(require.resolve("../../package.json"));
		const shimDir = join(repoRoot, "quickjs/native/v8");
		const apiDir = join(repoRoot, "quickjs/native/include");
		const gyp = parseGyp(readFileSync(gypFile, "utf-8"));
		const vars: Vars = {
			OS: toolchain.os,
			target_arch: toolchain.arch,
			module_root_dir: root,
			node_root_dir: shimDir,
			library: "static_library",
			...V8AddonBuilder.topLevelVariables(gyp),
		};
		const targets = (Array.isArray(gyp.targets) ? gyp.targets : []) as GypDict[];
		const wanted = new Set(pkg.addonPaths.map((p) => basename(p, ".node")));
		const main =
			targets.find((t) => wanted.has(String(t.target_name))) ?? (targets.length === 1 ? targets[0] : undefined);
		if (!main) {
			throw new RuntimeError(
				`${pkg.name}: binding.gyp defines no target named like the addon it ships (${[...wanted].join(", ")}).`
			);
		}

		const settings = V8AddonBuilder.resolveTarget(main, gypFile, vars, pkg.packageDir);
		const cacheKey = V8AddonBuilder.cacheKey(pkg.packageDir, settings, `${target}:${options.libc ?? ""}`, shimDir);
		const cacheDir = join(NodeRuntime.cacheDir(), "v8-addons", cacheKey);
		const outFile = join(cacheDir, `${settings.name}.node`);
		const relativePath = `build/Release/${settings.name}.node`;
		if (existsSync(outFile)) return { file: outFile, relativePath };

		log(`Building ${pkg.name} (${settings.name}) from source against Graak's V8 layer for ${meta.name}`);
		const work = mkdtempSync(join(tmpdir(), "graak-v8addon-"));
		try {
			const objects: string[] = [];
			const nan = V8AddonBuilder.findNan(pkg.packageDir);
			const commonIncludes = [shimDir, apiDir, ...(nan ? [nan] : [])];
			// A dependency target's `direct_dependent_settings` apply to whatever depends on it: this is how
			// a vendored zlib makes its own headers visible to the addon that uses it.
			const dependencies = settings.dependencies.map((dep) =>
				V8AddonBuilder.resolveDependency(dep, pkg.packageDir, vars)
			);
			const inherited = {
				includeDirs: dependencies.flatMap((d) => d.dependentIncludeDirs),
				defines: dependencies.flatMap((d) => d.dependentDefines),
			};
			const compileTarget = (t: GypTargetSettings, isMain: boolean) => {
				const includes = [...commonIncludes, ...t.includeDirs, ...(isMain ? inherited.includeDirs : [])];
				const defines = [
					...t.defines,
					...(isMain ? inherited.defines : []),
					`NODE_GYP_MODULE_NAME=${settings.name}`,
					"BUILDING_NODE_EXTENSION",
					"USING_UV_SHARED=1",
					"USING_V8_SHARED=1",
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
						...(cxx ? ["-std=gnu++17", "-fno-exceptions"] : []),
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
							`Compiling ${relative(root, source)} of ${pkg.name} for ${meta.name} failed:\n${spawnOutput(res).split("\n").slice(0, 25).join("\n")}`
						);
					}
					objects.push(object);
				}
			};

			// Dependencies first (static libraries their objects are linked straight into the addon).
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
					`Linking ${pkg.name} for ${meta.name} failed:\n${spawnOutput(link).split("\n").slice(0, 25).join("\n")}`
				);
			}
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
		return { file: outFile, relativePath };
	}

	/**
	 * Replaces a package's V8 `.node` files in the archive with the one built from source. The built
	 * file goes where `bindings` and `node-gyp-build` look first, and any prebuilt binary for another
	 * platform is dropped: it cannot run here and only adds weight.
	 */
	public static replace(
		entries: ArchiveEntry[],
		pkg: V8AddonPackage,
		built: V8BuildResult,
		packageArchiveDir: string
	): void {
		for (const path of pkg.addonPaths) {
			const index = entries.findIndex((e) => e.path === path);
			if (index >= 0) entries.splice(index, 1);
		}
		entries.push({ path: `${packageArchiveDir}/${built.relativePath}`, source: built.file, mode: 0o755 });
	}

	/** Archive directory of a package, from the archive path of one of its files. */
	public static archiveDirOf(addonPath: string): string {
		const marker = "node_modules/";
		const at = addonPath.lastIndexOf(marker);
		if (at < 0) return dirname(addonPath);
		const rest = addonPath.slice(at + marker.length).split("/");
		const depth = rest[0].startsWith("@") ? 2 : 1;
		return addonPath.slice(0, at + marker.length) + rest.slice(0, depth).join("/");
	}

	public static topLevelVariables(gyp: GypDict): Record<string, string> {
		const out: Record<string, string> = {};
		const variables = gyp.variables;
		if (variables && typeof variables === "object" && !Array.isArray(variables)) {
			for (const [k, v] of Object.entries(variables)) if (typeof v === "string") out[k.replace(/%$/, "")] = v;
		}
		return out;
	}

	private static expand(value: string, vars: Vars, packageDir: string, gypDir: string): string {
		let out = value;
		// <!(node -e "require('nan')") : the include directory of a package, resolved from the project.
		out = out.replace(
			/<!@?\(\s*node\s+-(?:e|p)\s+["']?\s*require\(\s*\\?['"]([\w@/.-]+)\\?['"]\s*\)(\.include)?\s*["']?\s*\)/g,
			(_m, pkgName: string) => {
				const found = V8AddonBuilder.findPackage(pkgName, packageDir);
				if (!found) throw new RuntimeError(`binding.gyp needs the package '${pkgName}', which is not installed.`);
				return found;
			}
		);
		out = out.replace(/<\(([A-Za-z_]+)\)/g, (_m, name: string) => {
			if (name === "module_root_dir") return vars.module_root_dir ?? packageDir;
			if (name === "DEPTH") return gypDir;
			if (name in vars) return vars[name];
			throw new RuntimeError(`binding.gyp uses the variable '<(${name})', which Graak's gyp reader does not define.`);
		});
		if (/<!?\(/.test(out)) {
			throw new RuntimeError(`binding.gyp uses a command expansion Graak's gyp reader does not support: ${value}`);
		}
		return out;
	}

	public static resolveTarget(block: GypDict, gypFile: string, vars: Vars, packageDir: string): GypTargetSettings {
		const gypDir = dirname(gypFile);
		const into: Partial<Record<(typeof SETTING_KEYS)[number], string[]>> = {};
		const dependent: GypDict[] = [];
		collectSettings(block, vars, into, dependent);
		const ex = (list: string[] | undefined) =>
			(list ?? []).map((s) => V8AddonBuilder.expand(s, vars, packageDir, gypDir));
		const abs = (p: string) => (isAbsolute(p) ? p : resolve(gypDir, p));
		const dependentInto: Partial<Record<(typeof SETTING_KEYS)[number], string[]>> = {};
		for (const d of dependent) collectSettings(d, vars, dependentInto, []);
		return {
			name: String(block.target_name ?? "addon"),
			type: String(block.type ?? "loadable_module"),
			sources: ex(into.sources).map(abs),
			includeDirs: ex(into.include_dirs).map(abs),
			defines: ex(into.defines),
			cflags: ex(into.cflags),
			cflagsC: ex(into.cflags_c),
			cflagsCc: ex(into.cflags_cc),
			ldflags: ex(into.ldflags),
			libraries: ex(into.libraries),
			dependencies: ex(into.dependencies),
			dependentIncludeDirs: ex(dependentInto.include_dirs).map(abs),
			dependentDefines: ex(dependentInto.defines),
			gypDir,
		};
	}

	/** `deps/zlib.gyp:zlib` -> the settings of that target in that file. */
	public static resolveDependency(spec: string, packageDir: string, vars: Vars): GypTargetSettings {
		const [file, name] = spec.split(":");
		const gypFile = resolve(vars.module_root_dir ?? packageDir, file);
		if (!existsSync(gypFile)) throw new RuntimeError(`binding.gyp depends on '${spec}', but ${file} does not exist.`);
		const gyp = parseGyp(readFileSync(gypFile, "utf-8"));
		const merged: Vars = { ...vars, ...V8AddonBuilder.topLevelVariables(gyp) };
		const target = ((Array.isArray(gyp.targets) ? gyp.targets : []) as GypDict[]).find(
			(t) => !name || t.target_name === name
		);
		if (!target) throw new RuntimeError(`binding.gyp depends on '${spec}', but no such target exists in ${file}.`);
		return V8AddonBuilder.resolveTarget(target, gypFile, merged, packageDir);
	}

	private static findPackage(name: string, from: string): string | null {
		let dir = from;
		for (;;) {
			const candidate = join(dir, "node_modules", name);
			if (existsSync(join(candidate, "package.json"))) return candidate;
			const parent = dirname(dir);
			if (parent === dir) return null;
			dir = parent;
		}
	}

	private static findNan(packageDir: string): string | null {
		return V8AddonBuilder.findPackage("nan", packageDir);
	}

	/**
	 * Windows addons import their Node-API functions from a named module. Naming the host's own
	 * executable makes the loader bind them to the running Graak host, which exports them.
	 */
	public static writeImportLibrary(dir: string, toolchain: Toolchain, apiDir: string): string {
		const names = new Set<string>();
		for (const header of ["js_native_api.h", "node_api.h"]) {
			const text = readFileSync(join(apiDir, header), "utf-8").replace(/\n/g, " ");
			for (const m of text.matchAll(/\b((?:napi|node_api)_[a-z0-9_]+)\s*\(/g)) names.add(m[1]);
		}
		const def = join(dir, "host.def");
		writeFileSync(def, `LIBRARY "${HOST_EXE_NAME}"\nEXPORTS\n${[...names].sort().join("\n")}\n`);
		const lib = join(dir, "libhost.a");
		const res = spawnSync(toolchain.dlltool as string, ["-d", def, "-l", lib], { encoding: "utf-8" });
		if (res.status !== 0) throw new RuntimeError(`Could not create the Node-API import library:\n${spawnOutput(res)}`);
		return lib;
	}

	private static cacheKey(packageDir: string, settings: GypTargetSettings, target: string, shimDir: string): string {
		const hash = createHash("sha256");
		hash.update(target);
		const addFiles = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) addFiles(path);
				else hash.update(entry.name).update(readFileSync(path));
			}
		};
		addFiles(shimDir);
		for (const source of settings.sources)
			if (existsSync(source) && statSync(source).isFile()) hash.update(source).update(readFileSync(source));
		hash.update(
			JSON.stringify([settings.defines, settings.cflags, settings.cflagsCc, settings.libraries, settings.dependencies])
		);
		void packageDir;
		return hash.digest("hex").slice(0, 24);
	}
}

// Kept for tests and callers that want to copy a built addon somewhere.
export function copyAddon(from: string, to: string): void {
	mkdirSync(dirname(to), { recursive: true });
	copyFileSync(from, to);
}
