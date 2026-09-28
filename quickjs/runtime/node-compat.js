/*
 * A Node.js compatibility layer for quickjs-ng.
 *
 * quickjs-ng is an engine, not a runtime: it implements the language completely (it passes every
 * syntax and builtin check in tools/engine-conformance.js, including everything that fails to
 * parse on the Windows 7 Node.js pin) but provides none of Node's library surface. This file is
 * the part of that surface that can be written in JavaScript, built on the primitives the engine's
 * own `qjs:os` and `qjs:std` modules already expose — files, directories, timers, environment,
 * process control and I/O readiness callbacks.
 *
 * What is deliberately NOT here: `net`, `tls`, `http`, `crypto` and `zlib`. Those need real native
 * work — `qjs:os` has no socket API at all — and a bot cannot reach Discord without them. They are
 * registered as modules that throw an explanation when required, rather than being stubbed into
 * something that looks present and then fails somewhere confusing. That follows the same rule as
 * the native addon shim: a stub that lies is worse than a clear stop.
 *
 * Load it before anything else:
 *
 *     qjs --std quickjs/runtime/node-compat.js your-entry.js
 */

import * as engineOs from "qjs:os";
import * as engineStd from "qjs:std";
import { installIntl } from "./intl.js";
import { createAssert } from "./node-assert.js";
import {
	Buffer,
	bufferConstants,
	INSPECT_MAX_BYTES,
	isAscii,
	isUtf8,
	kMaxLength,
	normalizeEncoding,
	SlowBuffer,
} from "./node-buffer.js";
import { createCrypto } from "./node-crypto.js";
import { installExtras } from "./node-extras.js";
import * as fetchApi from "./node-fetch.js";
import { createFs } from "./node-fs.js";
import { createHttp2 } from "./node-http2.js";
import { URLPattern } from "./node-urlpattern.js";
import {
	createConsole,
	format as inspectFormat,
	inspect as inspectValue,
	setPromiseStateReader,
} from "./node-inspect.js";
import { createChildProcess as createStreamingChild } from "./node-child.js";
import { createCluster } from "./node-cluster.js";
import * as misc from "./node-misc.js";
import * as v8Serdes from "./node-v8.js";
import { createConsumers, createStreamModule } from "./node-stream.js";
import {
	createModuleModule,
	createOs,
	createPunycode,
	createStdio,
	createUnavailable,
	createUtilTypes,
	createVm,
} from "./node-system.js";
import { URL, URLSearchParams, urlModule } from "./node-url.js";
import { createWebAssembly } from "./node-wasm.js";
import * as web from "./node-web.js";
import { Segmenter } from "./segmenter.js";
import { createTestModule } from "./node-test.js";
import { createWasi } from "./node-wasi.js";
import { createRepl } from "./node-repl.js";
import { createInspector } from "./node-inspector.js";
import { createDns } from "./node-dns.js";

// A single-file build runs from its executable's payload: os and std are wrapped to read the program from it.
const sea = globalThis.__graak_native?.sea
	? (await import("./node-sea.js")).installSea({ os: engineOs, std: engineStd, native: globalThis.__graak_native })
	: null;
const os = sea?.os ?? engineOs;
const std = sea?.std ?? engineStd;

const globalObject = globalThis;

// The engine has no URL; fetch, http and most libraries need it.
if (typeof globalThis.URL === "undefined") {
	globalThis.URL = URL;
	globalThis.URLSearchParams = URLSearchParams;
}

// The engine's console prints every object as "[object Object]"; this one formats like Node's.
{
	const promiseState = globalThis.__graak_native?.promiseState;
	if (promiseState) setPromiseStateReader(promiseState);
	// Until process.stdout/stderr exist (they are streams, built later) console writes straight to the C streams;
	// after that it goes through them, so a program that replaces process.stdout.write sees its console output too.
	globalObject.console = createConsole(
		(text) => {
			if (processModule.stdout?.write && processModule.stdout._isStdio) {
				processModule.stdout.write(text);
				return;
			}
			std.out.puts(text);
			std.out.flush();
		},
		(text) => {
			if (processModule.stderr?.write && processModule.stderr._isStdio) {
				processModule.stderr.write(text);
				return;
			}
			std.out.flush();
			std.err.puts(text);
			std.err.flush();
		},
		() => os.now() / 1000
	);
}

/*
 * Timers. The stock `qjs` binary puts these on the global object; the Graak host embeds only the
 * engine's `os` module, where they live as os.setTimeout and friends. Node hands back an object rather
 * than a number, and libraries call .unref() on it, so the same shape is returned here.
 *
 * The engine's loop runs while any timer is pending, so an unref'd timer is emulated: the ones still referenced are
 * counted, and once none is left the unref'd ones are cancelled (they could never have fired in Node either, which
 * exits when nothing but unref'd timers remain). Everything the runtime keeps alive (sockets, children, pumps) does so
 * with an ordinary timer, so it counts as referenced.
 */
if (typeof globalObject.setTimeout === "undefined" && typeof os.setTimeout === "function") {
	let referenced = 0;
	const unreferenced = new Set();
	let idleCheck = false;
	const settle = () => {
		if (idleCheck || unreferenced.size === 0) return;
		idleCheck = true;
		// A turn later, so a script that unrefs a timer and then makes the timer that keeps it alive is not cut short.
		os.setTimeout(() => {
			idleCheck = false;
			if (referenced > 0) return;
			for (const timer of unreferenced) {
				timer._done = true;
				os.clearTimeout(timer._handle);
			}
			unreferenced.clear();
		}, 0);
	};
	class Timeout {
		constructor(create, run, ms, repeat) {
			this._done = false;
			this._ref = true;
			this._repeat = repeat;
			this._ms = ms;
			this._create = create;
			this._run = run;
			this._start();
		}
		_start() {
			referenced++;
			this._arm();
		}
		_arm() {
			this._handle = this._create(() => {
				if (!this._repeat) {
					this._done = true;
					if (this._ref) referenced--;
					else unreferenced.delete(this);
				}
				try {
					this._run();
				} finally {
					settle();
				}
			}, this._ms);
		}
		ref() {
			if (!this._ref && !this._done) {
				this._ref = true;
				referenced++;
				unreferenced.delete(this);
			}
			return this;
		}
		unref() {
			if (this._ref && !this._done) {
				this._ref = false;
				referenced--;
				unreferenced.add(this);
				settle();
			}
			return this;
		}
		hasRef() {
			return this._ref;
		}
		refresh() {
			if (!this._done) os.clearTimeout(this._handle);
			else {
				this._done = false;
				if (this._ref) referenced++;
				else unreferenced.add(this);
			}
			this._arm();
			return this;
		}
		close() {
			if (!this._done) {
				this._done = true;
				if (this._ref) referenced--;
				else unreferenced.delete(this);
				os.clearTimeout(this._handle);
				settle();
			}
			return this;
		}
		[Symbol.toPrimitive]() {
			return 0;
		}
	}
	const start =
		(create, repeat) =>
		(fn, ms, ...args) => {
			if (typeof fn !== "function") {
				throw new TypeError('The "callback" argument must be of type function.');
			}
			// An exception in a timer is an uncaught exception, not something to lose: without this the engine
			// drops it and the event loop can quietly end.
			const run = () => {
				try {
					fn(...args);
				} catch (error) {
					reportUncaught(error);
				}
			};
			return new Timeout(create, run, Math.max(1, Number(ms) || 1), repeat);
		};
	const clear = (timer) => {
		if (timer instanceof Timeout) timer.close();
		else if (timer != null) os.clearTimeout(timer);
	};
	globalObject.setTimeout = start((fn, ms) => os.setTimeout(fn, ms), false);
	globalObject.setInterval = start((fn, ms) => os.setInterval(fn, ms), true);
	globalObject.clearTimeout = clear;
	globalObject.clearInterval = clear;
}

/*
 * V8's stack-trace API. `Error.captureStackTrace` exists in the engine, but `Error.prepareStackTrace`
 * and CallSite objects do not, and a good deal of published code depends on them: `bindings` finds the
 * calling module's directory this way, and `depd` and `source-map-support` read file and line out of it.
 * The engine's own stack text is parsed into CallSites when a custom prepareStackTrace is installed.
 */
{
	const captureNative = Error.captureStackTrace;
	const FRAME = /^\s*at (?:(.*?) \()?(.*?)(?::(\d+):(\d+))?\)?$/;
	class CallSite {
		constructor(frame) {
			this._frame = frame;
		}
		getThis() {
			return undefined;
		}
		getTypeName() {
			return null;
		}
		getFunction() {
			return undefined;
		}
		getFunctionName() {
			return this._frame.fn || null;
		}
		getMethodName() {
			return null;
		}
		getFileName() {
			return this._frame.file === "native" ? undefined : this._frame.file;
		}
		getLineNumber() {
			return this._frame.line;
		}
		getColumnNumber() {
			return this._frame.column;
		}
		getEvalOrigin() {
			return undefined;
		}
		getScriptNameOrSourceURL() {
			return this.getFileName();
		}
		isToplevel() {
			return !this._frame.fn;
		}
		isEval() {
			return false;
		}
		isNative() {
			return this._frame.file === "native";
		}
		isConstructor() {
			return false;
		}
		isAsync() {
			return false;
		}
		isPromiseAll() {
			return false;
		}
		getPromiseIndex() {
			return null;
		}
		toString() {
			const where = this._frame.file + (this._frame.line ? `:${this._frame.line}:${this._frame.column}` : "");
			return this._frame.fn ? `${this._frame.fn} (${where})` : where;
		}
	}
	Object.defineProperty(Error, "prepareStackTrace", {
		value: undefined,
		writable: true,
		configurable: true,
		enumerable: false,
	});

	// V8 starts every stack with "Name: message"; the engine's begins at the first frame. Code prints
	// `err.stack` to show what went wrong (Express does in its error page), so the header is added on first
	// read and then kept, as V8 fixes it at construction.
	const stackDescriptor = Object.getOwnPropertyDescriptor(Error.prototype, "stack");
	if (stackDescriptor?.get) {
		const headerOf = (error) => {
			let name = "Error";
			let message = "";
			try {
				name = error.name === undefined ? "Error" : String(error.name);
				message = error.message === undefined ? "" : String(error.message);
			} catch {
				// A hostile getter: fall back to the plain header.
			}
			return name && message ? `${name}: ${message}` : name || message;
		};
		Object.defineProperty(Error.prototype, "stack", {
			configurable: true,
			enumerable: false,
			get() {
				const raw = stackDescriptor.get.call(this);
				if (typeof raw !== "string") return raw;
				const value = raw ? `${headerOf(this)}\n${raw}` : headerOf(this);
				try {
					Object.defineProperty(this, "stack", { value, writable: true, configurable: true, enumerable: false });
				} catch {
					// Frozen error: return the value without keeping it.
				}
				return value;
			},
			set: stackDescriptor.set,
		});
	}
	if (typeof captureNative === "function") {
		Error.captureStackTrace = function captureStackTrace(target, constructorOpt) {
			// Frames above and including constructorOpt are left out; this wrapper is one more of them.
			captureNative.call(this, target, constructorOpt ?? Error.captureStackTrace);
			if (typeof Error.prepareStackTrace !== "function") return;
			const lines = String(target.stack).split("\n");
			const frames = lines
				.filter((line) => /^\s*at /.test(line))
				.map((line) => {
					const m = FRAME.exec(line);
					return {
						fn: m?.[1] ?? "",
						file: m?.[2] ?? "",
						line: m?.[3] ? Number(m[3]) : null,
						column: m?.[4] ? Number(m[4]) : null,
					};
				});
			const sites = frames.map((frame) => new CallSite(frame));
			// Evaluated on first read, as V8 does, so a caller can install its hook, capture, read, restore.
			Object.defineProperty(target, "stack", {
				configurable: true,
				enumerable: false,
				get() {
					const value = Error.prepareStackTrace(target, sites);
					Object.defineProperty(target, "stack", { value, writable: true, configurable: true, enumerable: false });
					return value;
				},
				set(value) {
					Object.defineProperty(target, "stack", { value, writable: true, configurable: true, enumerable: false });
				},
			});
		};
	}
}

/* ------------------------------------------------------------------ helpers */

function notImplemented(moduleName, reason) {
	return new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === "__graakUnavailable") return true;
				throw new Error(
					`'${moduleName}' is not available on the quickjs-ng runtime yet. ${reason} ` +
						"Graak does not stub it, because a module that appears to load and then misbehaves is " +
						"harder to diagnose than one that says what is missing."
				);
			},
		}
	);
}

/* --------------------------------------------------- TextEncoder / Decoder */

/*
 * The engine ships neither, and Buffer's utf8 path needs both. Written out rather than
 * approximated with escape/unescape tricks, which mangle anything outside the BMP: a lone
 * surrogate has to become U+FFFD, and a valid pair has to encode as one 4-byte sequence.
 */
class TextEncoderImpl {
	get encoding() {
		return "utf-8";
	}
	encode(input = "") {
		const str = String(input);
		const out = [];
		for (let i = 0; i < str.length; i++) {
			let code = str.charCodeAt(i);
			if (code >= 0xd800 && code <= 0xdbff) {
				const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
				if (next >= 0xdc00 && next <= 0xdfff) {
					code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
					i++;
				} else {
					code = 0xfffd;
				}
			} else if (code >= 0xdc00 && code <= 0xdfff) {
				code = 0xfffd;
			}

			if (code < 0x80) {
				out.push(code);
			} else if (code < 0x800) {
				out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
			} else if (code < 0x10000) {
				out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
			} else {
				out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
			}
		}
		return new Uint8Array(out);
	}
	encodeInto(source, destination) {
		const encoded = this.encode(source);
		const written = Math.min(encoded.length, destination.length);
		destination.set(encoded.subarray(0, written));
		return { read: source.length, written };
	}
}

class TextDecoderImpl {
	constructor(encoding = "utf-8") {
		this.encoding = String(encoding).toLowerCase();
		this._pending = [];
	}
	decode(input, options = {}) {
		if (input === undefined) return "";
		const bytes = ArrayBuffer.isView(input)
			? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
			: new Uint8Array(input);

		if (this.encoding === "latin1" || this.encoding === "binary" || this.encoding === "iso-8859-1") {
			let out = "";
			for (const byte of bytes) out += String.fromCharCode(byte);
			return out;
		}

		// Bytes left over from a previous streaming call complete their sequence here.
		const all = this._pending.length ? [...this._pending, ...bytes] : bytes;
		this._pending = [];

		let out = "";
		let i = 0;
		while (i < all.length) {
			const byte = all[i];
			let needed;
			let code;
			if (byte < 0x80) {
				out += String.fromCharCode(byte);
				i++;
				continue;
			}
			if ((byte & 0xe0) === 0xc0) {
				needed = 1;
				code = byte & 0x1f;
			} else if ((byte & 0xf0) === 0xe0) {
				needed = 2;
				code = byte & 0x0f;
			} else if ((byte & 0xf8) === 0xf0) {
				needed = 3;
				code = byte & 0x07;
			} else {
				out += "�";
				i++;
				continue;
			}

			if (i + needed >= all.length + (options.stream ? 0 : 1) && i + needed > all.length - 1) {
				if (options.stream) {
					// Hold an incomplete tail until the next chunk instead of emitting U+FFFD.
					this._pending = Array.from(all.slice(i));
					return out;
				}
				out += "�";
				break;
			}

			let valid = true;
			for (let k = 1; k <= needed; k++) {
				const cont = all[i + k];
				if ((cont & 0xc0) !== 0x80) {
					valid = false;
					break;
				}
				code = (code << 6) | (cont & 0x3f);
			}
			if (!valid) {
				out += "�";
				i++;
				continue;
			}

			// UTF-8 forbids surrogate code points, overlong encodings and anything above
			// U+10FFFF. Emitting them anyway is how mojibake and lone surrogates get into
			// strings that later fail to round-trip.
			const minimum = needed === 1 ? 0x80 : needed === 2 ? 0x800 : 0x10000;
			if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
				out += "�";
				i += needed + 1;
				continue;
			}

			if (code > 0xffff) {
				code -= 0x10000;
				out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
			} else {
				out += String.fromCharCode(code);
			}
			i += needed + 1;
		}
		return out;
	}
}

const TextEncoder = globalObject.TextEncoder ?? TextEncoderImpl;
const TextDecoder = globalObject.TextDecoder ?? TextDecoderImpl;
globalObject.TextEncoder = TextEncoder;
globalObject.TextDecoder = TextDecoder;

/* ------------------------------------------------------------------- buffer */

/* ------------------------------------------------------------------- events */

function initEventEmitter() {
	this._events = Object.create(null);
	this._maxListeners = undefined;
}

/*
 * Framework code mixes EventEmitter.prototype into plain objects and functions (Express does this to its
 * `app`) without ever running the constructor, so every method has to cope with `_events` not existing yet.
 */
const eventsOf = (emitter) => emitter._events ?? (emitter._events = Object.create(null));

function addListener(emitter, name, fn, prepend, once) {
	if (typeof fn !== "function") {
		throw Object.assign(
			new TypeError(`The "listener" argument must be of type function. Received ${fn === null ? "null" : typeof fn}`),
			{
				code: "ERR_INVALID_ARG_TYPE",
			}
		);
	}
	const events = eventsOf(emitter);
	let entry = fn;
	if (once) {
		const state = { fired: false };
		entry = function onceWrapper(...args) {
			if (state.fired) return undefined;
			state.fired = true;
			emitter.removeListener(name, entry);
			return fn.apply(emitter, args);
		};
		entry.listener = fn;
	}
	// 'newListener' fires before the listener is added, with the original function.
	if (events.newListener !== undefined && name !== "newListener") emitter.emit("newListener", name, fn);
	const list = events[name] ?? (events[name] = []);
	if (prepend) list.unshift(entry);
	else list.push(entry);
	return emitter;
}

class EventEmitter {
	constructor() {
		initEventEmitter.call(this);
	}

	on(name, fn) {
		return addListener(this, name, fn, false, false);
	}

	addListener(name, fn) {
		return addListener(this, name, fn, false, false);
	}

	once(name, fn) {
		return addListener(this, name, fn, false, true);
	}

	prependListener(name, fn) {
		return addListener(this, name, fn, true, false);
	}

	prependOnceListener(name, fn) {
		return addListener(this, name, fn, true, true);
	}

	off(name, fn) {
		return this.removeListener(name, fn);
	}

	removeListener(name, fn) {
		const events = eventsOf(this);
		const list = events[name];
		if (!list) return this;
		for (let i = list.length - 1; i >= 0; i--) {
			if (list[i] === fn || list[i].listener === fn) {
				list.splice(i, 1);
				if (!list.length) delete events[name];
				if (events.removeListener !== undefined) this.emit("removeListener", name, fn);
				break;
			}
		}
		return this;
	}

	removeAllListeners(name) {
		const events = eventsOf(this);
		if (name === undefined) this._events = Object.create(null);
		else delete events[name];
		return this;
	}

	emit(name, ...args) {
		const events = eventsOf(this);
		if (name === "error" && events[errorMonitorSymbol]) {
			for (const fn of [...events[errorMonitorSymbol]]) fn.apply(this, args);
		}
		const list = events[name];
		if (!list || !list.length) {
			// Node throws on an unhandled 'error' event rather than swallowing it, and code
			// depends on that being how a failure surfaces.
			if (name === "error") {
				if (args[0] instanceof Error) throw args[0];
				throw Object.assign(
					new Error(`Unhandled error. (${typeof args[0] === "string" ? `'${args[0]}'` : String(args[0])})`),
					{
						code: "ERR_UNHANDLED_ERROR",
						context: args[0],
					}
				);
			}
			return false;
		}
		for (const fn of list.length === 1 ? list : [...list]) fn.apply(this, args);
		return true;
	}

	listenerCount(name, fn) {
		const list = eventsOf(this)[name];
		if (!list) return 0;
		return fn === undefined ? list.length : list.filter((entry) => entry === fn || entry.listener === fn).length;
	}

	listeners(name) {
		return (eventsOf(this)[name] ?? []).map((entry) => entry.listener ?? entry);
	}

	rawListeners(name) {
		return [...(eventsOf(this)[name] ?? [])];
	}

	eventNames() {
		return Reflect.ownKeys(eventsOf(this));
	}

	setMaxListeners(n) {
		this._maxListeners = n;
		return this;
	}

	getMaxListeners() {
		return this._maxListeners === undefined ? EventEmitter.defaultMaxListeners : this._maxListeners;
	}

	static listenerCount(emitter, name) {
		return emitter.listenerCount(name);
	}

	static once(emitter, name, options) {
		return new Promise((resolve, reject) => {
			if (options?.signal?.aborted)
				return reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }));
			const onEvent = (...args) => {
				if (name !== "error") emitter.removeListener("error", onError);
				resolve(args);
			};
			const onError = (err) => {
				emitter.removeListener(name, onEvent);
				reject(err);
			};
			emitter.once(name, onEvent);
			if (name !== "error") emitter.once("error", onError);
			options?.signal?.addEventListener(
				"abort",
				() => {
					emitter.removeListener(name, onEvent);
					emitter.removeListener("error", onError);
					reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }));
				},
				{ once: true }
			);
		});
	}

	static getEventListeners(emitter, name) {
		return emitter.listeners(name);
	}

	static setMaxListeners(n, ...emitters) {
		if (!emitters.length) EventEmitter.defaultMaxListeners = n;
		else for (const emitter of emitters) emitter.setMaxListeners?.(n);
	}
}
const errorMonitorSymbol = Symbol("events.errorMonitor");
EventEmitter.errorMonitor = errorMonitorSymbol;
EventEmitter.captureRejections = false;
EventEmitter.EventEmitter = EventEmitter;
EventEmitter.defaultMaxListeners = 10;

/* --------------------------------------------------------------------- path */

const isWindows = os.platform === "win32";

function makePath(sep) {
	const windows = sep === "\\";
	// A Windows path's root is a drive ("C:\\", or "C:" alone), a bare separator, or a UNC prefix; a POSIX
	// path's is "/". Treating "C:" as an ordinary segment (as this once did) mangles every absolute path.
	const rootOf = (p) => {
		if (!windows) return p.startsWith("/") ? "/" : "";
		const m = /^(?:([a-zA-Z]:)([\\/])?|([\\/]))/.exec(p);
		if (!m) return "";
		return m[1] ? m[1] + (m[2] ? "\\" : "") : "\\";
	};
	const isAbsolute = (p) => (windows ? /^([a-zA-Z]:[\\/]|[\\/])/.test(p) : p.startsWith("/"));

	function normalizeParts(parts, allowAboveRoot) {
		const out = [];
		for (const part of parts) {
			if (!part || part === ".") continue;
			if (part === "..") {
				if (out.length && out[out.length - 1] !== "..") out.pop();
				else if (allowAboveRoot) out.push("..");
			} else {
				out.push(part);
			}
		}
		return out;
	}

	const path = {
		sep,
		delimiter: windows ? ";" : ":",
		isAbsolute,
		normalize(p) {
			const root = rootOf(p);
			const absolute = isAbsolute(p);
			const trailing = /[\\/]$/.test(p) && p.length > root.length;
			let result = normalizeParts(p.slice(root.length).split(/[\\/]+/), !absolute).join(sep);
			if (!result && !absolute && !root) result = ".";
			if (result && trailing) result += sep;
			return root + result;
		},
		join(...parts) {
			const joined = parts.filter((p) => p !== "" && p !== undefined).join(sep);
			return joined ? path.normalize(joined) : ".";
		},
		resolve(...parts) {
			let resolved = "";
			for (let i = parts.length - 1; i >= 0; i--) {
				const part = parts[i];
				if (!part) continue;
				resolved = resolved ? `${part}${sep}${resolved}` : part;
				if (isAbsolute(part)) break;
			}
			if (!isAbsolute(resolved)) resolved = `${os.getcwd()[0]}${sep}${resolved}`;
			// "\\dir" has no drive of its own: it belongs to the current one.
			if (windows) {
				const driveMatch = /^[\\/]+([a-zA-Z]:[\\/]?.*)/.exec(resolved);
				if (driveMatch) {
					resolved = driveMatch[1];
				} else if (/^[\\/]/.test(resolved)) {
					resolved = os.getcwd()[0].slice(0, 2) + resolved;
				}
			}
			const out = path.normalize(resolved);
			const root = rootOf(out);
			return out.length > root.length ? out.replace(/[\\/]$/, "") : out;
		},
		dirname(p) {
			const root = rootOf(p);
			const body = p.slice(root.length).replace(/[\\/]+$/, "");
			const at = Math.max(body.lastIndexOf("/"), windows ? body.lastIndexOf("\\") : -1);
			if (at < 0) return root || ".";
			return root + body.slice(0, at);
		},
		basename(p, ext) {
			const base =
				p
					.replace(/[\\/]+$/, "")
					.split(/[\\/]/)
					.pop() ?? "";
			return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
		},
		extname(p) {
			const base = path.basename(p);
			const dot = base.lastIndexOf(".");
			return dot > 0 ? base.slice(dot) : "";
		},
		relative(from, to) {
			const a = path.resolve(from);
			const b = path.resolve(to);
			if (windows && rootOf(a).toLowerCase() !== rootOf(b).toLowerCase()) return b;
			const fromParts = a.slice(rootOf(a).length).split(/[\\/]/).filter(Boolean);
			const toParts = b.slice(rootOf(b).length).split(/[\\/]/).filter(Boolean);
			const same = (x, y) => (windows ? x.toLowerCase() === y.toLowerCase() : x === y);
			while (fromParts.length && toParts.length && same(fromParts[0], toParts[0])) {
				fromParts.shift();
				toParts.shift();
			}
			return [...fromParts.map(() => ".."), ...toParts].join(sep);
		},
		parse(p) {
			const dir = path.dirname(p);
			const base = path.basename(p);
			const ext = path.extname(p);
			return { root: rootOf(p), dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
		},
		format(obj) {
			return path.join(obj.dir || obj.root || "", obj.base || `${obj.name || ""}${obj.ext || ""}`);
		},
	};
	return path;
}

const posixPath = makePath("/");
const win32Path = makePath("\\");
const pathModule = isWindows ? win32Path : posixPath;
pathModule.posix = posixPath;
pathModule.win32 = win32Path;

/* ----------------------------------------------------------------------- fs */

/* `fs` is built in node-fs.js once the stream classes it extends exist (see below). */
const fs = {};

/* ------------------------------------------------------------------ process */

// qjs:os hands the path back as a string; an older engine returned [path, error].
const exePathOf = () => {
	const found = os.exePath?.();
	return (Array.isArray(found) ? found[0] : found) || "qjs";
};
const processModule = new EventEmitter();
Object.assign(processModule, {
	argv: [exePathOf(), ...(globalObject.scriptArgs ?? []).slice(1)],
	argv0: "node",
	execArgv: [],
	title: "node",
	exitCode: undefined,
	env: std.getenviron(),
	platform: os.platform === "win32" ? "win32" : os.platform,
	arch: globalThis.__graak_native?.arch ?? "ia32",
	version: "v20.18.0",
	versions: {
		node: "20.18.0",
		v8: "0.0.0-quickjs-ng",
		quickjs: "0.16.2",
		uv: "1.48.0",
		modules: "0",
		napi: "10",
		openssl: "mbedtls-3.6.2",
		zlib: "miniz-3.0.2",
	},
	release: { name: "node", lts: "Iron" },
	config: { target_defaults: {}, variables: {} },
	features: {
		inspector: false,
		debug: false,
		uv: true,
		ipv6: true,
		tls_alpn: false,
		tls_sni: true,
		tls_ocsp: false,
		tls: true,
	},
	pid: os.getpid?.() ?? globalThis.__graak_native?.getpid?.() ?? 0,
	execPath: exePathOf(),
	cwd: () => os.getcwd()[0],
	chdir: (dir) => os.chdir(dir),
	exit: (code) => {
		if (code !== undefined) processModule.exitCode = code;
		const finalCode = processModule.exitCode ?? 0;
		if (!processModule._exiting) {
			processModule._exiting = true;
			try {
				processModule.emit("exit", finalCode);
			} catch {
				// An 'exit' listener that throws must not keep the process alive.
			}
		}
		std.exit(finalCode);
	},
	hrtime: Object.assign(
		(prev) => {
			const now = os.now() * 1000;
			const ns = prev ? now - (prev[0] * 1e9 + prev[1]) : now;
			return [Math.floor(ns / 1e9), Math.floor(ns % 1e9)];
		},
		{ bigint: () => BigInt(Math.floor(os.now() * 1000)) }
	),
	nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
	uptime: () => os.now() / 1e6,
	memoryUsage: Object.assign(
		() => ({
			rss: 50 * 1024 * 1024,
			heapTotal: 32 * 1024 * 1024,
			heapUsed: 16 * 1024 * 1024,
			external: 0,
			arrayBuffers: 0,
		}),
		{ rss: () => 50 * 1024 * 1024 }
	),
	cpuUsage: () => ({ user: Math.round((os.cputime?.() ?? 0) * 1000), system: 0 }),
	resourceUsage: () => ({ userCPUTime: 0, systemCPUTime: 0, maxRSS: 0 }),
	umask: () => 0o022,
	getuid: () => 0,
	geteuid: () => 0,
	getgid: () => 0,
	getegid: () => 0,
	getgroups: () => [],
	kill: (pid, signal = "SIGTERM") => {
		const signals = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGUSR1: 10, SIGUSR2: 12, SIGTERM: 15, 0: 0 };
		const number = typeof signal === "number" ? signal : signals[signal];
		if (number === undefined)
			throw Object.assign(new TypeError(`Unknown signal: ${signal}`), { code: "ERR_UNKNOWN_SIGNAL" });
		const rc = os.kill?.(pid, number) ?? -1;
		if (rc < 0) throw Object.assign(new Error(`kill ESRCH`), { code: "ESRCH", errno: rc, syscall: "kill" });
		return true;
	},
	abort: () => std.exit(134),
	binding: () => {
		throw new Error("process.binding is not available in the Graak native host");
	},
	setUncaughtExceptionCaptureCallback: () => {},
	hasUncaughtExceptionCaptureCallback: () => false,
	setSourceMapsEnabled: () => {},
	allowedNodeEnvironmentFlags: new Set(),
	stdout: { write: (s) => (std.out.puts(s), true), isTTY: false, fd: 1 },
	stderr: { write: (s) => (std.err.puts(s), true), isTTY: false, fd: 2 },
	emitWarning: (warning) => std.err.puts(`Warning: ${warning}\n`),
});

function formatSourceContext(error) {
	if (!error) return "";
	const stack = typeof error.stack === "string" ? error.stack : "";
	if (!stack) return "";
	const lines = stack.split("\n");
	const parseFrame = (line) => {
		const match = line.match(/\bat (?:.*?\((.+?):(\d+):(\d+)\)|(.+?):(\d+):(\d+))$/);
		if (!match) return null;
		const file = match[1] || match[4];
		const lineNum = Number.parseInt(match[2] || match[5], 10);
		const colNum = Number.parseInt(match[3] || match[6], 10);
		return { file, lineNum, colNum };
	};

	let chosen = null;
	for (const line of lines) {
		const frame = parseFrame(line);
		if (!frame || !frame.file || Number.isNaN(frame.lineNum) || frame.file.startsWith("native")) continue;
		if (frame.file.includes("/runtime/node-") || frame.file.includes("\\runtime\\node-")) continue;
		chosen = frame;
		break;
	}
	if (!chosen) {
		for (const line of lines) {
			const frame = parseFrame(line);
			if (!frame || !frame.file || Number.isNaN(frame.lineNum) || frame.file.startsWith("native")) continue;
			chosen = frame;
			break;
		}
	}
	if (!chosen) return "";

	let content = null;
	try {
		content = std.loadFile(chosen.file);
	} catch {
		try {
			if (fs.readFileSync) content = fs.readFileSync(chosen.file, "utf8");
		} catch {}
	}
	if (typeof content !== "string") return "";

	const srcLines = content.split(/\r?\n/);
	if (chosen.lineNum > 0 && chosen.lineNum <= srcLines.length) {
		const srcLine = srcLines[chosen.lineNum - 1];
		const col = Math.max(0, chosen.colNum - 1);
		const pointer = `${" ".repeat(col)}^`;
		return `${chosen.file}:${chosen.lineNum}\n${srcLine}\n${pointer}\n\n`;
	}
	return "";
}

function formatErrorWithContext(error) {
	if (!error) return `Uncaught ${inspectValue(error)}`;
	const prefix = formatSourceContext(error);
	let body = "";
	if (error instanceof Error) {
		const name = error.name || "Error";
		const msg = error.message || "";
		const header = `${name}: ${msg}`;
		let stack = typeof error.stack === "string" ? error.stack : "";
		if (stack && !stack.startsWith(header)) {
			stack = `${header}\n${stack}`;
		} else if (!stack) {
			stack = header;
		}

		const extra = {};
		for (const key of Object.getOwnPropertyNames(error)) {
			if (key !== "name" && key !== "message" && key !== "stack") {
				extra[key] = error[key];
			}
		}
		let extraText = "";
		if (Object.keys(extra).length > 0) {
			extraText = ` ${inspectValue(extra, { depth: 2, colors: false })}`;
		}
		if (error.cause !== undefined && !stack.includes("[cause]")) {
			extraText += ` {\n  [cause]: ${inspectValue(error.cause, { depth: 2, colors: false })}\n}`;
		}
		body = stack + extraText;
	} else {
		body = `Uncaught ${inspectValue(error)}`;
	}
	return prefix + body;
}

/*
 * What Node does with an exception nothing caught: give 'uncaughtException' listeners the chance, and
 * otherwise print it and exit with status 1. Timers and the socket poller route their errors here.
 */
function reportUncaught(error) {
	if (processModule.listenerCount("uncaughtException") > 0) {
		try {
			processModule.emit("uncaughtException", error, "uncaughtException");
			return;
		} catch (thrown) {
			error = thrown;
		}
	}
	const text = formatErrorWithContext(error);
	std.err.puts(`${text}\n`);
	processModule.exitCode = 1;
	processModule.exit(1);
}
globalObject.__graak_reportUncaught = reportUncaught;
/* Called by the host when the event loop runs dry (a listener may schedule more work) and again just before it exits. */
globalObject.__graak_beforeExit = () => {
	processModule.emit("beforeExit", processModule.exitCode ?? 0);
};
globalObject.__graak_exit = () => {
	if (!processModule._exiting) {
		processModule._exiting = true;
		try {
			processModule.emit("exit", processModule.exitCode ?? 0);
		} catch (error) {
			std.err.puts(`${error && error.stack ? error.stack : error}\n`);
			return 1;
		}
	}
	return Number(processModule.exitCode ?? 0) || 0;
};

/* --------------------------------------------------------------------- util */

const util = {
	inherits(ctor, superCtor) {
		Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
		Object.setPrototypeOf(ctor, superCtor);
	},
	promisify: Object.assign(
		(fn) => {
			if (typeof fn !== "function") {
				throw Object.assign(
					new TypeError(
						`The "original" argument must be of type function. Received ${fn === null ? "null" : typeof fn}`
					),
					{ code: "ERR_INVALID_ARG_TYPE" }
				);
			}
			// A function can say how it wants to be promisified (fs.exists, setTimeout, stream.pipeline, ...).
			const custom = fn[Symbol.for("nodejs.util.promisify.custom")];
			if (typeof custom === "function")
				return Object.defineProperty(custom, Symbol.for("nodejs.util.promisify.custom"), {
					value: custom,
					enumerable: false,
				});
			const promisified = function (...args) {
				return new Promise((resolve, reject) => {
					fn.call(this, ...args, (err, ...values) =>
						err
							? reject(err)
							: resolve(values.length > 1 && fn[Symbol.for("nodejs.util.promisify.customArgs")] ? values : values[0])
					);
				});
			};
			Object.setPrototypeOf(promisified, Object.getPrototypeOf(fn));
			return Object.defineProperties(promisified, Object.getOwnPropertyDescriptors(fn));
		},
		{ custom: Symbol.for("nodejs.util.promisify.custom") }
	),
	callbackify(fn) {
		return function (...args) {
			const cb = args.pop();
			if (typeof cb !== "function")
				throw Object.assign(new TypeError("The last argument must be of type function."), {
					code: "ERR_INVALID_ARG_TYPE",
				});
			fn.apply(this, args).then(
				(value) => queueMicrotask(() => cb(null, value)),
				(err) =>
					queueMicrotask(() =>
						cb(
							err ??
								Object.assign(new Error("Promise was rejected with a falsy value"), {
									reason: err,
									code: "ERR_FALSY_VALUE_REJECTION",
								})
						)
					)
			);
		};
	},
	format: inspectFormat,
	// The pre-Node-23 type predicates and helpers older packages still call.
	isArray: Array.isArray,
	isBoolean: (v) => typeof v === "boolean",
	isNull: (v) => v === null,
	isNullOrUndefined: (v) => v === null || v === undefined,
	isNumber: (v) => typeof v === "number",
	isString: (v) => typeof v === "string",
	isSymbol: (v) => typeof v === "symbol",
	isUndefined: (v) => v === undefined,
	isRegExp: (v) => v instanceof RegExp,
	isObject: (v) => v !== null && typeof v === "object",
	isDate: (v) => v instanceof Date,
	isError: (v) => v instanceof Error,
	isFunction: (v) => typeof v === "function",
	isPrimitive: (v) => v === null || (typeof v !== "object" && typeof v !== "function"),
	log: (...args) =>
		console.log(`${new Date().toISOString().slice(0, 19).replace("T", " ")} - ${inspectFormat(...args)}`),
	_extend: (target, source) => Object.assign(target, source),
	formatWithOptions: (options, ...args) => {
		// Options apply to the inspected arguments; a plain format is the common case.
		const { colors } = options ?? {};
		return colors
			? inspectFormat(...args.map((a) => (typeof a === "string" ? a : inspectValue(a, options))))
			: inspectFormat(...args);
	},
	stripVTControlCharacters: (text) =>
		String(text).replace(/[\u001b\u009b][[()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-ORZcf-nqry=><]/g, ""),
	styleText: (format, text) => {
		const names = Array.isArray(format) ? format : [format];
		const codes = {
			reset: [0, 0],
			bold: [1, 22],
			dim: [2, 22],
			italic: [3, 23],
			underline: [4, 24],
			inverse: [7, 27],
			hidden: [8, 28],
			strikethrough: [9, 29],
			black: [30, 39],
			red: [31, 39],
			green: [32, 39],
			yellow: [33, 39],
			blue: [34, 39],
			magenta: [35, 39],
			cyan: [36, 39],
			white: [37, 39],
			gray: [90, 39],
			grey: [90, 39],
			bgRed: [41, 49],
			bgGreen: [42, 49],
			bgYellow: [43, 49],
			bgBlue: [44, 49],
		};
		let out = String(text);
		for (const name of names) {
			const code = codes[name];
			if (!code)
				throw Object.assign(
					new TypeError(`The argument 'format' must be one of: ${Object.keys(codes).join(", ")}. Received '${name}'`),
					{ code: "ERR_INVALID_ARG_VALUE" }
				);
			out = `\u001b[${code[0]}m${out}\u001b[${code[1]}m`;
		}
		return out;
	},
	toUSVString: (value) => String(value).toWellFormed?.() ?? String(value),
	getSystemErrorName: (errno) =>
		({
			[-1]: "EPERM",
			[-2]: "ENOENT",
			[-13]: "EACCES",
			[-17]: "EEXIST",
			[-20]: "ENOTDIR",
			[-21]: "EISDIR",
			[-22]: "EINVAL",
			[-32]: "EPIPE",
			[-98]: "EADDRINUSE",
			[-104]: "ECONNRESET",
			[-110]: "ETIMEDOUT",
			[-111]: "ECONNREFUSED",
		})[errno],
	getSystemErrorMap: () =>
		new Map([
			[-1, ["EPERM", "operation not permitted"]],
			[-2, ["ENOENT", "no such file or directory"]],
			[-13, ["EACCES", "permission denied"]],
			[-17, ["EEXIST", "file already exists"]],
			[-98, ["EADDRINUSE", "address already in use"]],
			[-111, ["ECONNREFUSED", "connection refused"]],
		]),
	aborted: (signal) =>
		new Promise((resolve) =>
			signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })
		),
	parseEnv: (content) => {
		const out = {};
		for (const rawLine of String(content).split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			const match = /^(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/.exec(line);
			if (!match) continue;
			let value = match[2].trim();
			const quote = value[0];
			if ((quote === '"' || quote === "'" || quote === "`") && value.endsWith(quote) && value.length > 1)
				value = value.slice(1, -1);
			else value = value.replace(/\s+#.*$/, "");
			out[match[1]] = quote === '"' ? value.replace(/\\n/g, "\n") : value;
		}
		return out;
	},
	parseArgs: (config = {}) => {
		const {
			args = process.argv.slice(2),
			options = {},
			strict = true,
			allowPositionals = !strict,
			allowNegative = false,
		} = config;
		const values = {};
		const positionals = [];
		const short = {};
		for (const [name, def] of Object.entries(options)) if (def.short) short[def.short] = name;
		const assign = (name, def, value) => {
			if (def.multiple) (values[name] ??= []).push(value);
			else values[name] = value;
		};
		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			if (arg === "--") {
				positionals.push(...args.slice(i + 1));
				break;
			}
			let name;
			let inline;
			if (arg.startsWith("--")) {
				const eq = arg.indexOf("=");
				name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
				inline = eq < 0 ? undefined : arg.slice(eq + 1);
			} else if (arg.startsWith("-") && arg.length > 1) {
				name = short[arg[1]] ?? arg[1];
				inline = arg.length > 2 ? arg.slice(2) : undefined;
			} else {
				if (strict && !allowPositionals)
					throw Object.assign(
						new TypeError(`Unexpected argument '${arg}'. This command does not take positional arguments`),
						{ code: "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL" }
					);
				positionals.push(arg);
				continue;
			}
			let def = options[name];
			if (!def && allowNegative && name.startsWith("no-") && options[name.slice(3)]?.type === "boolean") {
				assign(name.slice(3), options[name.slice(3)], false);
				continue;
			}
			if (!def) {
				if (strict)
					throw Object.assign(new TypeError(`Unknown option '${arg.startsWith("--") ? `--${name}` : `-${name}`}'`), {
						code: "ERR_PARSE_ARGS_UNKNOWN_OPTION",
					});
				def = {
					type: inline === undefined && (i + 1 >= args.length || args[i + 1].startsWith("-")) ? "boolean" : "string",
				};
			}
			if (def.type === "string") {
				const value = inline ?? args[++i];
				if (value === undefined)
					throw Object.assign(new TypeError(`Option '--${name} <value>' argument missing`), {
						code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE",
					});
				assign(name, def, value);
			} else assign(name, def, true);
		}
		for (const [name, def] of Object.entries(options))
			if (def.default !== undefined && values[name] === undefined) values[name] = def.default;
		return { values, positionals };
	},
	inspect: inspectValue,
	isDeepStrictEqual(a, b) {
		return deepEqual(a, b);
	},
	types: createUtilTypes({ isProxy: globalThis.__graak_native?.isProxy }),
	deprecate(fn, message, code) {
		let warned = false;
		return function (...args) {
			if (!warned) {
				warned = true;
				processModule.emitWarning?.(message, "DeprecationWarning", code);
			}
			return fn.apply(this, args);
		};
	},
	// NODE_DEBUG=section[,section...] turns a section's log on, as in Node.js.
	debuglog(section) {
		const wanted = (std.getenv("NODE_DEBUG") ?? "")
			.split(",")
			.map((name) => name.trim().toUpperCase())
			.filter(Boolean);
		const enabled = wanted.includes(String(section).toUpperCase()) || wanted.includes("*");
		const log = (...args) => {
			if (enabled)
				std.err.puts(`${String(section).toUpperCase()} ${processModule.pid ?? 0}: ${util.format(...args)}\n`);
		};
		log.enabled = enabled;
		return log;
	},
	TextEncoder,
	TextDecoder,
};

function deepEqual(a, b) {
	if (a === b) return true;
	if (typeof a !== typeof b || a === null || b === null || typeof a !== "object")
		return Number.isNaN(a) && Number.isNaN(b);
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const ka = Object.keys(a);
	const kb = Object.keys(b);
	if (ka.length !== kb.length) return false;
	return ka.every((k) => deepEqual(a[k], b[k]));
}

/* ------------------------------------------------------------------- assert */

const assert = createAssert({ inspect: (value, options) => util.inspect(value, options) });

/* --------------------------------------------------------- web-ish globals */

class Event {
	constructor(type, init = {}) {
		this.type = type;
		this.defaultPrevented = false;
		this.cancelable = Boolean(init.cancelable);
		this.target = null;
	}
	preventDefault() {
		if (this.cancelable) this.defaultPrevented = true;
	}
	stopPropagation() {}
	stopImmediatePropagation() {}
}

class EventTarget {
	constructor() {
		this._listeners = Object.create(null);
	}
	addEventListener(type, fn, options = {}) {
		(this._listeners[type] ||= []).push({ fn, once: Boolean(options.once) });
	}
	removeEventListener(type, fn) {
		const list = this._listeners[type];
		if (!list) return;
		const index = list.findIndex((entry) => entry.fn === fn);
		if (index !== -1) list.splice(index, 1);
	}
	dispatchEvent(event) {
		event.target = this;
		for (const entry of [...(this._listeners[event.type] ?? [])]) {
			if (entry.once) this.removeEventListener(event.type, entry.fn);
			typeof entry.fn === "function" ? entry.fn.call(this, event) : entry.fn.handleEvent(event);
		}
		return !event.defaultPrevented;
	}
}

class AbortSignal extends EventTarget {
	constructor() {
		super();
		this.aborted = false;
		this.reason = undefined;
		this.onabort = null;
	}
	throwIfAborted() {
		if (this.aborted) throw this.reason;
	}
	static abort(reason) {
		const signal = new AbortSignal();
		signal.aborted = true;
		signal.reason = reason ?? new Error("This operation was aborted");
		return signal;
	}
	static timeout(ms) {
		const controller = new AbortController();
		setTimeout(() => controller.abort(new Error("The operation was aborted due to timeout")), ms);
		return controller.signal;
	}
}

class AbortController {
	constructor() {
		this.signal = new AbortSignal();
	}
	abort(reason) {
		if (this.signal.aborted) return;
		this.signal.aborted = true;
		this.signal.reason = reason ?? new Error("This operation was aborted");
		const event = new Event("abort");
		this.signal.onabort?.call(this.signal, event);
		this.signal.dispatchEvent(event);
	}
}

/*
 * A real structured clone, not a JSON round-trip: binary data has to survive, or anything built on it silently loses
 * bytes. Follows the HTML algorithm's observable rules: circular references and shared references are kept, Date,
 * RegExp, Map, Set, Error (with its cause), boxed primitives, ArrayBuffer and every typed array view are copied, a class
 * instance comes back as a plain object, and a function or symbol is a DataCloneError.
 */
function structuredClone(value, options) {
	if (arguments.length === 0)
		throw Object.assign(new TypeError('The "value" argument must be specified'), { code: "ERR_MISSING_ARGS" });
	void options;
	return cloneValue(value, new Map());
}

function cloneValue(value, seen) {
	const fail = () => {
		const text = typeof value === "symbol" ? value.toString() : String(value).split("\n")[0].slice(0, 80);
		throw new (globalThis.DOMException ?? Error)(`${text} could not be cloned.`, "DataCloneError");
	};
	if (typeof value === "function" || typeof value === "symbol") fail();
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return seen.get(value);
	const remember = (copy) => {
		seen.set(value, copy);
		return copy;
	};
	if (value instanceof Date) return remember(new Date(value.getTime()));
	if (value instanceof RegExp) return remember(new RegExp(value.source, value.flags));
	if (value instanceof ArrayBuffer) return remember(value.slice(0));
	if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) return remember(value);
	if (ArrayBuffer.isView(value)) {
		const buffer = cloneValue(value.buffer, seen);
		if (value instanceof DataView) return remember(new DataView(buffer, value.byteOffset, value.byteLength));
		const Ctor =
			Object.getPrototypeOf(Object.getPrototypeOf(value)) === Uint8Array.prototype ? Uint8Array : value.constructor;
		return remember(new Ctor(buffer, value.byteOffset, value.length));
	}
	if (value instanceof Map) {
		const copy = remember(new Map());
		for (const [k, v] of value) copy.set(cloneValue(k, seen), cloneValue(v, seen));
		return copy;
	}
	if (value instanceof Set) {
		const copy = remember(new Set());
		for (const v of value) copy.add(cloneValue(v, seen));
		return copy;
	}
	if (value instanceof Error) {
		const known = ["Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError"];
		const Ctor = known.includes(value.name) ? globalThis[value.name] : Error;
		const copy = remember(new Ctor(value.message));
		if (typeof value.stack === "string")
			Object.defineProperty(copy, "stack", {
				value: value.stack,
				writable: true,
				configurable: true,
				enumerable: false,
			});
		if ("cause" in value)
			Object.defineProperty(copy, "cause", {
				value: cloneValue(value.cause, seen),
				writable: true,
				configurable: true,
				enumerable: false,
			});
		return copy;
	}
	if (value instanceof Number || value instanceof String || value instanceof Boolean)
		return remember(Object(value.valueOf()));
	if (typeof BigInt !== "undefined" && Object.prototype.toString.call(value) === "[object BigInt]")
		return remember(Object(value.valueOf()));
	if (
		value instanceof Promise ||
		value instanceof WeakMap ||
		value instanceof WeakSet ||
		(typeof WeakRef !== "undefined" && value instanceof WeakRef)
	)
		fail();
	if (typeof Blob !== "undefined" && value instanceof Blob) return remember(value);
	const copy = remember(Array.isArray(value) ? new Array(value.length) : {});
	for (const key of Object.keys(value)) copy[key] = cloneValue(value[key], seen);
	return copy;
}

/* ------------------------------------------------------------ small modules */

const querystring = {
	parse(str) {
		const out = Object.create(null);
		for (const pair of String(str).split("&")) {
			if (!pair) continue;
			const eq = pair.indexOf("=");
			const key = decodeURIComponent((eq === -1 ? pair : pair.slice(0, eq)).replace(/\+/g, " "));
			const value = eq === -1 ? "" : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
			if (key in out) out[key] = [].concat(out[key], value);
			else out[key] = value;
		}
		return out;
	},
	stringify(obj) {
		return Object.entries(obj)
			.flatMap(([k, v]) => [].concat(v).map((item) => `${encodeURIComponent(k)}=${encodeURIComponent(item)}`))
			.join("&");
	},
	escape: encodeURIComponent,
	unescape: decodeURIComponent,
};

/*
 * StringDecoder keeps the bytes of a character split across chunks until the rest arrives. A function
 * constructor rather than a class, because old code inherits with `StringDecoder.call(this, encoding)`
 * (iconv-lite does), which an ES class refuses.
 */
function StringDecoder(encoding) {
	const enc = normalizeEncoding(encoding);
	if (enc === null) {
		throw Object.assign(new TypeError(`Unknown encoding: ${encoding}`), { code: "ERR_UNKNOWN_ENCODING" });
	}
	this.encoding = enc;
	this._pending = new Uint8Array(0);
}

/* How many trailing bytes of `bytes` are the start of a character that is not complete yet. */
function incompleteTail(encoding, bytes) {
	const n = bytes.length;
	if (encoding === "utf8") {
		for (let back = 1; back <= Math.min(3, n); back++) {
			const byte = bytes[n - back];
			if ((byte & 0xc0) === 0x80) continue; // a continuation byte: keep looking for its lead
			const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
			return need > back ? back : 0;
		}
		return 0;
	}
	if (encoding === "utf16le") {
		let keep = n % 2;
		// A high surrogate at the end waits for its low half.
		if (n - keep >= 2) {
			const unit = bytes[n - keep - 2] | (bytes[n - keep - 1] << 8);
			if (unit >= 0xd800 && unit <= 0xdbff) keep += 2;
		}
		return keep;
	}
	if (encoding === "base64" || encoding === "base64url") return n % 3;
	return 0;
}

StringDecoder.prototype.write = function write(buf) {
	if (typeof buf === "string") return buf;
	const bytes =
		buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.byteLength);
	const all = this._pending.length ? Buffer.concat([this._pending, bytes]) : bytes;
	const keep = incompleteTail(this.encoding, all);
	this._pending = keep ? Buffer.from(all.subarray(all.length - keep)) : new Uint8Array(0);
	const complete = keep ? all.subarray(0, all.length - keep) : all;
	return Buffer.from(complete).toString(this.encoding);
};

StringDecoder.prototype.end = function end(buf) {
	let out = buf === undefined ? "" : this.write(buf);
	if (this._pending.length) {
		out += this.encoding === "utf8" ? "\ufffd" : Buffer.from(this._pending).toString(this.encoding);
		this._pending = new Uint8Array(0);
	}
	return out;
};

StringDecoder.prototype.text = function text(buf, offset) {
	return this.write(buf.subarray(offset));
};

const osModule = createOs({ std, processModule, readText: (file) => std.loadFile(file) });

const timers = {
	setTimeout: globalObject.setTimeout,
	clearTimeout: globalObject.clearTimeout,
	setInterval: globalObject.setInterval,
	clearInterval: globalObject.clearInterval,
	setImmediate: (fn, ...args) => globalObject.setTimeout(() => fn(...args), 0),
	clearImmediate: (handle) => globalObject.clearTimeout(handle),
};

/* ------------------------------------------------------- diagnostics_channel */

const diagnosticsChannels = Object.create(null);

class Channel {
	constructor(name) {
		this.name = name;
		this._subscribers = [];
	}
	get hasSubscribers() {
		return this._subscribers.length > 0;
	}
	publish(message) {
		for (const fn of [...this._subscribers]) fn(message, this.name);
	}
	subscribe(fn) {
		this._subscribers.push(fn);
	}
	unsubscribe(fn) {
		const index = this._subscribers.indexOf(fn);
		if (index === -1) return false;
		this._subscribers.splice(index, 1);
		return true;
	}
}

/* start/end/asyncStart/asyncEnd/error channels around one traced operation (undici, Fastify use them). */
class TracingChannel {
	constructor(name) {
		for (const event of ["start", "end", "asyncStart", "asyncEnd", "error"]) {
			this[event] = diagnosticsChannel.channel(`tracing:${name}:${event}`);
		}
	}
	get hasSubscribers() {
		return ["start", "end", "asyncStart", "asyncEnd", "error"].some((event) => this[event].hasSubscribers);
	}
	subscribe(handlers) {
		for (const event of Object.keys(handlers)) this[event]?.subscribe(handlers[event]);
	}
	unsubscribe(handlers) {
		let all = true;
		for (const event of Object.keys(handlers))
			if (this[event] && !this[event].unsubscribe(handlers[event])) all = false;
		return all;
	}
	traceSync(fn, context = {}, thisArg, ...args) {
		if (!this.hasSubscribers) return fn.apply(thisArg, args);
		this.start.publish(context);
		try {
			const result = fn.apply(thisArg, args);
			context.result = result;
			return result;
		} catch (error) {
			context.error = error;
			this.error.publish(context);
			throw error;
		} finally {
			this.end.publish(context);
		}
	}
	tracePromise(fn, context = {}, thisArg, ...args) {
		if (!this.hasSubscribers) return fn.apply(thisArg, args);
		this.start.publish(context);
		const done = () => this.asyncEnd.publish(context);
		try {
			const promise = fn.apply(thisArg, args);
			this.end.publish(context);
			return promise.then(
				(result) => {
					context.result = result;
					this.asyncStart.publish(context);
					done();
					return result;
				},
				(error) => {
					context.error = error;
					this.error.publish(context);
					this.asyncStart.publish(context);
					done();
					throw error;
				}
			);
		} catch (error) {
			context.error = error;
			this.error.publish(context);
			this.end.publish(context);
			throw error;
		}
	}
	traceCallback(fn, position = -1, context = {}, thisArg, ...args) {
		if (!this.hasSubscribers) return fn.apply(thisArg, args);
		const index = position < 0 ? args.length + position : position;
		const original = args[index];
		args[index] = (error, result) => {
			if (error) {
				context.error = error;
				this.error.publish(context);
			} else context.result = result;
			this.asyncStart.publish(context);
			try {
				return original.call(thisArg, error, result);
			} finally {
				this.asyncEnd.publish(context);
			}
		};
		return this.traceSync(fn, context, thisArg, ...args);
	}
}

const diagnosticsChannel = {
	Channel,
	TracingChannel,
	tracingChannel: (name) => new TracingChannel(name),
	channel(name) {
		return (diagnosticsChannels[name] ||= new Channel(name));
	},
	hasSubscribers(name) {
		return Boolean(diagnosticsChannels[name]?.hasSubscribers);
	},
	subscribe(name, fn) {
		diagnosticsChannel.channel(name).subscribe(fn);
	},
	unsubscribe(name, fn) {
		return diagnosticsChannel.channel(name).unsubscribe(fn);
	},
};

/* ------------------------------------------------------------------- stream */

/*
 * ES classes cannot be invoked without `new`, but a great deal of published code inherits the old way:
 * `util.inherits(X, EventEmitter)` and then `EventEmitter.call(this)`. Wrapping the exported constructor
 * lets that call run the same initialisation on the caller's `this`. (The stream constructors in
 * node-stream.js are plain functions and need no wrapper.)
 */
function callable(Class, ...inits) {
	return new Proxy(Class, {
		apply(_target, thisArg, args) {
			for (const init of inits) init.apply(thisArg, args);
		},
	});
}

const CallableEventEmitter = callable(EventEmitter, initEventEmitter);
EventEmitter.EventEmitter = CallableEventEmitter;

const CallableStream = createStreamModule(CallableEventEmitter, Buffer, StringDecoder, web);
const streamModule = CallableStream;
{
	const stdio = createStdio({ os, std, Buffer, stream: streamModule });
	processModule.stdout = stdio.stdout;
	processModule.stderr = stdio.stderr;
	Object.defineProperty(processModule, "stdin", { get: stdio.getStdin, configurable: true, enumerable: true });
}
Object.assign(
	fs,
	createFs({
		os,
		std,
		Buffer,
		path: pathModule,
		stream: streamModule,
		EventEmitter: CallableEventEmitter,
		native: globalThis.__graak_native,
		platform: os.platform,
	})
);
if (globalThis.__graak_native) (await import("./native-modules.js")).zlib.attachStreams(streamModule.Transform);

/* ---------------------------------------------------------- module registry */

const NEEDS_NATIVE_WORK =
	"It needs native support the engine does not have yet (quickjs-ng exposes no socket API), " +
	"so Graak cannot provide it in JavaScript.";

/*
 * Modules that need the native layer. Present only when running under a Graak host (the C
 * build or the Rust one); on a bare `qjs` there are no sockets, so these stay unavailable and say
 * so rather than half-working.
 */
const nativeLayer = globalThis.__graak_native ?? null;
let nativeModules = null;
let http2Module = null;
if (nativeLayer) {
	const nm = await import("./native-modules.js");
	const { net, tls, dgram } = nm.createNetModules(EventEmitter, streamModule.Duplex, { fs, cryptoTools: () => nativeModules?.crypto?.tools && { ...nativeModules.crypto.tools, X509Certificate: nativeModules.crypto.X509Certificate } });
	const { http, https } = (await import("./node-http.js")).createHttpModules(
		{ net, tls },
		EventEmitter,
		streamModule,
		Buffer
	);
	const fetch = fetchApi.makeFetch({ http, https }, nm.zlib);
	const sqlite = (await import("./node-sqlite.js")).createSqlite({
		native: nativeLayer,
		Buffer,
		platform: os.platform,
	});
	const websocketModule = await import("./node-websocket.js");
	nativeModules = {
		net,
		tls,
		dgram,
		sqlite,
		http,
		https,
		fetch,
		crypto: createCrypto({ native: nativeLayer, Buffer, stream: streamModule, toBytes: nm.toBytes, StringDecoder }),
		zlib: nm.zlib,
	};

	// WebSocket, MessageEvent and CloseEvent are built on first use, so a program that never opens one pays nothing.
	{
		let built = null;
		// The events a runtime already has are kept; the getters installed below must not be asked for them.
		const present = { CloseEvent: globalThis.CloseEvent, MessageEvent: globalThis.MessageEvent };
		const build = () =>
			(built ??= websocketModule.createWebSocket({ http, https, crypto: nativeModules.crypto, Buffer, ...present }));
		Object.defineProperty(globalThis, Symbol.for("graak.websocket"), {
			get: build,
			configurable: true,
			enumerable: false,
		});
		for (const name of ["WebSocket", "CloseEvent", "MessageEvent"]) {
			if (typeof globalThis[name] !== "undefined") continue;
			Object.defineProperty(globalThis, name, {
				get: () => build()[name],
				set(value) {
					Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: false });
				},
				configurable: true,
				enumerable: false,
			});
		}
	}

	// Loaders for native addons choose between glibc and musl prebuilts by reading this, exactly as
	// they do under Node.js.
	processModule.report = {
		getReport: () => ({
			header: {
				glibcVersionRuntime: nativeLayer.glibc,
				glibcVersionCompiler: nativeLayer.glibc,
				platform: processModule.platform,
				arch: processModule.arch,
			},
		}),
	};

	// Native addons. A `.node` file is a shared library speaking Node-API, which the host implements
	// itself (quickjs/native/napi.c). Async work and thread-safe functions finish on other threads, so
	// while any is outstanding a timer drains their results on this one; it backs off when idle.
	if (typeof nativeLayer.dlopen === "function") {
		let timer = null;
		let pumping = false;
		let delay = 1;
		const tick = () => {
			timer = null;
			delay = nativeLayer.napiDrain() > 0 ? 1 : Math.min(delay * 2, 25);
			if (pumping) timer = globalObject.setTimeout(tick, delay);
		};
		nativeLayer.napiInit({
			Buffer,
			start() {
				pumping = true;
				delay = 1;
				if (!timer) timer = globalObject.setTimeout(tick, delay);
			},
			stop() {
				pumping = false;
				if (timer) globalObject.clearTimeout(timer);
				timer = null;
			},
		});
		processModule.dlopen = (module, filename) => {
			module.exports = nativeLayer.dlopen(filename, module.exports);
		};
	}

	// WebAssembly, on the wasm3 interpreter in the host. undici (fetch, discord.js) parses HTTP with a wasm build of llhttp.
	if (typeof nativeLayer.wasmInstantiate === "function" && typeof globalObject.WebAssembly === "undefined") {
		globalObject.WebAssembly = createWebAssembly(nativeLayer);
		// wasm3 has no SIMD: packages that offer a SIMD build first and fall back check this.
		processModule.env.UNDICI_NO_WASM_SIMD ??= "1";
	}

	// Web globals that only become real once there is a socket and a compressor behind them.
	defGlobal("fetch", fetch);
	defGlobal("Headers", fetchApi.Headers);
	defGlobal("Request", fetchApi.Request);
	defGlobal("Response", fetchApi.Response);
	defGlobal("FormData", fetchApi.FormData);
	defGlobal("crypto", nativeModules.crypto.webcrypto);
}

function defGlobal(name, value) {
	if (typeof globalObject[name] === "undefined" && value) globalObject[name] = value;
}

// Web Streams and Blob/File do not need the native layer at all, so they are installed either way.
defGlobal("URLPattern", URLPattern);
defGlobal("ReadableStream", web.ReadableStream);
defGlobal("WritableStream", web.WritableStream);
defGlobal("TransformStream", web.TransformStream);
defGlobal("ByteLengthQueuingStrategy", web.ByteLengthQueuingStrategy);
defGlobal("CountQueuingStrategy", web.CountQueuingStrategy);
defGlobal("Blob", web.Blob);
defGlobal("File", web.File);

/*
 * Intl.Segmenter, implemented per UAX #29 in segmenter.js rather than approximated: grapheme and
 * word granularity pass Unicode's own conformance suites in full (GraphemeBreakTest 1187/1187,
 * WordBreakTest 1826/1826). Sentence granularity throws, because those rules are locale-tailorable
 * and a single untailored implementation would be wrong for the locales that need tailoring.
 */
// quickjs-ng ships no Intl namespace at all, so it is created rather than extended. Only
// Segmenter is provided; the other Intl constructors need CLDR data this runtime does not carry,
// and inventing them would be the approximation this implementation exists to avoid.
if (typeof globalObject.Intl === "undefined") {
	globalObject.Intl = {};
}
if (typeof globalObject.Intl.Segmenter === "undefined") {
	globalObject.Intl.Segmenter = Segmenter;
}

/*
 * The rest of Intl (NumberFormat, DateTimeFormat, PluralRules, RelativeTimeFormat, ListFormat, Collator, DisplayNames,
 * DurationFormat, Locale) and the toLocaleString family, in intl.js over data ICU produced (intl-*.js, read on first use).
 */
{
	const runtimeDir = (() => {
		const script = String((globalObject.scriptArgs ?? [])[0] ?? "");
		const slash = Math.max(script.lastIndexOf("/"), script.lastIndexOf("\\"));
		return slash >= 0 ? script.slice(0, slash) : ".";
	})();
	// Data scripts (IDNA tables) evaluated on first use, by the same route as the Intl data.
	Object.defineProperty(globalObject, "__graak_loadData", {
		value: (name) => {
			const text = std.loadFile(`${runtimeDir}/${name}`);
			if (text == null) throw new Error(`${name} is not in this build`);
			std.evalScript(text);
		},
		configurable: true,
		writable: true,
		enumerable: false,
	});
	const envLocale = () => {
		const raw = processModule.env.LC_ALL || processModule.env.LC_MESSAGES || processModule.env.LANG || "";
		const tag = raw.split(".")[0].replace(/_/g, "-");
		return /^[A-Za-z]{2,3}(-[A-Za-z]{2})?$/.test(tag) ? tag : "en-US";
	};
	const envTimeZone = () => {
		const tz = processModule.env.TZ;
		if (tz) return tz.replace(/^:/, "");
		const link = os.readlink?.("/etc/localtime")?.[0];
		const match = /zoneinfo\/(.+)$/.exec(link ?? "");
		if (match) return match[1];
		try {
			return std.loadFile("/etc/timezone")?.trim() || null;
		} catch {
			return null;
		}
	};
	installIntl({
		global: globalObject,
		envLocale,
		envTimeZone,
		loadScript: (name) => {
			const text = std.loadFile(`${runtimeDir}/${name}`);
			if (text == null)
				throw new Error(
					`Intl data (${name}) is not in this build: it was made with --intl none, or the locale is not one the data covers`
				);
			std.evalScript(text);
		},
	});
}



function createReadlineModule() {
	const readline = misc.createReadline(EventEmitter);
	return readline;
}

const childProcessModule =
	misc.createChildProcess(
		os.exec ? os : { ...os, exec: nativeLayer?.exec, getpid: nativeLayer?.getpid },
		EventEmitter,
		{
			Buffer,
			readText: (path) => std.loadFile(path),
			readBytes: (path) => {
				const data = std.loadFile(path, { binary: true });
				return data === null ? null : new Uint8Array(data);
			},
			exists: (path) => {
				const [info, error] = os.stat(path);
				return error === 0 && (info.mode & 0o170000) !== 0o040000;
			},
			env: () => std.getenviron(),
			tmpdir: () => std.getenv("TMPDIR") ?? std.getenv("TEMP") ?? "/tmp",
			writeStderr: (text) => std.err.puts(text),
		}
	) ?? notImplemented("child_process", "This engine build exposes no exec().");

// spawn() with live pipes, fork() and the IPC channel come from the native layer's process table (fg_proc.c).
const streamingChild =
	nativeLayer?.procSpawn && childProcessModule.spawnSync
		? createStreamingChild({
				native: nativeLayer,
				EventEmitter,
				stream: streamModule,
				Buffer,
				process: processModule,
				isSea: Boolean(sea),
				shellArgv: (command) =>
					processModule.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", command] : ["/bin/sh", "-c", command],
			})
		: null;
if (streamingChild) {
	childProcessModule.spawn = streamingChild.spawn;
	childProcessModule.fork = streamingChild.fork;
	childProcessModule.ChildProcess = streamingChild.ChildProcess;
	streamingChild.installChannel();
}

const dnsModule = nativeModules
	? createDns({
			dgram: nativeModules.dgram,
			net: nativeModules.net,
			fs,
			Buffer,
			platform: processModule.platform,
			env: processModule.env,
			inspect: (value, options) => util.inspect(value, options),
			toASCII: (name) => builtins.punycode.toASCII(name),
			// Windows has no resolv.conf: the servers are read from the output of ipconfig (or nslookup).
			exec: (file, args, input) =>
				childProcessModule.execFileSync(file, args, { input, encoding: "latin1", windowsHide: true }),
		})
	: null;

const builtins = {
	assert,
	"assert/strict": assert.strict,
	buffer: {
		Buffer,
		SlowBuffer,
		kMaxLength,
		kStringMaxLength: bufferConstants.MAX_STRING_LENGTH,
		constants: bufferConstants,
		INSPECT_MAX_BYTES,
		isUtf8,
		isAscii,
		atob: (s) => Buffer.from(s, "base64").toString("latin1"),
		btoa: (s) => Buffer.from(s, "latin1").toString("base64"),
	},
	events: CallableEventEmitter,
	fs,
	"fs/promises": fs.promises,
	os: osModule,
	path: pathModule,
	"path/posix": posixPath,
	"path/win32": win32Path,
	process: processModule,
	querystring,
	string_decoder: { StringDecoder },
	timers,
	"timers/promises": {
		setTimeout: (ms, value) => new Promise((resolve) => globalObject.setTimeout(() => resolve(value), ms)),
		setImmediate: (value) => new Promise((resolve) => globalObject.setTimeout(() => resolve(value), 0)),
	},
	util,
	"util/types": util.types,
	console: globalObject.console,
	perf_hooks: { performance: globalObject.performance },
	url: urlModule,

	// Backed by the native layer when there is one; otherwise they say what is missing.
	net: nativeModules?.net ?? notImplemented("net", NEEDS_NATIVE_WORK),
	tls: nativeModules?.tls ?? notImplemented("tls", NEEDS_NATIVE_WORK),
	http: nativeModules?.http ?? notImplemented("http", NEEDS_NATIVE_WORK),
	https: nativeModules?.https ?? notImplemented("https", NEEDS_NATIVE_WORK),
	dns: dnsModule ?? notImplemented("dns", NEEDS_NATIVE_WORK),
	"dns/promises": dnsModule?.promises ?? notImplemented("dns/promises", NEEDS_NATIVE_WORK),
	// Built on first use: HTTP/2 is a large module and most programs never open a session.
	get http2() {
		if (!nativeModules) {
			return notImplemented("http2", NEEDS_NATIVE_WORK);
		}
		http2Module ??= createHttp2(
			{ net: nativeModules.net, tls: nativeModules.tls, http: nativeModules.http, fs, url: { URL } },
			EventEmitter,
			streamModule,
			Buffer
		);
		return http2Module;
	},
	crypto: nativeModules?.crypto ?? notImplemented("crypto", "It needs a native crypto library (hashing, HMAC and the TLS primitives)."),
	zlib: nativeModules?.zlib ?? notImplemented("zlib", "It needs a native compression library."),
	worker_threads:
		misc.createWorkerThreads(os.Worker, EventEmitter) ??
		notImplemented("worker_threads", "This engine build has no Worker implementation."),
	child_process: childProcessModule,
	async_hooks: misc.asyncHooks,
	v8: { ...misc.v8, ...v8Serdes },
	tty: misc.createTty({ isatty: os.isatty, write: (text) => std.out.puts(text) }),
	readline: createReadlineModule(),
	"readline/promises": createReadlineModule(),
	stream: CallableStream,
	"stream/promises": streamModule.promises,
	"stream/consumers": createConsumers(Buffer),
	"stream/web": {
		ReadableStream: web.ReadableStream,
		WritableStream: web.WritableStream,
		TransformStream: web.TransformStream,
		ByteLengthQueuingStrategy: web.ByteLengthQueuingStrategy,
		CountQueuingStrategy: web.CountQueuingStrategy,
	},
	diagnostics_channel: diagnosticsChannel,
	sys: util,
	punycode: createPunycode(),
	constants: { ...osModule.constants.errno, ...osModule.constants.signals, ...fs.constants },
	...createUnavailable(CallableEventEmitter),
	// Present only where the host has them; these replace the "unavailable" answer of the same name.
	...(nativeModules?.dgram ? { dgram: nativeModules.dgram } : {}),
	...(nativeModules?.sqlite ? { sqlite: nativeModules.sqlite.node, "bun:sqlite": nativeModules.sqlite.bun } : {}),
};

/*
 * node:test is built on first use, and it is reachable only through the `node:` scheme, as in Node: a bare `test` is
 * left for a package of that name.
 */
const SCHEME_ONLY = new Set(["test", "test/reporters"]);
{
	let testModules;
	const load = () =>
		(testModules ??= createTestModule(builtins, globalObject, {
			resolveModule,
			moduleCache,
			mockCommonJsModule,
			unmockCommonJsModule,
		}));
	let wasiModule;
	Object.defineProperty(builtins, "wasi", {
		get: () => (wasiModule ??= createWasi({ fs, path: pathModule, process: processModule, Buffer, os })),
		enumerable: true,
		configurable: true,
	});
	Object.defineProperty(builtins, "test", { get: () => load().test, enumerable: true, configurable: true });
	Object.defineProperty(builtins, "test/reporters", { get: () => load().reporters, enumerable: true, configurable: true });
}

// node:cluster is built on first use, or at start in a forked cluster worker so that the primary hears it come online.
if (streamingChild) {
	let clusterModule;
	Object.defineProperty(builtins, "cluster", {
		get: () =>
			(clusterModule ??= createCluster({
				EventEmitter,
				childProcess: childProcessModule,
				net: nativeModules?.net,
				tls: nativeModules?.tls,
				process: processModule,
			})),
		enumerable: true,
		configurable: true,
	});
	if (processModule.env.NODE_UNIQUE_ID !== undefined && processModule.connected) void builtins.cluster;
}

/*
 * node:repl and node:inspector are built on first use, as node:test is: a program that never opens a REPL or a debugger
 * session does not pay for them.
 */
{
	let replModule;
	let inspectorModule;
	const loadRepl = () =>
		(replModule ??= createRepl({
			EventEmitter,
			readline: builtins.readline,
			util,
			vm: builtins.vm,
			fs,
			path: pathModule,
			process: processModule,
			moduleModule: builtins.module,
			createRequire,
			signal: os.signal ? (number, handler) => os.signal(number, handler) : undefined,
		}));
	const loadInspector = () =>
		(inspectorModule ??= createInspector({ EventEmitter, util, vm: builtins.vm, process: processModule }));
	Object.defineProperty(builtins, "repl", { get: loadRepl, enumerable: true, configurable: true });
	Object.defineProperty(builtins, "inspector", { get: loadInspector, enumerable: true, configurable: true });
	Object.defineProperty(builtins, "inspector/promises", {
		get: () => loadInspector().promises,
		enumerable: true,
		configurable: true,
	});
}

/* -------------------------------------------------------- CommonJS require */

const moduleCache = new Map();

/**
 * `node:test`'s `mock.module()` for the CommonJS side: a resolved module id (an absolute file path, or
 * `builtin:<name>` for a builtin) maps to a builder that produces the mocked `module.exports`. Keyed independently
 * of `moduleCache` so a mock can override an already-loaded module and be undone without losing whatever was
 * cached before it. See `mockCommonJsModule` / `unmockCommonJsModule`, called from `node-test-mock.js`.
 */
const moduleMockRegistry = new Map();

/** Installs (or replaces) a CommonJS module mock for a resolved module id. */
function mockCommonJsModule(id, build, cache) {
	const hadPrevious = moduleCache.has(id);
	moduleMockRegistry.set(id, { build, cache, hadPrevious, previous: hadPrevious ? moduleCache.get(id) : undefined });
	// A module already cached (real or from a previous mock) must not shadow this mock on the very next require().
	moduleCache.delete(id);
}

/** Undoes a CommonJS module mock, restoring whatever `moduleCache` entry existed before it (or clearing it). */
function unmockCommonJsModule(id) {
	const mocked = moduleMockRegistry.get(id);
	moduleMockRegistry.delete(id);
	if (!mocked) return;
	if (mocked.hadPrevious) moduleCache.set(id, mocked.previous);
	else moduleCache.delete(id);
}

function moduleNotFound(specifier, fromDir) {
	const err = new Error(`Cannot find module '${specifier}' from '${fromDir}'`);
	err.code = "MODULE_NOT_FOUND";
	return err;
}

/** `@scope/pkg/sub/path` -> { name: "@scope/pkg", sub: "./sub/path" }; a bare package gets sub ".". */
function splitSpecifier(specifier) {
	const parts = specifier.split("/");
	const nameLength = specifier.startsWith("@") ? 2 : 1;
	return {
		name: parts.slice(0, nameLength).join("/"),
		sub: parts.length > nameLength ? `./${parts.slice(nameLength).join("/")}` : ".",
	};
}

/**
 * Resolves `sub` ("." or "./x") against a package's "exports": an exact key first, then the
 * longest matching "./dir/*" pattern. Returns null when the package does not export it.
 */
function matchExports(exports, sub) {
	if (typeof exports === "string" || Array.isArray(exports)) return sub === "." ? resolveExports(exports) : null;
	if (!exports || typeof exports !== "object") return null;

	const keys = Object.keys(exports);
	// No key starts with ".", so this object is a condition map for the root export alone.
	if (!keys.some((key) => key.startsWith("."))) return sub === "." ? resolveExports(exports) : null;
	if (Object.hasOwn(exports, sub)) return resolveExports(exports[sub]);

	let best = null;
	for (const key of keys) {
		const star = key.indexOf("*");
		if (star < 0) continue;
		const prefix = key.slice(0, star);
		const suffix = key.slice(star + 1);
		if (sub.length >= key.length - 1 && sub.startsWith(prefix) && sub.endsWith(suffix)) {
			if (!best || prefix.length > best.prefix.length) best = { key, prefix, suffix };
		}
	}
	if (!best) return null;
	const target = resolveExports(exports[best.key]);
	const middle = sub.slice(best.prefix.length, sub.length - best.suffix.length);
	return target ? target.replaceAll("*", middle) : null;
}

function resolveInstalledPackage(dir, specifier) {
	const { name, sub } = splitSpecifier(specifier);
	const packageDir = pathModule.join(dir, "node_modules", name);
	const manifestPath = pathModule.join(packageDir, "package.json");
	if (fs.existsSync(manifestPath)) {
		let exports;
		try {
			exports = JSON.parse(fs.readFileSync(manifestPath, "utf8")).exports;
		} catch {
			exports = undefined;
		}
		if (exports !== undefined && exports !== null) {
			const target = matchExports(exports, sub);
			if (target) {
				const found = resolvePackage(pathModule.join(packageDir, target));
				if (found) return found;
			} else if (sub !== ".") {
				const err = new Error(`Package subpath '${sub}' is not defined by "exports" in ${manifestPath}`);
				err.code = "ERR_PACKAGE_PATH_NOT_EXPORTED";
				throw err;
			}
		}
	}
	return resolvePackage(pathModule.join(dir, "node_modules", specifier));
}

/*
 * tsconfig.json / jsconfig.json `paths` and `baseUrl`: an import such as "@/components/Button" or "lib/util" that names
 * no installed package. The build converts TypeScript file by file and cannot know a path alias, so the alias is resolved
 * here, at run time, from the configuration that ships with the program. `extends` is followed (a relative file or a
 * package), comments and trailing commas are allowed, and only code outside node_modules is aliased.
 */
const tsConfigCache = new Map();

function parseJsonc(text) {
	let out = "";
	for (let i = 0; i < text.length; ) {
		const c = text[i];
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j + 1;
		} else if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
		} else if (c === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? text.length : end + 2;
		} else {
			out += c;
			i++;
		}
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1").replace(/^\uFEFF/, ""));
}

function readTsConfig(file, seen = new Set()) {
	if (seen.has(file)) return null;
	seen.add(file);
	let config;
	try {
		config = parseJsonc(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
	const dir = pathModule.dirname(file);
	let merged = { baseUrl: undefined, paths: undefined, pathsBase: undefined };
	for (const parent of [].concat(config.extends ?? [])) {
		let target = null;
		if (parent.startsWith(".") || pathModule.isAbsolute(parent))
			target = pathModule.resolve(dir, parent.endsWith(".json") ? parent : `${parent}.json`);
		else {
			try {
				target = resolveModule(parent.endsWith(".json") ? parent : `${parent}/tsconfig.json`, dir).file ?? null;
			} catch {
				target = null;
			}
		}
		const inherited = target && readTsConfig(target, seen);
		if (inherited)
			merged = { ...merged, ...Object.fromEntries(Object.entries(inherited).filter(([, v]) => v !== undefined)) };
	}
	const options = config.compilerOptions ?? {};
	if (options.baseUrl !== undefined) merged.baseUrl = pathModule.resolve(dir, options.baseUrl);
	if (options.paths) {
		merged.paths = options.paths;
		merged.pathsBase = merged.baseUrl ?? dir;
	}
	return merged;
}

function tsConfigFor(dir) {
	if (tsConfigCache.has(dir)) return tsConfigCache.get(dir);
	let found = null;
	for (const name of ["tsconfig.json", "jsconfig.json"]) {
		const candidate = pathModule.join(dir, name);
		if (fs.existsSync(candidate)) {
			found = readTsConfig(candidate);
			if (found) break;
		}
	}
	if (!found) {
		const parent = pathModule.dirname(dir);
		if (parent !== dir) found = tsConfigFor(parent);
	}
	tsConfigCache.set(dir, found);
	return found;
}

function resolveTsPaths(specifier, fromDir) {
	if (fromDir.includes("/node_modules/") || fromDir.includes("\\node_modules\\")) return null;
	const config = tsConfigFor(fromDir);
	if (!config?.paths) return null;
	let best = null;
	for (const [pattern, targets] of Object.entries(config.paths)) {
		const star = pattern.indexOf("*");
		if (star === -1) {
			if (pattern === specifier) best = { targets, captured: "", length: pattern.length };
			continue;
		}
		const prefix = pattern.slice(0, star);
		const suffix = pattern.slice(star + 1);
		if (
			specifier.startsWith(prefix) &&
			specifier.endsWith(suffix) &&
			specifier.length >= prefix.length + suffix.length
		) {
			if (!best || prefix.length > best.length)
				best = {
					targets,
					captured: specifier.slice(prefix.length, specifier.length - suffix.length),
					length: prefix.length,
				};
		}
	}
	if (!best) return null;
	for (const target of best.targets) {
		const found = resolvePackage(pathModule.resolve(config.pathsBase, target.replace("*", best.captured)));
		if (found) return { file: found };
	}
	return null;
}

function resolveTsBaseUrl(specifier, fromDir) {
	if (fromDir.includes("/node_modules/") || fromDir.includes("\\node_modules\\")) return null;
	const config = tsConfigFor(fromDir);
	if (!config?.baseUrl) return null;
	const found = resolvePackage(pathModule.resolve(config.baseUrl, specifier));
	return found ? { file: found } : null;
}

function resolveModule(specifier, fromDir) {
	const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
	if (bare in builtins && !(SCHEME_ONLY.has(bare) && !specifier.startsWith("node:"))) return { builtin: bare };
	if (specifier.startsWith("#")) {
		const found = resolvePackageImport(specifier, fromDir);
		if (found) return found;
		throw moduleNotFound(specifier, fromDir);
	}

	let base;
	if (
		specifier === "." ||
		specifier === ".." ||
		specifier.startsWith("./") ||
		specifier.startsWith("../") ||
		pathModule.isAbsolute(specifier)
	) {
		base = pathModule.resolve(fromDir, specifier);
	} else {
		// A path alias from tsconfig.json wins over an installed package of the same name, as it does in TypeScript.
		const aliased = resolveTsPaths(specifier, fromDir);
		if (aliased) return aliased;
		// Walk up node_modules the way Node does, so an installed dependency tree resolves.
		let dir = fromDir;
		for (;;) {
			const found = resolveInstalledPackage(dir, specifier);
			if (found) return { file: found };
			const parent = pathModule.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
		const fromBase = resolveTsBaseUrl(specifier, fromDir);
		if (fromBase) return fromBase;
		throw moduleNotFound(specifier, fromDir);
	}

	const found = resolvePackage(base);
	if (!found) throw moduleNotFound(specifier, fromDir);
	return { file: found };
}

/**
 * Picks the CommonJS target out of an "exports" or "imports" value.
 *
 * Conditions are tried in the order the package lists them, as Node does, against the ones this runtime satisfies:
 * "require", "node", "node-addons", "module-sync" and "default". A package that offers only "import" is an ES module
 * whose code was converted to CommonJS at build time, so it is used as a last resort.
 */
function resolveExports(exports) {
	return pickCondition(exports, false) ?? pickCondition(exports, true);
}

function pickCondition(exports, allowImport) {
	if (!exports) return null;
	if (typeof exports === "string") return exports;
	if (Array.isArray(exports)) {
		for (const candidate of exports) {
			const resolved = pickCondition(candidate, allowImport);
			if (resolved) return resolved;
		}
		return null;
	}
	if (typeof exports !== "object") return null;

	const root = Object.hasOwn(exports, ".") ? exports["."] : exports;
	if (typeof root === "string") return root;
	if (!root || typeof root !== "object") return null;
	if (Array.isArray(root)) return pickCondition(root, allowImport);

	for (const condition of Object.keys(root)) {
		if (condition.startsWith(".")) continue;
		const active =
			condition === "require" ||
			condition === "node" ||
			condition === "node-addons" ||
			condition === "module-sync" ||
			condition === "default" ||
			(allowImport && condition === "import");
		if (!active) continue;
		const resolved = pickCondition(root[condition], allowImport);
		if (resolved) return resolved;
	}
	return null;
}

/** `#name` specifiers: the "imports" map of the nearest package.json above the importing file. */
function resolvePackageImport(specifier, fromDir) {
	let dir = fromDir;
	for (;;) {
		const manifestPath = pathModule.join(dir, "package.json");
		if (fs.existsSync(manifestPath)) {
			let imports;
			try {
				imports = JSON.parse(fs.readFileSync(manifestPath, "utf8")).imports;
			} catch {
				imports = undefined;
			}
			if (imports && typeof imports === "object") {
				let target = null;
				if (Object.hasOwn(imports, specifier)) target = resolveExports(imports[specifier]);
				else {
					let best = null;
					for (const key of Object.keys(imports)) {
						const star = key.indexOf("*");
						if (star < 0) continue;
						const prefix = key.slice(0, star);
						const suffix = key.slice(star + 1);
						if (
							specifier.startsWith(prefix) &&
							specifier.endsWith(suffix) &&
							specifier.length >= key.length - 1 &&
							(!best || prefix.length > best.prefix.length)
						)
							best = { key, prefix, suffix };
					}
					if (best) {
						const value = resolveExports(imports[best.key]);
						target = value
							? value.replaceAll("*", specifier.slice(best.prefix.length, specifier.length - best.suffix.length))
							: null;
					}
				}
				if (!target) {
					throw Object.assign(
						new Error(`Package import specifier "${specifier}" is not defined in package ${manifestPath}`),
						{ code: "ERR_PACKAGE_IMPORT_NOT_DEFINED" }
					);
				}
				if (target.startsWith("./")) {
					const found = resolvePackage(pathModule.join(dir, target));
					if (found) return { file: found };
					throw moduleNotFound(target, dir);
				}
				return resolveModule(target, dir);
			}
			return null;
		}
		const parent = pathModule.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/* TypeScript and JSX files are converted to JavaScript at build time and renamed; an import that still says .ts finds them. */
const SOURCE_EXTENSION_MAP = { ".ts": ".js", ".tsx": ".js", ".jsx": ".js", ".mts": ".mjs", ".cts": ".cjs" };

function resolvePackage(base) {
	for (const candidate of [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}.json`, `${base}.node`]) {
		if (fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory()) return candidate;
	}
	const mapped = /\.(tsx?|jsx|mts|cts)$/.exec(base);
	if (mapped) {
		const alternative = base.slice(0, -mapped[0].length) + SOURCE_EXTENSION_MAP[`.${mapped[1]}`];
		if (fs.existsSync(alternative) && !fs.statSync(alternative).isDirectory()) return alternative;
	}
	if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
		const manifestPath = pathModule.join(base, "package.json");
		if (fs.existsSync(manifestPath)) {
			try {
				const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
				// "exports" wins over "main", as in Node. Most current packages ship only
				// "exports", so a resolver that reads just "main" cannot load them at all.
				const entry = resolveExports(manifest.exports) ?? (typeof manifest.main === "string" ? manifest.main : null);
				if (entry) {
					const resolved = resolvePackage(pathModule.join(base, entry));
					if (resolved) return resolved;
				}
			} catch {
				/* an unreadable manifest just means falling through to index.js */
			}
		}
		for (const name of ["index.js", "index.cjs", "index.mjs", "index.json", "index.node"]) {
			const index = pathModule.join(base, name);
			if (fs.existsSync(index)) return index;
		}
	}
	return null;
}

let mainModule = null;

function nodeModulePaths(from) {
	const paths = [];
	let dir = from;
	for (;;) {
		if (pathModule.basename(dir) !== "node_modules") paths.push(pathModule.join(dir, "node_modules"));
		const parent = pathModule.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return paths;
}

function createRequire(fromFile, parentModule) {
	let target = fromFile;
	if (typeof target === "object" && target !== null && "href" in target) {
		target = urlModule.fileURLToPath(target, { windows: isWindows });
	} else if (typeof target === "string" && target.startsWith("file:")) {
		target = urlModule.fileURLToPath(target, { windows: isWindows });
	}
	const isDir = typeof target === "string" && (target.endsWith("/") || target.endsWith("\\"));
	const fromDir = isDir ? pathModule.resolve(target) : pathModule.dirname(pathModule.resolve(target));
	const require = (specifier) => {
		if (typeof specifier !== "string") {
			throw Object.assign(
				new TypeError(
					`The "id" argument must be of type string. Received ${specifier === null ? "null" : typeof specifier}`
				),
				{ code: "ERR_INVALID_ARG_TYPE" }
			);
		}
		if (specifier === "")
			throw Object.assign(new TypeError("The argument 'id' must be a non-empty string. Received ''"), {
				code: "ERR_INVALID_ARG_VALUE",
			});
		const resolved = resolveModule(specifier, fromDir);
		if (resolved.builtin) {
			const builtinKey = `builtin:${resolved.builtin}`;
			if (moduleCache.has(builtinKey)) return moduleCache.get(builtinKey).exports;
			const mockedBuiltin = moduleMockRegistry.get(builtinKey);
			if (mockedBuiltin) {
				const mockedExports = mockedBuiltin.build();
				if (mockedBuiltin.cache) moduleCache.set(builtinKey, { exports: mockedExports, id: builtinKey, filename: builtinKey, loaded: true });
				return mockedExports;
			}
			return builtins[resolved.builtin];
		}

		const file = resolved.file;
		if (moduleCache.has(file)) return moduleCache.get(file).exports;

		const mocked = moduleMockRegistry.get(file);
		if (mocked) {
			const mockedExports = mocked.build();
			if (mocked.cache) moduleCache.set(file, { exports: mockedExports, id: file, filename: file, loaded: true, children: [], paths: [], parent: parentModule });
			return mockedExports;
		}

		if (file.endsWith(".json")) {
			let parsed;
			try {
				parsed = JSON.parse(fs.readFileSync(file, "utf8"));
			} catch (err) {
				err.message = `${file}: ${err.message}`;
				throw err;
			}
			moduleCache.set(file, { exports: parsed, id: file, filename: file, loaded: true });
			return parsed;
		}

		const module = {
			id: file,
			path: pathModule.dirname(file),
			exports: {},
			filename: file,
			loaded: false,
			children: [],
			paths: nodeModulePaths(pathModule.dirname(file)),
			parent: parentModule,
		};
		module.require = createRequire(file, module);
		parentModule?.children?.push(module);
		if (mainModule === null) {
			mainModule = module;
			module.id = "."; // the entry module is "." in Node
		}
		moduleCache.set(file, module);
		if (file.endsWith(".node")) {
			if (typeof processModule.dlopen !== "function") {
				moduleCache.delete(file);
				throw new Error(`Cannot load native addon '${file}': this Graak runtime has no native host to load it with.`);
			}
			try {
				processModule.dlopen(module, file);
			} catch (err) {
				moduleCache.delete(file);
				throw err;
			}
			module.loaded = true;
			return module.exports;
		}
		let source = fs.readFileSync(file, "utf8");
		if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
		if (source.startsWith("#!")) source = `//${source}`;
		const text = `(function (exports, require, module, __filename, __dirname) {${source}\n})`;
		const wrapper = nativeLayer?.evalScript ? nativeLayer.evalScript(text, file) : std.evalScript(text);
		try {
			wrapper.call(module.exports, module.exports, module.require, module, file, pathModule.dirname(file));
		} catch (err) {
			// A module that throws while loading is not left half-registered, as in Node.
			moduleCache.delete(file);
			throw err;
		}
		module.loaded = true;
		return module.exports;
	};
	require.resolve = Object.assign(
		(specifier) => {
			const resolved = resolveModule(specifier, fromDir);
			return resolved.builtin ? specifier : resolved.file;
		},
		{ paths: (specifier) => (specifier.startsWith(".") ? [fromDir] : nodeModulePaths(fromDir)) }
	);
	Object.defineProperty(require, "main", { get: () => mainModule ?? undefined, enumerable: true });
	require.extensions = { ".js": () => {}, ".json": () => {}, ".node": () => {} };
	require.cache = new Proxy(moduleCache, {
		get: (target, key) =>
			key === "__proto__"
				? undefined
				: typeof key === "string" && key !== "constructor"
					? target.get(key)
					: Reflect.get(target, key),
		has: (target, key) => target.has(key),
		deleteProperty: (target, key) => target.delete(key),
		ownKeys: (target) => [...target.keys()],
		getOwnPropertyDescriptor: (target, key) =>
			target.has(key) ? { value: target.get(key), writable: true, enumerable: true, configurable: true } : undefined,
		set: (target, key, value) => (target.set(key, value), true),
	});
	return require;
}

// `vm` and `module` need the resolver and the evaluator, which exist only now.
{
	const evalScript = (code, filename) =>
		nativeLayer?.evalScript ? nativeLayer.evalScript(code, filename) : std.evalScript(code);
	builtins.vm = createVm({ evalScript });
	builtins.module = createModuleModule({
		builtins,
		schemeOnly: SCHEME_ONLY,
		moduleCache,
		createRequire,
		resolveModule,
		pathModule,
		readText: (file) => fs.readFileSync(file, "utf8"),
		evalScript,
	});
}

/* ---------------------------------------------------------------- install */

Object.assign(globalObject, {
	Buffer,
	process: processModule,
	global: globalObject,
	EventTarget,
	Event,
	AbortController,
	AbortSignal,
	structuredClone,
	require: createRequire(`${os.getcwd()[0]}/`),
});
globalObject.setImmediate = timers.setImmediate;
globalObject.clearImmediate = timers.clearImmediate;
if (typeof globalObject.performance === "undefined") {
	globalObject.performance = { now: () => os.now() / 1000, timeOrigin: Date.now() };
}

installExtras({
	builtins,
	globalObject,
	EventEmitter: CallableEventEmitter,
	Buffer,
	util,
	processModule,
	pathModule,
	os,
	std,
	nativeLayer,
	web,
	streamModule: CallableStream,
	fs,
});

export { Buffer, builtins, createRequire, EventEmitter, fs, pathModule as path, processModule as process, util };

/*
 * When given a script argument, run it as the entry point. This is what makes
 * `qjs node-compat.js app.js` behave like `node app.js`.
 */
// A forked copy of a single-file program is told which of its modules to run through the environment.
const forkEntry = processModule.env.GRAAK_FORK_ENTRY;
delete processModule.env.GRAAK_FORK_ENTRY;
const entry = forkEntry || (globalObject.scriptArgs ?? [])[1];
if (entry) {
	const resolved = pathModule.resolve(entry);
	const appDir = pathModule.dirname(resolved);
	processModule.env.GRAAK = "1";
	if (!processModule.env.GRAAK_APP_DIR) processModule.env.GRAAK_APP_DIR = appDir;
	if (!processModule.env.GRAAK_ROOT_DIR) processModule.env.GRAAK_ROOT_DIR = pathModule.dirname(appDir);
	processModule.argv[1] = resolved;
	try {
		const target = resolved.startsWith("/") || /^[a-zA-Z]:/.test(resolved) ? resolved : `./${entry}`;
		const res = createRequire(resolved)(target);
		// The payload blocks kept for start-up are memory from here on; a later require decompresses what it needs.
		sea?.release();
		if (res && typeof res.then === "function") {
			res.catch((err) => reportUncaught(err));
		}
	} catch (err) {
		reportUncaught(err);
	}
}
