"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectCollector = exports.NATIVE_ONLY_ENTRY_EXTENSIONS = void 0;
exports.packageArchiveDirOf = packageArchiveDirOf;
exports.isInside = isInside;
exports.resolveInside = resolveInside;
exports.compareVersions = compareVersions;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const structures_1 = require("../structures");
const BinaryInspector_1 = require("./BinaryInspector");
const WasmShimGenerator_1 = require("./WasmShimGenerator");
const ALWAYS_EXCLUDED_NAMES = new Set([
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    ".DS_Store",
    "Thumbs.db",
    ".npmrc",
    ".yarnrc",
    ".yarnrc.yml",
    ".yarn",
    ".pnpm-store",
    ".graak-cache",
    "coverage",
]);
const SUPPORTED_ENTRY_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".ts", ".mts", ".cts", ".tsx", ".jsx"]);
/** Entry extensions only the native host can run: it converts them at build time. Node.js targets need built JavaScript. */
exports.NATIVE_ONLY_ENTRY_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".tsx", ".jsx"]);
const SOURCE_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);
const BUN_API_PATTERN = /\bBun\.[a-zA-Z]|["']bun:[a-z]/;
/** What of Bun the native host does not provide: everything but `bun:sqlite`. */
const BUN_GLOBALS_PATTERN = /\bBun\.[a-zA-Z]|["']bun:(?!sqlite["'])[a-z]/;
function toPosix(p) {
    return p.split(node_path_1.sep).join("/");
}
/** Archive directory of a package, from the archive path of one of its files (e.g. its `binding.gyp` or `.node`). */
function packageArchiveDirOf(path) {
    const marker = "node_modules/";
    const at = path.lastIndexOf(marker);
    if (at < 0)
        return (0, node_path_1.dirname)(path);
    const rest = path.slice(at + marker.length).split("/");
    const depth = rest[0].startsWith("@") ? 2 : 1;
    return path.slice(0, at + marker.length) + rest.slice(0, depth).join("/");
}
function isInside(child, parent) {
    const rel = (0, node_path_1.relative)(parent, child);
    return rel === "" || (rel.split(node_path_1.sep)[0] !== ".." && !(0, node_path_1.isAbsolute)(rel));
}
/**
 * Resolves `input` against `root` and throws when it escapes `root` (symlinks included).
 */
function resolveInside(root, input) {
    const absRoot = (0, node_path_1.resolve)(root);
    const abs = (0, node_path_1.resolve)(absRoot, input);
    if (!isInside(abs, absRoot))
        throw new structures_1.PathOutsideRootError(input, absRoot);
    if ((0, node_fs_1.existsSync)(abs) && !isInside((0, node_fs_1.realpathSync)(abs), (0, node_fs_1.realpathSync)(absRoot))) {
        throw new structures_1.PathOutsideRootError(input, absRoot);
    }
    return abs;
}
function readJson(file) {
    try {
        return JSON.parse((0, node_fs_1.readFileSync)(file, "utf-8"));
    }
    catch {
        return null;
    }
}
function parseMinVersion(range) {
    if (typeof range !== "string")
        return null;
    // Use the smallest version referenced by the range: good enough for ">=x", "^x", "x || y"
    const versions = [...range.matchAll(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/g)].map((m) => `${m[1]}.${m[2] ?? 0}.${m[3] ?? 0}`);
    return versions.sort(compareVersions)[0] ?? null;
}
function compareVersions(a, b) {
    const pa = a.replace(/^v/, "").split(".").map(Number);
    const pb = b.replace(/^v/, "").split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0)
            return d;
    }
    return 0;
}
class ProjectCollector {
    root;
    options;
    excluded;
    /**
     * Finds the closest directory above `start` that contains a package.json.
     */
    static findProjectRoot(start) {
        let dir = (0, node_path_1.resolve)(start);
        if ((0, node_fs_1.existsSync)(dir) && (0, node_fs_1.statSync)(dir).isFile())
            dir = (0, node_path_1.dirname)(dir);
        for (;;) {
            if ((0, node_fs_1.existsSync)((0, node_path_1.join)(dir, "package.json")))
                return dir;
            const parent = (0, node_path_1.dirname)(dir);
            if (parent === dir) {
                throw new structures_1.ProjectError(`No package.json found above '${start}'`);
            }
            dir = parent;
        }
    }
    static collect(options) {
        const entryAbs = (0, node_path_1.resolve)(options.entrypoint);
        if (!(0, node_fs_1.existsSync)(entryAbs) || !(0, node_fs_1.statSync)(entryAbs).isFile()) {
            throw new structures_1.ProjectError(`Entrypoint file not found: ${entryAbs}`);
        }
        const ext = (0, node_path_1.extname)(entryAbs);
        if (!SUPPORTED_ENTRY_EXTENSIONS.has(ext)) {
            throw new structures_1.ProjectError(`Entrypoint '${(0, node_path_1.basename)(entryAbs)}' must be JavaScript (.js, .cjs, .mjs) or TypeScript (.ts, .tsx). ` +
                "Compile TypeScript first (e.g. `tsc`, or `bun build --target=node --outdir dist`) and pass the built file.");
        }
        const root = (0, node_fs_1.realpathSync)(ProjectCollector.findProjectRoot(entryAbs));
        const entryReal = (0, node_fs_1.realpathSync)(entryAbs);
        if (!isInside(entryReal, root))
            throw new structures_1.PathOutsideRootError(entryAbs, root);
        if ((0, node_fs_1.existsSync)((0, node_path_1.join)(root, ".pnp.cjs")) || (0, node_fs_1.existsSync)((0, node_path_1.join)(root, ".pnp.js"))) {
            // BinaryPackager.compile() handles this itself (see YarnPnpCompat): it materializes a
            // real node_modules tree in a throwaway copy before ever calling collect(), so this
            // only fires when collect() is called directly on a PnP project without going through
            // that step.
            throw new structures_1.ProjectError("Yarn Plug'n'Play projects have no node_modules for ProjectCollector to bundle directly. " +
                "Build through BinaryPackager.compile() (or the CLI), which materializes one via YarnPnpCompat " +
                "automatically, or set `nodeLinker: node-modules` in .yarnrc.yml yourself and reinstall.");
        }
        const pkg = readJson((0, node_path_1.join)(root, "package.json")) ?? {};
        const excluded = (options.excludePaths ?? []).map((p) => (0, node_path_1.resolve)(p));
        const collector = new ProjectCollector(root, options, excluded);
        collector.addProjectFiles(root, "");
        collector.addDependencies(pkg, options.includeDev === true);
        collector.addEngines(pkg);
        const rawName = typeof pkg.name === "string" ? pkg.name : (0, node_path_1.basename)(root);
        const nodeArchiveDirs = new Set(collector.nativeAddons.map((a) => packageArchiveDirOf(a.path)));
        // The package name a prebuilt native addon actually came from, for the case below: a platform-specific
        // optional dependency (e.g. "@lmdb/lmdb-linux-x64") carries the real ".node", not the package with the
        // "binding.gyp" ("lmdb" itself), which only needs the gyp file to build for platforms with no such prebuilt.
        // packageArchiveDirOf's own return value already is "node_modules/<name>" (or "node_modules/@scope/name"),
        // so the package name is what follows that marker -- no filesystem read needed (the dest path is relative).
        const nativeAddonPackageNames = new Set([...nodeArchiveDirs].map((dir) => dir.slice(dir.lastIndexOf("node_modules/") + "node_modules/".length)));
        const sourceOnlyAddons = [];
        const seenArchiveDirs = new Set();
        for (const gyp of collector.gypFiles) {
            const archiveDir = packageArchiveDirOf(gyp.dest);
            // A package that already ships a matching prebuilt `.node` needs no from-source build.
            if (seenArchiveDirs.has(archiveDir) || nodeArchiveDirs.has(archiveDir))
                continue;
            seenArchiveDirs.add(archiveDir);
            // Nor does one whose own optional/regular dependencies already resolved to a package that provided a
            // prebuilt: a platform package picked for this build stands in for the binding.gyp build.
            const ownPkg = readJson((0, node_path_1.join)((0, node_path_1.dirname)(gyp.abs), "package.json")) ?? {};
            const depNames = [
                ...Object.keys(ownPkg.optionalDependencies ?? {}),
                ...Object.keys(ownPkg.dependencies ?? {}),
            ];
            if (depNames.some((n) => nativeAddonPackageNames.has(n)))
                continue;
            sourceOnlyAddons.push({ archiveDir, sourceDir: (0, node_path_1.dirname)(gyp.abs), name: (0, node_path_1.basename)(archiveDir) });
        }
        // A ready-made binding for every ".wasm" the project ships: a module compiled from Rust, Zig, C or anything
        // else that targets wasm32 needs no hand-written loader -- its own export table says what to expose. Skipped
        // when the project already has its own "<file>.wasm.js" (a hand-written loader takes precedence) or the
        // module imports something besides WASI (an arbitrary "env" object nothing here can supply on its own).
        const existingDests = new Set(collector.entries.map((e) => e.path));
        for (const entry of [...collector.entries]) {
            if (!entry.path.endsWith(".wasm") || typeof entry.source !== "string")
                continue;
            const shimPath = `${entry.path}.js`;
            if (existingDests.has(shimPath))
                continue;
            let shim;
            try {
                shim = (0, WasmShimGenerator_1.generateWasmShim)((0, node_fs_1.readFileSync)(entry.source), (0, node_path_1.basename)(entry.path));
            }
            catch {
                continue; // not a well-formed module, or a section shape this reader does not follow: ship the .wasm alone
            }
            if (shim)
                collector.entries.push({ path: shimPath, source: Buffer.from(shim, "utf-8"), mode: entry.mode });
        }
        return {
            root,
            name: rawName.replace(/^@[^/]+\//, "").replace(/[^a-zA-Z0-9._-]/g, "-") || "app",
            entry: toPosix((0, node_path_1.relative)(root, entryReal)),
            entries: collector.entries,
            nativeAddons: collector.nativeAddons,
            sourceOnlyAddons,
            minNode: collector.minNode,
            usesBunApis: collector.usesBunApis,
            usesBunGlobals: collector.usesBunGlobals,
            packages: collector.placed.size,
        };
    }
    entries = [];
    nativeAddons = [];
    /** `binding.gyp` files seen under a dependency, {dest: archive path, abs: on-disk path}. */
    gypFiles = [];
    usesBunApis = [];
    usesBunGlobals = [];
    minNode = null;
    /** Destination package dir (e.g. "node_modules/a/node_modules/b") -> real source dir. */
    placed = new Map();
    /** Positions that must stay empty because a package resolves past them. */
    reserved = new Set();
    visitedDirs = new Set();
    constructor(root, options, excluded) {
        this.root = root;
        this.options = options;
        this.excluded = excluded;
    }
    isExcluded(abs, name, isProjectFile) {
        if (ALWAYS_EXCLUDED_NAMES.has(name))
            return true;
        if (name.endsWith(".graak"))
            return true;
        if (isProjectFile && !this.options.includeEnv && /^\.env(\..*)?$/.test(name))
            return true;
        return this.excluded.some((p) => isInside(abs, p));
    }
    addFile(abs, dest, stats, isProjectFile) {
        this.entries.push({ path: dest, source: abs, mode: stats.mode });
        if (dest.endsWith(".node")) {
            let info = null;
            try {
                info = BinaryInspector_1.BinaryInspector.inspect(abs);
            }
            catch {
                // Unreadable addon: reported with unknown info
            }
            this.nativeAddons.push({ path: dest, info });
        }
        else if (!isProjectFile && (0, node_path_1.basename)(dest) === "binding.gyp") {
            // A dependency's own source, not the project's: a project that vendors a binding.gyp for
            // something else is not asking Graak to compile it.
            this.gypFiles.push({ dest, abs });
        }
        else if (isProjectFile && SOURCE_EXTENSIONS.has((0, node_path_1.extname)(dest)) && stats.size < 4 * 1024 * 1024) {
            const text = (0, node_fs_1.readFileSync)(abs, "utf-8");
            if (BUN_API_PATTERN.test(text)) {
                this.usesBunApis.push(dest);
                if (BUN_GLOBALS_PATTERN.test(text))
                    this.usesBunGlobals.push(dest);
            }
        }
    }
    /**
     * Copies a directory tree, following symlinks while guarding against cycles.
     */
    walk(dir, destPrefix, isProjectFile, skipNodeModules) {
        const real = (0, node_fs_1.realpathSync)(dir);
        const visitKey = `${real}\0${destPrefix}`;
        if (this.visitedDirs.has(visitKey))
            return;
        this.visitedDirs.add(visitKey);
        for (const name of (0, node_fs_1.readdirSync)(dir).sort()) {
            const abs = (0, node_path_1.join)(dir, name);
            if (name === "node_modules" && skipNodeModules)
                continue;
            if (this.isExcluded(abs, name, isProjectFile))
                continue;
            let stats;
            try {
                stats = (0, node_fs_1.statSync)(abs);
            }
            catch {
                continue; // Broken symlink
            }
            if ((0, node_fs_1.lstatSync)(abs).isSymbolicLink() && stats.isDirectory()) {
                const target = (0, node_fs_1.realpathSync)(abs);
                // A link to an ancestor would recurse forever
                if (isInside(real, target))
                    continue;
            }
            const dest = destPrefix ? `${destPrefix}/${name}` : name;
            if (stats.isDirectory())
                this.walk(abs, dest, isProjectFile, true);
            else if (stats.isFile())
                this.addFile(abs, dest, stats, isProjectFile);
        }
    }
    addProjectFiles(root, prefix) {
        this.walk(root, prefix, true, true);
    }
    addEngines(pkg) {
        const engines = pkg.engines;
        const min = parseMinVersion(engines?.node);
        if (min && (!this.minNode || compareVersions(min, this.minNode) > 0)) {
            this.minNode = min;
        }
    }
    /**
     * Node.js resolution: look for `name` in node_modules directories from `fromDir` upwards.
     */
    resolvePackageDir(name, fromDir) {
        let dir = fromDir;
        for (;;) {
            const candidate = (0, node_path_1.join)(dir, "node_modules", name);
            if ((0, node_fs_1.existsSync)((0, node_path_1.join)(candidate, "package.json")))
                return (0, node_fs_1.realpathSync)(candidate);
            // Also check pnpm / yarn virtual store resolution
            const pnpmCandidate = (0, node_path_1.join)(dir, "node_modules", ".pnpm");
            if ((0, node_fs_1.existsSync)(pnpmCandidate)) {
                // Search inside virtual store
                try {
                    const entries = (0, node_fs_1.readdirSync)(pnpmCandidate);
                    for (const entry of entries) {
                        if (entry.startsWith(name.replace("/", "+"))) {
                            const targetPkg = (0, node_path_1.join)(pnpmCandidate, entry, "node_modules", name);
                            if ((0, node_fs_1.existsSync)((0, node_path_1.join)(targetPkg, "package.json"))) {
                                return (0, node_fs_1.realpathSync)(targetPkg);
                            }
                        }
                    }
                }
                catch { }
            }
            const parent = (0, node_path_1.dirname)(dir);
            if (parent === dir)
                return null;
            dir = parent;
        }
    }
    addDependencies(rootPkg, includeDev) {
        const queue = [{ realDir: this.root, dest: "", pkg: rootPkg, isRoot: true }];
        // Breadth-first so parents claim shallow positions before their children resolve
        for (let item = queue.shift(); item; item = queue.shift()) {
            const { realDir, dest, pkg, isRoot } = item;
            const required = { ...pkg.dependencies };
            const optional = {
                ...(isRoot && includeDev ? pkg.devDependencies : {}),
                ...pkg.peerDependencies,
                ...pkg.optionalDependencies,
            };
            const names = [
                ...Object.keys(required).map((n) => [n, true]),
                ...Object.keys(optional)
                    .filter((n) => !(n in required))
                    .map((n) => [n, false]),
            ];
            for (const [name, isRequired] of names) {
                const depReal = this.resolvePackageDir(name, realDir);
                if (!depReal) {
                    if (isRequired && !(pkg.bundleDependencies || pkg.bundledDependencies)) {
                        throw new structures_1.ProjectError(`Dependency '${name}' required by '${isRoot ? "project" : dest}' is not installed. Run your package manager's install first.`);
                    }
                    continue;
                }
                const position = this.place(name, depReal, dest);
                if (position.isNew) {
                    const depPkg = readJson((0, node_path_1.join)(depReal, "package.json")) ?? {};
                    this.walk(depReal, position.dest, false, true);
                    this.addEngines(depPkg);
                    queue.push({
                        realDir: depReal,
                        dest: position.dest,
                        pkg: depPkg,
                        isRoot: false,
                    });
                }
            }
        }
    }
    place(name, realDir, parentDest) {
        // Candidate positions ordered from nearest (inside parent) to the project root
        const candidates = [];
        let base = parentDest;
        for (;;) {
            candidates.push(base ? `${base}/node_modules/${name}` : `node_modules/${name}`);
            if (!base)
                break;
            const idx = base.lastIndexOf("/node_modules/");
            base = idx === -1 ? "" : base.slice(0, idx);
        }
        let chosen = null;
        for (const candidate of candidates) {
            const occupant = this.placed.get(candidate);
            if (occupant !== undefined) {
                if (occupant === realDir) {
                    this.reserve(candidates, candidate);
                    return { dest: candidate, isNew: false };
                }
                break;
            }
            if (this.reserved.has(candidate))
                break;
            chosen = candidate;
        }
        if (!chosen) {
            throw new structures_1.ProjectError(`Cannot place '${name}' for '${parentDest || "project"}' without shadowing another version`);
        }
        this.placed.set(chosen, realDir);
        this.reserve(candidates, chosen);
        return { dest: chosen, isNew: true };
    }
    reserve(candidates, resolved) {
        for (const candidate of candidates) {
            if (candidate === resolved)
                break;
            this.reserved.add(candidate);
        }
    }
}
exports.ProjectCollector = ProjectCollector;
//# sourceMappingURL=ProjectCollector.js.map