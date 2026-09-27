"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NativeAddonCompiler = void 0;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const structures_1 = require("../structures");
const NodeRuntime_1 = require("./NodeRuntime");
const SpawnOutput_1 = require("./SpawnOutput");
const V8AddonBuilder_1 = require("./V8AddonBuilder");
class NativeAddonCompiler {
    /** Whether a from-source Node-API addon can be built for this target at all (needs its cross toolchain). */
    static supports(target, libc) {
        return libc === "musl-dynamic" ? target in V8AddonBuilder_1.MUSL_TOOLCHAINS : target in V8AddonBuilder_1.TOOLCHAINS;
    }
    /** Compiles `addon` for `target`. Throws, naming the reason, when it cannot. */
    static build(options) {
        const { addon, target } = options;
        const log = options.onLog ?? (() => { });
        const meta = structures_1.TARGET_METADATA_MAP[target];
        const toolchain = options.libc === "musl-dynamic" ? V8AddonBuilder_1.MUSL_TOOLCHAINS[target] : V8AddonBuilder_1.TOOLCHAINS[target];
        if (!toolchain) {
            throw new structures_1.RuntimeError(`${addon.name} ships only source (a binding.gyp, no prebuilt .node for any platform), and Graak ` +
                `compiles those with the target's own C/C++ toolchain, which is not wired up for ${meta.name} yet.`);
        }
        for (const tool of [toolchain.cc, toolchain.cxx, ...(toolchain.dlltool ? [toolchain.dlltool] : [])]) {
            if (!(0, V8AddonBuilder_1.hasTool)(tool)) {
                throw new structures_1.RuntimeError(`Building ${addon.name} for ${meta.name} needs ${tool}, which is not installed.`);
            }
        }
        const gypFile = (0, node_path_1.join)(addon.sourceDir, "binding.gyp");
        if (!(0, node_fs_1.existsSync)(gypFile)) {
            throw new structures_1.RuntimeError(`${addon.name} has no binding.gyp at ${addon.sourceDir}; nothing to compile.`);
        }
        const gyp = (0, V8AddonBuilder_1.parseGyp)((0, node_fs_1.readFileSync)(gypFile, "utf-8"));
        const vars = {
            OS: toolchain.os,
            target_arch: toolchain.arch,
            module_root_dir: addon.sourceDir,
            node_root_dir: addon.sourceDir,
            library: "static_library",
            ...V8AddonBuilder_1.V8AddonBuilder.topLevelVariables(gyp),
        };
        const targets = (Array.isArray(gyp.targets) ? gyp.targets : []);
        const main = targets.find((t) => String(t.target_name) === addon.name) ?? targets[0];
        if (!main)
            throw new structures_1.RuntimeError(`${addon.name}: binding.gyp defines no targets.`);
        const settings = V8AddonBuilder_1.V8AddonBuilder.resolveTarget(main, gypFile, vars, addon.sourceDir);
        const cacheKey = NativeAddonCompiler.cacheKey(settings, `${target}:${options.libc ?? ""}`);
        const cacheDir = (0, node_path_1.join)(NodeRuntime_1.NodeRuntime.cacheDir(), "native-addons", cacheKey);
        const outFile = (0, node_path_1.join)(cacheDir, `${settings.name}.node`);
        const relativePath = `build/Release/${settings.name}.node`;
        if ((0, node_fs_1.existsSync)(outFile))
            return { file: outFile, relativePath };
        // node-gyp only makes sense for a native build: it configures whatever toolchain the *building*
        // machine already has for its *own* OS/arch, not Graak's cross toolchains for other targets.
        const buildingNative = options.libc !== "musl-dynamic" &&
            toolchain.os === (process.platform === "win32" ? "win" : "linux") &&
            toolchain.arch === (process.arch === "x64" ? "x64" : "ia32");
        if (buildingNative && (0, V8AddonBuilder_1.hasTool)("node-gyp") && ((0, V8AddonBuilder_1.hasTool)("python3") || (0, V8AddonBuilder_1.hasTool)("python"))) {
            const viaNodeGyp = NativeAddonCompiler.buildWithNodeGyp(addon, settings, log);
            if (viaNodeGyp) {
                (0, node_fs_1.mkdirSync)(cacheDir, { recursive: true });
                (0, node_fs_1.copyFileSync)(viaNodeGyp, outFile);
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
    static buildWithNodeGyp(addon, settings, log) {
        log(`Trying node-gyp for ${addon.name} (a native build: it cannot target another platform/arch)`);
        const res = (0, node_child_process_1.spawnSync)("node-gyp", ["rebuild"], { cwd: addon.sourceDir, encoding: "utf-8", timeout: 300_000 });
        if (res.status !== 0) {
            log(`node-gyp did not build ${addon.name} (${(0, SpawnOutput_1.spawnOutput)(res).split("\n")[0] ?? "unknown error"}); compiling directly instead`);
            return null;
        }
        const built = (0, node_path_1.join)(addon.sourceDir, "build/Release", `${settings.name}.node`);
        return (0, node_fs_1.existsSync)(built) ? built : null;
    }
    /** Direct `cc`/`c++` invocation against the vendored Node-API headers, using the target's own toolchain. */
    static compileDirect(addon, settings, toolchain, target, cacheDir, outFile, relativePath) {
        const meta = structures_1.TARGET_METADATA_MAP[target];
        const repoRoot = (0, node_path_1.dirname)(require.resolve("../../package.json"));
        const apiDir = (0, node_path_1.join)(repoRoot, "quickjs/native/include");
        const work = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "graak-napi-addon-"));
        try {
            const objects = [];
            const vars = { OS: toolchain.os, target_arch: toolchain.arch };
            const dependencies = settings.dependencies.map((dep) => V8AddonBuilder_1.V8AddonBuilder.resolveDependency(dep, addon.sourceDir, vars));
            const inherited = {
                includeDirs: dependencies.flatMap((d) => d.dependentIncludeDirs),
                defines: dependencies.flatMap((d) => d.dependentDefines),
            };
            const compileTarget = (t, isMain) => {
                const includes = [apiDir, ...t.includeDirs, ...(isMain ? inherited.includeDirs : [])];
                const defines = [
                    ...t.defines,
                    ...(isMain ? inherited.defines : []),
                    `NODE_GYP_MODULE_NAME=${settings.name}`,
                    "BUILDING_NODE_EXTENSION",
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
                    const res = (0, node_child_process_1.spawnSync)(cxx ? toolchain.cxx : toolchain.cc, filtered, { encoding: "utf-8" });
                    if (res.status !== 0) {
                        throw new structures_1.RuntimeError(`Compiling ${(0, node_path_1.relative)(addon.sourceDir, source)} of ${addon.name} for ${meta.name} failed:\n` +
                            `${(0, SpawnOutput_1.spawnOutput)(res).split("\n").slice(0, 25).join("\n")}`);
                    }
                    objects.push(object);
                }
            };
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
                const importLib = V8AddonBuilder_1.V8AddonBuilder.writeImportLibrary(work, toolchain, apiDir);
                linkArgs.push(importLib, "-static", "-static-libgcc", "-static-libstdc++");
            }
            else {
                linkArgs.push("-static-libstdc++", "-static-libgcc", "-lpthread");
            }
            linkArgs.push(...settings.libraries.filter((l) => l.startsWith("-l")));
            const link = (0, node_child_process_1.spawnSync)(toolchain.cxx, linkArgs, { encoding: "utf-8" });
            if (link.status !== 0) {
                throw new structures_1.RuntimeError(`Linking ${addon.name} for ${meta.name} failed:\n${(0, SpawnOutput_1.spawnOutput)(link).split("\n").slice(0, 25).join("\n")}`);
            }
        }
        finally {
            (0, node_fs_1.rmSync)(work, { recursive: true, force: true });
        }
        return { file: outFile, relativePath };
    }
    static cacheKey(settings, target) {
        const hash = (0, node_crypto_1.createHash)("sha256");
        hash.update(target);
        for (const source of settings.sources) {
            if ((0, node_fs_1.existsSync)(source) && (0, node_fs_1.statSync)(source).isFile())
                hash.update(source).update((0, node_fs_1.readFileSync)(source));
        }
        hash.update(JSON.stringify([settings.defines, settings.cflags, settings.cflagsCc, settings.libraries, settings.dependencies]));
        return hash.digest("hex").slice(0, 24);
    }
}
exports.NativeAddonCompiler = NativeAddonCompiler;
//# sourceMappingURL=NativeAddonCompiler.js.map