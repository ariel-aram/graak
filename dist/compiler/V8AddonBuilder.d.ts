import { TargetDevice } from "../structures";
import type { ArchiveEntry } from "./Archive";
/** Whether an addon was compiled against V8 itself (and so cannot load outside Node.js as-is). */
export declare function isV8Addon(file: string): boolean;
export type GypValue = string | number | boolean | null | GypValue[] | {
    [key: string]: GypValue;
};
export type GypDict = {
    [key: string]: GypValue;
};
/** gyp files are Python dict literals: single or double quotes, `#` comments, trailing commas. */
export declare function parseGyp(text: string): GypDict;
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
export interface Toolchain {
    cc: string;
    cxx: string;
    dlltool?: string;
    windows: boolean;
    os: "linux" | "win";
    arch: "x64" | "ia32";
}
export declare const TOOLCHAINS: Partial<Record<TargetDevice, Toolchain>>;
/** Where the host is musl-based (Alpine, iSH), addons are musl-linked, and are built with musl.cc's toolchains. */
export declare const MUSL_TOOLCHAINS: Partial<Record<TargetDevice, Toolchain>>;
export declare function hasTool(tool: string): boolean;
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
export declare class V8AddonBuilder {
    /** Whether V8 addons can be built for this target at all (needs the target's cross toolchain). */
    static supports(target: TargetDevice, libc?: "musl-dynamic" | string): boolean;
    /** Groups the project's V8 addons by owning package. `entries` are what the archive will contain. */
    static find(entries: readonly ArchiveEntry[]): V8AddonPackage[];
    /**
     * A package that ships only its prebuilt binary usually still names its repository, and the tag for
     * the version installed holds the source. This fetches that (from GitHub, or `mirror`, which serves
     * codeload.github.com's paths) into the cache and returns the directory holding `binding.gyp`.
     */
    static fetchSource(pkg: V8AddonPackage, options?: {
        offline?: boolean;
        mirror?: string;
        onLog?: (message: string) => void;
    }): Promise<string | null>;
    private static packageDirOf;
    /** Compiles the package's addon for `target`. Throws, naming the reason, when it cannot. */
    static build(options: {
        pkg: V8AddonPackage;
        target: TargetDevice;
        /** "musl-dynamic" builds for a musl host (Alpine, iSH); anything else uses the target's default. */
        libc?: string;
        onLog?: (message: string) => void;
    }): V8BuildResult;
    /**
     * Replaces a package's V8 `.node` files in the archive with the one built from source. The built
     * file goes where `bindings` and `node-gyp-build` look first, and any prebuilt binary for another
     * platform is dropped: it cannot run here and only adds weight.
     */
    static replace(entries: ArchiveEntry[], pkg: V8AddonPackage, built: V8BuildResult, packageArchiveDir: string): void;
    /** Archive directory of a package, from the archive path of one of its files. */
    static archiveDirOf(addonPath: string): string;
    static topLevelVariables(gyp: GypDict): Record<string, string>;
    private static expand;
    static resolveTarget(block: GypDict, gypFile: string, vars: Vars, packageDir: string): GypTargetSettings;
    /** `deps/zlib.gyp:zlib` -> the settings of that target in that file. */
    static resolveDependency(spec: string, packageDir: string, vars: Vars): GypTargetSettings;
    private static findPackage;
    private static findNan;
    /**
     * Windows addons import their Node-API functions from a named module. Naming the host's own
     * executable makes the loader bind them to the running Graak host, which exports them.
     */
    static writeImportLibrary(dir: string, toolchain: Toolchain, apiDir: string): string;
    private static cacheKey;
}
export declare function copyAddon(from: string, to: string): void;
//# sourceMappingURL=V8AddonBuilder.d.ts.map