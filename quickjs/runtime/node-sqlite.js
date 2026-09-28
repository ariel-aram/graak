/*
 * `node:sqlite` and `bun:sqlite` on the host's built-in SQLite (quickjs/native/fg_sqlite.c).
 *
 * A program that keeps its data in SQLite -- through Node's own `node:sqlite`, Bun's `bun:sqlite`, or Deno KV, which
 * is built on it -- runs on every target with nothing to install, on the same database file format everywhere.
 * `DatabaseSync` and `StatementSync` follow Node's documentation: rows are null-prototype objects, an integer outside
 * 53 bits is an error unless the statement reads bigints, `run()` reports `changes` and `lastInsertRowid`, and named
 * parameters bind with or without their prefix.
 */

const SQLITE_OPEN_READONLY = 0x00000001;
const SQLITE_OPEN_READWRITE = 0x00000002;
const SQLITE_OPEN_CREATE = 0x00000004;

function sqliteError(message, code = "ERR_SQLITE_ERROR", extra) {
	return Object.assign(new Error(message), { code }, extra);
}

function createSqlite({ native, Buffer, platform = globalThis.process?.platform ?? "linux" }) {
	if (typeof native?.sqliteOpen !== "function") return null;

	const toDbPath = (value) => {
		if (typeof value === "string") return value;
		if (value instanceof URL) {
			if (value.protocol !== "file:") throw sqliteError("The URL must be of scheme file", "ERR_INVALID_URL_SCHEME");
			return decodeURIComponent(platform === "win32" ? value.pathname.replace(/^\/([A-Za-z]:)/, "$1") : value.pathname);
		}
		if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
		throw Object.assign(new TypeError('The "path" argument must be a string, Uint8Array, or URL without null bytes.'), {
			code: "ERR_INVALID_ARG_TYPE",
		});
	};

	class StatementSync {
		constructor(database, id, sql) {
			this._db = database;
			this._id = id;
			this._sql = sql;
			this._bigints = false;
			this._bare = true;
			this._columns = null;
		}

		_live() {
			if (this._id === null) throw sqliteError("statement has been finalized");
			if (!this._db._isOpen) throw sqliteError("database is not open");
			return this._id;
		}

		get sourceSQL() {
			return this._sql;
		}
		get expandedSQL() {
			return native.sqliteSql(this._live(), true);
		}

		setReadBigInts(enabled) {
			if (typeof enabled !== "boolean")
				throw Object.assign(new TypeError('The "readBigInts" argument must be a boolean.'), {
					code: "ERR_INVALID_ARG_TYPE",
				});
			this._bigints = enabled;
		}
		setAllowBareNamedParameters(enabled) {
			if (typeof enabled !== "boolean")
				throw Object.assign(new TypeError('The "allowBareNamedParameters" argument must be a boolean.'), {
					code: "ERR_INVALID_ARG_TYPE",
				});
			this._bare = enabled;
		}

		columns() {
			const id = this._live();
			return native.sqliteColumns(id).map((name) => ({ column: null, database: null, name, table: null, type: null }));
		}

		_names() {
			return (this._columns ??= native.sqliteColumns(this._id));
		}

		_bind(params) {
			const id = this._live();
			native.sqliteReset(id, true);
			let position = 1;
			for (const value of params) {
				if (
					value !== null &&
					typeof value === "object" &&
					!(value instanceof Uint8Array) &&
					!ArrayBuffer.isView(value) &&
					!(value instanceof ArrayBuffer)
				) {
					for (const [key, v] of Object.entries(value)) {
						let index = native.sqliteBindIndex(id, key);
						if (index === 0 && this._bare) {
							for (const prefix of [":", "$", "@"]) {
								index = native.sqliteBindIndex(id, prefix + key);
								if (index) break;
							}
						}
						if (index === 0) throw sqliteError(`Unknown named parameter '${key}'`, "ERR_INVALID_STATE");
						native.sqliteBind(id, index, this._coerce(v));
					}
				} else {
					native.sqliteBind(id, position++, this._coerce(value));
				}
			}
		}

		_coerce(value) {
			if (value === undefined) return null;
			if (typeof value === "boolean") return value ? 1 : 0;
			if (typeof value === "number" || typeof value === "bigint" || typeof value === "string" || value === null)
				return value;
			if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
			throw Object.assign(
				new TypeError(`Provided value cannot be bound to SQLite parameter. Unsupported type ${typeof value}.`),
				{ code: "ERR_INVALID_ARG_TYPE" }
			);
		}

		_object(row) {
			const names = this._names();
			const out = Object.create(null);
			for (let i = 0; i < names.length; i++) out[names[i]] = row[i];
			return out;
		}

		run(...params) {
			this._bind(params);
			const id = this._id;
			while (native.sqliteStep(id)) {
				// A statement that returns rows still runs to the end.
			}
			native.sqliteReset(id, false);
			const [changes, rowid] = native.sqliteInfo(this._db._handle);
			return {
				changes: this._bigints ? BigInt(changes) : changes,
				lastInsertRowid: this._bigints ? rowid : Number(rowid),
			};
		}

		get(...params) {
			this._bind(params);
			const id = this._id;
			try {
				return native.sqliteStep(id) ? this._object(native.sqliteRow(id, this._bigints)) : undefined;
			} finally {
				native.sqliteReset(id, false);
			}
		}

		all(...params) {
			this._bind(params);
			const id = this._id;
			const rows = [];
			try {
				while (native.sqliteStep(id)) rows.push(this._object(native.sqliteRow(id, this._bigints)));
			} finally {
				native.sqliteReset(id, false);
			}
			return rows;
		}

		/** Rows as arrays, which is what `bun:sqlite` calls values(). */
		_values(params) {
			this._bind(params);
			const id = this._id;
			const rows = [];
			try {
				while (native.sqliteStep(id)) rows.push(native.sqliteRow(id, this._bigints));
			} finally {
				native.sqliteReset(id, false);
			}
			return rows;
		}

		iterate(...params) {
			this._bind(params);
			const id = this._id;
			const self = this;
			let done = false;
			return {
				next() {
					if (done) return { value: undefined, done: true };
					if (native.sqliteStep(id)) return { value: self._object(native.sqliteRow(id, self._bigints)), done: false };
					done = true;
					native.sqliteReset(id, false);
					return { value: undefined, done: true };
				},
				return(value) {
					if (!done) {
						done = true;
						native.sqliteReset(id, false);
					}
					return { value, done: true };
				},
				[Symbol.iterator]() {
					return this;
				},
			};
		}

		finalize() {
			if (this._id !== null) {
				native.sqliteFinalize(this._id);
				this._id = null;
			}
		}
	}

	class DatabaseSync {
		constructor(path, options = {}) {
			this._path = toDbPath(path);
			this._options = options ?? {};
			this._handle = null;
			this._isOpen = false;
			this._statements = new Set();
			if (this._options.open !== false) this.open();
		}

		open() {
			if (this._isOpen) throw sqliteError("database is already open", "ERR_INVALID_STATE");
			const flags = this._options.readOnly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE;
			this._handle = native.sqliteOpen(this._path, flags);
			this._isOpen = true;
			if (this._options.enableForeignKeyConstraints !== false)
				native.sqliteExec(this._handle, "PRAGMA foreign_keys = ON");
		}

		close() {
			if (!this._isOpen) throw sqliteError("database is not open", "ERR_INVALID_STATE");
			for (const statement of this._statements) statement.finalize();
			this._statements.clear();
			native.sqliteClose(this._handle);
			this._isOpen = false;
			this._handle = null;
		}

		get isOpen() {
			return this._isOpen;
		}
		get isTransaction() {
			return this._isOpen ? native.sqliteInfo(this._handle)[2] : false;
		}

		_live() {
			if (!this._isOpen) throw sqliteError("database is not open", "ERR_INVALID_STATE");
			return this._handle;
		}

		exec(sql) {
			if (typeof sql !== "string")
				throw Object.assign(new TypeError('The "sql" argument must be a string.'), { code: "ERR_INVALID_ARG_TYPE" });
			native.sqliteExec(this._live(), sql);
		}

		prepare(sql) {
			if (typeof sql !== "string")
				throw Object.assign(new TypeError('The "sql" argument must be a string.'), { code: "ERR_INVALID_ARG_TYPE" });
			const [id] = native.sqlitePrepare(this._live(), sql);
			if (id === null) throw sqliteError("The SQL statement is empty", "ERR_SQLITE_ERROR");
			const statement = new StatementSync(this, id, sql);
			this._statements.add(statement);
			return statement;
		}

		function() {
			throw sqliteError(
				"User-defined functions are not available in the Graak SQLite build",
				"ERR_FEATURE_UNAVAILABLE_ON_PLATFORM"
			);
		}
		loadExtension() {
			throw sqliteError(
				"SQLite extensions cannot be loaded: the Graak SQLite build has extension loading disabled",
				"ERR_LOAD_SQLITE_EXTENSION"
			);
		}
		enableLoadExtension() {}

		[Symbol.dispose]() {
			if (this._isOpen) this.close();
		}
	}

	/*
	 * Standalone async function, not a DatabaseSync method, matching node:sqlite. Argument and option validation
	 * throws synchronously, as Node's does; opening the destination and copying pages happens after, so those
	 * errors (and a normal result) arrive through the returned promise, also as in Node.
	 */
	function backup(sourceDb, destination, ...rest) {
		if (!(sourceDb instanceof DatabaseSync))
			throw Object.assign(new TypeError('The "sourceDb" argument must be an object.'), { code: "ERR_INVALID_ARG_TYPE" });
		const handle = sourceDb._live();
		// Same argument as DatabaseSync's own constructor: a string, Uint8Array or file: URL, no null bytes.
		const destPath = toDbPath(destination);

		let rate = 100;
		let source = "main";
		let target = "main";
		let progress;
		if (rest.length > 0) {
			const options = rest[0];
			if (typeof options !== "object" || options === null)
				throw Object.assign(new TypeError('The "options" argument must be an object.'), { code: "ERR_INVALID_ARG_TYPE" });
			if (options.rate !== undefined) {
				if (!Number.isInteger(options.rate))
					throw Object.assign(new TypeError('The "options.rate" argument must be an integer.'), {
						code: "ERR_INVALID_ARG_TYPE",
					});
				if (options.rate <= 0)
					throw Object.assign(new RangeError('The "options.rate" argument must be a positive integer.'), {
						code: "ERR_OUT_OF_RANGE",
					});
				rate = options.rate;
			}
			if (options.source !== undefined) {
				if (typeof options.source !== "string")
					throw Object.assign(new TypeError('The "options.source" argument must be a string.'), {
						code: "ERR_INVALID_ARG_TYPE",
					});
				source = options.source;
			}
			if (options.target !== undefined) {
				if (typeof options.target !== "string")
					throw Object.assign(new TypeError('The "options.target" argument must be a string.'), {
						code: "ERR_INVALID_ARG_TYPE",
					});
				target = options.target;
			}
			if (options.progress !== undefined) {
				if (typeof options.progress !== "function")
					throw Object.assign(new TypeError('The "options.progress" argument must be a function.'), {
						code: "ERR_INVALID_ARG_TYPE",
					});
				progress = options.progress;
			}
		}

		return (async () => {
			const id = native.sqliteBackupInit(handle, source, destPath, target);
			try {
				for (;;) {
					const [done, totalPages, remainingPages] = native.sqliteBackupStep(id, rate);
					if (done) return totalPages;
					if (progress) progress({ totalPages, remainingPages });
				}
			} catch (e) {
				native.sqliteBackupFinish(id);
				throw e;
			}
		})();
	}

	const node = {
		DatabaseSync,
		StatementSync,
		constants: {
			SQLITE_CHANGESET_OMIT: 0,
			SQLITE_CHANGESET_REPLACE: 1,
			SQLITE_CHANGESET_ABORT: 2,
			SQLITE_CHANGESET_DATA: 1,
			SQLITE_CHANGESET_NOTFOUND: 2,
			SQLITE_CHANGESET_CONFLICT: 3,
			SQLITE_CHANGESET_CONSTRAINT: 4,
			SQLITE_CHANGESET_FOREIGN_KEY: 5,
		},
		backup,
		version: native.sqliteVersion(),
	};

	/* ------------------------------------------------------------------ bun:sqlite */

	class BunStatement {
		constructor(statement, strict) {
			this._s = statement;
			if (strict) statement.setAllowBareNamedParameters(true);
		}
		get columnNames() {
			return native.sqliteColumns(this._s._live());
		}
		get paramsCount() {
			const sql = this._s.sourceSQL;
			return (sql.match(/[?:@$]\w*/g) ?? []).length;
		}
		all(...params) {
			return this._s.all(...params).map((row) => ({ ...row }));
		}
		get(...params) {
			const row = this._s.get(...params);
			return row === undefined ? null : { ...row };
		}
		run(...params) {
			const result = this._s.run(...params);
			return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
		}
		values(...params) {
			return this._s._values(params);
		}
		*iterate(...params) {
			for (const row of this._s.iterate(...params)) yield { ...row };
		}
		[Symbol.iterator]() {
			return this.iterate();
		}
		finalize() {
			this._s.finalize();
		}
		toString() {
			return this._s.expandedSQL;
		}
	}

	class Database {
		constructor(filename = ":memory:", options = {}) {
			if (typeof options === "number")
				options = { readonly: Boolean(options & SQLITE_OPEN_READONLY), create: Boolean(options & SQLITE_OPEN_CREATE) };
			this._strict = Boolean(options?.strict);
			this.filename = filename;
			this._queries = new Map();
			this._db = new DatabaseSync(filename, {
				readOnly: options?.readonly === true,
				enableForeignKeyConstraints: true,
			});
			if (options?.safeIntegers) this._safe = true;
		}
		static open(filename, options) {
			return new Database(filename, options);
		}
		get inTransaction() {
			return this._db.isTransaction;
		}
		exec(sql, ...params) {
			if (params.length) return this.run(sql, ...params);
			this._db.exec(sql);
		}
		prepare(sql) {
			const statement = this._db.prepare(sql);
			if (this._safe) statement.setReadBigInts(true);
			return new BunStatement(statement, this._strict);
		}
		query(sql) {
			let cached = this._queries.get(sql);
			if (!cached) {
				cached = this.prepare(sql);
				this._queries.set(sql, cached);
			}
			return cached;
		}
		run(sql, ...params) {
			const statement = this.prepare(sql);
			try {
				return statement.run(...params);
			} finally {
				statement.finalize();
			}
		}
		transaction(fn) {
			const make = (begin) => {
				const wrapped = (...args) => {
					const nested = this._db.isTransaction;
					const savepoint = nested ? `graak_sp_${Math.random().toString(36).slice(2)}` : null;
					this._db.exec(nested ? `SAVEPOINT ${savepoint}` : begin);
					try {
						const result = fn.apply(this, args);
						this._db.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
						return result;
					} catch (error) {
						this._db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
						throw error;
					}
				};
				return wrapped;
			};
			const transaction = make("BEGIN");
			transaction.deferred = make("BEGIN DEFERRED");
			transaction.immediate = make("BEGIN IMMEDIATE");
			transaction.exclusive = make("BEGIN EXCLUSIVE");
			return transaction;
		}
		close() {
			for (const q of this._queries.values()) q.finalize();
			this._queries.clear();
			this._db.close();
		}
		loadExtension() {
			this._db.loadExtension();
		}
		[Symbol.dispose]() {
			this.close();
		}
	}

	const bun = {
		Database,
		Statement: BunStatement,
		constants: { SQLITE_OPEN_READONLY, SQLITE_OPEN_READWRITE, SQLITE_OPEN_CREATE },
		SQLiteError: Error,
	};
	return { node, bun };
}

export { createSqlite };
