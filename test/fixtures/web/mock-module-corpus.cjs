// node:test's mock.module(): gated behind --experimental-test-module-mocks like Node's own (this fixture is run
// with that flag; see the `nodeArgs` / `NODE_OPTIONS` special-case for it in test/webRuntime.test.ts). Covers the
// CommonJS require() path only -- Node gates ESM mocking behind the same flag, and this engine cannot intercept its
// native ESM loader from JS at all, so ESM mocking is not exercised here.
const { test } = require("node:test");
const path = require("node:path");

const log = [];
const say = (...a) => log.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));

// The reporter writes to process.stdout as tests finish; keep what it writes and print it, masked, at the end.
let reporterText = "";
const realWrite = process.stdout.write;
process.stdout.write = function (chunk) {
	reporterText += String(chunk);
	return true;
};

const modFile = path.join(__dirname, "mock-module-target.cjs");

test("mock.module exists behind the flag", (t) => {
	say("typeof mock.module", typeof t.mock.module);
});

test("named exports only", (t) => {
	const mock = t.mock.module(modFile, { exports: { greet: () => "mocked-greet" } });
	const mod = require(modFile);
	say("keys", Object.keys(mod).sort());
	say("greet", mod.greet());
	say("default", mod.default);
	mock.restore();
	delete require.cache[require.resolve(modFile)];
	say("after restore greet", require(modFile).greet());
});

test("default export only spreads onto CJS exports", (t) => {
	const mock = t.mock.module(modFile, { exports: { default: { onlyDefault: true } } });
	const mod = require(modFile);
	say("keys", Object.keys(mod).sort());
	say("mod", mod);
	mock.restore();
});

test("default plus named exports merge", (t) => {
	const mock = t.mock.module(modFile, {
		exports: { default: { isDefault: true }, greet: () => "named-greet" },
	});
	const mod = require(modFile);
	say("keys", Object.keys(mod).sort());
	say("isDefault", mod.isDefault);
	say("greet", mod.greet());
	mock.restore();
});

test("deprecated namedExports/defaultExport options still work", (t) => {
	const mock = t.mock.module(modFile, {
		namedExports: { greet: () => "deprecated-greet" },
		defaultExport: { isDefault: true },
	});
	const mod = require(modFile);
	say("keys", Object.keys(mod).sort());
	say("greet", mod.greet());
	mock.restore();
});

test("no options gives an empty exports object", (t) => {
	const mock = t.mock.module(modFile);
	say("mod", require(modFile));
	mock.restore();
});

test("mocking after the real module was already required preserves identity on restore", (t) => {
	delete require.cache[require.resolve(modFile)];
	const before = require(modFile);
	say("before greet", before.greet());
	const mock = t.mock.module(modFile, { exports: { greet: () => "mocked-after" } });
	const after = require(modFile);
	say("after mock greet", after.greet());
	say("same reference before mocking?", require(modFile) === before);
	mock.restore();
	say("same reference after restore?", require(modFile) === before);
});

test("cache:false gives a fresh module object on every require", (t) => {
	const mock = t.mock.module(modFile, { cache: false, exports: { greet: () => "nocache-greet" } });
	const a = require(modFile);
	const b = require(modFile);
	say("a === b", a === b);
	say("a.greet", a.greet());
	mock.restore();
	delete require.cache[require.resolve(modFile)];
	say("after restore greet", require(modFile).greet());
});

test("mock.reset() undoes an active module mock", (t) => {
	t.mock.module(modFile, { exports: { greet: () => "reset-mocked" } });
	say("mocked greet", require(modFile).greet());
	t.mock.reset();
	delete require.cache[require.resolve(modFile)];
	say("after reset greet", require(modFile).greet());
});

test("a builtin module can be mocked too", (t) => {
	const mock = t.mock.module("node:path", { exports: { basename: () => "mocked-basename" } });
	const mockedPath = require("node:path");
	say("basename", mockedPath.basename("/a/b/c"));
	mock.restore();
	say("after restore basename", require("node:path").basename("/a/b/c"));
});

// ---- the end --------------------------------------------------------------------------------------------------
process.on("exit", (code) => {
	process.stdout.write = realWrite;
	const clean = reporterText
		.replace(/\(\d+(?:\.\d+)?ms\)/g, "(<ms>)")
		.replace(/duration_ms \d+(?:\.\d+)?/g, "duration_ms <ms>")
		.replace(/^ *at .*\n/gm, "")
		.replace(/^test at .*$/gm, "test at <location>")
		.split(path.dirname(__filename))
		.join("<dir>");
	console.log(clean);
	console.log("--- program side");
	say("exit code", code, process.exitCode);
	for (const line of log) console.log(line);
	process.exitCode = 0;
});
