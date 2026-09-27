"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.V8AddonBuilder = exports.MUSL_TOOLCHAINS = exports.TOOLCHAINS = void 0;
exports.isV8Addon = isV8Addon;
exports.parseGyp = parseGyp;
exports.hasTool = hasTool;
exports.copyAddon = copyAddon;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const structures_1 = require("../structures");
const NodeRuntime_1 = require("./NodeRuntime");
const SpawnOutput_1 = require("./SpawnOutput");
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
function isV8Addon(file) {
    let bytes;
    try {
        bytes = (0, node_fs_1.readFileSync)(file);
    }
    catch {
        return false;
    }
    if (NAPI_SIGNATURES.some((sig) => bytes.includes(sig)))
        return false;
    return V8_SIGNATURES.some((sig) => bytes.includes(sig));
}
/** gyp files are Python dict literals: single or double quotes, `#` comments, trailing commas. */
function parseGyp(text) {
    let i = 0;
    const fail = (message) => {
        const line = text.slice(0, i).split("\n").length;
        throw new structures_1.RuntimeError(`binding.gyp: ${message} (line ${line})`);
    };
    const skip = () => {
        for (;;) {
            while (i < text.length && /\s/.test(text[i]))
                i++;
            if (text[i] === "#")
                while (i < text.length && text[i] !== "\n")
                    i++;
            else
                return;
        }
    };
    const string = () => {
        const quote = text[i++];
        let out = "";
        while (i < text.length && text[i] !== quote) {
            if (text[i] === "\\") {
                const next = text[i + 1];
                out += next === "n" ? "\n" : next === "t" ? "\t" : next;
                i += 2;
            }
            else
                out += text[i++];
        }
        if (text[i] !== quote)
            fail("unterminated string");
        i++;
        return out;
    };
    const value = () => {
        skip();
        const c = text[i];
        if (c === "{") {
            i++;
            const obj = {};
            for (;;) {
                skip();
                if (text[i] === "}") {
                    i++;
                    return obj;
                }
                const key = text[i] === "'" || text[i] === '"' ? string() : fail("expected a key");
                skip();
                if (text[i] !== ":")
                    fail("expected ':'");
                i++;
                obj[key] = value();
                skip();
                if (text[i] === ",")
                    i++;
            }
        }
        if (c === "[") {
            i++;
            const list = [];
            for (;;) {
                skip();
                if (text[i] === "]") {
                    i++;
                    return list;
                }
                list.push(value());
                skip();
                if (text[i] === ",")
                    i++;
            }
        }
        if (c === "'" || c === '"') {
            let s = string();
            // Adjacent literals concatenate in Python.
            for (;;) {
                skip();
                if (text[i] !== "'" && text[i] !== '"')
                    return s;
                s += string();
            }
        }
        const word = /^-?[A-Za-z0-9_.]+/.exec(text.slice(i))?.[0];
        if (!word)
            return fail(`unexpected '${c}'`);
        i += word.length;
        if (word === "True")
            return true;
        if (word === "False")
            return false;
        if (word === "None")
            return null;
        const n = Number(word);
        return Number.isNaN(n) ? word : n;
    };
    const root = value();
    if (!root || typeof root !== "object" || Array.isArray(root))
        fail("expected a dictionary at the top level");
    return root;
}
const asList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
/** Evaluates the small condition language addons use: `OS=="win"`, `target_arch!="ia32"`, `and`/`or`. */
function evalCondition(expr, vars) {
    const clause = (part) => {
        const m = /^\s*\(?\s*([A-Za-z_]+)\s*(==|!=)\s*['"]([^'"]*)['"]\s*\)?\s*$/.exec(part);
        if (!m)
            throw new structures_1.RuntimeError(`binding.gyp: cannot evaluate the condition '${expr}'`);
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
];
function collectSettings(block, vars, into, dependent) {
    for (const key of SETTING_KEYS) {
        if (key === "conditions" || key.endsWith("dependent_settings"))
            continue;
        into[key] = [...(into[key] ?? []), ...asList(block[key])];
    }
    for (const key of ["direct_dependent_settings", "all_dependent_settings"]) {
        const settings = block[key];
        if (settings && typeof settings === "object" && !Array.isArray(settings))
            dependent.push(settings);
    }
    const conditions = block.conditions;
    if (!Array.isArray(conditions))
        return;
    for (const condition of conditions) {
        if (!Array.isArray(condition) || typeof condition[0] !== "string")
            continue;
        const [expr, then, otherwise] = condition;
        const branch = evalCondition(expr, vars) ? then : otherwise;
        if (branch && typeof branch === "object" && !Array.isArray(branch))
            collectSettings(branch, vars, into, dependent);
    }
}
exports.TOOLCHAINS = {
    [structures_1.TargetDevice.LinuxModernX64]: {
        cc: "x86_64-linux-gnu-gcc",
        cxx: "x86_64-linux-gnu-g++",
        windows: false,
        os: "linux",
        arch: "x64",
    },
    [structures_1.TargetDevice.WinVistaX64]: {
        cc: "x86_64-w64-mingw32-gcc",
        cxx: "x86_64-w64-mingw32-g++-posix",
        dlltool: "x86_64-w64-mingw32-dlltool",
        windows: true,
        os: "win",
        arch: "x64",
    },
    [structures_1.TargetDevice.WinLegacyX64]: {
        cc: "x86_64-w64-mingw32-gcc",
        cxx: "x86_64-w64-mingw32-g++-posix",
        dlltool: "x86_64-w64-mingw32-dlltool",
        windows: true,
        os: "win",
        arch: "x64",
    },
    [structures_1.TargetDevice.WinVistaX86]: {
        cc: "i686-w64-mingw32-gcc",
        cxx: "i686-w64-mingw32-g++-posix",
        dlltool: "i686-w64-mingw32-dlltool",
        windows: true,
        os: "win",
        arch: "ia32",
    },
    [structures_1.TargetDevice.WinLegacyX86]: {
        cc: "i686-w64-mingw32-gcc",
        cxx: "i686-w64-mingw32-g++-posix",
        dlltool: "i686-w64-mingw32-dlltool",
        windows: true,
        os: "win",
        arch: "ia32",
    },
    [structures_1.TargetDevice.WinXpX86]: {
        cc: "i686-w64-mingw32-gcc",
        cxx: "i686-w64-mingw32-g++-posix",
        dlltool: "i686-w64-mingw32-dlltool",
        windows: true,
        os: "win",
        arch: "ia32",
    },
};
/** Where the host is musl-based (Alpine, iSH), addons are musl-linked, and are built with musl.cc's toolchains. */
exports.MUSL_TOOLCHAINS = {
    [structures_1.TargetDevice.LinuxModernX64]: {
        cc: "x86_64-linux-musl-gcc",
        cxx: "x86_64-linux-musl-g++",
        windows: false,
        os: "linux",
        arch: "x64",
    },
    [structures_1.TargetDevice.LinuxX86]: {
        cc: "i686-linux-musl-gcc",
        cxx: "i686-linux-musl-g++",
        windows: false,
        os: "linux",
        arch: "ia32",
    },
    [structures_1.TargetDevice.IosIshX86]: {
        cc: "i686-linux-musl-gcc",
        cxx: "i686-linux-musl-g++",
        windows: false,
        os: "linux",
        arch: "ia32",
    },
};
function hasTool(tool) {
    return (0, node_child_process_1.spawnSync)("sh", ["-c", `command -v ${tool}`], { encoding: "utf-8" }).status === 0;
}
const HOST_EXE_NAME = "graak-c.exe";
class V8AddonBuilder {
    /** Whether V8 addons can be built for this target at all (needs the target's cross toolchain). */
    static supports(target, libc) {
        return libc === "musl-dynamic" ? target in exports.MUSL_TOOLCHAINS : target in exports.TOOLCHAINS;
    }
    /** Groups the project's V8 addons by owning package. `entries` are what the archive will contain. */
    static find(entries) {
        const packages = new Map();
        for (const entry of entries) {
            if (!entry.path.endsWith(".node") || typeof entry.source !== "string")
                continue;
            if (!isV8Addon(entry.source))
                continue;
            const packageDir = V8AddonBuilder.packageDirOf(entry.source);
            const key = packageDir ?? (0, node_path_1.dirname)(entry.source);
            const existing = packages.get(key);
            if (existing)
                existing.addonPaths.push(entry.path);
            else
                packages.set(key, {
                    packageDir: key,
                    name: packageDir ? (0, node_path_1.basename)(packageDir) : (0, node_path_1.basename)((0, node_path_1.dirname)(entry.source)),
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
    static async fetchSource(pkg, options = {}) {
        if (options.offline)
            return null;
        let manifest;
        try {
            manifest = JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.join)(pkg.packageDir, "package.json"), "utf-8"));
        }
        catch {
            return null;
        }
        const repo = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
        const directory = typeof manifest.repository === "object" ? (manifest.repository?.directory ?? "") : "";
        const match = /(?:github(?:\.com)?[:/])([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[#/].*)?$/i.exec(repo ?? "") ??
            /^([\w.-]+)\/([\w.-]+)$/.exec(repo ?? "");
        if (!match || !manifest.version)
            return null;
        const [, owner, name] = match;
        const cache = (0, node_path_1.join)(NodeRuntime_1.NodeRuntime.cacheDir(), "v8-sources", `${owner}-${name}-${manifest.version}`);
        const found = (dir) => ((0, node_fs_1.existsSync)((0, node_path_1.join)(dir, "binding.gyp")) ? dir : null);
        if ((0, node_fs_1.existsSync)(cache))
            return found((0, node_path_1.join)(cache, directory));
        const base = (options.mirror ?? "https://codeload.github.com").replace(/\/$/, "");
        const refs = [manifest.gitHead, `v${manifest.version}`, manifest.version].filter((r) => Boolean(r));
        for (const ref of refs) {
            let response;
            try {
                response = await fetch(`${base}/${owner}/${name}/tar.gz/${ref}`);
            }
            catch {
                continue;
            }
            if (!response.ok)
                continue;
            options.onLog?.(`${pkg.name} ships no source: fetching ${owner}/${name}@${ref} from its repository`);
            const work = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "graak-v8src-"));
            try {
                const archive = (0, node_path_1.join)(work, "source.tar.gz");
                (0, node_fs_1.writeFileSync)(archive, Buffer.from(await response.arrayBuffer()));
                (0, node_fs_1.mkdirSync)(cache, { recursive: true });
                const extract = (0, node_child_process_1.spawnSync)("tar", ["-xzf", archive, "-C", cache, "--strip-components=1"], { encoding: "utf-8" });
                if (extract.status !== 0) {
                    (0, node_fs_1.rmSync)(cache, { recursive: true, force: true });
                    continue;
                }
            }
            finally {
                (0, node_fs_1.rmSync)(work, { recursive: true, force: true });
            }
            return found((0, node_path_1.join)(cache, directory));
        }
        return null;
    }
    static packageDirOf(file) {
        let dir = (0, node_path_1.dirname)(file);
        for (let depth = 0; depth < 8; depth++) {
            if ((0, node_fs_1.existsSync)((0, node_path_1.join)(dir, "package.json")))
                return dir;
            const parent = (0, node_path_1.dirname)(dir);
            if (parent === dir)
                break;
            dir = parent;
        }
        return null;
    }
    /** Compiles the package's addon for `target`. Throws, naming the reason, when it cannot. */
    static build(options) {
        const { pkg, target } = options;
        const log = options.onLog ?? (() => { });
        const toolchain = options.libc === "musl-dynamic" ? exports.MUSL_TOOLCHAINS[target] : exports.TOOLCHAINS[target];
        const meta = structures_1.TARGET_METADATA_MAP[target];
        if (!toolchain) {
            throw new structures_1.RuntimeError(`${pkg.name} is a native addon compiled against V8, and Graak builds those from source with the ` +
                `target's own C++ toolchain, which is not wired up for ${meta.name} yet.`);
        }
        const root = pkg.sourceDir ?? pkg.packageDir;
        const gypFile = (0, node_path_1.join)(root, "binding.gyp");
        if (!(0, node_fs_1.existsSync)(gypFile)) {
            throw new structures_1.RuntimeError(`${pkg.name} ships only a prebuilt addon compiled against V8 -- there is no binding.gyp or source next to it -- ` +
                "and a V8 binary cannot load outside Node.js. Graak looks for the source in the package's " +
                "repository too (a GitHub tag matching its version); that found nothing or was not allowed (offline). " +
                "Use a version of the package that ships its source, or a Node-API build of it.");
        }
        for (const tool of [toolchain.cc, toolchain.cxx, ...(toolchain.dlltool ? [toolchain.dlltool] : [])]) {
            if (!hasTool(tool)) {
                throw new structures_1.RuntimeError(`Building ${pkg.name} for ${meta.name} needs ${tool}, which is not installed.`);
            }
        }
        const repoRoot = (0, node_path_1.dirname)(require.resolve("../../package.json"));
        const shimDir = (0, node_path_1.join)(repoRoot, "quickjs/native/v8");
        const apiDir = (0, node_path_1.join)(repoRoot, "quickjs/native/include");
        const gyp = parseGyp((0, node_fs_1.readFileSync)(gypFile, "utf-8"));
        const vars = {
            OS: toolchain.os,
            target_arch: toolchain.arch,
            module_root_dir: root,
            node_root_dir: shimDir,
            library: "static_library",
            ...V8AddonBuilder.topLevelVariables(gyp),
        };
        const targets = (Array.isArray(gyp.targets) ? gyp.targets : []);
        const wanted = new Set(pkg.addonPaths.map((p) => (0, node_path_1.basename)(p, ".node")));
        const main = targets.find((t) => wanted.has(String(t.target_name))) ?? (targets.length === 1 ? targets[0] : undefined);
        if (!main) {
            throw new structures_1.RuntimeError(`${pkg.name}: binding.gyp defines no target named like the addon it ships (${[...wanted].join(", ")}).`);
        }
        const settings = V8AddonBuilder.resolveTarget(main, gypFile, vars, pkg.packageDir);
        const cacheKey = V8AddonBuilder.cacheKey(pkg.packageDir, settings, `${target}:${options.libc ?? ""}`, shimDir);
        const cacheDir = (0, node_path_1.join)(NodeRuntime_1.NodeRuntime.cacheDir(), "v8-addons", cacheKey);
        const outFile = (0, node_path_1.join)(cacheDir, `${settings.name}.node`);
        const relativePath = `build/Release/${settings.name}.node`;
        if ((0, node_fs_1.existsSync)(outFile))
            return { file: outFile, relativePath };
        log(`Building ${pkg.name} (${settings.name}) from source against Graak's V8 layer for ${meta.name}`);
        const work = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "graak-v8addon-"));
        try {
            const objects = [];
            const nan = V8AddonBuilder.findNan(pkg.packageDir);
            const commonIncludes = [shimDir, apiDir, ...(nan ? [nan] : [])];
            // A dependency target's `direct_dependent_settings` apply to whatever depends on it: this is how
            // a vendored zlib makes its own headers visible to the addon that uses it.
            const dependencies = settings.dependencies.map((dep) => V8AddonBuilder.resolveDependency(dep, pkg.packageDir, vars));
            const inherited = {
                includeDirs: dependencies.flatMap((d) => d.dependentIncludeDirs),
                defines: dependencies.flatMap((d) => d.dependentDefines),
            };
            const compileTarget = (t, isMain) => {
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
                    const ext = (0, node_path_1.extname)(source).toLowerCase();
                    if (![".c", ".cc", ".cpp", ".cxx"].includes(ext))
                        continue;
                    const cxx = ext !== ".c";
                    const object = (0, node_path_1.join)(work, `${objects.length}-${(0, node_path_1.basename)(source)}.o`);
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
                    const res = (0, node_child_process_1.spawnSync)(cxx ? toolchain.cxx : toolchain.cc, filtered, { encoding: "utf-8" });
                    if (res.status !== 0) {
                        throw new structures_1.RuntimeError(`Compiling ${(0, node_path_1.relative)(root, source)} of ${pkg.name} for ${meta.name} failed:\n${(0, SpawnOutput_1.spawnOutput)(res).split("\n").slice(0, 25).join("\n")}`);
                    }
                    objects.push(object);
                }
            };
            // Dependencies first (static libraries their objects are linked straight into the addon).
            for (const dep of dependencies)
                compileTarget(dep, false);
            compileTarget(settings, true);
            (0, node_fs_1.mkdirSync)(cacheDir, { recursive: true });
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
            }
            else {
                linkArgs.push("-static-libstdc++", "-static-libgcc", "-lpthread");
            }
            linkArgs.push(...settings.libraries.filter((l) => l.startsWith("-l")));
            const link = (0, node_child_process_1.spawnSync)(toolchain.cxx, linkArgs, { encoding: "utf-8" });
            if (link.status !== 0) {
                throw new structures_1.RuntimeError(`Linking ${pkg.name} for ${meta.name} failed:\n${(0, SpawnOutput_1.spawnOutput)(link).split("\n").slice(0, 25).join("\n")}`);
            }
        }
        finally {
            (0, node_fs_1.rmSync)(work, { recursive: true, force: true });
        }
        return { file: outFile, relativePath };
    }
    /**
     * Replaces a package's V8 `.node` files in the archive with the one built from source. The built
     * file goes where `bindings` and `node-gyp-build` look first, and any prebuilt binary for another
     * platform is dropped: it cannot run here and only adds weight.
     */
    static replace(entries, pkg, built, packageArchiveDir) {
        for (const path of pkg.addonPaths) {
            const index = entries.findIndex((e) => e.path === path);
            if (index >= 0)
                entries.splice(index, 1);
        }
        entries.push({ path: `${packageArchiveDir}/${built.relativePath}`, source: built.file, mode: 0o755 });
    }
    /** Archive directory of a package, from the archive path of one of its files. */
    static archiveDirOf(addonPath) {
        const marker = "node_modules/";
        const at = addonPath.lastIndexOf(marker);
        if (at < 0)
            return (0, node_path_1.dirname)(addonPath);
        const rest = addonPath.slice(at + marker.length).split("/");
        const depth = rest[0].startsWith("@") ? 2 : 1;
        return addonPath.slice(0, at + marker.length) + rest.slice(0, depth).join("/");
    }
    static topLevelVariables(gyp) {
        const out = {};
        const variables = gyp.variables;
        if (variables && typeof variables === "object" && !Array.isArray(variables)) {
            for (const [k, v] of Object.entries(variables))
                if (typeof v === "string")
                    out[k.replace(/%$/, "")] = v;
        }
        return out;
    }
    static expand(value, vars, packageDir, gypDir) {
        let out = value;
        // <!(node -e "require('nan')") : the include directory of a package, resolved from the project.
        out = out.replace(/<!@?\(\s*node\s+-(?:e|p)\s+["']?\s*require\(\s*\\?['"]([\w@/.-]+)\\?['"]\s*\)(\.include)?\s*["']?\s*\)/g, (_m, pkgName) => {
            const found = V8AddonBuilder.findPackage(pkgName, packageDir);
            if (!found)
                throw new structures_1.RuntimeError(`binding.gyp needs the package '${pkgName}', which is not installed.`);
            return found;
        });
        out = out.replace(/<\(([A-Za-z_]+)\)/g, (_m, name) => {
            if (name === "module_root_dir")
                return vars.module_root_dir ?? packageDir;
            if (name === "DEPTH")
                return gypDir;
            if (name in vars)
                return vars[name];
            throw new structures_1.RuntimeError(`binding.gyp uses the variable '<(${name})', which Graak's gyp reader does not define.`);
        });
        if (/<!?\(/.test(out)) {
            throw new structures_1.RuntimeError(`binding.gyp uses a command expansion Graak's gyp reader does not support: ${value}`);
        }
        return out;
    }
    static resolveTarget(block, gypFile, vars, packageDir) {
        const gypDir = (0, node_path_1.dirname)(gypFile);
        const into = {};
        const dependent = [];
        collectSettings(block, vars, into, dependent);
        const ex = (list) => (list ?? []).map((s) => V8AddonBuilder.expand(s, vars, packageDir, gypDir));
        const abs = (p) => ((0, node_path_1.isAbsolute)(p) ? p : (0, node_path_1.resolve)(gypDir, p));
        const dependentInto = {};
        for (const d of dependent)
            collectSettings(d, vars, dependentInto, []);
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
    static resolveDependency(spec, packageDir, vars) {
        const [file, name] = spec.split(":");
        const gypFile = (0, node_path_1.resolve)(vars.module_root_dir ?? packageDir, file);
        if (!(0, node_fs_1.existsSync)(gypFile))
            throw new structures_1.RuntimeError(`binding.gyp depends on '${spec}', but ${file} does not exist.`);
        const gyp = parseGyp((0, node_fs_1.readFileSync)(gypFile, "utf-8"));
        const merged = { ...vars, ...V8AddonBuilder.topLevelVariables(gyp) };
        const target = (Array.isArray(gyp.targets) ? gyp.targets : []).find((t) => !name || t.target_name === name);
        if (!target)
            throw new structures_1.RuntimeError(`binding.gyp depends on '${spec}', but no such target exists in ${file}.`);
        return V8AddonBuilder.resolveTarget(target, gypFile, merged, packageDir);
    }
    static findPackage(name, from) {
        let dir = from;
        for (;;) {
            const candidate = (0, node_path_1.join)(dir, "node_modules", name);
            if ((0, node_fs_1.existsSync)((0, node_path_1.join)(candidate, "package.json")))
                return candidate;
            const parent = (0, node_path_1.dirname)(dir);
            if (parent === dir)
                return null;
            dir = parent;
        }
    }
    static findNan(packageDir) {
        return V8AddonBuilder.findPackage("nan", packageDir);
    }
    /**
     * Windows addons import their Node-API functions from a named module. Naming the host's own
     * executable makes the loader bind them to the running Graak host, which exports them.
     */
    static writeImportLibrary(dir, toolchain, apiDir) {
        const names = new Set();
        for (const header of ["js_native_api.h", "node_api.h"]) {
            const text = (0, node_fs_1.readFileSync)((0, node_path_1.join)(apiDir, header), "utf-8").replace(/\n/g, " ");
            for (const m of text.matchAll(/\b((?:napi|node_api)_[a-z0-9_]+)\s*\(/g))
                names.add(m[1]);
        }
        const def = (0, node_path_1.join)(dir, "host.def");
        (0, node_fs_1.writeFileSync)(def, `LIBRARY "${HOST_EXE_NAME}"\nEXPORTS\n${[...names].sort().join("\n")}\n`);
        const lib = (0, node_path_1.join)(dir, "libhost.a");
        const res = (0, node_child_process_1.spawnSync)(toolchain.dlltool, ["-d", def, "-l", lib], { encoding: "utf-8" });
        if (res.status !== 0)
            throw new structures_1.RuntimeError(`Could not create the Node-API import library:\n${(0, SpawnOutput_1.spawnOutput)(res)}`);
        return lib;
    }
    static cacheKey(packageDir, settings, target, shimDir) {
        const hash = (0, node_crypto_1.createHash)("sha256");
        hash.update(target);
        const addFiles = (dir) => {
            for (const entry of (0, node_fs_1.readdirSync)(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
                const path = (0, node_path_1.join)(dir, entry.name);
                if (entry.isDirectory())
                    addFiles(path);
                else
                    hash.update(entry.name).update((0, node_fs_1.readFileSync)(path));
            }
        };
        addFiles(shimDir);
        for (const source of settings.sources)
            if ((0, node_fs_1.existsSync)(source) && (0, node_fs_1.statSync)(source).isFile())
                hash.update(source).update((0, node_fs_1.readFileSync)(source));
        hash.update(JSON.stringify([settings.defines, settings.cflags, settings.cflagsCc, settings.libraries, settings.dependencies]));
        void packageDir;
        return hash.digest("hex").slice(0, 24);
    }
}
exports.V8AddonBuilder = V8AddonBuilder;
// Kept for tests and callers that want to copy a built addon somewhere.
function copyAddon(from, to) {
    (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(to), { recursive: true });
    (0, node_fs_1.copyFileSync)(from, to);
}
//# sourceMappingURL=V8AddonBuilder.js.map