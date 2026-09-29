/*
 * Node's `node:test`: `test`/`it`, `describe`/`suite`, the four hooks, subtests, `skip`/`todo`/`only`/`expectFailure`,
 * `t.plan`, `t.assert`, `t.diagnostic`, `t.signal`, `t.waitFor`, timeouts, callback tests, `concurrency`, mocks (see
 * node-test-mock.js), the spec, tap, dot, junit and lcov reporters, `run()`, and the summary and exit code of a run that ends when
 * the process does. The shape follows Node's lib/internal/test_runner: a root test that owns every top-level test, a
 * TestsStream of `test:*` events, and reporters that turn those events into text.
 *
 * What differs from Node, and why:
 *  - Node finds the test a call belongs to by async context. This engine has none, so `test()`, `describe()`, `it()` and
 *    the hooks attach to the test or suite whose function is running *synchronously*; after an `await` inside a test, use
 *    `t.test()` (which is unambiguous) rather than a top-level `test()`.
 *  - `run()` runs the files in this process (Node's `isolation: 'none'`), never in child processes.
 *  - Coverage, snapshots, watch mode, test tags, shard and randomize are not implemented. `mock.module` covers the
 *    CommonJS `require()` path, gated behind `--experimental-test-module-mocks` like Node's own (Node gates it there
 *    too, for CommonJS as well as ESM); ESM's `import`/`import()` go through the engine's native module loader, which
 *    this JS-only mock cannot intercept, so ESM mocking stays unavailable regardless of the flag.
 */

import { createMockTools } from "./node-test-mock.js";
import {
	addAbortListener,
	createAbortError,
	hooks as utilHooks,
	invalidArgType,
	invalidArgValue,
	kEmptyObject,
	nodeError,
	TIMEOUT_MAX,
	validateAbortSignal,
	validateBoolean,
	validateFunction,
	validateInteger,
	validateNumber,
	validateObject,
	validateOneOf,
	validateString,
	validateUint32,
} from "./node-test-util.js";

const kCallbackAndPromisePresent = "callbackAndPromisePresent";
const kCancelledByParent = "cancelledByParent";
const kAborted = "testAborted";
const kParentAlreadyFinished = "parentAlreadyFinished";
const kSubtestsFailed = "subtestsFailed";
const kTestCodeFailure = "testCodeFailure";
const kTestTimeoutFailure = "testTimeoutFailure";
const kExpectedFailure = "expectedFailure";
const kHookFailure = "hookFailed";
const kMultipleCallbackInvocations = "multipleCallbackInvocations";
const kDefaultTimeout = null;
const kHookNames = ["before", "after", "beforeEach", "afterEach"];
const kUnwrapErrors = new Set([kTestCodeFailure, kHookFailure, "uncaughtException", "unhandledRejection"]);
const kEmitMessage = Symbol("kEmitMessage");
const kShouldAbort = Symbol("kShouldAbort");
const kIsNodeError = Symbol("kIsNodeError");
const noop = () => {};

function createTestModule(builtins, globalObject, moduleMockHooks) {
	const { process } = builtins;
	const util = builtins.util;
	const pathModule = builtins.path;
	const { Readable, Transform } = builtins.stream;
	const EventEmitter = builtins.events;
	// Durations come from `performance.now()`, which is in milliseconds.
	const hrtime = () => BigInt(Math.round(globalObject.performance.now() * 1e6));
	const realSetTimeout = globalObject.setTimeout;
	const realClearTimeout = globalObject.clearTimeout;
	const realSetInterval = globalObject.setInterval;
	const realClearInterval = globalObject.clearInterval;

	utilHooks.inspect = (value, options) => util.inspect(value, options);

	/* ------------------------------------------------------------------------------------------------- basics */

	function inspectWithNoCustomRetry(obj, options) {
		try {
			return util.inspect(obj, options);
		} catch {
			return util.inspect(obj, { ...options, customInspect: false });
		}
	}

	function testFailure(error, failureType) {
		let message = error?.message ?? error;
		if (typeof message !== "string") message = inspectWithNoCustomRetry(message);
		// Node hides the runner's own frames from this error, which leaves it no frames at all.
		const err = nodeError(Error, "ERR_TEST_FAILURE", message, { hideFrames: true });
		Object.defineProperty(err, kIsNodeError, { value: true, configurable: true });
		Object.defineProperty(err, "failureType", { value: failureType, writable: true, configurable: true, enumerable: true });
		Object.defineProperty(err, "cause", { value: error, writable: true, configurable: true, enumerable: true });
		return err;
	}

	function isTestFailureError(err) {
		return err?.code === "ERR_TEST_FAILURE" && kIsNodeError in err;
	}

	function isError(value) {
		return value instanceof Error || util.types?.isNativeError?.(value) === true;
	}

	function isPromise(value) {
		return value != null && typeof value.then === "function" && value instanceof Promise;
	}

	function withResolvers() {
		let resolve;
		let reject;
		const promise = new Promise((res, rej) => {
			resolve = res;
			reject = rej;
		});
		return { promise, resolve, reject };
	}

	function once(callback, { preserveReturnValue = false } = kEmptyObject) {
		let called = false;
		let returnValue;
		return function (...args) {
			if (called) return returnValue;
			called = true;
			const result = Reflect.apply(callback, this, args);
			returnValue = preserveReturnValue ? result : undefined;
			return result;
		};
	}

	const stackFrame = /^\s*at (?:.*? \()?(.*?):(\d+):(\d+)\)?$/;
	const SELF_FILE = (() => {
		const match = stackFrame.exec(new Error().stack.split("\n").find((line) => line.startsWith("    at ")) ?? "");
		return match?.[1];
	})();

	/** `[line, column, file]` of whoever called into this module: the location a test is reported at. */
	function getCallerLocation() {
		for (const line of String(new Error().stack).split("\n")) {
			const match = stackFrame.exec(line);
			if (match && match[1] !== SELF_FILE && !match[1].startsWith("node:")) {
				return [Number(match[2]), Number(match[3]), match[1]];
			}
		}
		return undefined;
	}

	function fileToPath(file) {
		return file?.startsWith("file://") ? decodeURIComponent(file.slice(process.platform === "win32" ? 8 : 7)) : file;
	}

	const colors = {
		blue: "",
		green: "",
		white: "",
		yellow: "",
		red: "",
		gray: "",
		reset: "",
		shouldColorize(stream) {
			const force = process.env.FORCE_COLOR;
			if (force !== undefined) return !["0", "false"].includes(force);
			return Boolean(stream?.isTTY && (typeof stream.getColorDepth === "function" ? stream.getColorDepth() > 2 : true));
		},
		refresh() {
			const on = colors.shouldColorize(process.stderr);
			colors.blue = on ? "\u001b[34m" : "";
			colors.green = on ? "\u001b[32m" : "";
			colors.white = on ? "\u001b[39m" : "";
			colors.yellow = on ? "\u001b[33m" : "";
			colors.red = on ? "\u001b[31m" : "";
			colors.gray = on ? "\u001b[90m" : "";
			colors.reset = on ? "\u001b[0m" : "";
		},
	};
	colors.refresh();

	/* -------------------------------------------------------------------------------------------------- stream */

	/** The `test:*` events of a run: a Readable of `{ type, data }` that also emits each event by name, as Node's does. */
	class TestsStream extends Readable {
		#buffer = [];
		#canPush = true;
		#sinks = [];
		#buffered;

		constructor({ buffered = true } = {}) {
			super({ objectMode: true, highWaterMark: Number.MAX_SAFE_INTEGER });
			this.#buffered = buffered;
		}

		_read() {
			this.#canPush = true;
			while (this.#buffer.length > 0) {
				if (!this.#tryPush(this.#buffer.shift())) return;
			}
		}

		/** Called synchronously with each `{ type, data }`, then with `null` at the end. */
		addSink(fn) {
			this.#sinks.push(fn);
		}

		fail(nesting, loc, testNumber, name, details, directive, testId, parentId) {
			this[kEmitMessage]("test:fail", {
				__proto__: null,
				name,
				nesting,
				testNumber,
				testId,
				parentId,
				details,
				tags: [],
				...(details.classname && { __proto__: null, classname: details.classname }),
				...loc,
				...directive,
			});
		}

		ok(nesting, loc, testNumber, name, details, directive, testId, parentId) {
			this[kEmitMessage]("test:pass", {
				__proto__: null,
				name,
				nesting,
				testNumber,
				testId,
				parentId,
				details,
				tags: [],
				...(details.classname && { __proto__: null, classname: details.classname }),
				...loc,
				...directive,
			});
		}

		complete(nesting, loc, testNumber, name, details, directive, testId, parentId) {
			this[kEmitMessage]("test:complete", {
				__proto__: null,
				name,
				nesting,
				testNumber,
				testId,
				parentId,
				details,
				tags: [],
				...loc,
				...directive,
			});
		}

		plan(nesting, loc, count) {
			this[kEmitMessage]("test:plan", { __proto__: null, nesting, count, ...loc });
		}

		getSkip(reason = undefined) {
			return { __proto__: null, skip: reason ?? true };
		}

		getTodo(reason = undefined) {
			return { __proto__: null, todo: reason ?? true };
		}

		getXFail(expectation = undefined) {
			return { __proto__: null, expectFailure: expectation ?? true };
		}

		enqueue(nesting, loc, name, type, testId, parentId) {
			this[kEmitMessage]("test:enqueue", { __proto__: null, nesting, name, type, testId, parentId, tags: [], ...loc });
		}

		dequeue(nesting, loc, name, type, testId, parentId) {
			this[kEmitMessage]("test:dequeue", { __proto__: null, nesting, name, type, testId, parentId, tags: [], ...loc });
		}

		start(nesting, loc, name, testId, parentId) {
			this[kEmitMessage]("test:start", { __proto__: null, nesting, name, testId, parentId, tags: [], ...loc });
		}

		log(nesting, loc, message, data, name, testId, parentId) {
			this[kEmitMessage]("test:log", { __proto__: null, name, nesting, testId, parentId, message, data, ...loc });
		}

		diagnostic(nesting, loc, message, level = "info") {
			this[kEmitMessage]("test:diagnostic", { __proto__: null, nesting, message, level, ...loc });
		}

		summary(nesting, file, success, counts, duration_ms) {
			this[kEmitMessage]("test:summary", { __proto__: null, success, counts, duration_ms, file });
		}

		end() {
			for (const sink of this.#sinks) sink(null);
			this.#tryPush(null);
		}

		[kEmitMessage](type, data) {
			this.emit(type, data);
			const message = { type, data };
			for (const sink of this.#sinks) sink(message);
			if (this.#buffered) this.#tryPush(message);
		}

		#tryPush(message) {
			if (this.#canPush) this.#canPush = this.push(message);
			else this.#buffer.push(message);
			return this.#canPush;
		}
	}

	/** Where the events of a filtered-out test and of a hook go: nowhere. */
	class NoopStream {
		getSkip = TestsStream.prototype.getSkip;
		getTodo = TestsStream.prototype.getTodo;
		getXFail = TestsStream.prototype.getXFail;
		fail() {}
		ok() {}
		complete() {}
		plan() {}
		enqueue() {}
		dequeue() {}
		start() {}
		log() {}
		diagnostic() {}
		summary() {}
		end() {}
	}
	const noopStream = new NoopStream();

	/* ------------------------------------------------------------------------------------------------ the tests */

	let assertMap;
	function getAssertionMap() {
		if (assertMap === undefined) {
			assertMap = new Map();
			const assert = builtins.assert;
			for (const name of [
				"deepEqual",
				"deepStrictEqual",
				"doesNotMatch",
				"doesNotReject",
				"doesNotThrow",
				"equal",
				"fail",
				"ifError",
				"match",
				"notDeepEqual",
				"notDeepStrictEqual",
				"notEqual",
				"notStrictEqual",
				"partialDeepStrictEqual",
				"rejects",
				"strictEqual",
				"throws",
			]) {
				if (typeof assert[name] === "function") assertMap.set(name, assert[name]);
			}
			// Snapshot testing writes and reads files next to the test; this runtime does not provide it.
			for (const name of ["snapshot", "fileSnapshot"]) {
				assertMap.set(name, () => {
					throw nodeError(Error, "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", `t.assert.${name}() is not available on this runtime.`);
				});
			}
		}
		return assertMap;
	}

	function stopTest(timeout, signal) {
		const deferred = withResolvers();
		const abortListener = addAbortListener(signal, deferred.resolve);
		let promise = deferred.promise;
		let dispose = abortListener.dispose;
		if (timeout !== kDefaultTimeout) {
			const timer = realSetTimeout(deferred.resolve, timeout);
			timer.unref?.();
			promise = promise.then(() => {
				throw testFailure(`test timed out after ${timeout}ms`, kTestTimeoutFailure);
			});
			dispose = () => {
				abortListener.dispose();
				realClearTimeout(timer);
			};
		}
		promise.dispose = dispose;
		return promise;
	}

	function testMatchesPattern(test, patterns) {
		const byNameOrParent =
			patterns.some((re) => re.exec(test.name) !== null) || (test.parent && testMatchesPattern(test.parent, patterns));
		if (byNameOrParent) return true;
		const nameWithAncestors = test.getTestNameWithAncestors().trim();
		return patterns.some((re) => re.exec(nameWithAncestors) !== null);
	}

	class TestPlan {
		#waitIndefinitely = false;
		#planPromise = null;
		#timeoutId = null;

		constructor(count, options = kEmptyObject) {
			validateUint32(count, "count");
			validateObject(options, "options");
			this.expected = count;
			this.actual = 0;
			const { wait } = options;
			if (typeof wait === "boolean") {
				this.wait = wait;
				this.#waitIndefinitely = wait;
			} else if (typeof wait === "number") {
				validateNumber(wait, "options.wait", 0, TIMEOUT_MAX);
				this.wait = wait;
			} else if (wait !== undefined) {
				throw invalidArgType("options.wait", ["boolean", "number"], wait);
			}
		}

		#planMet() {
			return this.actual === this.expected;
		}

		#createTimeout(reject) {
			return realSetTimeout(() => {
				reject(
					testFailure(
						`plan timed out after ${this.wait}ms with ${this.actual} assertions when expecting ${this.expected}`,
						kTestTimeoutFailure
					)
				);
			}, this.wait);
		}

		check() {
			if (this.#planMet()) {
				if (this.#timeoutId) {
					realClearTimeout(this.#timeoutId);
					this.#timeoutId = null;
				}
				if (this.#planPromise) {
					this.#planPromise.resolve();
					this.#planPromise = null;
				}
				return;
			}
			if (!this.#shouldWait()) {
				throw testFailure(`plan expected ${this.expected} assertions but received ${this.actual}`, kTestCodeFailure);
			}
			if (!this.#planPromise) {
				const { promise, resolve, reject } = withResolvers();
				this.#planPromise = { promise, resolve, reject };
				if (!this.#waitIndefinitely) this.#timeoutId = this.#createTimeout(reject);
			}
			return this.#planPromise.promise;
		}

		count() {
			this.actual++;
			if (this.#planPromise) this.check();
		}

		#shouldWait() {
			return this.wait !== undefined && this.wait !== false;
		}
	}

	class TestContext {
		#assert;
		#test;

		constructor(test) {
			this.#test = test;
		}

		get signal() {
			return this.#test.signal;
		}

		get name() {
			return this.#test.name;
		}

		get filePath() {
			return this.#test.entryFile;
		}

		get fullName() {
			return getFullName(this.#test);
		}

		get error() {
			return this.#test.error;
		}

		get passed() {
			return this.#test.passed;
		}

		get attempt() {
			return this.#test.attempt ?? 0;
		}

		get workerId() {
			return Number(process.env.NODE_TEST_WORKER_ID) || undefined;
		}

		diagnostic(message) {
			this.#test.diagnostic(message);
		}

		log(message, data) {
			this.#test.log(message, data);
		}

		plan(count, options = kEmptyObject) {
			if (this.#test.plan !== null) throw testFailure("cannot set plan more than once", kTestCodeFailure);
			this.#test.plan = new TestPlan(count, options);
		}

		get assert() {
			if (this.#assert === undefined) {
				const { plan } = this.#test;
				const map = getAssertionMap();
				const assert = { __proto__: null };
				this.#assert = assert;
				map.forEach((method, name) => {
					assert[name] = (...args) => {
						if (plan !== null) plan.count();
						return Reflect.apply(method, this, args);
					};
				});
				if (!map.has("ok")) {
					assert.ok = (...args) => {
						if (plan !== null) plan.count();
						return builtins.assert.ok(...args);
					};
				}
			}
			return this.#assert;
		}

		get mock() {
			this.#test.mock ??= new MockTracker();
			return this.#test.mock;
		}

		runOnly(value) {
			this.#test.runOnlySubtests = !!value;
		}

		skip(message) {
			this.#test.skip(message);
		}

		todo(message) {
			this.#test.todo(message);
		}

		test(name, options, fn) {
			const overrides = { __proto__: null, loc: getCallerLocation() };
			const { plan } = this.#test;
			if (plan !== null) plan.count();
			const subtest = this.#test.createSubtest(Test, name, options, fn, overrides);
			return subtest.start();
		}

		before(fn, options) {
			this.#test.createHook("before", fn, {
				__proto__: null,
				...options,
				parent: this.#test,
				hookType: "before",
				loc: getCallerLocation(),
			});
		}

		after(fn, options) {
			this.#test.createHook("after", fn, {
				__proto__: null,
				...options,
				parent: this.#test,
				hookType: "after",
				loc: getCallerLocation(),
			});
		}

		beforeEach(fn, options) {
			this.#test.createHook("beforeEach", fn, {
				__proto__: null,
				...options,
				parent: this.#test,
				hookType: "beforeEach",
				loc: getCallerLocation(),
			});
		}

		afterEach(fn, options) {
			this.#test.createHook("afterEach", fn, {
				__proto__: null,
				...options,
				parent: this.#test,
				hookType: "afterEach",
				loc: getCallerLocation(),
			});
		}

		waitFor(condition, options = kEmptyObject) {
			validateFunction(condition, "condition");
			validateObject(options, "options");
			const { interval = 50, timeout = 1000 } = options;
			validateNumber(interval, "options.interval", 0, TIMEOUT_MAX);
			validateNumber(timeout, "options.timeout", 0, TIMEOUT_MAX);

			const { promise, resolve, reject } = withResolvers();
			const noError = Symbol();
			let cause = noError;
			let pollerId;
			let timeoutId;
			const done = (err, result) => {
				realClearTimeout(pollerId);
				realClearTimeout(timeoutId);
				if (err === noError) resolve(result);
				else reject(err);
			};
			timeoutId = realSetTimeout(() => {
				const err = new Error("waitFor() timed out");
				if (cause !== noError) err.cause = cause;
				done(err);
			}, timeout);
			const poller = async () => {
				try {
					done(noError, await condition());
				} catch (err) {
					cause = err;
					pollerId = realSetTimeout(poller, interval);
				}
			};
			poller();
			return promise;
		}
	}

	class SuiteContext {
		#suite;

		constructor(suite) {
			this.#suite = suite;
		}

		get signal() {
			return this.#suite.signal;
		}

		get name() {
			return this.#suite.name;
		}

		get filePath() {
			return this.#suite.entryFile;
		}

		get fullName() {
			return getFullName(this.#suite);
		}

		get passed() {
			return this.#suite.passed;
		}

		get attempt() {
			return this.#suite.attempt ?? 0;
		}

		diagnostic(message) {
			this.#suite.diagnostic(message);
		}

		log(message, data) {
			this.#suite.log(message, data);
		}
	}

	function parseExpectFailure(expectFailure) {
		if (expectFailure === undefined || expectFailure === false) return false;
		if (typeof expectFailure === "string") return { __proto__: null, label: expectFailure, match: undefined };
		if (typeof expectFailure === "function" || expectFailure instanceof RegExp) {
			return { __proto__: null, label: undefined, match: expectFailure };
		}
		if (typeof expectFailure !== "object") return { __proto__: null, label: undefined, match: undefined };
		const keys = Object.keys(expectFailure);
		if (keys.length === 0) throw invalidArgValue("options.expectFailure", expectFailure, "must not be an empty object");
		if (keys.every((k) => k === "match" || k === "label")) {
			return { __proto__: null, label: expectFailure.label, match: expectFailure.match };
		}
		return { __proto__: null, label: undefined, match: expectFailure };
	}

	/** The test the code running right now (synchronously) belongs to, in place of Node's async context. */
	let currentTest;
	const pendingAsyncSuites = new Set();

	/** Where a `test()`, `describe()` or hook call belongs: the running test or suite, else an async suite's function. */
	function currentParent() {
		if (currentTest) return currentTest;
		// With several unfinished, the oldest is taken: functions that wait alike finish in the order they started.
		for (const suite of pendingAsyncSuites) if (suite.detached) return suite;
		return undefined;
	}

	class Test {
		reportedType = "test";
		abortController;
		outerSignal;

		constructor(options) {
			let { fn, name, parent } = options;
			const { concurrency, entryFile, expectFailure, loc, only, timeout, todo, skip, signal, plan } = options;

			if (typeof fn !== "function") fn = noop;
			if (typeof name !== "string" || name === "") name = fn.name || "<anonymous>";
			if (!(parent instanceof Test)) parent = null;

			this.name = name;
			this.parent = parent;
			this.testNumber = 0;
			this.outputSubtestCount = 0;
			this.diagnostics = [];
			this.filtered = false;
			this.filteredByName = false;
			this.hasOnlyTests = false;

			if (parent === null) {
				this.root = this;
				this.harness = options.harness;
				this.config = this.harness.config;
				this.concurrency = 1;
				this.nesting = 0;
				this.only = this.config.only;
				this.reporter = options.reporter ?? new TestsStream();
				this.runOnlySubtests = this.only;
				this.childNumber = 0;
				this.timeout = kDefaultTimeout;
				this.entryFile = entryFile;
				this.nextTestId = 1;
				this.testId = 0;
			} else {
				const nesting = parent.parent === null ? parent.nesting : parent.nesting + 1;
				const { config, isFilteringByName, isFilteringByOnly } = parent.root.harness;

				this.root = parent.root;
				this.harness = null;
				this.config = config;
				this.concurrency = parent.concurrency;
				this.nesting = nesting;
				this.only = only;
				this.reporter = parent.reporter;
				this.runOnlySubtests = false;
				this.childNumber = parent.subtests.length + 1;
				this.timeout = parent.timeout;
				this.entryFile = parent.entryFile;
				this.testId = this.root.nextTestId++;

				if (isFilteringByName) {
					this.filteredByName = this.willBeFilteredByName();
					if (!this.filteredByName) {
						for (let t = this.parent; t !== null && t.filteredByName; t = t.parent) t.filteredByName = false;
					}
				}

				if (isFilteringByOnly) {
					if (this.only) {
						// A suite that has a test marked `only` runs just those tests; one without runs all of them.
						this.parent.runOnlySubtests = true;
						if (this.parent === this.root || this.parent.startTime === null) {
							for (let t = this.parent; t !== null && !t.hasOnlyTests; t = t.parent) t.hasOnlyTests = true;
						}
					} else if (this.only === false) {
						fn = noop;
					}
				} else if (only || this.parent.runOnlySubtests) {
					this.diagnostic("'only' and 'runOnly' require the --test-only command-line option.");
				}
			}

			switch (typeof concurrency) {
				case "number":
					validateUint32(concurrency, "options.concurrency", true);
					this.concurrency = concurrency;
					break;
				case "boolean":
					if (concurrency) {
						this.concurrency = parent === null ? Math.max(availableParallelism() - 1, 1) : Infinity;
					} else {
						this.concurrency = 1;
					}
					break;
				default:
					if (concurrency != null) throw invalidArgType("options.concurrency", ["boolean", "number"], concurrency);
			}

			if (timeout != null && timeout !== Infinity) {
				validateNumber(timeout, "options.timeout", 0, TIMEOUT_MAX);
				this.timeout = timeout;
			} else if (timeout == null) {
				const cliTimeout = this.config.timeout;
				if (cliTimeout != null && cliTimeout !== Infinity) {
					validateNumber(cliTimeout, "this.config.timeout", 0, TIMEOUT_MAX);
					this.timeout = cliTimeout;
				}
			}

			if (skip) fn = noop;

			this.abortController = new AbortController();
			this.outerSignal = signal;
			this.signal = this.abortController.signal;

			validateAbortSignal(signal, "options.signal");
			this.outerSignal?.addEventListener("abort", this.#abortHandler);

			this.fn = fn;
			this.mock = null;
			this.plan = null;
			this.expectedAssertions = plan;
			this.cancelled = false;
			this.expectFailure = parseExpectFailure(expectFailure) || this.parent?.expectFailure;
			this.skipped = skip !== undefined && skip !== false;
			this.isTodo = (todo !== undefined && todo !== false) || this.parent?.isTodo;
			this.startTime = null;
			this.endTime = null;
			this.passed = false;
			this.error = null;
			this.attempt = undefined;
			this.message = typeof skip === "string" ? skip : typeof todo === "string" ? todo : null;
			this.activeSubtests = 0;
			this.pendingSubtests = [];
			this.readySubtests = new Map();
			this.unfinishedSubtests = new Set();
			this.subtestsPromise = null;
			this.subtests = [];
			this.nextReportOrder = 1;
			this.reportOrder = 0;
			this.waitingOn = 0;
			this.finished = false;
			this.hooks = { __proto__: null, before: [], after: [], beforeEach: [], afterEach: [], ownAfterEachCount: 0 };

			if (loc === undefined) {
				this.loc = undefined;
			} else {
				this.loc = { __proto__: null, line: loc[0], column: loc[1], file: fileToPath(loc[2]) };
			}
		}

		runInAsyncScope(fn, thisArg, ...args) {
			const previous = currentTest;
			currentTest = this;
			try {
				return Reflect.apply(fn, thisArg, args);
			} finally {
				currentTest = previous;
			}
		}

		applyFilters() {
			if (this.error) return; // Never filter out errors.
			if (this.filteredByName) {
				this.filtered = true;
				return;
			}
			if (this.root.harness.isFilteringByOnly && !this.only && !this.hasOnlyTests) {
				if (this.parent.runOnlySubtests || this.parent.hasOnlyTests || this.only === false) this.filtered = true;
			}
		}

		willBeFilteredByName() {
			const { testNamePatterns, testSkipPatterns } = this.config;
			if (testNamePatterns && !testMatchesPattern(this, testNamePatterns)) return true;
			if (testSkipPatterns && testMatchesPattern(this, testSkipPatterns)) return true;
			return false;
		}

		/** The name prefixed by the names of all its ancestors, separated by a space: "grandparent parent test". */
		getTestNameWithAncestors() {
			if (!this.parent) return "";
			return `${this.parent.getTestNameWithAncestors()} ${this.name}`;
		}

		hasConcurrency() {
			return this.concurrency > this.activeSubtests;
		}

		addPendingSubtest(deferred) {
			this.pendingSubtests.push(deferred);
		}

		assignReportOrder(subtest) {
			if (subtest.reportOrder === 0) subtest.reportOrder = this.nextReportOrder++;
		}

		async processPendingSubtests() {
			while (this.pendingSubtests.length > 0 && this.hasConcurrency()) {
				const deferred = this.pendingSubtests.shift();
				const test = deferred.test;
				this.assignReportOrder(test);
				test.reporter.dequeue(test.nesting, test.loc, test.name, this.reportedType, test.testId, this.testId);
				await test.run();
				deferred.resolve();
			}
		}

		addReadySubtest(subtest) {
			this.assignReportOrder(subtest);
			this.readySubtests.set(subtest.reportOrder, subtest);
			if (this.unfinishedSubtests.delete(subtest) && this.unfinishedSubtests.size === 0) this.subtestsPromise.resolve();
		}

		processReadySubtestRange(canSend) {
			const start = this.waitingOn;
			const end = start + this.readySubtests.size;
			for (let i = start; i < end; i++) {
				const subtest = this.readySubtests.get(i);
				// A gap means a subtest that is still running: later ones must wait so the report stays in order.
				if (subtest === undefined) return;
				canSend ||= this.isClearToSend();
				if (!canSend) return;
				subtest.finalize();
				this.readySubtests.delete(i);
			}
		}

		createSubtest(Factory, name, options, fn, overrides) {
			if (typeof name === "function") {
				fn = name;
			} else if (name !== null && typeof name === "object") {
				fn = options;
				options = name;
			} else if (typeof options === "function") {
				fn = options;
			}
			if (options === null || typeof options !== "object") options = kEmptyObject;

			let parent = this;
			// A test created after its parent ended is attached to the root so that the error can be reported.
			const preventAddingSubtests = this.finished || this.buildPhaseFinished;
			if (preventAddingSubtests) {
				while (parent.parent !== null) parent = parent.parent;
			}

			const test = new Factory({ __proto__: null, fn, name, parent, ...options, ...overrides });

			if (parent.waitingOn === 0) {
				parent.waitingOn = test.childNumber;
				parent.subtestsPromise = withResolvers();
			}
			if (preventAddingSubtests) {
				test.fail(testFailure("test could not be started because its parent finished", kParentAlreadyFinished));
			}
			parent.subtests.push(test);
			return test;
		}

		#abortHandler = () => {
			const error = this.outerSignal?.reason || createAbortError("The test was aborted");
			error.failureType = kAborted;
			this.#cancel(error);
		};

		#cancel(error) {
			if (this.endTime !== null || this.error !== null) return;
			this.fail(error || testFailure("test did not finish before its parent and was cancelled", kCancelledByParent));
			this.cancelled = true;
			this.abortController.abort();
		}

		computeInheritedHooks() {
			if (this.parent.hooks.beforeEach.length > 0) this.hooks.beforeEach.unshift(...this.parent.hooks.beforeEach);
			if (this.parent.hooks.afterEach.length > 0) this.hooks.afterEach.push(...this.parent.hooks.afterEach);
		}

		createHook(name, fn, options) {
			validateOneOf(name, "hook name", kHookNames);
			const hook = new TestHook(fn, options);
			if (name === "before" || name === "after") hook.run = once(hook.run, { preserveReturnValue: true });
			if (name === "before" && this.startTime !== null) {
				// The test has already started, so the hook runs at once.
				hook.run(this.getRunArgs()).then(() => {
					if (hook.error != null) this.fail(hook.error);
				});
			}
			if (name === "afterEach") {
				// A test's own afterEach hooks run in creation order, and before those of its ancestors.
				this.hooks[name].splice(this.hooks.ownAfterEachCount, 0, hook);
				this.hooks.ownAfterEachCount++;
			} else {
				this.hooks[name].push(hook);
			}
		}

		fail(err) {
			if (this.error !== null) return;
			if (this.expectFailure) {
				if (typeof this.expectFailure === "object" && this.expectFailure.match !== undefined) {
					const { match: validation } = this.expectFailure;
					try {
						const errorToCheck =
							err?.code === "ERR_TEST_FAILURE" && err?.failureType === kTestCodeFailure && err.cause ? err.cause : err;
						builtins.assert.throws(() => {
							throw errorToCheck;
						}, validation);
					} catch (e) {
						this.passed = false;
						this.error = testFailure(
							"The test failed, but the error did not match the expected validation",
							kTestCodeFailure
						);
						this.error.cause = e;
						return;
					}
				}
				this.passed = true;
			} else {
				this.passed = false;
			}
			this.error = err;
		}

		pass() {
			if (this.error == null && this.expectFailure && !this.skipped) {
				this.passed = false;
				this.error = testFailure("test was expected to fail but passed", kExpectedFailure);
				return;
			}
			if (this.error !== null) return;
			if (this.skipped || this.isTodo) {
				this.passed = true;
				return;
			}
			if (this.expectFailure) {
				this.passed = false;
				this.error = testFailure("Test passed but was expected to fail", kTestCodeFailure);
				return;
			}
			this.passed = true;
		}

		skip(message) {
			this.skipped = true;
			this.message = message;
		}

		todo(message) {
			this.isTodo = true;
			this.message = message;
		}

		diagnostic(message) {
			this.diagnostics.push(message);
		}

		log(message, data) {
			validateString(message, "message");
			this.reporter.log(this.nesting, this.loc, message, data, this.name, this.testId, this.parent?.testId);
		}

		start() {
			this.applyFilters();
			if (this.filtered) {
				this.reporter = noopStream;
				this.run = this.filteredRun;
			} else {
				this.testNumber = ++this.parent.outputSubtestCount;
			}

			// With concurrency to spare the test runs now; otherwise it waits, and the caller gets a promise.
			this.parent.unfinishedSubtests.add(this);
			this.reporter.enqueue(this.nesting, this.loc, this.name, this.reportedType, this.testId, this.parent?.testId);
			if (this.root.harness.buildPromise || !this.parent.hasConcurrency()) {
				const deferred = withResolvers();
				deferred.test = this;
				this.parent.addPendingSubtest(deferred);
				return deferred.promise;
			}

			this.parent.assignReportOrder(this);
			this.reporter.dequeue(this.nesting, this.loc, this.name, this.reportedType, this.testId, this.parent?.testId);
			return this.run();
		}

		[kShouldAbort]() {
			if (this.signal.aborted || this.outerSignal?.aborted) {
				this.#abortHandler();
				return true;
			}
		}

		#ctx;
		getCtx() {
			this.#ctx ??= new TestContext(this);
			return this.#ctx;
		}

		getRunArgs() {
			const ctx = this.getCtx();
			return { __proto__: null, ctx, args: [ctx] };
		}

		async runHook(hook, args) {
			validateOneOf(hook, "hook name", kHookNames);
			try {
				const hooks = this.hooks[hook];
				for (let i = 0; i < hooks.length; ++i) {
					const hook = hooks[i];
					await hook.run(args);
					if (hook.error) throw hook.error;
				}
			} catch (err) {
				const error = testFailure(`failed running ${hook} hook`, kHookFailure);
				error.cause = isTestFailureError(err) ? err.cause : err;
				throw error;
			}
		}

		async filteredRun() {
			this.pass();
			this.subtests = [];
			this.report = noop;
			queueMicrotask(() => this.postRun());
		}

		async run() {
			if (this.parent !== null) {
				this.parent.activeSubtests++;
				this.computeInheritedHooks();
			}
			this.startTime ??= hrtime();
			running.add(this);

			if (this[kShouldAbort]()) {
				running.delete(this);
				this.postRun();
				return;
			}

			const hookArgs = this.getRunArgs();
			const { args, ctx } = hookArgs;

			if (this.plan === null && this.expectedAssertions) ctx.plan(this.expectedAssertions);

			const wasSkippedBeforeRun = this.skipped;
			const after = async () => {
				if (this.hooks.after.length > 0) await this.runHook("after", hookArgs);
			};
			const afterEach = once(async () => {
				if (this.parent?.hooks.afterEach.length > 0 && !wasSkippedBeforeRun) {
					await this.parent.runHook("afterEach", hookArgs);
				}
			}, { preserveReturnValue: true });

			let stopPromise;
			try {
				if (this.parent?.hooks.before.length > 0) {
					// This hook usually runs immediately, but the test has to wait for it.
					await this.parent.runHook("before", this.parent.getRunArgs());
				}
				if (this.parent?.hooks.beforeEach.length > 0 && !this.skipped) {
					await this.parent.runHook("beforeEach", hookArgs);
				}
				stopPromise = stopTest(this.timeout, this.signal);
				const runArgs = args.slice();
				runArgs.unshift(this.fn, ctx);

				const promises = [];
				if (this.fn.length === runArgs.length - 1) {
					// The test uses a Node.js error-first callback.
					let calledCount = 0;
					const { promise, resolve, reject } = withResolvers();
					const cb = (err) => {
						calledCount++;
						if (calledCount > 1) {
							// Once is a warning; more than that is ignored.
							if (calledCount === 2) throw testFailure("callback invoked multiple times", kMultipleCallbackInvocations);
							return;
						}
						if (err) return reject(err);
						resolve();
					};
					runArgs.push(cb);
					const ret = Reflect.apply(this.runInAsyncScope, this, runArgs);
					if (isPromise(ret)) {
						this.fail(testFailure("passed a callback but also returned a Promise", kCallbackAndPromisePresent));
						promises.push(ret);
					} else {
						promises.push(Promise.resolve(promise));
					}
				} else {
					// The test is synchronous or returns a promise.
					const promise = Reflect.apply(this.runInAsyncScope, this, runArgs);
					promises.push(Promise.resolve(promise));
				}
				promises.push(stopPromise);

				await Promise.race(promises);
				this[kShouldAbort]();

				if (this.subtestsPromise !== null) await Promise.race([this.subtestsPromise.promise, stopPromise]);

				if (this.plan !== null) {
					const planPromise = this.plan?.check();
					// A promise means the plan is waiting for more assertions.
					if (planPromise) await Promise.race([planPromise, stopPromise]);
				}

				this.pass();
				await afterEach();
				await after();
			} catch (err) {
				if (isTestFailureError(err)) {
					if (err.failureType === kTestTimeoutFailure) this.#cancel(err);
					else this.fail(err);
				} else {
					this.fail(testFailure(err, kTestCodeFailure));
				}
				try {
					await afterEach();
				} catch {
					/* the test is already failing */
				}
				try {
					await after();
				} catch {
					/* likewise */
				}
			} finally {
				stopPromise?.dispose();
				running.delete(this);
				// Hooks and the root test are shared by later tests, so they are not aborted.
				if (this.parent !== null) this.abortController.abort();
			}

			if (this.parent !== null || typeof this.hookType === "string") {
				// Clean up, report the results and start any test that was waiting for concurrency. The root is left
				// alone: its postRun() runs when the process is about to exit, to catch late asynchronous activity.
				this.postRun();
			} else if (this.config.forceExit) {
				this.harness.teardown().then(() => process.exit());
			}
		}

		postRun(pendingSubtestsError) {
			// A test cancelled before it started has its start and end times corrected here.
			this.endTime ??= hrtime();
			this.startTime ??= this.endTime;

			// The test has run: cancel what is still outstanding and fail the test if a subtest failed.
			this.pendingSubtests = [];
			let failed = 0;
			for (let i = 0; i < this.subtests.length; i++) {
				const subtest = this.subtests[i];
				if (!subtest.finished) {
					subtest.#cancel(pendingSubtestsError);
					subtest.postRun(pendingSubtestsError);
				}
				if (!subtest.passed && !subtest.isTodo) failed++;
			}

			if ((this.passed || this.parent === null) && failed > 0) {
				this.fail(testFailure(`${failed} subtest${failed > 1 ? "s" : ""} failed`, kSubtestsFailed));
			}

			this.outerSignal?.removeEventListener("abort", this.#abortHandler);
			this.mock?.reset();

			if (this.parent !== null) {
				if (!this.filtered) {
					const report = this.getReportDetails();
					report.details.passed = this.passed;
					this.testNumber ||= ++this.parent.outputSubtestCount;
					this.reporter.complete(
						this.nesting,
						this.loc,
						this.testNumber,
						this.name,
						report.details,
						report.directive,
						this.testId,
						this.parent?.testId
					);
					this.parent.activeSubtests--;
				}
				this.parent.addReadySubtest(this);
				this.parent.processReadySubtestRange(false);
				this.parent.processPendingSubtests();
			} else if (!this.reported) {
				const { diagnostics, harness, loc, nesting, reporter } = this;
				this.reported = true;
				reporter.plan(nesting, loc, harness.counters.topLevel);
				for (let i = 0; i < diagnostics.length; i++) reporter.diagnostic(nesting, loc, diagnostics[i]);

				const duration = this.duration();
				reporter.diagnostic(nesting, loc, `tests ${harness.counters.tests}`);
				reporter.diagnostic(nesting, loc, `suites ${harness.counters.suites}`);
				reporter.diagnostic(nesting, loc, `pass ${harness.counters.passed}`);
				reporter.diagnostic(nesting, loc, `fail ${harness.counters.failed}`);
				reporter.diagnostic(nesting, loc, `cancelled ${harness.counters.cancelled}`);
				reporter.diagnostic(nesting, loc, `skipped ${harness.counters.skipped}`);
				reporter.diagnostic(nesting, loc, `todo ${harness.counters.todo}`);
				reporter.diagnostic(nesting, loc, `duration_ms ${duration}`);
				reporter.summary(nesting, loc?.file, harness.success, harness.counters, duration);
				reporter.end();
			}
		}

		isClearToSend() {
			return this.parent === null || (this.parent.waitingOn === this.reportOrder && this.parent.isClearToSend());
		}

		finalize() {
			// The test and its subtests have finished or been cancelled, and it is the test's turn to report. Subtests not
			// reported yet are flushed first, then this test's own result, and the parent's counter moves on.
			this.processReadySubtestRange(true);
			this.report();
			this.parent.waitingOn++;
			this.finished = true;

			if (this.parent === this.root && this.root.waitingOn > this.root.subtests.length) {
				// Every test has finished, but a handle may keep the loop alive: give the global after() hooks a chance.
				this.root.run();
			}
		}

		duration() {
			// Recorded in nanoseconds as a BigInt, reported in milliseconds.
			return Number(this.endTime - this.startTime) / 1_000_000;
		}

		getReportDetails() {
			let directive;
			const details = { __proto__: null, duration_ms: this.duration() };

			if (this.skipped) {
				directive = this.reporter.getSkip(this.message);
			} else if (this.isTodo) {
				directive = this.reporter.getTodo(this.message);
			} else if (this.expectFailure) {
				const message = typeof this.expectFailure === "object" ? this.expectFailure.label : this.expectFailure;
				directive = this.reporter.getXFail(message);
			}

			if (this.reportedType) details.type = this.reportedType;
			if (!this.passed) details.error = this.error;
			if (this.attempt !== undefined) details.attempt = this.attempt;

			// The suite hierarchy is the class name of a test in a JUnit report.
			if (this.parent && this.parent !== this.root) {
				const parts = [];
				for (let t = this.parent; t !== t.root; t = t.parent) parts.unshift(t.name);
				if (parts.length > 0) details.classname = parts.join(".");
			}
			return { __proto__: null, details, directive };
		}

		report() {
			countCompletedTest(this);
			if (this.outputSubtestCount > 0) this.reporter.plan(this.subtests[0].nesting, this.loc, this.outputSubtestCount);
			else this.reportStarted();
			const report = this.getReportDetails();

			if (this.passed) {
				this.reporter.ok(
					this.nesting,
					this.loc,
					this.testNumber,
					this.name,
					report.details,
					report.directive,
					this.testId,
					this.parent?.testId
				);
			} else {
				this.reporter.fail(
					this.nesting,
					this.loc,
					this.testNumber,
					this.name,
					report.details,
					report.directive,
					this.testId,
					this.parent?.testId
				);
			}
			for (let i = 0; i < this.diagnostics.length; i++) {
				this.reporter.diagnostic(this.nesting, this.loc, this.diagnostics[i]);
			}
		}

		#reportedSubtest;
		reportStarted() {
			if (this.#reportedSubtest || this.parent === null) return;
			this.#reportedSubtest = true;
			this.parent.reportStarted();
			this.reporter.start(this.nesting, this.loc, this.name, this.testId, this.parent?.testId);
		}
	}

	class TestHook extends Test {
		reportedType = "hook";
		#args;

		constructor(fn, options) {
			const { hookType, loc, parent, timeout, signal } = options;
			super({ __proto__: null, fn, loc, timeout, signal, harness: parent.root.harness, reporter: noopStream });
			this.parentTest = parent;
			this.hookType = hookType;
		}

		run(args) {
			if (this.error && !this.outerSignal?.aborted) {
				this.passed = false;
				this.error = null;
				this.abortController.abort();
				this.abortController = new AbortController();
				this.signal = this.abortController.signal;
			}
			this.#args = args;
			return super.run();
		}

		getCtx() {
			return this.parentTest.getCtx();
		}

		getRunArgs() {
			return this.#args;
		}

		willBeFilteredByName() {
			return false;
		}

		postRun() {
			const { error, loc, parentTest: parent } = this;
			// A failure in the root's after() hook has no test to be attached to, so it is reported at the top.
			if (error && parent === parent.root && this.hookType === "after") {
				if (isTestFailureError(error)) error.failureType = kHookFailure;
				this.endTime ??= hrtime();
				parent.reporter.fail(
					0,
					loc,
					parent.subtests.length + 1,
					loc.file,
					{ __proto__: null, duration_ms: this.duration(), error },
					undefined,
					undefined,
					undefined
				);
			}
		}
	}

	class Suite extends Test {
		reportedType = "suite";

		constructor(options) {
			super(options);
			if (options.timeout == null) this.timeout = null;
			if (this.config.testNamePatterns !== null && this.config.testSkipPatterns !== null && !options.skip) {
				this.fn = options.fn || this.fn;
				this.skipped = false;
			}
			this.buildSuite = this.createBuild();
			this.fn = noop;
		}

		async createBuild() {
			// A test declared after an `await` in the suite's function has no async context to say where it belongs. The
			// suite is marked once the current synchronous code is over (this microtask runs before any continuation the
			// function queues), and while it is unfinished, declarations made outside any running test belong to it.
			queueMicrotask(() => {
				this.detached = true;
			});
			try {
				const { ctx, args } = this.getRunArgs();
				const result = Reflect.apply(this.runInAsyncScope, this, [this.fn, ctx, ...args]);
				if (isPromise(result)) {
					pendingAsyncSuites.add(this);
					await result;
				}
			} catch (err) {
				this.fail(testFailure(err, kTestCodeFailure));
			}
			pendingAsyncSuites.delete(this);
			this.buildPhaseFinished = true;
		}

		#ctx;
		getCtx() {
			this.#ctx ??= new TestContext(this);
			return this.#ctx;
		}

		getRunArgs() {
			const ctx = new SuiteContext(this);
			return { __proto__: null, ctx, args: [ctx] };
		}

		async filteredRun() {
			await this.buildSuite;
			return super.filteredRun();
		}

		async run() {
			this.computeInheritedHooks();
			const hookArgs = this.getRunArgs();

			let stopPromise;
			const after = once(() => this.runHook("after", hookArgs), { preserveReturnValue: true });
			try {
				this.parent.activeSubtests++;
				await this.buildSuite;
				this.startTime = hrtime();

				if (this[kShouldAbort]()) {
					this.subtests = [];
					this.postRun();
					return;
				}

				if (this.parent.hooks.before.length > 0) await this.parent.runHook("before", this.parent.getRunArgs());
				await this.runHook("before", hookArgs);

				stopPromise = stopTest(this.timeout, this.signal);
				const subtests = this.skipped || this.error ? [] : this.subtests;
				const promise = Promise.all(subtests.map((subtest) => subtest.start()));

				await Promise.race([promise, stopPromise]);
				await after();
				this.pass();
			} catch (err) {
				try {
					await after();
				} catch {
					/* the suite is already failing */
				}
				if (isTestFailureError(err)) this.fail(err);
				else this.fail(testFailure(err, kTestCodeFailure));
			} finally {
				stopPromise?.dispose();
			}
			this.postRun();
		}
	}

	function getFullName(test) {
		if (test === test.root) return test.name;
		let fullName = test.name;
		for (let t = test.parent; t !== t.root; t = t.parent) fullName = `${t.name} > ${fullName}`;
		return fullName;
	}

	function availableParallelism() {
		return builtins.os.availableParallelism?.() ?? builtins.os.cpus?.().length ?? 1;
	}

	function countCompletedTest(test, harness = test.root.harness) {
		if (test.nesting === 0) harness.counters.topLevel++;
		if (test.reportedType === "suite") {
			harness.counters.suites++;
			if (!test.passed && !test.isTodo) harness.success = false;
			return;
		}
		// Skipped and todo tests come first: they are not failures.
		if (test.skipped) {
			harness.counters.skipped++;
		} else if (test.isTodo) {
			harness.counters.todo++;
		} else if (test.cancelled) {
			harness.counters.cancelled++;
			harness.success = false;
		} else if (!test.passed) {
			harness.counters.failed++;
			harness.success = false;
		} else {
			harness.counters.passed++;
		}
		harness.counters.tests++;
	}

	/* ------------------------------------------------------------------------------------------------ reporters */

	const reporterUnicodeSymbolMap = {
		__proto__: null,
		"test:fail": "✖ ",
		"test:pass": "✔ ",
		"test:diagnostic": "ℹ ",
		"test:log": "ℹ ",
		"test:coverage": "ℹ ",
		"arrow:right": "▶ ",
		"hyphen:minus": "﹣ ",
		"warning:alert": "⚠ ",
	};

	const reporterColorMap = {
		__proto__: null,
		get "test:fail"() {
			return colors.red;
		},
		get "test:pass"() {
			return colors.green;
		},
		get "test:diagnostic"() {
			return colors.blue;
		},
		get "test:log"() {
			return colors.blue;
		},
		get info() {
			return colors.blue;
		},
		get warn() {
			return colors.yellow;
		},
		get error() {
			return colors.red;
		},
	};

	function indent(nesting) {
		return "  ".repeat(nesting);
	}

	function formatError(error, indentation) {
		const err = error.code === "ERR_TEST_FAILURE" ? error.cause : error;
		const options = { colors: colors.shouldColorize(process.stdout), breakLength: Infinity };
		const message = inspectWithNoCustomRetry(err, options).split(/\r?\n/).join(`\n${indentation}  `);
		return `\n${indentation}  ${message}\n`;
	}

	function formatTestReport(type, data, showErrorDetails = true, prefix = "", indentation = "") {
		let color = reporterColorMap[type] ?? colors.white;
		let symbol = reporterUnicodeSymbolMap[type] ?? " ";
		const { skip, todo, expectFailure } = data;
		const duration_ms = data.details?.duration_ms ? ` ${colors.gray}(${data.details.duration_ms}ms)${colors.white}` : "";
		const replayed =
			data.details?.passed_on_attempt !== undefined
				? ` ${colors.gray}(passed on attempt ${data.details.passed_on_attempt})${colors.white}`
				: "";
		let title = `${data.name}${duration_ms}${replayed}`;

		if (skip !== undefined) {
			title += ` # ${typeof skip === "string" && skip.length ? skip : "SKIP"}`;
			color = colors.gray;
			symbol = reporterUnicodeSymbolMap["hyphen:minus"];
		} else if (todo !== undefined) {
			title += ` # ${typeof todo === "string" && todo.length ? todo : "TODO"}`;
			if (type === "test:fail") {
				color = colors.yellow;
				symbol = reporterUnicodeSymbolMap["warning:alert"];
			}
		} else if (expectFailure !== undefined) {
			title += " # EXPECTED FAILURE";
		}

		const err = showErrorDetails && data.details?.error ? formatError(data.details.error, indentation) : "";
		return `${prefix}${indentation}${color}${symbol}${title}${colors.white}${err}`;
	}

	/** The state of the spec reporter: what is printed for an event, and what is left to print at the end. */
	class SpecFormatter {
		#stack = [];
		#failedTests = [];
		#cwd = process.cwd();

		#formatFailedTestResults() {
			if (this.#failedTests.length === 0) return "";
			const results = [`\n${reporterColorMap["test:fail"]}${reporterUnicodeSymbolMap["test:fail"]}failing tests:${colors.white}\n`];
			for (const test of this.#failedTests) {
				const formattedErr = formatTestReport("test:fail", test);
				if (test.file) {
					const relPath = pathModule.relative(this.#cwd, test.file);
					results.push(`test at ${relPath}:${test.line}:${test.column}`);
				}
				results.push(formattedErr);
			}
			this.#failedTests = [];
			return results.join("\n");
		}

		#handleTestReportEvent(type, data) {
			this.#stack.shift(); // The matching `test:start`.
			let prefix = "";
			while (this.#stack.length) {
				// Report all the parent `test:start` events.
				const parent = this.#stack.pop();
				const msg = parent.data;
				prefix += `${indent(msg.nesting)}${reporterUnicodeSymbolMap["arrow:right"]}${msg.name}\n`;
			}
			return `${formatTestReport(type, data, false, prefix, indent(data.nesting))}\n`;
		}

		#formatInterruptedTests(tests) {
			if (tests.length === 0) return "";
			const results = [`\n${colors.yellow}Interrupted while running:${colors.white}\n`];
			for (const test of tests) {
				let msg = `${indent(test.nesting)}${reporterUnicodeSymbolMap["warning:alert"]}${test.name}`;
				if (test.file) {
					msg += ` ${colors.gray}(${pathModule.relative(this.#cwd, test.file)}:${test.line}:${test.column})${colors.white}`;
				}
				results.push(msg);
			}
			return `${results.join("\n")}\n`;
		}

		handle({ type, data }) {
			switch (type) {
				case "test:fail":
					if (data.details?.error?.failureType !== kSubtestsFailed) this.#failedTests.push(data);
					return this.#handleTestReportEvent(type, data);
				case "test:pass":
					return this.#handleTestReportEvent(type, data);
				case "test:start":
					this.#stack.unshift({ __proto__: null, data, type });
					break;
				case "test:stderr":
				case "test:stdout":
					return data.message;
				case "test:diagnostic":
				case "test:log": {
					const diagnosticColor = reporterColorMap[data.level] || reporterColorMap[type];
					return `${diagnosticColor}${indent(data.nesting)}${reporterUnicodeSymbolMap[type]}${data.message}${colors.white}\n`;
				}
				case "test:summary":
					// Only the summary of the root test is reported.
					if (data.file === undefined) return this.#formatFailedTestResults();
					break;
				case "test:interrupted":
					return this.#formatInterruptedTests(data.tests);
			}
		}

		flush() {
			return this.#formatFailedTestResults();
		}
	}

	class SpecReporter extends Transform {
		#formatter = new SpecFormatter();

		constructor() {
			super({ writableObjectMode: true });
			colors.refresh();
		}

		_transform(event, encoding, callback) {
			callback(null, this.#formatter.handle(event));
		}

		_flush(callback) {
			callback(null, this.#formatter.flush());
		}
	}

	/** Node's lcov reporter: a `test:coverage` event becomes an lcov tracefile, and every other event is dropped. */
	class LcovReporter extends Transform {
		constructor(options) {
			super({ ...options, writableObjectMode: true, __proto__: null });
		}

		_transform(event, encoding, callback) {
			if (event.type !== "test:coverage") return callback(null);
			let lcov = "TN:\n";
			const { workingDirectory } = event.data.summary;
			try {
				for (const file of event.data.summary.files) {
					lcov += `SF:${pathModule.relative(workingDirectory, file.path)}\n`;
					let fnda = "";
					for (let j = 0; j < file.functions.length; j++) {
						const func = file.functions[j];
						const name = func.name || `anonymous_${j}`;
						lcov += `FN:${func.line},${name}\n`;
						fnda += `FNDA:${func.count},${name}\n`;
					}
					lcov += fnda;
					lcov += `FNF:${file.totalFunctionCount}\nFNH:${file.coveredFunctionCount}\n`;
					for (let j = 0; j < file.branches.length; j++) {
						lcov += `BRDA:${file.branches[j].line},${j},0,${file.branches[j].count}\n`;
					}
					lcov += `BRF:${file.totalBranchCount}\nBRH:${file.coveredBranchCount}\n`;
					for (const line of [...file.lines].sort((a, b) => a.line - b.line)) lcov += `DA:${line.line},${line.count}\n`;
					lcov += `LH:${file.coveredLineCount}\nLF:${file.totalLineCount}\nend_of_record\n`;
				}
			} catch (error) {
				return callback(error);
			}
			return callback(null, lcov);
		}
	}

	class DotFormatter {
		#count = 0;
		#failedTests = [];
		#diagnostics = [];
		#columns = DotFormatter.lineLength();

		static lineLength() {
			return Math.max(process.stdout.columns ?? 20, 20);
		}

		handle({ type, data }) {
			let out = "";
			if (type === "test:pass") out += `${colors.green}.${colors.reset}`;
			if (type === "test:fail") {
				out += `${colors.red}X${colors.reset}`;
				this.#failedTests.push(data);
			}
			if ((type === "test:fail" || type === "test:pass") && ++this.#count === this.#columns) {
				out += "\n";
				// Read again in case the terminal was resized.
				this.#columns = DotFormatter.lineLength();
				this.#count = 0;
			}
			if (type === "test:diagnostic" && data.level === "error") this.#diagnostics.push(data);
			return out;
		}

		flush() {
			let out = "\n";
			for (const diagnostic of this.#diagnostics) {
				const color = reporterColorMap[diagnostic.level] || reporterColorMap["test:diagnostic"];
				out += `${color}${reporterUnicodeSymbolMap["test:diagnostic"]}${diagnostic.message}${colors.white}\n`;
			}
			if (this.#failedTests.length > 0) {
				out += `\n${colors.red}Failed tests:${colors.white}\n\n`;
				for (const test of this.#failedTests) out += formatTestReport("test:fail", test);
			}
			return out;
		}
	}

	const kTapIndent = "    ";
	const kFrameStart = /^ {4}at /;
	const kLineBreak = /\n|\r\n/;

	function tapEscape(input) {
		return input
			.replaceAll("\b", "\\b")
			.replaceAll("\f", "\\f")
			.replaceAll("\t", "\\t")
			.replaceAll("\n", "\\n")
			.replaceAll("\r", "\\r")
			.replaceAll("\v", "\\v")
			.replaceAll("\\", "\\\\")
			.replaceAll("#", "\\#");
	}

	function isAssertionLike(value) {
		return value && typeof value === "object" && "expected" in value && "actual" in value;
	}

	function jsToYaml(indentation, name, value, seen) {
		if (value === undefined) return "";
		const prefix = `${indentation}  ${name}:`;
		if (value === null) return `${prefix} ~\n`;

		const inspectOptions = { colors: false, breakLength: Infinity };
		if (typeof value !== "object") {
			if (typeof value !== "string") return `${prefix} ${inspectWithNoCustomRetry(value, inspectOptions)}\n`;
			const lines = value.split(kLineBreak);
			if (lines.length === 1) return `${prefix} ${inspectWithNoCustomRetry(value, inspectOptions)}\n`;
			let str = `${prefix} |-\n`;
			for (const line of lines) str += `${indentation}    ${line}\n`;
			return str;
		}

		seen.add(value);
		const entries = Object.entries(value);
		const isErrorObj = isError(value);
		let propsIndent = indentation;
		let result = "";

		if (name != null) {
			result += prefix;
			// YAML uses the ISO-8601 standard to express dates.
			if (value instanceof Date) result += ` ${Date.prototype.toISOString.call(value)}`;
			result += "\n";
			propsIndent += "  ";
		}

		for (const [key, entry] of entries) {
			if (isErrorObj && (key === "cause" || key === "code")) continue;
			if (seen.has(entry)) {
				result += `${propsIndent}  ${key}: <Circular>\n`;
				continue;
			}
			result += jsToYaml(propsIndent, key, entry, seen);
		}

		if (isErrorObj) {
			const { cause, code, failureType, message, expected, actual, operator, stack, name } = value;
			let errMsg = message ?? "<unknown error>";
			let errName = name;
			let errStack = stack;
			let errCode = code;
			let errExpected = expected;
			let errActual = actual;
			let errOperator = operator;
			let errIsAssertion = isAssertionLike(value);

			// An ERR_TEST_FAILURE that wraps an error from user code reports that error's message and stack.
			if (code === "ERR_TEST_FAILURE" && kUnwrapErrors.has(failureType)) {
				errStack = cause?.stack ?? errStack;
				errCode = cause?.code ?? errCode;
				errName = cause?.name ?? errName;
				errMsg = cause?.message ?? errMsg;
				if (isAssertionLike(cause)) {
					errExpected = cause.expected;
					errActual = cause.actual;
					errOperator = cause.operator ?? errOperator;
					errIsAssertion = true;
				}
			}

			result += jsToYaml(indentation, "error", errMsg, seen);
			if (errCode) result += jsToYaml(indentation, "code", errCode, seen);
			if (errName && errName !== "Error") result += jsToYaml(indentation, "name", errName, seen);
			if (errIsAssertion) {
				// `expected` and `actual` each get their own copy of `seen`, so a circular reference is found per property.
				result += jsToYaml(indentation, "expected", errExpected, new Set(seen));
				result += jsToYaml(indentation, "actual", errActual, new Set(seen));
				if (errOperator) result += jsToYaml(indentation, "operator", errOperator, seen);
			}
			if (typeof errStack === "string") {
				const frames = [];
				for (const frame of errStack.split(kLineBreak)) {
					const processed = frame.replace(kFrameStart, "");
					if (processed.length > 0 && processed.length !== frame.length) frames.push(processed);
				}
				if (frames.length > 0) {
					const frameDelimiter = `\n${indentation}    `;
					result += `${indentation}  stack: |-${frameDelimiter}`;
					result += `${frames.join(frameDelimiter)}\n`;
				}
			}
		}
		return result;
	}

	function tapIndent(nesting) {
		return kTapIndent.repeat(nesting);
	}

	function reportTapTest(nesting, testNumber, status, name, skip, todo, expectFailure) {
		let line = `${tapIndent(nesting)}${status} ${testNumber}`;
		if (name) line += ` ${tapEscape(`- ${name}`)}`;
		if (skip !== undefined) {
			line += ` # SKIP${typeof skip === "string" && skip.length ? ` ${tapEscape(skip)}` : ""}`;
		} else if (todo !== undefined) {
			line += ` # TODO${typeof todo === "string" && todo.length ? ` ${tapEscape(todo)}` : ""}`;
		} else if (expectFailure !== undefined) {
			line += ` # EXPECTED FAILURE${typeof expectFailure === "string" ? ` ${tapEscape(expectFailure)}` : ""}`;
		}
		return `${line}\n`;
	}

	function reportTapDetails(nesting, data = kEmptyObject, location) {
		const { error, duration_ms } = data;
		const pad = tapIndent(nesting);
		let details = `${pad}  ---\n`;
		details += jsToYaml(pad, "duration_ms", duration_ms);
		details += jsToYaml(pad, "type", data.type);
		if (location) details += jsToYaml(pad, "location", location);
		details += jsToYaml(pad, null, error, new Set());
		details += `${pad}  ...\n`;
		return details;
	}

	class TapFormatter {
		start() {
			return "TAP version 13\n";
		}

		handle({ type, data }) {
			let out = "";
			switch (type) {
				case "test:fail": {
					out += reportTapTest(data.nesting, data.testNumber, "not ok", data.name, data.skip, data.todo, data.expectFailure);
					const location = data.file ? `${data.file}:${data.line}:${data.column}` : null;
					out += reportTapDetails(data.nesting, data.details, location);
					break;
				}
				case "test:pass":
					out += reportTapTest(data.nesting, data.testNumber, "ok", data.name, data.skip, data.todo, data.expectFailure);
					out += reportTapDetails(data.nesting, data.details, null);
					break;
				case "test:plan":
					out += `${tapIndent(data.nesting)}1..${data.count}\n`;
					break;
				case "test:start":
					out += `${tapIndent(data.nesting)}# Subtest: ${tapEscape(data.name)}\n`;
					break;
				case "test:stderr":
				case "test:stdout":
					for (const line of data.message.split(kLineBreak)) {
						if (line.length === 0) continue;
						out += `# ${tapEscape(line)}\n`;
					}
					break;
				case "test:diagnostic":
				case "test:log":
					out += `${tapIndent(data.nesting)}# ${tapEscape(data.message)}\n`;
					break;
				case "test:interrupted":
					for (const test of data.tests) {
						let msg = `Interrupted while running: ${test.name}`;
						if (test.file) msg += ` at ${test.file}:${test.line}:${test.column}`;
						out += `# ${tapEscape(msg)}\n`;
					}
					break;
			}
			return out;
		}
	}

	function junitEscapeContent(s = "") {
		return s.replace(/(&)(?!#\d{1,7};)/g, "&amp;").replace(/</g, "&lt;");
	}

	function junitEscapeAttribute(s = "") {
		return junitEscapeContent(s.replace(/\n/g, "&#10;").replace(/"/g, "&quot;"));
	}

	function junitTreeToXML(tree) {
		if (typeof tree === "string") return `${junitEscapeContent(tree)}\n`;
		const { tag, attrs, nesting, children, comment } = tree;
		const pad = "\t".repeat(nesting + 1);
		if (comment != null) return `${pad}<!-- ${comment.replace(/--/g, "&#45;&#45;")} -->\n`;
		const attrsString = Object.entries(attrs)
			.map(([key, value]) => `${key}="${junitEscapeAttribute(String(value))}"`)
			.join(" ");
		if (!children?.length) return `${pad}<${tag} ${attrsString}/>\n`;
		return `${pad}<${tag} ${attrsString}>\n${children.map(junitTreeToXML).join("")}${pad}</${tag}>\n`;
	}

	const junitIsFailure = (node) =>
		(node?.children && node.children.some((c) => c.tag === "failure")) || node?.attrs?.failures;
	const junitIsSkipped = (node) =>
		(node?.children && node.children.some((c) => c.tag === "skipped")) || node?.attrs?.skipped;

	class JunitFormatter {
		#currentSuite = null;
		#roots = [];

		start() {
			return '<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n';
		}

		#startTest(event) {
			const originalSuite = this.#currentSuite;
			this.#currentSuite = {
				__proto__: null,
				attrs: { __proto__: null, name: event.data.name },
				nesting: event.data.nesting,
				parent: this.#currentSuite,
				children: [],
			};
			if (originalSuite?.children) originalSuite.children.push(this.#currentSuite);
			if (!this.#currentSuite.parent) this.#roots.push(this.#currentSuite);
		}

		handle(event) {
			switch (event.type) {
				case "test:start":
					this.#startTest(event);
					break;
				case "test:pass":
				case "test:fail": {
					if (!this.#currentSuite) this.#startTest({ __proto__: null, data: { __proto__: null, name: "root", nesting: 0 } });
					if (this.#currentSuite.attrs.name !== event.data.name || this.#currentSuite.nesting !== event.data.nesting) {
						this.#startTest(event);
					}
					const currentTest = this.#currentSuite;
					if (this.#currentSuite?.nesting === event.data.nesting) this.#currentSuite = this.#currentSuite.parent;
					currentTest.attrs.time = (event.data.details.duration_ms / 1000).toFixed(6);
					const nonCommentChildren = currentTest.children.filter((c) => c.comment == null);
					if (nonCommentChildren.length > 0) {
						currentTest.tag = "testsuite";
						currentTest.attrs.disabled = 0;
						currentTest.attrs.errors = 0;
						currentTest.attrs.tests = nonCommentChildren.length;
						currentTest.attrs.failures = currentTest.children.filter(junitIsFailure).length;
						currentTest.attrs.skipped = currentTest.children.filter(junitIsSkipped).length;
						// A suite's `test:start` is emitted lazily, so its start time is the end minus its duration.
						currentTest.attrs.timestamp = new Date(Date.now() - event.data.details.duration_ms).toISOString();
						currentTest.attrs.hostname = builtins.os.hostname();
					} else {
						currentTest.tag = "testcase";
						currentTest.attrs.classname = event.data.classname ?? "test";
						if (event.data.file) currentTest.attrs.file = event.data.file;
						if (event.data.skip) {
							currentTest.children.push({
								__proto__: null,
								nesting: event.data.nesting + 1,
								tag: "skipped",
								attrs: { __proto__: null, type: "skipped", message: event.data.skip },
							});
						}
						if (event.data.todo) {
							currentTest.children.push({
								__proto__: null,
								nesting: event.data.nesting + 1,
								tag: "skipped",
								attrs: { __proto__: null, type: "todo", message: event.data.todo },
							});
						}
						if (event.type === "test:fail") {
							const error = event.data.details?.error;
							currentTest.children.push({
								__proto__: null,
								nesting: event.data.nesting + 1,
								tag: "failure",
								attrs: { __proto__: null, type: error?.failureType || error?.code, message: error?.message.trim() ?? "" },
								children: [inspectWithNoCustomRetry(error, { colors: false, breakLength: Infinity })],
							});
							currentTest.failures = 1;
							currentTest.attrs.failure = error?.message ?? "";
						}
					}
					break;
				}
				case "test:diagnostic":
				case "test:log": {
					const parent = this.#currentSuite?.children ?? this.#roots;
					parent.push({ __proto__: null, nesting: event.data.nesting, comment: event.data.message });
					break;
				}
				default:
					break;
			}
			return "";
		}

		flush() {
			return `${this.#roots.map(junitTreeToXML).join("")}</testsuites>\n`;
		}
	}

	/** A reporter as Node's are written: an async generator function over the events of a run. */
	function generatorReporter(Formatter) {
		return async function* reporter(source) {
			colors.refresh();
			const formatter = new Formatter();
			const head = formatter.start?.();
			if (head) yield head;
			for await (const event of source) {
				const text = formatter.handle(event);
				if (text) yield text;
			}
			const rest = formatter.flush?.();
			if (rest) yield rest;
		};
	}

	const formatters = { spec: SpecFormatter, dot: DotFormatter, tap: TapFormatter, junit: JunitFormatter };

	// `spec` is a class in Node's terms: `new spec()` and `spec()` both give a Transform.
	const reporters = {
		dot: generatorReporter(DotFormatter),
		junit: generatorReporter(JunitFormatter),
		spec: function spec() {
			return Reflect.construct(SpecReporter, arguments);
		},
		tap: generatorReporter(TapFormatter),
		lcov: function lcov() {
			return Reflect.construct(LcovReporter, arguments);
		},
	};

	/**
	 * Wires a built-in reporter straight to the events of a stream. What it writes is held back until the current turn of
	 * the event loop is over and goes out at once after that, as it does in Node, where a reporter's stream starts
	 * flowing a tick after the first tests have run; from then on it is written as the events happen.
	 */
	function attachBuiltinReporter(stream, formatter, write) {
		colors.refresh();
		let held = true;
		let buffer = "";
		const emit = (text) => {
			if (!text) return;
			if (held) buffer += text;
			else write(text);
		};
		const release = () => {
			if (!held) return;
			held = false;
			if (buffer) write(buffer);
			buffer = "";
		};
		emit(formatter.start?.());
		const timer = realSetTimeout(release, 0);
		timer.unref?.();
		stream.addSink((event) => {
			if (event === null) {
				emit(formatter.flush?.());
				release();
			} else {
				emit(formatter.handle(event));
			}
		});
	}

	/** Feeds a custom reporter the events of a stream and hands what it produces to `write`; resolves when it is done. */
	function attachReporter(stream, reporter, write) {
		const queue = [];
		let wake;
		let done = false;
		stream.addSink((event) => {
			if (event === null) done = true;
			else queue.push(event);
			wake?.();
		});
		const source = {
			async *[Symbol.asyncIterator]() {
				for (;;) {
					while (queue.length > 0) yield queue.shift();
					if (done) return;
					await new Promise((resolve) => {
						wake = resolve;
					});
					wake = undefined;
				}
			},
		};

		return (async () => {
			let output = reporter;
			if (typeof output === "function") output = output(source);
			else if (output && typeof output.write === "function" && typeof output.on === "function") {
				// A Transform instance: the events go in, the text comes out.
				const chunks = [];
				output.on("data", (chunk) => chunks.push(chunk));
				for await (const event of source) output.write(event);
				output.end();
				await new Promise((resolve) => output.on("end", resolve));
				for (const chunk of chunks) write(chunk);
				return;
			}
			if (output && typeof output.then === "function") output = await output;
			if (output != null && (typeof output[Symbol.asyncIterator] === "function" || typeof output[Symbol.iterator] === "function")) {
				for await (const chunk of output) write(chunk);
			}
		})();
	}

	/* ----------------------------------------------------------------------------------------------- options */

	function splitArguments(text) {
		const args = [];
		const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
		for (let match = pattern.exec(text); match; match = pattern.exec(text)) args.push(match[1] ?? match[2] ?? match[3]);
		return args;
	}

	function convertStringToRegExp(str, name) {
		const match = /^\/(.*)\/([a-z]*)$/.exec(str);
		const pattern = match?.[1] ?? str;
		const flags = match?.[2] || "";
		try {
			return new RegExp(pattern, flags);
		} catch (err) {
			throw invalidArgValue(name, str, `is an invalid regular expression.${err?.message ? ` ${err.message}` : ""}`);
		}
	}

	let globalTestOptions;
	/** The `--test-*` options this process was started with (in execArgv or NODE_OPTIONS), and the reporters they name. */
	function parseCommandLine() {
		if (globalTestOptions) return globalTestOptions;
		const argv = [...(process.execArgv ?? []), ...splitArguments(process.env.NODE_OPTIONS ?? "")];
		const values = { reporter: [], destination: [], namePattern: [], skipPattern: [] };
		let only = false;
		let forceExit = false;
		let timeout;
		for (let i = 0; i < argv.length; i++) {
			const [flag, inline] = argv[i].startsWith("--") && argv[i].includes("=") ? [argv[i].slice(0, argv[i].indexOf("=")), argv[i].slice(argv[i].indexOf("=") + 1)] : [argv[i]];
			const value = () => inline ?? argv[++i];
			switch (flag) {
				case "--test-reporter":
					values.reporter.push(value());
					break;
				case "--test-reporter-destination":
					values.destination.push(value());
					break;
				case "--test-name-pattern":
					values.namePattern.push(value());
					break;
				case "--test-skip-pattern":
					values.skipPattern.push(value());
					break;
				case "--test-only":
					only = true;
					break;
				case "--test-force-exit":
					forceExit = true;
					break;
				case "--test-timeout":
					timeout = Number(value()) || undefined;
					break;
			}
		}

		const reporterNames = values.reporter;
		const destinations = values.destination;
		if (reporterNames.length === 0 && destinations.length === 0) reporterNames.push("spec");
		if (reporterNames.length === 1 && destinations.length === 0) destinations.push("stdout");
		if (destinations.length !== reporterNames.length) {
			throw invalidArgValue("--test-reporter", reporterNames, "must match the number of specified '--test-reporter-destination'");
		}

		const setup = async (rootReporter) => {
			const attached = [];
			for (let i = 0; i < reporterNames.length; i++) {
				const name = reporterNames[i];
				const destination = destinations[i];
				let write;
				if (destination === "stdout") write = (text) => process.stdout.write(text);
				else if (destination === "stderr") write = (text) => process.stderr.write(text);
				else write = (text) => builtins.fs.appendFileSync(destination, text);
				if (destination !== "stdout" && destination !== "stderr") builtins.fs.writeFileSync(destination, "");

				if (formatters[name]) {
					attachBuiltinReporter(rootReporter, new formatters[name](), write);
					continue;
				}
				let reporter;
				{
					const resolved = builtins.module.createRequire(`${process.cwd()}/`)(name);
					reporter = resolved?.default ?? resolved;
					if (reporter?.prototype && Object.getOwnPropertyDescriptor(reporter.prototype, "constructor")) {
						reporter = new reporter();
					}
					if (!reporter) throw invalidArgValue("Reporter", name, "is not a valid reporter");
				}
				attached.push(attachReporter(rootReporter, reporter, write));
			}
			reporterScope.pending = Promise.all(attached);
		};

		globalTestOptions = {
			__proto__: null,
			isTestRunner: false,
			concurrency: 1,
			coverage: false,
			destinations,
			forceExit,
			isolation: undefined,
			only,
			reporters: reporterNames,
			setup,
			testNamePatterns: values.namePattern.length ? values.namePattern.map((re) => convertStringToRegExp(re, "--test-name-pattern")) : null,
			testSkipPatterns: values.skipPattern.length ? values.skipPattern.map((re) => convertStringToRegExp(re, "--test-skip-pattern")) : null,
			timeout: timeout || Infinity,
		};
		return globalTestOptions;
	}
	const reporterScope = { pending: null };

	/* ------------------------------------------------------------------------------------------------ harness */

	const running = new Set();
	let globalRoot;

	function createTestTree(rootTestOptions, globalOptions) {
		const buildPhaseDeferred = withResolvers();
		const isFilteringByName = globalOptions.testNamePatterns || globalOptions.testSkipPatterns;
		const isFilteringByOnly = globalOptions.isolation === "process" ? globalOptions.only : true;
		const harness = {
			__proto__: null,
			buildPromise: buildPhaseDeferred.promise,
			buildSuites: [],
			isWaitingForBuildPhase: false,
			config: globalOptions,
			resetCounters() {
				harness.counters = {
					__proto__: null,
					tests: 0,
					failed: 0,
					passed: 0,
					cancelled: 0,
					skipped: 0,
					todo: 0,
					topLevel: 0,
					suites: 0,
				};
			},
			success: true,
			counters: null,
			teardown: null,
			isFilteringByName,
			isFilteringByOnly,
			bootstrapPromise: null,
			async waitForBuildPhase() {
				if (harness.buildSuites.length > 0) await Promise.all(harness.buildSuites);
				buildPhaseDeferred.resolve();
			},
		};
		harness.resetCounters();
		globalRoot = new Test({ __proto__: null, ...rootTestOptions, harness, name: "<root>" });
		setupProcessState(globalRoot);
		globalRoot.startTime = hrtime();
		return globalRoot;
	}

	function createProcessEventHandler(eventName, rootTest) {
		return (err) => {
			if (rootTest.harness.bootstrapPromise) {
				// Something went wrong while the runner was starting; there is no test to blame.
				throw err;
			}

			// The test that caused this is the one that is running, when exactly one is. With none or with several
			// (concurrent tests), there is no telling, and the error is reported at the top.
			const candidates = [...running].filter((t) => !t.hookType && t.parent !== null && t.reportedType === "test");
			const test = candidates.length === 1 ? candidates[0] : undefined;

			if (!test || test.finished) {
				let msg;
				if (test) {
					let locInfo = "";
					if (test.loc) {
						locInfo = ` at ${pathModule.relative(rootTest.config.cwd, test.loc.file)}:${test.loc.line}:${test.loc.column}`;
					}
					msg =
						`Error: Test "${test.name}"${locInfo} generated asynchronous ` +
						`activity after the test ended. This activity created the error "${err}" and would have caused the ` +
						`test to fail, but instead triggered an ${eventName} event.`;
				} else {
					msg =
						"Error: A resource generated asynchronous activity after " +
						`the test ended. This activity created the error "${err}" which ` +
						`triggered an ${eventName} event, caught by the test runner.`;
				}
				rootTest.diagnostic(msg);
				rootTest.harness.success = false;
				process.exitCode = 1;
				return;
			}

			test.fail(testFailure(err, eventName));
			test.abortController.abort();
		};
	}

	function setupProcessState(root) {
		const exceptionHandler = createProcessEventHandler("uncaughtException", root);
		const rejectionHandler = createProcessEventHandler("unhandledRejection", root);

		const exitHandler = async (kill) => {
			if (root.subtests.length === 0 && (root.hooks.before.length > 0 || root.hooks.after.length > 0)) {
				// Run the global before/after hooks when there are no tests.
				await root.run();
			}

			if (kill !== true && root.subtestsPromise !== null) {
				// Wait for the subtests to finish, keeping the process alive if no handle is left.
				const keepAlive = realSetInterval(() => {}, TIMEOUT_MAX);
				await root.subtestsPromise.promise;
				realClearInterval(keepAlive);
			}

			root.postRun(
				testFailure("Promise resolution is still pending but the event loop has already resolved", kCancelledByParent)
			);
			await reporterScope.pending;

			process.removeListener("uncaughtException", exceptionHandler);
			process.removeListener("unhandledRejection", rejectionHandler);
			process.removeListener("beforeExit", exitHandler);
		};

		process.on("uncaughtException", exceptionHandler);
		process.on("unhandledRejection", rejectionHandler);
		process.on("beforeExit", exitHandler);
		root.harness.teardown = exitHandler;
	}

	function lazyBootstrapRoot() {
		if (!globalRoot) {
			// The runner starts here when node:test is used without `run()`.
			const entryFile = process.argv?.[1];
			const rootTestOptions = {
				__proto__: null,
				entryFile,
				loc: entryFile ? [1, 1, entryFile] : undefined,
				reporter: new TestsStream({ buffered: false }),
			};
			const globalOptions = parseCommandLine();
			globalOptions.cwd = process.cwd();
			createTestTree(rootTestOptions, globalOptions);
			globalRoot.reporter.on("test:summary", (data) => {
				if (!data.success) process.exitCode = 1;
			});
			globalRoot.harness.bootstrapPromise = Promise.resolve(globalOptions.setup(globalRoot.reporter));
		}
		return globalRoot;
	}

	async function startSubtestAfterBootstrap(subtest) {
		if (subtest.root.harness.buildPromise) {
			if (subtest.root.harness.bootstrapPromise) {
				await subtest.root.harness.bootstrapPromise;
				subtest.root.harness.bootstrapPromise = null;
			}
			if (subtest.buildSuite) subtest.root.harness.buildSuites.push(subtest.buildSuite);
			if (!subtest.root.harness.isWaitingForBuildPhase) {
				subtest.root.harness.isWaitingForBuildPhase = true;
				queueMicrotask(() => {
					subtest.root.harness.waitForBuildPhase();
				});
			}
			await subtest.root.harness.buildPromise;
			subtest.root.harness.buildPromise = null;
		}
		await subtest.start();
	}

	function runInParentContext(Factory) {
		function run(name, options, fn, overrides) {
			const parent = currentParent() ?? lazyBootstrapRoot();
			const subtest = parent.createSubtest(Factory, name, options, fn, overrides);
			if (parent instanceof Suite) return Promise.resolve();
			return startSubtestAfterBootstrap(subtest);
		}

		const test = (name, options, fn) => run(name, options, fn, { __proto__: null, loc: getCallerLocation() });
		for (const keyword of ["expectFailure", "skip", "todo", "only"]) {
			test[keyword] = (name, options, fn) =>
				run(name, options, fn, { __proto__: null, [keyword]: true, loc: getCallerLocation() });
		}
		return test;
	}

	function hook(hookName) {
		return (fn, options) => {
			const parent = currentParent() ?? lazyBootstrapRoot();
			parent.createHook(hookName, fn, {
				__proto__: null,
				...options,
				parent,
				hookType: hookName,
				loc: getCallerLocation(),
			});
		};
	}

	function getTestContext() {
		const test = currentParent();
		return test === undefined ? undefined : test.getCtx();
	}

	/* ----------------------------------------------------------------------------------------------------- run */

	function createTestFileList(patterns, cwd) {
		const defaults = ["test", "test/**/*", "test-*", "*[._-]test"].map((p) => `**/${p}.{js,mjs,cjs}`);
		const found = new Set();
		for (const pattern of patterns?.length ? patterns : defaults) {
			for (const file of builtins.fs.globSync(pattern, { cwd, exclude: (name) => name === "node_modules" })) found.add(file);
		}
		return [...found].sort();
	}

	function run(options = kEmptyObject) {
		validateObject(options, "options");
		const {
			concurrency,
			timeout,
			signal,
			files,
			forceExit,
			isolation = "process",
			setup,
			only,
			globPatterns,
			cwd = process.cwd(),
			testNamePatterns,
			testSkipPatterns,
		} = options;

		if (files != null && !Array.isArray(files)) throw invalidArgType("options.files", "Array", files);
		if (forceExit != null) validateBoolean(forceExit, "options.forceExit");
		if (only != null) validateBoolean(only, "options.only");
		if (globPatterns != null && !Array.isArray(globPatterns)) throw invalidArgType("options.globPatterns", "Array", globPatterns);
		validateOneOf(isolation, "options.isolation", ["process", "none"]);
		if (options.watch) throw nodeError(Error, "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", "run() does not support watch mode on this runtime.");
		if (options.coverage) throw nodeError(Error, "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", "run() does not support code coverage on this runtime.");

		const rootTestOptions = { __proto__: null, concurrency, timeout, signal, reporter: new TestsStream() };
		const globalOptions = {
			__proto__: null,
			...parseCommandLine(),
			setup,
			cwd,
			testNamePatterns: testNamePatterns == null ? null : [].concat(testNamePatterns).map((p) => (p instanceof RegExp ? p : convertStringToRegExp(p, "options.testNamePatterns"))),
			testSkipPatterns: testSkipPatterns == null ? null : [].concat(testSkipPatterns).map((p) => (p instanceof RegExp ? p : convertStringToRegExp(p, "options.testSkipPatterns"))),
			only: only ?? false,
			forceExit: forceExit ?? false,
			isolation: "none",
			timeout: timeout ?? Infinity,
		};
		const previousRoot = globalRoot;
		const root = createTestTree(rootTestOptions, globalOptions);
		const testFiles = files ?? createTestFileList(globPatterns, cwd);
		const isolatedRoot = root;

		const runChain = async () => {
			if (typeof setup === "function") await setup(root.reporter);
			root.harness.bootstrapPromise = null;
			const load = createRequireFrom(cwd);
			let topLevelTestCount = 0;
			for (const testFile of testFiles) {
				const resolved = pathModule.resolve(cwd, testFile);
				root.entryFile = resolved;
				let importError;
				let threw = false;
				try {
					await load(resolved);
				} catch (err) {
					threw = true;
					importError = err;
				}
				if (topLevelTestCount === root.subtests.length) {
					// A file with no tests in it gets a placeholder test, which fails if the file could not be loaded.
					const subtest = root.createSubtest(Test, testFile, kEmptyObject, undefined, {
						__proto__: null,
						loc: [1, 1, resolved],
					});
					if (threw) subtest.fail(importError);
					startSubtestAfterBootstrap(subtest);
				}
				topLevelTestCount = root.subtests.length;
			}
			root.entryFile = null;
			// Everything the files declared runs now; the tree ends when its tests do.
			if (root.harness.buildPromise) {
				if (root.harness.buildSuites.length > 0) await Promise.all(root.harness.buildSuites);
				root.harness.buildPromise = null;
			}
			await root.processPendingSubtests();
			if (root.subtests.length === 0) await root.harness.teardown();
			else if (root.subtestsPromise) await root.subtestsPromise.promise;
			await root.harness.teardown();
			globalRoot = previousRoot === isolatedRoot ? undefined : previousRoot;
		};

		runChain().catch((err) => {
			isolatedRoot.reporter.emit("error", err);
		});
		return root.reporter;
	}

	function createRequireFrom(cwd) {
		const require = builtins.module.createRequire(`${cwd}/`);
		return async (file) => require(file);
	}

	/* ------------------------------------------------------------------------------------------------ module */

	// Node gates `mock.module()` behind this flag for CommonJS as well as ESM; match that exactly.
	const moduleMockingEnabled = [...(process.execArgv ?? []), ...splitArguments(process.env.NODE_OPTIONS ?? "")].includes(
		"--experimental-test-module-mocks"
	);

	const { MockTracker } = createMockTools({
		globalObject,
		timers: builtins.timers,
		timersPromises: builtins["timers/promises"],
		EventEmitter,
		moduleMockingEnabled,
		resolveCommonJsModule: moduleMockHooks?.resolveModule,
		moduleCache: moduleMockHooks?.moduleCache,
		mockCommonJsModule: moduleMockHooks?.mockCommonJsModule,
		unmockCommonJsModule: moduleMockHooks?.unmockCommonJsModule,
		mockEsmModule: moduleMockHooks?.mockEsmModule,
		unmockEsmModule: moduleMockHooks?.unmockEsmModule,
	});

	const test = runInParentContext(Test);
	const suite = runInParentContext(Suite);
	const exported = test;
	Object.assign(exported, {
		after: hook("after"),
		afterEach: hook("afterEach"),
		before: hook("before"),
		beforeEach: hook("beforeEach"),
		describe: suite,
		getTestContext,
		it: test,
		run,
		suite,
		test,
	});

	let lazyMock;
	Object.defineProperty(exported, "mock", {
		configurable: true,
		enumerable: true,
		get() {
			lazyMock ??= new MockTracker();
			return lazyMock;
		},
	});

	// Snapshot testing needs files next to the tests and a serializer; it is not provided, and says so when used.
	Object.defineProperty(exported, "snapshot", {
		configurable: true,
		enumerable: true,
		get() {
			const unavailable = (name) => () => {
				throw nodeError(Error, "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", `snapshot.${name}() is not available on this runtime.`);
			};
			return {
				__proto__: null,
				setDefaultSnapshotSerializers: unavailable("setDefaultSnapshotSerializers"),
				setResolveSnapshotPath: unavailable("setResolveSnapshotPath"),
			};
		},
	});

	let lazyAssert;
	Object.defineProperty(exported, "assert", {
		configurable: true,
		enumerable: true,
		get() {
			lazyAssert ??= {
				__proto__: null,
				register(name, fn) {
					validateString(name, "name");
					validateFunction(fn, "fn");
					getAssertionMap().set(name, fn);
				},
			};
			return lazyAssert;
		},
	});

	return { test: exported, reporters };
}

export { createTestModule };
