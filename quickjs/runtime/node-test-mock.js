/*
 * `node:test`'s mocking: `mock.fn`, `mock.method`, `mock.getter`, `mock.setter`, `mock.property`, `mock.timers` and
 * `mock.module`, with the `mock.calls` / `mock.accesses` records Node keeps. The behaviour follows Node's own
 * implementation, checked against Node's output in test/fixtures/web/nodetest-corpus.cjs and mock-module-corpus.cjs.
 *
 * `mock.module` matches Node exactly: it does not exist on the tracker at all unless the process was started with
 * `--experimental-test-module-mocks` (checked against real Node 24.21.0 and 26.9.0 — the flag gates CommonJS
 * `require()` mocking too, not just ESM, despite the flag's name). Once enabled, it hooks the CommonJS `require()`
 * path the runtime already has (`node-compat.js`'s module-mock registry, threaded in as `mockCommonJsModule` /
 * `unmockCommonJsModule` / `resolveCommonJsModule`) for both sides of ESM mocking, because of how a packaged
 * program actually runs `import`/`import()`:
 *
 * - Every project file the packager ships — `.mjs` included — is compiled to CommonJS by its own esbuild pass
 *   before it ever reaches this engine (LegacyTranspiler.toCommonJs), and a dynamic `import()` becomes
 *   `require()` wrapped in esbuild's own `__toESM()` helper. That helper reads one thing on the required value —
 *   a non-enumerable `__esModule: true` marker esbuild's ESM-to-CJS conversion always sets — to tell an ESM file's
 *   `require()` result apart from a plain CommonJS one: with the marker, `default` and the named exports stay
 *   separate (real ESM shape); without it, `import()` synthesizes a CommonJS-style default the way importing a
 *   genuine `.cjs` file does. `module()` below matches this: a specifier resolving to `.mjs`/`.mts` is mocked with
 *   `buildEsmShapedMockExports` (the marker set, default and named kept apart); everything else (a builtin, a
 *   `.cjs`/`.js` file) keeps `buildCommonJsMockExports`, exactly as before this change — required directly, an
 *   ESM-shaped mock would print differently than Node's own `require()` of a CommonJS module does, so which
 *   builder runs has to depend on the specifier, not be one shared shape for both.
 * - fg_sea_module_loader (quickjs/native/fg_sea.c) is the engine's own module loader — installed once, for every
 *   build, not only a single-file one — and it now also calls back into JS for every import it is asked to
 *   resolve (`mockEsmModule` / `unmockEsmModule`, also in node-compat.js, keyed the same way the CommonJS side is:
 *   off `resolveCommonJsModule`'s resolution, since a relative ESM specifier resolves to the identical on-disk
 *   path `require()` would use). This is exercised by a real native ES module import — this runtime's own
 *   `quickjs/runtime/*.js` files import each other exactly that way, checked in mock-module-esm-corpus.mjs's own
 *   package (a builtin can be mocked bare or with a `node:` prefix through it too) — but a *packaged program's*
 *   own `import()` calls, per the esbuild step above, do not currently reach it; that only changes if a future
 *   build path stops converting user ESM to CommonJS before running it.
 *
 * Two gaps remain on the native-loader side, both verified against real Node 24.21.0/26.9.0 and both rooted in the
 * same cause: quickjs (like the spec) caches a loaded module by its resolved specifier at the engine level
 * (`ctx->loaded_modules`, internal to quickjs.c and not exposed to `fg_sea_module_loader`), consulted *before* the
 * loader is ever called, and nothing here can evict an entry from it once populated. (1) `cache: false` behaves
 * like `cache: true`: a second `import()` of the same specifier never reaches the mock hook again to hand back a
 * fresh module instance, where real Node's own loader mints a distinct module identity per call. (2) Mocking a
 * specifier some earlier `import`/`import()` already resolved has no effect (it still returns the real,
 * already-cached module), where real Node's loader can retroactively swap it. Calling `mock.module()` before the
 * first import of a specifier — the normal pattern, and the one every case here uses — is unaffected by either.
 */

import {
	addAbortListener,
	createAbortError,
	invalidArgValue,
	invalidState,
	kEmptyObject,
	TIMEOUT_MAX,
	validateAbortSignal,
	validateBoolean,
	validateFunction,
	validateInteger,
	validateNumber,
	validateObject,
	validateString,
	validateStringArray,
	validateUint32,
	invalidArgType,
} from "./node-test-util.js";

const kDefaultFunction = function () {};

function validateStringOrSymbol(value, name) {
	if (typeof value !== "string" && typeof value !== "symbol") throw invalidArgType(name, ["string", "symbol"], value);
}

function validateTimes(value, name) {
	if (value === Infinity) return;
	validateInteger(value, name, 1);
}

function findMethodOnPrototypeChain(instance, methodName) {
	let host = instance;
	let descriptor;
	while (host !== null) {
		descriptor = Object.getOwnPropertyDescriptor(host, methodName);
		if (descriptor) break;
		host = Object.getPrototypeOf(host);
	}
	return descriptor;
}

/* --------------------------------------------------------------------------------------------------- mock.module */

const stackFrame = /^\s*at (?:.*? \()?(.*?):(\d+):(\d+)\)?$/;
const SELF_FILE = (() => {
	const match = stackFrame.exec(new Error().stack.split("\n").find((line) => line.startsWith("    at ")) ?? "");
	return match?.[1];
})();

/** The file of whoever called into this module, the way `mock.module()` resolves a relative specifier in Node. */
function getCallerFile() {
	for (const line of String(new Error().stack).split("\n")) {
		const match = stackFrame.exec(line);
		if (match && match[1] !== SELF_FILE && !match[1].startsWith("node:")) return match[1];
	}
	return undefined;
}

/** CJS interop for a mock: the default export's own properties spread under the named exports, as Node does. */
function buildCommonJsMockExports({ hasDefault, defaultExport, namedExports }) {
	if (hasDefault && (defaultExport === null || typeof defaultExport !== "object") && !namedExports) return defaultExport;
	const result = {};
	if (hasDefault && defaultExport !== null && typeof defaultExport === "object") Object.assign(result, defaultExport);
	if (namedExports) for (const key of Object.keys(namedExports)) if (key !== "default") result[key] = namedExports[key];
	return result;
}

/*
 * The ESM shape of a mock, for a specifier that resolves to a `.mjs`/`.mts` file: `default` and the named exports
 * stay separate, as real ESM keeps them, with a non-enumerable `__esModule: true` marker. This is what the
 * packager's own esbuild conversion of a real `.mjs` file produces on `require()` -- every project file (`.mjs`
 * included) is compiled to CommonJS before it runs on this engine, and a dynamic `import()` becomes
 * `require()` wrapped in esbuild's `__toESM()` helper, which reads exactly this marker to decide whether to keep a
 * module's shape (this branch) or synthesize a CommonJS-style default (`buildCommonJsMockExports`, used for
 * everything else: builtins and `.cjs`/`.js` files, matching plain `require()`'s own interop-free behavior).
 */
function buildEsmShapedMockExports({ hasDefault, defaultExport, namedExports }) {
	const result = {};
	Object.defineProperty(result, "__esModule", { value: true, enumerable: false, configurable: true, writable: true });
	if (hasDefault) result.default = defaultExport;
	if (namedExports) for (const key of Object.keys(namedExports)) if (key !== "default") result[key] = namedExports[key];
	return result;
}

class MockModuleContext {
	#unmock;
	#restored = false;
	constructor(unmock) {
		this.#unmock = unmock;
	}
	restore() {
		if (this.#restored) return;
		this.#restored = true;
		this.#unmock();
	}
}

const { restore: restoreModule } = MockModuleContext.prototype;

class MockFunctionContext {
	#calls = [];
	#mocks = new Map();
	#implementation;
	#restore;
	#times;

	constructor(implementation, restore, times) {
		this.#implementation = implementation;
		this.#restore = restore;
		this.#times = times;
	}

	get calls() {
		return this.#calls.slice(0);
	}

	callCount() {
		return this.#calls.length;
	}

	mockImplementation(implementation) {
		validateFunction(implementation, "implementation");
		this.#implementation = implementation;
	}

	mockImplementationOnce(implementation, onCall) {
		validateFunction(implementation, "implementation");
		const nextCall = this.#calls.length;
		const call = onCall ?? nextCall;
		validateInteger(call, "onCall", nextCall);
		this.#mocks.set(call, implementation);
	}

	restore() {
		const { descriptor, object, original, methodName } = this.#restore;
		if (typeof methodName === "string") {
			// An object method spy.
			Object.defineProperty(object, methodName, { __proto__: null, ...descriptor });
		} else {
			// A bare function spy: the mock calls the original from here on.
			this.#implementation = original;
		}
	}

	resetCalls() {
		this.#calls = [];
	}

	trackCall(call) {
		this.#calls.push(call);
	}

	nextImpl() {
		const nextCall = this.#calls.length;
		const mock = this.#mocks.get(nextCall);
		const impl = mock ?? this.#implementation;
		if (nextCall + 1 === this.#times) this.restore();
		this.#mocks.delete(nextCall);
		return impl;
	}
}

// The tracker calls these on a context without exposing them to the program.
const { nextImpl, restore: restoreFn, trackCall } = MockFunctionContext.prototype;
delete MockFunctionContext.prototype.trackCall;
delete MockFunctionContext.prototype.nextImpl;

class MockPropertyContext {
	#object;
	#propertyName;
	#value;
	#originalValue;
	#descriptor;
	#accesses = [];
	#onceValues = new Map();

	constructor(object, propertyName, ...rest) {
		this.#object = object;
		this.#propertyName = propertyName;
		this.#originalValue = object[propertyName];
		this.#value = rest.length > 0 ? rest[0] : this.#originalValue;
		this.#descriptor = Object.getOwnPropertyDescriptor(object, propertyName);
		if (!this.#descriptor) throw invalidArgValue("propertyName", propertyName, "is not a property of the object");

		const { configurable, enumerable } = this.#descriptor;
		Object.defineProperty(object, propertyName, {
			configurable,
			enumerable,
			get: () => {
				const nextValue = this.#getAccessValue(this.#value);
				this.#accesses.push({ __proto__: null, type: "get", value: nextValue, stack: new Error() });
				return nextValue;
			},
			set: this.mockImplementation.bind(this),
		});
	}

	get accesses() {
		return this.#accesses.slice(0);
	}

	accessCount() {
		return this.#accesses.length;
	}

	mockImplementation(value) {
		if (!this.#descriptor.writable) throw invalidArgValue("propertyName", this.#propertyName, "cannot be set");
		const nextValue = this.#getAccessValue(value);
		this.#accesses.push({ __proto__: null, type: "set", value: nextValue, stack: new Error() });
		this.#value = nextValue;
	}

	#getAccessValue(value) {
		const accessIndex = this.#accesses.length;
		if (this.#onceValues.has(accessIndex)) {
			const once = this.#onceValues.get(accessIndex);
			this.#onceValues.delete(accessIndex);
			return once;
		}
		return value;
	}

	mockImplementationOnce(value, onAccess) {
		const nextAccess = this.#accesses.length;
		const accessIndex = onAccess ?? nextAccess;
		validateInteger(accessIndex, "onAccess", nextAccess);
		this.#onceValues.set(accessIndex, value);
	}

	resetAccesses() {
		this.#accesses = [];
	}

	restore() {
		Object.defineProperty(this.#object, this.#propertyName, {
			__proto__: null,
			...this.#descriptor,
			value: this.#originalValue,
		});
	}
}

const { restore: restoreProperty } = MockPropertyContext.prototype;

function createMockTools(env) {
	const {
		globalObject,
		timers: nodeTimers,
		timersPromises: nodeTimersPromises,
		EventEmitter,
		moduleMockingEnabled,
		resolveCommonJsModule,
		mockCommonJsModule,
		unmockCommonJsModule,
		mockEsmModule,
		unmockEsmModule,
	} = env;

	/* ------------------------------------------------------------------------------------------------ mock timers */

	const kInitialEpoch = 0;
	const SUPPORTED_APIS = ["setTimeout", "setInterval", "setImmediate", "Date", "scheduler.wait", "AbortSignal.timeout"];
	let kMock;

	/** A queue ordered by when a timer runs, then by creation order, as Node's priority queue is. */
	class TimerQueue {
		#items = [];
		insert(timer) {
			const items = this.#items;
			const before = (a, b) => a.runAt - b.runAt || a.id - b.id;
			let low = 0;
			let high = items.length;
			while (low < high) {
				const mid = (low + high) >> 1;
				if (before(items[mid], timer) <= 0) low = mid + 1;
				else high = mid;
			}
			items.splice(low, 0, timer);
			timer.queued = true;
		}
		remove(timer) {
			const index = this.#items.indexOf(timer);
			if (index >= 0) this.#items.splice(index, 1);
			timer.queued = false;
		}
		peek() {
			return this.#items[0];
		}
		peekBottom() {
			return this.#items.at(-1);
		}
		shift() {
			const timer = this.#items.shift();
			if (timer) timer.queued = false;
			return timer;
		}
		clear() {
			for (const timer of this.#items) timer.queued = false;
			this.#items = [];
		}
	}

	class Timeout {
		#clear;
		constructor(opts) {
			this.id = opts.id;
			this.callback = opts.callback;
			this.runAt = opts.runAt;
			this.interval = opts.interval;
			this.args = opts.args;
			this.#clear = opts.clear;
		}
		hasRef() {
			return true;
		}
		ref() {
			return this;
		}
		unref() {
			return this;
		}
		refresh() {
			return this;
		}
		close() {
			this.#clear(this);
			return this;
		}
		[Symbol.dispose]() {
			this.#clear(this);
		}
	}

	const abortIt = (signal) => createAbortError(undefined, { cause: signal.reason });

	class MockTimers {
		#timersInContext = [];
		#isEnabled = false;
		#currentTimer = 1;
		#now = kInitialEpoch;
		#queue = new TimerQueue();
		#saved = new Map();
		#nativeDate;
		#realAbortSignalTimeout;
		#realSchedulerWait;

		#setTimeout = (callback, delay, ...args) => this.#createTimer(false, callback, delay, ...args);
		#clearTimeout = (timer) => this.#clearTimer(timer);
		#setInterval = (callback, delay, ...args) => this.#createTimer(true, callback, delay, ...args);
		#clearInterval = (timer) => this.#clearTimer(timer);
		#setImmediate = (callback, ...args) => this.#createTimer(false, callback, -1, ...args);
		#clearImmediate = (timer) => this.#clearTimer(timer);

		#save(names) {
			for (const name of names) {
				this.#saved.set(`global:${name}`, Object.getOwnPropertyDescriptor(globalObject, name));
				this.#saved.set(`timers:${name}`, Object.getOwnPropertyDescriptor(nodeTimers, name));
			}
			// Only the `set*` half has a promise form in timers/promises.
			this.#saved.set(`promises:${names[0]}`, Object.getOwnPropertyDescriptor(nodeTimersPromises, names[0]));
		}

		#restore(names) {
			for (const name of names) {
				const global = this.#saved.get(`global:${name}`);
				if (global) Object.defineProperty(globalObject, name, global);
				const local = this.#saved.get(`timers:${name}`);
				if (local) Object.defineProperty(nodeTimers, name, local);
			}
		}

		#createTimer(isInterval, callback, delay, ...args) {
			if (delay > TIMEOUT_MAX) delay = 1;
			const timer = new Timeout({
				id: this.#currentTimer++,
				callback,
				runAt: this.#now + delay,
				interval: isInterval ? delay : undefined,
				args,
				clear: this.#clearTimeout,
			});
			this.#queue.insert(timer);
			return timer;
		}

		#clearTimer(timer) {
			if (timer?.queued) {
				this.#queue.remove(timer);
				timer.interval = undefined;
			}
		}

		#createDate() {
			kMock ??= Symbol("MockTimers");
			const NativeDate = this.#nativeDate.value;
			if (NativeDate.isMock) throw invalidState("Date is already being mocked!");
			function MockDate(year, month, date, hours, minutes, seconds, ms) {
				const source = MockDate[kMock];
				const Native = source.#nativeDate.value;
				if (!new.target) return Date.prototype.toString.call(new Native(source.#now));
				switch (arguments.length) {
					case 0:
						return new Native(MockDate[kMock].#now);
					case 1:
						return new Native(year);
					case 2:
						return new Native(year, month);
					case 3:
						return new Native(year, month, date);
					case 4:
						return new Native(year, month, date, hours);
					case 5:
						return new Native(year, month, date, hours, minutes);
					case 6:
						return new Native(year, month, date, hours, minutes, seconds);
					default:
						return new Native(year, month, date, hours, minutes, seconds, ms);
				}
			}
			const { prototype, ...dateProps } = Object.getOwnPropertyDescriptors(NativeDate);
			Object.defineProperties(MockDate, dateProps);
			MockDate.now = function now() {
				return MockDate[kMock].#now;
			};
			MockDate.toString = function toString() {
				return Function.prototype.toString.call(MockDate[kMock].#nativeDate.value);
			};
			Object.defineProperties(MockDate, {
				[kMock]: { enumerable: false, configurable: false, writable: false, value: this },
				isMock: { enumerable: true, configurable: false, writable: false, value: true },
			});
			MockDate.prototype = NativeDate.prototype;
			MockDate.parse = NativeDate.parse;
			MockDate.UTC = NativeDate.UTC;
			return MockDate;
		}

		async *#setIntervalPromisified(interval, result, options) {
			const emitter = new EventEmitter();
			let abortListener;
			if (options?.signal) {
				validateAbortSignal(options.signal, "options.signal");
				if (options.signal.aborted) throw abortIt(options.signal);
				abortListener = addAbortListener(options.signal, () => emitter.emit("error", abortIt(options.signal)));
			}
			const events = EventEmitter.on(emitter, "data");
			const timer = this.#createTimer(true, () => emitter.emit("data"), interval, options);
			try {
				// eslint-disable-next-line no-unused-vars
				for await (const event of events) yield result;
			} finally {
				abortListener?.dispose();
				this.#clearInterval(timer);
			}
		}

		async #promisifyTimer({ timerFn, clearFn, ms, result, options }) {
			let resolve;
			let reject;
			const promise = new Promise((res, rej) => {
				resolve = res;
				reject = rej;
			});
			let abortListener;
			if (options?.signal) {
				validateAbortSignal(options.signal, "options.signal");
				if (options.signal.aborted) throw abortIt(options.signal);
				abortListener = addAbortListener(options.signal, () => reject(abortIt(options.signal)));
			}
			const timer = timerFn(resolve, ms);
			try {
				await promise;
				return result;
			} finally {
				abortListener?.dispose();
				clearFn(timer);
			}
		}

		#assertTimersAreEnabled() {
			if (!this.#isEnabled) throw invalidState("You should enable MockTimers first by calling the .enable function");
		}

		#assertTimeArg(time) {
			if (time < 0) throw invalidArgValue("time", time, "must be a positive integer");
		}

		#toggleEnableTimers(activate) {
			const fake = {
				"scheduler.wait": () => {
					const scheduler = nodeTimersPromises.scheduler;
					this.#realSchedulerWait = scheduler.wait;
					scheduler.wait = (delay, options) => this.#promisifyTimer({
						timerFn: this.#setTimeout,
						clearFn: this.#clearTimeout,
						ms: delay,
						result: undefined,
						options,
					});
				},
				setTimeout: () => {
					this.#save(["setTimeout", "clearTimeout"]);
					globalObject.setTimeout = this.#setTimeout;
					globalObject.clearTimeout = this.#clearTimeout;
					nodeTimers.setTimeout = this.#setTimeout;
					nodeTimers.clearTimeout = this.#clearTimeout;
					nodeTimersPromises.setTimeout = (ms, result, options) => this.#promisifyTimer({
						timerFn: this.#setTimeout,
						clearFn: this.#clearTimeout,
						ms,
						result,
						options,
					});
				},
				setInterval: () => {
					this.#save(["setInterval", "clearInterval"]);
					globalObject.setInterval = this.#setInterval;
					globalObject.clearInterval = this.#clearInterval;
					nodeTimers.setInterval = this.#setInterval;
					nodeTimers.clearInterval = this.#clearInterval;
					nodeTimersPromises.setInterval = (interval, result, options) =>
						this.#setIntervalPromisified(interval, result, options);
				},
				setImmediate: () => {
					this.#save(["setImmediate", "clearImmediate"]);
					globalObject.setImmediate = this.#setImmediate;
					globalObject.clearImmediate = this.#clearImmediate;
					nodeTimers.setImmediate = this.#setImmediate;
					nodeTimers.clearImmediate = this.#clearImmediate;
					nodeTimersPromises.setImmediate = (result, options) => this.#promisifyTimer({
						timerFn: this.#setImmediate,
						clearFn: this.#clearImmediate,
						ms: -1,
						result,
						options,
					});
				},
				Date: () => {
					this.#nativeDate = Object.getOwnPropertyDescriptor(globalObject, "Date");
					globalObject.Date = this.#createDate();
				},
				"AbortSignal.timeout": () => {
					const AbortSignalClass = globalObject.AbortSignal;
					this.#realAbortSignalTimeout = Object.getOwnPropertyDescriptor(AbortSignalClass, "timeout");
					const mock = this;
					Object.defineProperty(AbortSignalClass, "timeout", {
						configurable: true,
						writable: true,
						value: function timeout(delay) {
							validateUint32(delay, "delay", false);
							const controller = new globalObject.AbortController();
							mock.#setTimeout(() => controller.abort(), delay);
							return controller.signal;
						},
					});
				},
			};
			const real = {
				"scheduler.wait": () => {
					nodeTimersPromises.scheduler.wait = this.#realSchedulerWait;
				},
				setTimeout: () => {
					this.#restore(["setTimeout", "clearTimeout"]);
					const saved = this.#saved.get("promises:setTimeout");
					if (saved) Object.defineProperty(nodeTimersPromises, "setTimeout", saved);
				},
				setInterval: () => {
					this.#restore(["setInterval", "clearInterval"]);
					const saved = this.#saved.get("promises:setInterval");
					if (saved) Object.defineProperty(nodeTimersPromises, "setInterval", saved);
				},
				setImmediate: () => {
					this.#restore(["setImmediate", "clearImmediate"]);
					const saved = this.#saved.get("promises:setImmediate");
					if (saved) Object.defineProperty(nodeTimersPromises, "setImmediate", saved);
				},
				Date: () => {
					Object.defineProperty(globalObject, "Date", this.#nativeDate);
				},
				"AbortSignal.timeout": () => {
					Object.defineProperty(globalObject.AbortSignal, "timeout", this.#realAbortSignalTimeout);
				},
			};
			const target = activate ? fake : real;
			for (const api of this.#timersInContext) target[api]();
			this.#isEnabled = activate;
		}

		tick(time = 1) {
			this.#assertTimersAreEnabled();
			this.#assertTimeArg(time);
			this.#now += time;
			let timer = this.#queue.peek();
			while (timer) {
				if (timer.runAt > this.#now) break;
				Reflect.apply(timer.callback, undefined, timer.args);
				// A callback may have cleared its own timer.
				if (this.#queue.peek()?.id === timer.id) this.#queue.shift();
				if (timer.interval !== undefined) {
					timer.runAt += timer.interval;
					this.#queue.insert(timer);
				}
				timer = this.#queue.peek();
			}
		}

		enable(options = { apis: SUPPORTED_APIS, now: 0 }) {
			const internal = { ...options };
			if (this.#isEnabled) throw invalidState("MockTimers is already enabled!");
			if (Number.isNaN(internal.now)) {
				throw invalidArgValue("now", internal.now, `epoch must be a positive integer received ${internal.now}`);
			}
			internal.now ||= 0;
			internal.apis ||= SUPPORTED_APIS;
			validateStringArray(internal.apis, "options.apis");
			for (const api of internal.apis) {
				if (!SUPPORTED_APIS.includes(api)) throw invalidArgValue("options.apis", api, `option ${api} is not supported`);
			}
			this.#timersInContext = internal.apis;
			if (internal.now instanceof Date || Object.prototype.toString.call(internal.now) === "[object Date]") {
				this.#now = Date.prototype.getTime.call(internal.now);
			} else {
				validateNumber(internal.now, "initialTime");
				this.#assertTimeArg(internal.now);
				this.#now = internal.now;
			}
			this.#toggleEnableTimers(true);
		}

		setTime(time = kInitialEpoch) {
			validateNumber(time, "time");
			this.#assertTimeArg(time);
			this.#assertTimersAreEnabled();
			this.#now = time;
		}

		[Symbol.dispose]() {
			this.reset();
		}

		reset() {
			if (!this.#isEnabled) return;
			this.#toggleEnableTimers(false);
			this.#timersInContext = [];
			this.#now = kInitialEpoch;
			this.#queue.clear();
		}

		runAll() {
			this.#assertTimersAreEnabled();
			const longest = this.#queue.peekBottom();
			if (!longest) return;
			this.tick(longest.runAt - this.#now);
		}
	}

	/* --------------------------------------------------------------------------------------------------- tracker */

	class MockTracker {
		#mocks = [];
		#timers;

		get timers() {
			this.#timers ??= new MockTimers();
			return this.#timers;
		}

		fn(original = function () {}, implementation = original, options = kEmptyObject) {
			if (original !== null && typeof original === "object") {
				options = original;
				original = function () {};
				implementation = original;
			} else if (implementation !== null && typeof implementation === "object") {
				options = implementation;
				implementation = original;
			}
			validateFunction(original, "original");
			validateFunction(implementation, "implementation");
			validateObject(options, "options");
			const { times = Infinity } = options;
			validateTimes(times, "options.times");
			const ctx = new MockFunctionContext(implementation, { __proto__: null, original }, times);
			return this.#setupMock(ctx, original);
		}

		method(objectOrFunction, methodName, implementation = kDefaultFunction, options = kEmptyObject) {
			validateStringOrSymbol(methodName, "methodName");
			if (typeof objectOrFunction !== "function") validateObject(objectOrFunction, "object");
			if (implementation !== null && typeof implementation === "object") {
				options = implementation;
				implementation = kDefaultFunction;
			}
			validateFunction(implementation, "implementation");
			validateObject(options, "options");
			const { getter = false, setter = false, times = Infinity } = options;
			validateBoolean(getter, "options.getter");
			validateBoolean(setter, "options.setter");
			validateTimes(times, "options.times");
			if (setter && getter) throw invalidArgValue("options.setter", setter, "cannot be used with 'options.getter'");

			const descriptor = findMethodOnPrototypeChain(objectOrFunction, methodName);
			let original;
			if (getter) original = descriptor?.get;
			else if (setter) original = descriptor?.set;
			else original = descriptor?.value;
			if (typeof original !== "function") throw invalidArgValue("methodName", original, "must be a method");

			const restore = { __proto__: null, descriptor, object: objectOrFunction, methodName };
			const impl = implementation === kDefaultFunction ? original : implementation;
			const ctx = new MockFunctionContext(impl, restore, times);
			const mock = this.#setupMock(ctx, original);
			const mockDescriptor = { __proto__: null, configurable: descriptor.configurable, enumerable: descriptor.enumerable };
			if (getter) {
				mockDescriptor.get = mock;
				mockDescriptor.set = descriptor.set;
			} else if (setter) {
				mockDescriptor.get = descriptor.get;
				mockDescriptor.set = mock;
			} else {
				mockDescriptor.writable = descriptor.writable;
				mockDescriptor.value = mock;
			}
			Object.defineProperty(objectOrFunction, methodName, mockDescriptor);
			return mock;
		}

		getter(object, methodName, implementation = kDefaultFunction, options = kEmptyObject) {
			if (implementation !== null && typeof implementation === "object") {
				options = implementation;
				implementation = kDefaultFunction;
			} else {
				validateObject(options, "options");
			}
			const { getter = true } = options;
			if (getter === false) throw invalidArgValue("options.getter", getter, "cannot be false");
			return this.method(object, methodName, implementation, { __proto__: null, ...options, getter });
		}

		setter(object, methodName, implementation = kDefaultFunction, options = kEmptyObject) {
			if (implementation !== null && typeof implementation === "object") {
				options = implementation;
				implementation = kDefaultFunction;
			} else {
				validateObject(options, "options");
			}
			const { setter = true } = options;
			if (setter === false) throw invalidArgValue("options.setter", setter, "cannot be false");
			return this.method(object, methodName, implementation, { __proto__: null, ...options, setter });
		}

		property(object, propertyName, ...value) {
			validateObject(object, "object");
			validateStringOrSymbol(propertyName, "propertyName");
			const ctx = new MockPropertyContext(object, propertyName, ...value);
			this.#mocks.push({ __proto__: null, ctx, restore: restoreProperty });
			return new Proxy(object, {
				get(target, property, receiver) {
					if (property === "mock") return ctx;
					return Reflect.get(target, property, receiver);
				},
			});
		}

		module(specifier, options = kEmptyObject) {
			validateString(specifier, "specifier");
			validateObject(options, "options");
			const { cache = true, exports, namedExports, defaultExport } = options;
			validateBoolean(cache, "options.cache");
			if (namedExports !== undefined) {
				globalObject.process.emitWarning?.(
					"mock.module(): options.namedExports is deprecated. Use options.exports instead.",
					"DeprecationWarning"
				);
			}
			if (defaultExport !== undefined) {
				globalObject.process.emitWarning?.(
					"mock.module(): options.defaultExport is deprecated. Use options.exports.default instead.",
					"DeprecationWarning"
				);
			}
			if (exports !== undefined) validateObject(exports, "options.exports");
			if (namedExports !== undefined) validateObject(namedExports, "options.namedExports");

			const hasDefault = defaultExport !== undefined || (exports !== undefined && "default" in exports);
			const defaultValue = defaultExport !== undefined ? defaultExport : exports?.default;
			const named = exports !== undefined || namedExports !== undefined ? { ...namedExports, ...exports } : undefined;

			const callerFile = getCallerFile();
			const fromDir = callerFile ? callerFile.replace(/[\\/][^\\/]*$/, "") : globalObject.process.cwd();
			const resolved = resolveCommonJsModule(specifier, fromDir);
			const moduleId = resolved.builtin ? `builtin:${resolved.builtin}` : resolved.file;

			// A mocked `.mjs`/`.mts` file is required the ESM-shaped way (see buildEsmShapedMockExports); anything
			// else -- a builtin, or a plain `.cjs`/`.js` file -- keeps require()'s own CommonJS interop.
			const isEsmFile = !resolved.builtin && /\.(mjs|mts)$/i.test(resolved.file);
			const buildExports = isEsmFile ? buildEsmShapedMockExports : buildCommonJsMockExports;
			const build = () => buildExports({ hasDefault, defaultExport: defaultValue, namedExports: named });
			mockCommonJsModule(moduleId, build, cache);

			// The ESM side: every specifier text the mocked module could be imported by. A relative or absolute
			// specifier resolves to one on-disk path either way; a builtin can be spelled bare or with "node:".
			const esmIds = resolved.builtin
				? [...new Set([specifier, resolved.builtin, `node:${resolved.builtin}`])]
				: [resolved.file];
			const esmMockId = mockEsmModule?.(esmIds, hasDefault, defaultValue, named);

			const ctx = new MockModuleContext(() => {
				unmockCommonJsModule(moduleId);
				unmockEsmModule?.(esmIds, esmMockId);
			});
			this.#mocks.push({ __proto__: null, ctx, restore: restoreModule });
			return ctx;
		}

		reset() {
			this.restoreAll();
			this.#timers?.reset();
			this.#mocks = [];
		}

		restoreAll() {
			for (const { ctx, restore } of this.#mocks) Function.prototype.call.call(restore, ctx);
		}

		#setupMock(ctx, fnToMatch) {
			const mock = new Proxy(fnToMatch, {
				apply(_fn, thisArg, argList) {
					const fn = Function.prototype.call.call(nextImpl, ctx);
					let result;
					let error;
					try {
						result = Reflect.apply(fn, thisArg, argList);
					} catch (err) {
						error = err;
						throw err;
					} finally {
						Function.prototype.call.call(trackCall, ctx, {
							__proto__: null,
							arguments: argList,
							error,
							result,
							stack: new Error(),
							target: undefined,
							this: thisArg,
						});
					}
					return result;
				},
				construct(target, argList, newTarget) {
					const realTarget = Function.prototype.call.call(nextImpl, ctx);
					let result;
					let error;
					try {
						result = Reflect.construct(realTarget, argList, newTarget);
					} catch (err) {
						error = err;
						throw err;
					} finally {
						Function.prototype.call.call(trackCall, ctx, {
							__proto__: null,
							arguments: argList,
							error,
							result,
							stack: new Error(),
							target,
							this: result,
						});
					}
					return result;
				},
				get(target, property, receiver) {
					if (property === "mock") return ctx;
					return Reflect.get(target, property, receiver);
				},
			});
			this.#mocks.push({ __proto__: null, ctx, restore: restoreFn });
			return mock;
		}
	}

	// Node itself defines `mock.module` only when started with `--experimental-test-module-mocks`; match that: the
	// property does not exist at all otherwise, rather than existing and throwing.
	if (!moduleMockingEnabled) delete MockTracker.prototype.module;

	return { MockTracker, MockTimers };
}

export { createMockTools };
