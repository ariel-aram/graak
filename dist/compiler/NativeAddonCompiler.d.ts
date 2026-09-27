import { type TargetDevice } from "../structures";
import type { SourceOnlyAddon } from "./ProjectCollector";
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
export declare class NativeAddonCompiler {
    /** Whether a from-source Node-API addon can be built for this target at all (needs its cross toolchain). */
    static supports(target: TargetDevice, libc?: "musl-dynamic" | string): boolean;
    /** Compiles `addon` for `target`. Throws, naming the reason, when it cannot. */
    static build(options: {
        addon: SourceOnlyAddon;
        target: TargetDevice;
        /** "musl-dynamic" builds for a musl host (Alpine, iSH); anything else uses the target's default. */
        libc?: string;
        onLog?: (message: string) => void;
    }): NativeAddonBuildResult;
    /**
     * `node-gyp rebuild` in the package's own directory, for a native (non-cross) build. Returns the
     * built file, or null when node-gyp itself failed (offline, no matching Node headers cached, an
     * unsupported gyp feature) so the caller falls back to compiling directly.
     */
    private static buildWithNodeGyp;
    /** Direct `cc`/`c++` invocation against the vendored Node-API headers, using the target's own toolchain. */
    private static compileDirect;
    private static cacheKey;
}
//# sourceMappingURL=NativeAddonCompiler.d.ts.map