// node:test's mock.module() on the ESM side: gated behind --experimental-test-module-mocks, like the CommonJS
// side in mock-module-corpus.cjs (see the `nodeArgs` / `NODE_OPTIONS` special-case for both in test/webRuntime.test.ts).
//
// Every case here calls mock.module() before the *first* `import()` of that specifier, and imports each specifier
// only once in the whole file (a fresh target file per case where that matters). That is deliberate, not an
// oversight: quickjs caches a loaded ES module by its resolved specifier at the engine level, before the loader
// (and so this runtime's mock hook) is ever consulted again, and nothing here can evict that cache entry. Real
// Node's own loader can retroactively swap an already-imported specifier and can hand back a fresh module
// instance on every `cache: false` import; this runtime cannot, for the reason above. See the comment on
// `mock.module` in quickjs/runtime/node-test-mock.js. Every case below is unaffected by either gap.
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const log = [];
const say = (...a) => log.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));

// The reporter writes to process.stdout as tests finish; keep what it writes and print it, masked, at the end.
let reporterText = "";
const realWrite = process.stdout.write;
process.stdout.write = function (chunk) {
	reporterText += String(chunk);
	return true;
};

const here = fileURLToPath(new URL(".", import.meta.url));
const dir = here.endsWith("/") ? here.slice(0, -1) : here;

test("mock.module exists behind the flag", (t) => {
	say("typeof mock.module", typeof t.mock.module);
});

test("named exports only", async (t) => {
	const mock = t.mock.module("./mock-module-esm-target-named.mjs", { exports: { greet: () => "mocked-greet" } });
	const mod = await import("./mock-module-esm-target-named.mjs");
	say("keys", Object.keys(mod).sort());
	say("greet", mod.greet());
	say("default", mod.default);
	mock.restore();
});

test("default export only stays default only (no CommonJS-style spreading)", async (t) => {
	const mock = t.mock.module("./mock-module-esm-target-default.mjs", { exports: { default: { onlyDefault: true } } });
	const mod = await import("./mock-module-esm-target-default.mjs");
	say("keys", Object.keys(mod).sort());
	say("default", mod.default);
	say("greet", mod.greet);
	mock.restore();
});

test("default plus named exports, kept separate", async (t) => {
	const mock = t.mock.module("./mock-module-esm-target-both.mjs", {
		exports: { default: { isDefault: true }, greet: () => "named-greet" },
	});
	const mod = await import("./mock-module-esm-target-both.mjs");
	say("keys", Object.keys(mod).sort());
	say("default", mod.default);
	say("greet", mod.greet());
	mock.restore();
});

test("deprecated namedExports/defaultExport options still work", async (t) => {
	const mock = t.mock.module("./mock-module-esm-target-deprecated.mjs", {
		namedExports: { greet: () => "deprecated-greet" },
		defaultExport: { isDefault: true },
	});
	const mod = await import("./mock-module-esm-target-deprecated.mjs");
	say("keys", Object.keys(mod).sort());
	say("default", mod.default);
	say("greet", mod.greet());
	mock.restore();
});

test("no options gives an empty module", async (t) => {
	const mock = t.mock.module("./mock-module-esm-target-empty.mjs");
	const mod = await import("./mock-module-esm-target-empty.mjs");
	say("keys", Object.keys(mod).sort());
	say("default", mod.default);
	mock.restore();
});

test("a builtin module can be mocked too", async (t) => {
	// node:path is not imported anywhere else in this file, so this is its first-ever import here.
	const mock = t.mock.module("node:path", { exports: { basename: () => "mocked-basename" } });
	const mockedPath = await import("node:path");
	say("basename", mockedPath.basename("/a/b/c"));
	mock.restore();
});

// ---- the end --------------------------------------------------------------------------------------------------
process.on("exit", (code) => {
	process.stdout.write = realWrite;
	const clean = reporterText
		.replace(/\(\d+(?:\.\d+)?ms\)/g, "(<ms>)")
		.replace(/duration_ms \d+(?:\.\d+)?/g, "duration_ms <ms>")
		.replace(/^ *at .*\n/gm, "")
		.replace(/^test at .*$/gm, "test at <location>")
		.split(dir)
		.join("<dir>");
	console.log(clean);
	console.log("--- program side");
	say("exit code", code, process.exitCode);
	for (const line of log) console.log(line);
	process.exitCode = 0;
});
