import { TargetDevice, type TargetMetadata } from "../structures";
import { type PackageManager } from "./PolicyEnforcer";
import { type IntlData, type NativeHostLibc } from "./QuickJsPackager";
import { type StaticSiteOptions } from "./StaticSite";
export type BuildStrategy = "auto" | "sea" | "portable";
/** Which engine runs the program: Graak's native host (quickjs-ng), or a Node.js runtime. `auto` follows the target. */
export type BuildEngine = "auto" | "native" | "node";
/**
 * Runtimes below this major need their bundled code lowered and the modern platform APIs
 * supplied. Node.js 20 is the floor because that is where the last of what current discord.js
 * reaches for lands: `fetch`, Web Streams and `AbortController` are Node 18, but undici also
 * calls `String.prototype.toWellFormed`, which is Node 20.
 */
export declare const MIN_MODERN_API_NODE_MAJOR = 20;
/**
 * Lowest runtime the legacy pipeline can actually serve. esbuild refuses to emit below ES6
 * ("Transforming const to the configured target environment is not supported yet"), so a
 * runtime older than Node.js 6 cannot have modern code lowered for it at all. That is a real
 * ceiling, not a setting: the Windows Vista pin (Node.js 5.12.0) sits below it.
 */
export declare const MIN_TRANSPILABLE_NODE_MAJOR = 6;
export type LegacyRuntimePlan = {
    kind: "modern";
} | {
    kind: "lower";
    jsTarget: string;
} | {
    kind: "unreachable";
    reason: string;
};
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
export declare const DEFAULT_OUTPUT_DIR = "graak-out";
export declare class BinaryPackager {
    /**
     * Builds a program into a Node.js Single Executable Application when the target
     * runtime supports it, otherwise into a portable bundle (launcher + archive + runtime).
     */
    /**
     * The project directory of an entry file: the closest one with a package.json, or with a deno.json(c) when a Deno
     * project has no package.json (or keeps its config nearer to the entry).
     */
    static findRoot(entry: string): string;
    static compile(options: BuildOptions): Promise<BuildResult>;
    /**
     * Decides whether a build needs the legacy treatment, and which language level to lower to.
     * `null` means the runtime is modern enough to run current code as published.
     *
     * The esbuild target is built from the runtime's own major and minor rather than a fixed
     * string, so lowering is never more aggressive than the runtime requires.
     */
    static legacyRuntimePlan(runtimeVersion: string | null): LegacyRuntimePlan;
    /**
     * A prebuilt addon compiled against V8 cannot load outside Node.js, but the package that ships it
     * usually ships its source too. That source is rebuilt here against Graak's V8 layer for the
     * target -- from any build machine, whatever platform the installed prebuild was for.
     *
     * Packages that are only optional accelerators, with a host that cannot load addons anyway, are
     * left alone: building them would produce something the host then could not use.
     */
    private static rebuildV8Addons;
    /**
     * A dependency that ships only a `binding.gyp` and C/C++ source -- no prebuilt `.node` for any
     * platform -- cannot be `require()`d as-is: nothing was ever placed at the path its own `index.js`
     * loads. This compiles it here, against the Node-API headers the native host itself implements
     * (`quickjs/native/napi.c`), so the result loads exactly the way any other addon does. See
     * NativeAddonCompiler for the toolchain and the node-gyp / direct-compile fallback it tries.
     */
    private static compileSourceAddons;
    /**
     * On Windows Vista and 7, redirects the few imports a prebuilt addon (or a DLL it ships) needs that
     * those systems lack, to compatibility DLLs shipped beside it. See Win7Compat.
     */
    private static applyWin7Compat;
    /**
     * Some addons and DLLs (libvips, for sharp) link the Universal C Runtime. Windows 7 has it only with
     * update KB2999226. Microsoft allows shipping it app-local, so when a directory of those DLLs is
     * given (the `Redist\\ucrt\\DLLs\\<arch>` folder of a Windows SDK) they are copied beside the file
     * that needs them; without one, the build says what will happen.
     */
    private static bundleUcrt;
    private static checkNativeAddons;
    private static selectRuntime;
    /**
     * The SEA blob should be produced by the same Node.js version it is injected into.
     */
    private static selectGenerator;
}
//# sourceMappingURL=BinaryPackager.d.ts.map