// node:sqlite: what a program can observe of the database. Must print exactly what Node.js prints.
const { DatabaseSync, backup } = require("node:sqlite");
const out = [];
const say = (...a) => out.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? `${v}n` : v instanceof Uint8Array ? `u8[${[...v]}]` : v)))).join(" "));

const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER, score REAL, photo BLOB, note TEXT);
CREATE TABLE tag (person INTEGER REFERENCES person(id), label TEXT);
CREATE INDEX tag_label ON tag(label);`);
const insert = db.prepare("INSERT INTO person (name, age, score, photo, note) VALUES (?, ?, ?, ?, ?)");
say("run", insert.run("Ada", 36, 9.5, new Uint8Array([1, 2, 3]), null), insert.run("Grace", 45, 8.25, null, "admiral"));
const insertNamed = db.prepare("INSERT INTO person (name, age) VALUES (:name, $age)");
say("named", insertNamed.run({ name: "Linus", age: 54 }), insertNamed.run({ ":name": "Margaret", $age: 33 }));
const all = db.prepare("SELECT * FROM person ORDER BY id");
say("all", all.all());
say("get", db.prepare("SELECT name, age FROM person WHERE id = ?").get(2), db.prepare("SELECT name FROM person WHERE id = ?").get(99));
say("proto", Object.getPrototypeOf(all.get()) === null, Object.keys(all.get()));
say("iterate", [...db.prepare("SELECT name FROM person WHERE age > ? ORDER BY name").iterate(40)]);
say("columns", db.prepare("SELECT id, name AS who FROM person").columns().map((c) => c.name));
say("types", db.prepare("SELECT 1 AS i, 1.5 AS r, 'x' AS t, x'0a0b' AS b, NULL AS n, 1 = 1 AS ok").get());
say("bind types", db.prepare("SELECT ? AS a, ? AS b, ? AS c, ? AS d").get(1, 2.5, "three", null));

const big = db.prepare("SELECT 9007199254740993 AS big, -9223372036854775807 AS small");
try { big.get(); } catch (e) { say("unsafe", e.name, e.code); }
big.setReadBigInts(true);
say("bigint", big.get());
const rowid = db.prepare("INSERT INTO tag VALUES (?, ?)");
rowid.setReadBigInts(true);
say("bigint run", rowid.run(1, "a"));

db.exec("BEGIN");
say("in transaction", db.isTransaction);
db.prepare("INSERT INTO tag VALUES (1, 'kept')").run();
db.exec("ROLLBACK");
say("rolled back", db.prepare("SELECT count(*) AS n FROM tag").get(), db.isTransaction);

try { db.prepare("INSERT INTO person (name) VALUES (NULL)").run(); } catch (e) { say("constraint", e.code, e.errcode, /NOT NULL/.test(e.message)); }
try { db.prepare("SELEC 1"); } catch (e) { say("syntax", e.code, e.errcode); }
try { db.prepare("INSERT INTO tag VALUES (999, 'orphan')").run(); } catch (e) { say("foreign key", e.code, /FOREIGN KEY/.test(e.message)); }
try { insert.run("a", 1); insert.run("only-one"); say("fewer params", "ok"); } catch (e) { say("fewer params", e.code); }
try { insertNamed.run({ nope: 1 }); } catch (e) { say("unknown param", e.code); }
try { db.exec(42); } catch (e) { say("exec type", e.code); }

say("expanded", db.prepare("SELECT ? + ?").expandedSQL === undefined ? "n/a" : db.prepare("SELECT ?1 + ?2").sourceSQL);
const stmt = db.prepare("SELECT 1");
say("source", stmt.sourceSQL);
say("open", db.isOpen);
db.close();
say("closed", db.isOpen);
try { db.exec("SELECT 1"); } catch (e) { say("after close", e.code); }
try { db.close(); } catch (e) { say("double close", e.code); }
const lazy = new DatabaseSync(":memory:", { open: false });
say("lazy", lazy.isOpen);
lazy.open();
say("opened", lazy.isOpen, lazy.prepare("SELECT 42 AS v").get());
lazy.close();

const path = require("path");
const fs = require("fs");
const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "graak-sqlite-"));
const file = path.join(dir, "data.db");
const disk = new DatabaseSync(file);
disk.exec("CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER) STRICT");
disk.prepare("INSERT INTO t VALUES (?, ?)").run("a", 1);
disk.close();
const again = new DatabaseSync(file);
say("persisted", again.prepare("SELECT * FROM t").all());
again.close();
const readonly = new DatabaseSync(file, { readOnly: true });
try { readonly.exec("INSERT INTO t VALUES ('b', 2)"); } catch (e) { say("readonly", e.code); }
readonly.close();
fs.rmSync(dir, { recursive: true, force: true });

/*
 * function(): a scalar SQL function bound through sqlite3_create_function_v2(). Return values, argument coercion
 * and the options node:sqlite documents (deterministic, directOnly, varargs, useBigIntArguments) are checked; the
 * flags a function is registered with are used through the query planner, not observable in a query's own output,
 * so the corpus checks only that the calls succeed and the function still runs correctly under them.
 */
function udfTests() {
	const fdb = new DatabaseSync(":memory:");
	fdb.exec("CREATE TABLE t (x)");
	fdb.exec("INSERT INTO t VALUES (1), (2), (3)");

	fdb.function("add1", (a) => a + 1);
	say("udf basic", fdb.prepare("SELECT add1(x) AS y FROM t ORDER BY x").all());

	fdb.function("sum", { varargs: true }, (...args) => args.reduce((a, b) => a + b, 0));
	say("udf varargs", fdb.prepare("SELECT sum(1, 2, 3) AS s").get(), fdb.prepare("SELECT sum() AS s").get());

	fdb.function("twice", { deterministic: true }, (a) => a * 2);
	say("udf deterministic", fdb.prepare("SELECT twice(x) AS y FROM t ORDER BY x").all());

	fdb.function("directonly", { directOnly: true }, (a) => a);
	say("udf directOnly", fdb.prepare("SELECT directonly(5) AS v").get());

	fdb.function("argtype", { useBigIntArguments: true }, (a) => `${typeof a}:${a}`);
	say("udf useBigIntArguments", fdb.prepare("SELECT argtype(3) AS v, argtype(3.5) AS w").get());
	fdb.function("argtypeNoBig", (a) => `${typeof a}:${a}`);
	say("udf number arguments (default)", fdb.prepare("SELECT argtypeNoBig(3) AS v").get());

	fdb.function("boom", () => {
		throw new RangeError("kaboom");
	});
	try {
		fdb.prepare("SELECT boom() AS v").get();
	} catch (e) {
		say("udf throws", e.constructor.name, e.message);
	}
	try {
		fdb.exec("SELECT boom() FROM t");
	} catch (e) {
		say("udf throws in exec", e.constructor.name, e.message);
	}

	fdb.function("fixedArity", (a, b) => a + b);
	try {
		fdb.prepare("SELECT fixedArity(1) AS v").get();
	} catch (e) {
		say("udf wrong arity", e.code, /wrong number of arguments/.test(e.message));
	}

	say("udf return types", fdb.prepare("SELECT typeof(add1(1)) AS numType").get());
	fdb.function("retnull", () => null);
	fdb.function("retundef", () => undefined);
	fdb.function("retbig", () => 123n);
	fdb.function("retbuf", () => Buffer.from("hi"));
	fdb.function("retu8", () => new Uint8Array([1, 2, 3]));
	say(
		"udf return values",
		fdb.prepare("SELECT retnull() a, retundef() b, retbig() c, retbuf() d, retu8() e").get()
	);
	fdb.function("retoobig", () => 99999999999999999999999n);
	try {
		fdb.prepare("SELECT retoobig() AS v").get();
	} catch (e) {
		say("udf bigint overflow", e.code, e.message);
	}
	fdb.function("retbad", () => ({ nope: true }));
	try {
		fdb.prepare("SELECT retbad() AS v").get();
	} catch (e) {
		say("udf bad return type", e.code, e.message);
	}

	fdb.function("echo", (a) => `${typeof a}:${a}`);
	fdb.exec("CREATE TABLE big (x)");
	fdb.exec("INSERT INTO big VALUES (9007199254740993)");
	try {
		fdb.prepare("SELECT echo(x) AS v FROM big").get();
	} catch (e) {
		say("udf arg overflow", e.constructor.name, e.code, e.message);
	}

	try {
		fdb.function(123, () => 1);
	} catch (e) {
		say("udf bad name", e.constructor.name, e.code, e.message);
	}
	try {
		fdb.function("x", 5, () => 1);
	} catch (e) {
		say("udf bad options", e.constructor.name, e.code, e.message);
	}
	try {
		fdb.function("x", {});
	} catch (e) {
		say("udf bad fn", e.constructor.name, e.code, e.message);
	}
	try {
		fdb.function("x", { deterministic: 1 }, () => 1);
	} catch (e) {
		say("udf bad option flag", e.constructor.name, e.code, e.message);
	}

	fdb.function("redefine", () => 1);
	fdb.function("redefine", () => 2);
	say("udf redefine", fdb.prepare("SELECT redefine() AS v").get());

	fdb.close();
	try {
		fdb.function("late", () => 1);
	} catch (e) {
		say("udf on closed db", e.constructor.name, e.code, e.message);
	}
}
udfTests();

/*
 * backup(): a standalone async function, not a DatabaseSync method. Page counts vary by SQLite version, so only the
 * relationships between what backup() returns and reports to `progress` are checked, not literal numbers.
 */
async function backupTests() {
	const dir2 = fs.mkdtempSync(path.join(require("os").tmpdir(), "graak-sqlite-backup-"));
	const srcPath = path.join(dir2, "src.db");
	const destPath = path.join(dir2, "dest.db");

	const src = new DatabaseSync(srcPath);
	src.exec("CREATE TABLE big (id INTEGER PRIMARY KEY, v TEXT)");
	const ins = src.prepare("INSERT INTO big (v) VALUES (?)");
	for (let i = 0; i < 500; i++) ins.run(`row-${i}-${"x".repeat(80)}`);

	const calls = [];
	const total = await backup(src, destPath, { rate: 3, progress: (info) => calls.push(info) });
	const totalsMatch = calls.every((c) => c.totalPages === total);
	const decreasing = calls.every((c, i) => i === 0 || c.remainingPages < calls[i - 1].remainingPages);
	const lastPositive = calls.length === 0 || calls[calls.length - 1].remainingPages > 0;
	const expectedCalls = Math.max(0, Math.ceil(total / 3) - 1);
	say("backup basic", total > 0, calls.length === expectedCalls, totalsMatch, decreasing, lastPositive);

	const dest = new DatabaseSync(destPath);
	say("backup rows", dest.prepare("SELECT count(*) AS n FROM big").get());
	dest.close();

	// Defaults: no progress, rate 100.
	const destDefaults = path.join(dir2, "dest-defaults.db");
	const totalDefaults = await backup(src, destDefaults);
	say("backup defaults", totalDefaults === total);
	const destDefaultsDb = new DatabaseSync(destDefaults);
	say("backup defaults rows", destDefaultsDb.prepare("SELECT count(*) AS n FROM big").get());
	destDefaultsDb.close();

	// options.source: an attached database, not "main".
	const auxPath = path.join(dir2, "aux.db").replace(/'/g, "''");
	src.exec(`ATTACH DATABASE '${auxPath}' AS aux`);
	src.exec("CREATE TABLE aux.u (y)");
	src.prepare("INSERT INTO aux.u VALUES (2)").run();
	const destAux = path.join(dir2, "dest-aux.db");
	const totalAux = await backup(src, destAux, { source: "aux" });
	say("backup source option", totalAux > 0);
	const destAuxDb = new DatabaseSync(destAux);
	say(
		"backup source option tables",
		destAuxDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
	);
	destAuxDb.close();

	// Synchronous argument validation, same as Node's: it throws before any promise is involved.
	try {
		backup(42, destPath);
	} catch (e) {
		say("backup bad source type", e.constructor.name, e.code, e.message);
	}
	try {
		backup(src, 42);
	} catch (e) {
		say("backup bad destination type", e.constructor.name, e.code, e.message);
	}
	try {
		backup(src, destPath, 5);
	} catch (e) {
		say("backup bad options type", e.constructor.name, e.code, e.message);
	}
	try {
		backup(src, destPath, { rate: 1.5 });
	} catch (e) {
		say("backup bad rate", e.constructor.name, e.code, e.message);
	}
	try {
		backup(src, destPath, { rate: 0 });
	} catch (e) {
		say("backup rate not positive", e.constructor.name, e.code, e.message);
	}
	try {
		backup(src, destPath, { progress: 1 });
	} catch (e) {
		say("backup bad progress", e.constructor.name, e.code, e.message);
	}
	const closedDb = new DatabaseSync(":memory:");
	closedDb.close();
	try {
		backup(closedDb, destPath);
	} catch (e) {
		say("backup closed source", e.constructor.name, e.code, e.message);
	}
	src.close();

	// Asynchronous errors: opening the destination or resolving options.source/target happens after backup() returns.
	const open = new DatabaseSync(":memory:");
	open.exec("CREATE TABLE t (x)");
	try {
		await backup(open, path.join(dir2, "no-such-dir", "out.db"));
		say("backup bad path", "no error");
	} catch (e) {
		say("backup bad path", e.constructor.name, e.code, /unable to open database file/.test(e.message));
	}
	try {
		await backup(open, path.join(dir2, "dest-bad-source.db"), { source: "does-not-exist" });
		say("backup bad source name", "no error");
	} catch (e) {
		say("backup bad source name", e.constructor.name, e.code, /unknown database/.test(e.message));
	}
	open.close();

	fs.rmSync(dir2, { recursive: true, force: true });
}

backupTests().then(
	() => {
		for (const l of out) console.log(l);
		process.exit(0);
	},
	(e) => {
		console.log(out.join("\n"));
		console.log("FAILED", e && e.stack);
		process.exit(1);
	}
);
