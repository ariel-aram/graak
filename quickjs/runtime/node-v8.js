/*
 * node:v8 serialization: V8's own wire format (version 15), written and read in JavaScript.
 *
 * The bytes are the ones V8's ValueSerializer produces, so they can be exchanged with a real Node.js
 * process. Serializer/Deserializer follow lib/v8.js and the C++ SerializerContext/DeserializerContext
 * behind it: DefaultSerializer writes typed arrays and Buffers as host objects, the plain Serializer
 * writes them natively (ArrayBuffer followed by a view tag).
 *
 * V8 looks at internal state that JavaScript cannot see; where it matters the choice made here is:
 *   - an array is written densely when it has no holes (V8 also demands a "packed" elements kind, so
 *     `new Array(3).fill(0)` is written sparsely by V8 and densely here),
 *   - an array holding only numbers of which one is not an int32 is written as doubles (V8's
 *     PACKED_DOUBLE_ELEMENTS),
 *   - a view over a resizable ArrayBuffer is "length tracking" when it reaches the end of the buffer,
 *   - a RegExp is written with its `source`,
 *   - a Proxy (detected with `__graak_native.isProxy`) always throws, like V8, with a message built the
 *     same way for every shape V8 special-cases (plain object, array, Map, Set, Date, RegExp, Error, a
 *     revoked proxy) by reading only what an untrapped Proxy forwards safely (`instanceof`,
 *     `constructor.name`, `Array.isArray`, `String()`). V8 builds its message by peeking at the real
 *     target through state JavaScript cannot see; a Proxy wrapping a callable can't follow that: it is
 *     already caught earlier (by `typeof value === "function"`) and reports this engine's own
 *     `Function.prototype.toString` output for it, which does not reliably match V8's message text
 *     (V8's own is the target's real source when it has one, and otherwise still differs from this
 *     engine's own formatting for a function with none, e.g. a bound function).
 */

import { inspect } from "./node-inspect.js";

const VERSION = 15;

const toStr = Object.prototype.toString;
const hasOwn = Object.prototype.hasOwnProperty;
const isView = ArrayBuffer.isView;
const fromCharCode = String.fromCharCode;
const abByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;
const sabByteLength =
	typeof SharedArrayBuffer === "function"
		? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength").get
		: null;
const TypedArray = Object.getPrototypeOf(Uint8Array);
const typedArrayTag = Object.getOwnPropertyDescriptor(TypedArray.prototype, Symbol.toStringTag).get;
const dateGetTime = Date.prototype.getTime;
const mapHas = Map.prototype.has;
const setHas = Set.prototype.has;
const weakMapHas = WeakMap.prototype.has;
const weakSetHas = WeakSet.prototype.has;
const dvByteLength = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength").get;
const regexpSource = Object.getOwnPropertyDescriptor(RegExp.prototype, "source").get;
const numberValueOf = Number.prototype.valueOf;
const stringValueOf = String.prototype.valueOf;
const booleanValueOf = Boolean.prototype.valueOf;
const bigintValueOf = BigInt.prototype.valueOf;
const symbolValueOf = Symbol.prototype.valueOf;

const brand = (fn, value, ...args) => {
	try {
		fn.call(value, ...args);
		return true;
	} catch {
		return false;
	}
};

const isArrayBuffer = (v) => brand(abByteLength, v);
const isSharedArrayBuffer = (v) => sabByteLength !== null && brand(sabByteLength, v);
const isTypedArray = (v) => {
	try {
		return typedArrayTag.call(v) !== undefined;
	} catch {
		return false;
	}
};
const isError = (v) => (typeof Error.isError === "function" ? Error.isError(v) : toStr.call(v) === "[object Error]");
const nativeIsProxy = globalThis.__graak_native?.isProxy;
const isProxy = (v) => (v !== null && (typeof v === "object" || typeof v === "function") ? Boolean(nativeIsProxy?.(v)) : false);

// Wire tags.
const T = {
	version: 0xff,
	padding: 0x00,
	verifyObjectCount: 0x3f,
	theHole: 0x2d,
	undefined: 0x5f,
	null: 0x30,
	true: 0x54,
	false: 0x46,
	int32: 0x49,
	uint32: 0x55,
	double: 0x4e,
	bigint: 0x5a,
	utf8: 0x53,
	oneByte: 0x22,
	twoByte: 0x63,
	objectRef: 0x5e,
	beginObject: 0x6f,
	endObject: 0x7b,
	beginSparse: 0x61,
	endSparse: 0x40,
	beginDense: 0x41,
	endDense: 0x24,
	date: 0x44,
	trueObject: 0x79,
	falseObject: 0x78,
	numberObject: 0x6e,
	bigintObject: 0x7a,
	stringObject: 0x73,
	regexp: 0x52,
	beginMap: 0x3b,
	endMap: 0x3a,
	beginSet: 0x27,
	endSet: 0x2c,
	arrayBuffer: 0x42,
	resizableArrayBuffer: 0x7e,
	arrayBufferTransfer: 0x74,
	view: 0x56,
	sharedArrayBuffer: 0x75,
	error: 0x72,
	hostObject: 0x5c,
};

// ArrayBufferView sub-tags.
const VIEW_TAGS = {
	Int8Array: 0x62,
	Uint8Array: 0x42,
	Uint8ClampedArray: 0x43,
	Int16Array: 0x77,
	Uint16Array: 0x57,
	Int32Array: 0x64,
	Uint32Array: 0x44,
	Float16Array: 0x68,
	Float32Array: 0x66,
	Float64Array: 0x46,
	BigInt64Array: 0x71,
	BigUint64Array: 0x51,
	DataView: 0x3f,
};
const VIEW_CTORS = new Map();
for (const name of Object.keys(VIEW_TAGS)) {
	if (typeof globalThis[name] === "function") VIEW_CTORS.set(VIEW_TAGS[name], globalThis[name]);
}

const ERROR_TAGS = { EvalError: 0x45, RangeError: 0x52, ReferenceError: 0x46, SyntaxError: 0x53, TypeError: 0x54, URIError: 0x55 };
const ERROR_CTORS = new Map([
	[0x45, EvalError],
	[0x52, RangeError],
	[0x46, ReferenceError],
	[0x53, SyntaxError],
	[0x54, TypeError],
	[0x55, URIError],
]);

const UNSUPPORTED_TAGS = new Set([
	"Promise",
	"WeakMap",
	"WeakSet",
	"WeakRef",
	"FinalizationRegistry",
	"Generator",
	"AsyncGenerator",
	"Map Iterator",
	"Set Iterator",
	"Array Iterator",
	"String Iterator",
	"RegExp String Iterator",
	"Module",
]);

const invalidArg = (message) => Object.assign(new TypeError(message), { code: "ERR_INVALID_ARG_TYPE" });
const uint32Of = (n) => Number(n) >>> 0;

const scratch = new DataView(new ArrayBuffer(8));

/* ------------------------------------------------------------------ Serializer */

class Serializer {
	#bytes = new Uint8Array(64);
	#size = 0;
	#nextId = 0;
	#ids = new Map();
	#transfers = new Map();
	#viewsAreHost = false;

	#ensure(extra) {
		const need = this.#size + extra;
		if (need <= this.#bytes.length) return;
		let capacity = this.#bytes.length * 2;
		while (capacity < need) capacity *= 2;
		const grown = new Uint8Array(capacity);
		grown.set(this.#bytes.subarray(0, this.#size));
		this.#bytes = grown;
	}
	#tag(tag) {
		this.#ensure(1);
		this.#bytes[this.#size++] = tag;
	}
	#varint(value) {
		this.#ensure(10);
		let n = value;
		while (n >= 0x80) {
			this.#bytes[this.#size++] = (n % 128) | 0x80;
			n = Math.floor(n / 128);
		}
		this.#bytes[this.#size++] = n;
	}
	#varintBig(value) {
		this.#ensure(10);
		let n = value;
		while (n >= 0x80n) {
			this.#bytes[this.#size++] = Number(n & 0x7fn) | 0x80;
			n >>= 7n;
		}
		this.#bytes[this.#size++] = Number(n);
	}
	#double(value) {
		this.#ensure(8);
		scratch.setFloat64(0, value, true);
		for (let i = 0; i < 8; i++) this.#bytes[this.#size++] = scratch.getUint8(i);
	}
	#raw(view) {
		this.#ensure(view.length);
		this.#bytes.set(view, this.#size);
		this.#size += view.length;
	}

	writeHeader() {
		this.#tag(T.version);
		this.#varint(VERSION);
	}

	writeValue(value) {
		this.#writeObject(value);
		return true;
	}

	releaseBuffer() {
		const out = Buffer.from(this.#bytes.slice(0, this.#size).buffer);
		this.#bytes = new Uint8Array(64);
		this.#size = 0;
		return out;
	}

	transferArrayBuffer(id, arrayBuffer) {
		if (!isArrayBuffer(arrayBuffer)) throw invalidArg("arrayBuffer must be an ArrayBuffer");
		this.#transfers.set(uint32Of(id), arrayBuffer);
	}

	writeUint32(value) {
		this.#varint(uint32Of(value));
	}

	writeUint64(hi, lo) {
		this.#varintBig((BigInt(uint32Of(hi)) << 32n) | BigInt(uint32Of(lo)));
	}

	writeDouble(value) {
		this.#double(Number(value));
	}

	writeRawBytes(source) {
		if (!isView(source)) throw invalidArg("source must be a TypedArray or a DataView");
		this.#raw(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
	}

	_setTreatArrayBufferViewsAsHostObjects(flag) {
		this.#viewsAreHost = Boolean(flag);
	}

	#cloneError(message) {
		// Node calls the hook as a plain function, so it may not be a class.
		return this._getDataCloneError(message);
	}

	#describe(value) {
		if (typeof value === "function") return Function.prototype.toString.call(value);
		if (typeof value === "symbol") return value.toString();
		if (brand(symbolValueOf, value)) return "[object Symbol]";
		let name = "Object";
		try {
			const ctor = value.constructor;
			if (typeof ctor === "function" && typeof ctor.name === "string" && ctor.name) name = ctor.name;
		} catch {}
		return `#<${name}>`;
	}

	// A proxy wrapping a callable target is already caught by #writeObject's own `typeof value ===
	// "function"` case (typeof sees straight through a Proxy's [[Call]] internal method), which formats
	// it the same way as here, through #describe; that path never reaches this one.
	#describeProxy(value) {
		try {
			Reflect.getPrototypeOf(value);
		} catch {
			// A revoked proxy's target is spec-mandated to become null; V8 reports that as the target.
			return "null";
		}
		if (Array.isArray(value)) return "[object Array]";
		if (value instanceof Error) {
			try {
				return String(value);
			} catch {}
		}
		if (value instanceof Date) return "[object Date]";
		if (value instanceof RegExp) return "[object RegExp]";
		return this.#describe(value);
	}

	#writeString(text) {
		let oneByte = true;
		for (let i = 0; i < text.length; i++) {
			if (text.charCodeAt(i) > 0xff) {
				oneByte = false;
				break;
			}
		}
		if (oneByte) {
			this.#tag(T.oneByte);
			this.#varint(text.length);
			this.#ensure(text.length);
			for (let i = 0; i < text.length; i++) this.#bytes[this.#size++] = text.charCodeAt(i);
			return;
		}
		const byteLength = text.length * 2;
		let varintSize = 1;
		for (let n = byteLength; n >= 0x80; n = Math.floor(n / 128)) varintSize++;
		// The two-byte payload has to start on an even offset.
		if ((this.#size + 1 + varintSize) & 1) this.#tag(T.padding);
		this.#tag(T.twoByte);
		this.#varint(byteLength);
		this.#ensure(byteLength);
		for (let i = 0; i < text.length; i++) {
			const unit = text.charCodeAt(i);
			this.#bytes[this.#size++] = unit & 0xff;
			this.#bytes[this.#size++] = unit >> 8;
		}
	}

	#writeBigIntContents(value) {
		const negative = value < 0n;
		let magnitude = negative ? -value : value;
		const digits = [];
		while (magnitude > 0n) {
			digits.push(magnitude & 0xffffffffffffffffn);
			magnitude >>= 64n;
		}
		this.#varint(digits.length * 8 * 2 + (negative ? 1 : 0));
		this.#ensure(digits.length * 8);
		for (const digit of digits) {
			let d = digit;
			for (let i = 0; i < 8; i++) {
				this.#bytes[this.#size++] = Number(d & 0xffn);
				d >>= 8n;
			}
		}
	}

	#writeNumber(value) {
		if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 && !Object.is(value, -0)) {
			this.#tag(T.int32);
			this.#varint(((value << 1) ^ (value >> 31)) >>> 0);
		} else {
			this.#tag(T.double);
			this.#double(value);
		}
	}

	#writeObject(value) {
		switch (typeof value) {
			case "undefined":
				return this.#tag(T.undefined);
			case "boolean":
				return this.#tag(value ? T.true : T.false);
			case "number":
				return this.#writeNumber(value);
			case "string":
				return this.#writeString(value);
			case "bigint":
				this.#tag(T.bigint);
				return this.#writeBigIntContents(value);
			case "symbol":
			case "function":
				throw this.#cloneError(`${this.#describe(value)} could not be cloned.`);
		}
		if (value === null) return this.#tag(T.null);
		if (isProxy(value)) throw this.#cloneError(`${this.#describeProxy(value)} could not be cloned.`);
		return this.#writeReceiver(value);
	}

	#classify(value) {
		if (Array.isArray(value)) return "array";
		const tag = toStr.call(value).slice(8, -1);
		if (tag === "Object") return "object";
		if (isTypedArray(value)) return "typedarray";
		if (brand(dvByteLength, value)) return "dataview";
		if (isArrayBuffer(value)) return "arraybuffer";
		if (isSharedArrayBuffer(value)) return "sharedarraybuffer";
		if (brand(dateGetTime, value)) return "date";
		if (value !== RegExp.prototype && brand(regexpSource, value)) return "regexp";
		if (brand(mapHas, value, undefined)) return "map";
		if (brand(setHas, value, undefined)) return "set";
		if (isError(value)) return "error";
		if (brand(numberValueOf, value)) return "number";
		if (brand(stringValueOf, value)) return "string";
		if (brand(booleanValueOf, value)) return "boolean";
		if (brand(bigintValueOf, value)) return "bigint";
		if (brand(symbolValueOf, value)) return "symbol";
		if (brand(weakMapHas, value, {}) || brand(weakSetHas, value, {})) return "unsupported";
		if (UNSUPPORTED_TAGS.has(tag)) return "unsupported";
		return "object";
	}

	#writeReceiver(value) {
		const kind = this.#classify(value);
		if (kind === "typedarray" || kind === "dataview") {
			// The buffer goes first (and takes an id) unless views are host objects.
			if (!this.#ids.has(value) && !this.#viewsAreHost) this.#writeReceiverPlain(value.buffer);
			return this.#writeReceiverPlain(value, kind);
		}
		return this.#writeReceiverPlain(value, kind);
	}

	#writeReceiverPlain(value, kind = this.#classify(value)) {
		const known = this.#ids.get(value);
		if (known !== undefined) {
			this.#tag(T.objectRef);
			return this.#varint(known);
		}
		this.#ids.set(value, this.#nextId++);
		switch (kind) {
			case "array":
				return this.#writeArray(value);
			case "object":
				return this.#writeObjectBody(value);
			case "date":
				this.#tag(T.date);
				return this.#double(dateGetTime.call(value));
			case "number":
				this.#tag(T.numberObject);
				return this.#double(numberValueOf.call(value));
			case "bigint":
				this.#tag(T.bigintObject);
				return this.#writeBigIntContents(bigintValueOf.call(value));
			case "string":
				this.#tag(T.stringObject);
				return this.#writeString(stringValueOf.call(value));
			case "boolean":
				return this.#tag(booleanValueOf.call(value) ? T.trueObject : T.falseObject);
			case "regexp":
				return this.#writeRegExp(value);
			case "map": {
				const entries = [...Map.prototype.entries.call(value)];
				this.#tag(T.beginMap);
				for (const [k, v] of entries) {
					this.#writeObject(k);
					this.#writeObject(v);
				}
				this.#tag(T.endMap);
				return this.#varint(entries.length * 2);
			}
			case "set": {
				const items = [...Set.prototype.values.call(value)];
				this.#tag(T.beginSet);
				for (const item of items) this.#writeObject(item);
				this.#tag(T.endSet);
				return this.#varint(items.length);
			}
			case "arraybuffer":
				return this.#writeArrayBuffer(value);
			case "sharedarraybuffer": {
				if (typeof this._getSharedArrayBufferId !== "function") {
					throw this.#cloneError(`${this.#describe(value)} could not be cloned.`);
				}
				const id = uint32Of(this._getSharedArrayBufferId(value));
				this.#tag(T.sharedArrayBuffer);
				return this.#varint(id);
			}
			case "typedarray":
			case "dataview":
				return this.#writeView(value, kind);
			case "error":
				return this.#writeError(value);
			default:
				throw this.#cloneError(`${this.#describe(value)} could not be cloned.`);
		}
	}

	#ownStringKeys(value) {
		return Object.keys(value);
	}

	// Own enumerable string keys (array indices as numbers) with their values, in V8's order.
	#writeProperties(value, keys) {
		let written = 0;
		for (const key of keys) {
			if (!Object.prototype.propertyIsEnumerable.call(value, key)) continue;
			const index = isIndexKey(key);
			if (index === -1) this.#writeString(key);
			else this.#writeNumber(index);
			this.#writeObject(value[key]);
			written++;
		}
		return written;
	}

	#writeObjectBody(value) {
		this.#tag(T.beginObject);
		const written = this.#writeProperties(value, this.#ownStringKeys(value));
		this.#tag(T.endObject);
		this.#varint(written);
	}

	#writeArray(value) {
		const length = value.length;
		const keys = this.#ownStringKeys(value);
		let indexKeys = 0;
		for (const key of keys) if (isIndexKey(key) !== -1) indexKeys++;
		if (indexKeys === length) {
			this.#tag(T.beginDense);
			this.#varint(length);
			let doubles = length > 0;
			let anyNonInt = false;
			for (let i = 0; i < length && doubles; i++) {
				const item = value[i];
				if (typeof item !== "number") doubles = false;
				else if (!(Number.isInteger(item) && item >= -2147483648 && item <= 2147483647 && !Object.is(item, -0))) {
					anyNonInt = true;
				}
			}
			doubles = doubles && anyNonInt;
			for (let i = 0; i < length; i++) {
				const item = value[i];
				if (doubles) {
					this.#tag(T.double);
					this.#double(item);
				} else {
					this.#writeObject(item);
				}
			}
			const written = this.#writeProperties(
				value,
				keys.filter((key) => isIndexKey(key) === -1),
			);
			this.#tag(T.endDense);
			this.#varint(written);
			return this.#varint(length);
		}
		this.#tag(T.beginSparse);
		this.#varint(length);
		const written = this.#writeProperties(value, keys);
		this.#tag(T.endSparse);
		this.#varint(written);
		this.#varint(length);
	}

	#writeRegExp(value) {
		this.#tag(T.regexp);
		this.#writeString(regexpSource.call(value));
		const flags = value.flags;
		let bits = 0;
		for (const flag of flags) {
			bits |= { g: 1, i: 2, m: 4, y: 8, u: 16, s: 32, d: 128, v: 256 }[flag] ?? 0;
		}
		this.#varint(bits);
	}

	#writeArrayBuffer(value) {
		for (const [id, buffer] of this.#transfers) {
			if (buffer === value) {
				this.#tag(T.arrayBufferTransfer);
				return this.#varint(id);
			}
		}
		if (value.detached === true) throw this.#cloneError("An ArrayBuffer is detached and could not be cloned.");
		const bytes = new Uint8Array(value);
		if (value.resizable) {
			this.#tag(T.resizableArrayBuffer);
			this.#varint(bytes.length);
			this.#varint(value.maxByteLength);
		} else {
			this.#tag(T.arrayBuffer);
			this.#varint(bytes.length);
		}
		this.#raw(bytes);
	}

	#writeView(value, kind) {
		if (this.#viewsAreHost) {
			if (typeof this._writeHostObject !== "function") {
				throw this.#cloneError(`${toStr.call(value)} could not be cloned.`);
			}
			this.#tag(T.hostObject);
			this._writeHostObject(value);
			return;
		}
		const name = kind === "dataview" ? "DataView" : typedArrayTag.call(value);
		const buffer = value.buffer;
		this.#tag(T.view);
		this.#tag(VIEW_TAGS[name] ?? VIEW_TAGS.Uint8Array);
		let flags = 0;
		if (buffer.resizable) {
			flags |= 2;
			if (tracksLength(value, buffer)) flags |= 1;
		}
		this.#varint(value.byteOffset);
		// A length-tracking view has no length of its own to record.
		this.#varint(flags & 1 ? 0 : value.byteLength);
		this.#varint(flags);
	}

	#writeError(value) {
		this.#tag(T.error);
		let name;
		try {
			name = String(value.name);
		} catch {}
		if (name !== undefined && hasOwn.call(ERROR_TAGS, name)) this.#tag(ERROR_TAGS[name]);
		const messageDescriptor = Object.getOwnPropertyDescriptor(value, "message");
		if (messageDescriptor) {
			this.#tag(0x6d);
			this.#writeString(String(value.message));
		}
		const stack = value.stack;
		if (typeof stack === "string") {
			this.#tag(0x73);
			this.#writeString(stack);
		}
		if (Object.getOwnPropertyDescriptor(value, "cause")) {
			this.#tag(0x63);
			this.#writeObject(value.cause);
		}
		this.#tag(0x2e);
	}
}
Serializer.prototype._getDataCloneError = Error;

// Whether a view over a resizable buffer follows the buffer's length: told apart by resizing the
// buffer by one byte for a moment and seeing whether the view moves with it.
function tracksLength(view, buffer) {
	const length = buffer.byteLength;
	const before = view.byteLength;
	try {
		if (length < buffer.maxByteLength) {
			buffer.resize(length + 1);
			const tracks = view.byteLength !== before;
			buffer.resize(length);
			return tracks;
		}
		if (length === 0) return false;
		const bytes = new Uint8Array(buffer);
		const last = bytes[length - 1];
		buffer.resize(length - 1);
		const tracks = view.byteLength !== 0 || before === 0;
		buffer.resize(length);
		new Uint8Array(buffer)[length - 1] = last;
		return tracks && before !== 0;
	} catch {
		return false;
	}
}

// Array index keys are canonical numeric strings below 2^32 - 1; the rest stay strings.
function isIndexKey(key) {
	if (key.length === 0 || key.length > 10) return -1;
	const first = key.charCodeAt(0);
	if (first < 0x30 || first > 0x39 || (first === 0x30 && key.length > 1)) return -1;
	for (let i = 1; i < key.length; i++) {
		const c = key.charCodeAt(i);
		if (c < 0x30 || c > 0x39) return -1;
	}
	const n = Number(key);
	return n < 4294967295 ? n : -1;
}

/* ---------------------------------------------------------------- Deserializer */

const FAIL = "Unable to deserialize cloned data.";
const VERSION_FAIL = "Unable to deserialize cloned data due to invalid or unsupported version.";

class Deserializer {
	#bytes;
	#pos = 0;
	#version = 0;
	#objects = new Map();
	#nextId = 0;
	#transfers = new Map();

	constructor(buffer) {
		if (!isView(buffer)) throw invalidArg("buffer must be a TypedArray or a DataView");
		this.buffer = buffer;
		this.#bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	}

	#fail() {
		return new Error(FAIL);
	}
	#peek() {
		return this.#pos < this.#bytes.length ? this.#bytes[this.#pos] : -1;
	}
	#byte() {
		if (this.#pos >= this.#bytes.length) throw this.#fail();
		return this.#bytes[this.#pos++];
	}
	#varint() {
		let result = 0;
		let scale = 1;
		for (;;) {
			const b = this.#byte();
			if (scale < 4294967296) result += (b & 0x7f) * scale;
			scale *= 128;
			if (!(b & 0x80)) break;
		}
		return result % 4294967296;
	}
	#varintBig() {
		let result = 0n;
		let shift = 0n;
		for (;;) {
			const b = this.#byte();
			if (shift < 64n) result |= BigInt(b & 0x7f) << shift;
			shift += 7n;
			if (!(b & 0x80)) break;
		}
		return result & 0xffffffffffffffffn;
	}
	#double() {
		if (this.#pos + 8 > this.#bytes.length) throw this.#fail();
		for (let i = 0; i < 8; i++) scratch.setUint8(i, this.#bytes[this.#pos + i]);
		this.#pos += 8;
		return scratch.getFloat64(0, true);
	}
	#take(length) {
		if (length > this.#bytes.length - this.#pos) throw this.#fail();
		const out = this.#bytes.subarray(this.#pos, this.#pos + length);
		this.#pos += length;
		return out;
	}

	readHeader() {
		if (this.#peek() !== T.version) throw new Error(VERSION_FAIL);
		this.#pos++;
		const version = this.#varint();
		if (version > VERSION) throw new Error(VERSION_FAIL);
		this.#version = version;
		return true;
	}

	getWireFormatVersion() {
		return this.#version;
	}

	readValue() {
		return this.#readObject();
	}

	transferArrayBuffer(id, arrayBuffer) {
		if (isArrayBuffer(arrayBuffer)) this.#transfers.set(uint32Of(id), arrayBuffer);
		else if (!isSharedArrayBuffer(arrayBuffer)) throw invalidArg("arrayBuffer must be an ArrayBuffer or SharedArrayBuffer");
	}

	readUint32() {
		try {
			return this.#varint();
		} catch {
			throw new Error("ReadUint32() failed");
		}
	}

	readUint64() {
		try {
			const value = this.#varintBig();
			return [Number(value >> 32n), Number(value & 0xffffffffn)];
		} catch {
			throw new Error("ReadUint64() failed");
		}
	}

	readDouble() {
		try {
			return this.#double();
		} catch {
			throw new Error("ReadDouble() failed");
		}
	}

	_readRawBytes(length) {
		const size = uint32Of(length);
		if (size > this.#bytes.length - this.#pos) throw new Error("ReadRawBytes() failed");
		const offset = this.#pos;
		this.#pos += size;
		return offset;
	}

	readRawBytes(length) {
		const offset = this._readRawBytes(length);
		return Buffer.from(this.buffer.buffer, this.buffer.byteOffset + offset, length);
	}

	#latin1(length) {
		const bytes = this.#take(length);
		let out = "";
		for (let i = 0; i < bytes.length; i += 8192) out += fromCharCode.apply(null, bytes.subarray(i, i + 8192));
		return out;
	}
	#utf16(byteLength) {
		if (byteLength & 1) throw this.#fail();
		const bytes = this.#take(byteLength);
		let out = "";
		const units = [];
		for (let i = 0; i < bytes.length; i += 2) {
			units.push(bytes[i] | (bytes[i + 1] << 8));
			if (units.length === 8192) {
				out += fromCharCode.apply(null, units);
				units.length = 0;
			}
		}
		return out + fromCharCode.apply(null, units);
	}
	#skipPadding() {
		while (this.#peek() === T.padding) this.#pos++;
	}
	#readString() {
		this.#skipPadding();
		const tag = this.#byte();
		const length = this.#varint();
		if (tag === T.oneByte) return this.#latin1(length);
		if (tag === T.twoByte) return this.#utf16(length);
		if (tag === T.utf8) return new TextDecoder().decode(this.#take(length));
		throw this.#fail();
	}
	#remember(value) {
		this.#objects.set(this.#nextId++, value);
		return value;
	}
	#readBigIntContents() {
		const bitfield = this.#varint();
		const byteLength = bitfield >>> 1;
		if (byteLength % 8) throw this.#fail();
		const bytes = this.#take(byteLength);
		let magnitude = 0n;
		for (let i = bytes.length - 1; i >= 0; i--) magnitude = (magnitude << 8n) | BigInt(bytes[i]);
		return bitfield & 1 ? -magnitude : magnitude;
	}

	#readObject() {
		const value = this.#readValueRecord();
		// A view record follows the ArrayBuffer (or a reference to it) that it looks at.
		if (this.#peek() === T.view && value !== null && typeof value === "object" && isArrayBuffer(value)) {
			return this.#readView(value);
		}
		return value;
	}

	#readValueRecord() {
		this.#skipPadding();
		const tag = this.#byte();
		switch (tag) {
			case T.verifyObjectCount:
				this.#varint();
				return this.#readObject();
			case T.undefined:
				return undefined;
			case T.null:
				return null;
			case T.true:
				return true;
			case T.false:
				return false;
			case T.int32: {
				const z = this.#varint();
				return (z >>> 1) ^ -(z & 1);
			}
			case T.uint32:
				return this.#varint();
			case T.double:
				return this.#double();
			case T.bigint:
				return this.#readBigIntContents();
			case T.oneByte:
			case T.twoByte:
			case T.utf8:
				this.#pos--;
				return this.#readString();
			case T.objectRef: {
				const id = this.#varint();
				if (!this.#objects.has(id)) throw this.#fail();
				return this.#objects.get(id);
			}
			case T.beginObject: {
				const out = this.#remember({});
				const count = this.#readProperties(out, T.endObject);
				if (this.#varint() !== count) throw this.#fail();
				return out;
			}
			case T.beginDense:
				return this.#readDense();
			case T.beginSparse: {
				const length = this.#varint();
				const out = this.#remember(new Array(length));
				const count = this.#readProperties(out, T.endSparse);
				if (this.#varint() !== count || this.#varint() !== length) throw this.#fail();
				return out;
			}
			case T.date: {
				const time = this.#double();
				return this.#remember(new Date(time));
			}
			case T.trueObject:
				return this.#remember(Object(true));
			case T.falseObject:
				return this.#remember(Object(false));
			case T.numberObject:
				return this.#remember(Object(this.#double()));
			case T.bigintObject:
				return this.#remember(Object(this.#readBigIntContents()));
			case T.stringObject:
				return this.#remember(Object(this.#readString()));
			case T.regexp: {
				const source = this.#readString();
				const bits = this.#varint();
				let flags = "";
				for (const [bit, flag] of [
					[1, "g"],
					[2, "i"],
					[4, "m"],
					[8, "y"],
					[16, "u"],
					[32, "s"],
					[128, "d"],
					[256, "v"],
				]) {
					if (bits & bit) flags += flag;
				}
				return this.#remember(new RegExp(source, flags));
			}
			case T.beginMap: {
				const out = this.#remember(new Map());
				let count = 0;
				while (this.#peek() !== T.endMap) {
					const key = this.#readObject();
					out.set(key, this.#readObject());
					count += 2;
				}
				this.#pos++;
				if (this.#varint() !== count) throw this.#fail();
				return out;
			}
			case T.beginSet: {
				const out = this.#remember(new Set());
				let count = 0;
				while (this.#peek() !== T.endSet) {
					out.add(this.#readObject());
					count++;
				}
				this.#pos++;
				if (this.#varint() !== count) throw this.#fail();
				return out;
			}
			case T.arrayBuffer:
			case T.resizableArrayBuffer:
			case T.arrayBufferTransfer:
			case T.sharedArrayBuffer:
				return this.#readBuffer(tag);
			case T.error:
				return this.#readError();
			case T.hostObject: {
				const id = this.#nextId++;
				if (typeof this._readHostObject !== "function") throw this.#fail();
				const out = this._readHostObject();
				if (out === null || (typeof out !== "object" && typeof out !== "function")) {
					throw new TypeError("readHostObject must return an object");
				}
				this.#objects.set(id, out);
				return out;
			}
			default:
				throw this.#fail();
		}
	}

	#readProperties(target, endTag) {
		let count = 0;
		while (this.#peek() !== endTag) {
			const key = this.#readObject();
			if (typeof key !== "string" && typeof key !== "number") throw this.#fail();
			const value = this.#readObject();
			Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
			count++;
		}
		this.#pos++;
		return count;
	}

	#readDense() {
		const length = this.#varint();
		if (length > this.#bytes.length - this.#pos) throw this.#fail();
		const out = this.#remember(new Array(length));
		for (let i = 0; i < length; i++) {
			if (this.#peek() === T.theHole) {
				this.#pos++;
				continue;
			}
			out[i] = this.#readObject();
		}
		const count = this.#readProperties(out, T.endDense);
		if (this.#varint() !== count || this.#varint() !== length) throw this.#fail();
		return out;
	}

	#readBuffer(tag) {
		let buffer;
		if (tag === T.arrayBuffer) {
			const bytes = this.#take(this.#varint());
			buffer = new ArrayBuffer(bytes.length);
			new Uint8Array(buffer).set(bytes);
		} else if (tag === T.resizableArrayBuffer) {
			const length = this.#varint();
			const max = this.#varint();
			if (length > max) throw this.#fail();
			const bytes = this.#take(length);
			buffer = new ArrayBuffer(length, { maxByteLength: max });
			new Uint8Array(buffer).set(bytes);
		} else if (tag === T.arrayBufferTransfer) {
			buffer = this.#transfers.get(this.#varint());
			if (buffer === undefined) throw this.#fail();
		} else {
			// Node's deserializer cannot hand a SharedArrayBuffer back, so a 'u' record always fails.
			throw this.#fail();
		}
		return this.#remember(buffer);
	}

	#readView(buffer) {
		this.#pos++;
		const kind = this.#byte();
		const offset = this.#varint();
		const length = this.#varint();
		const flags = this.#version >= 14 ? this.#varint() : 0;
		const Ctor = VIEW_CTORS.get(kind);
		if (!Ctor || offset + length > buffer.byteLength) throw this.#fail();
		const size = kind === VIEW_TAGS.DataView ? 1 : Ctor.BYTES_PER_ELEMENT;
		if (offset % size || length % size) throw this.#fail();
		try {
			const view =
				flags & 1
					? new Ctor(buffer, offset)
					: kind === VIEW_TAGS.DataView
						? new Ctor(buffer, offset, length)
						: new Ctor(buffer, offset, length / size);
			return this.#remember(view);
		} catch {
			throw this.#fail();
		}
	}

	#readError() {
		let Ctor = Error;
		let message;
		let stack;
		let hasCause = false;
		let cause;
		for (;;) {
			const tag = this.#byte();
			if (ERROR_CTORS.has(tag)) {
				Ctor = ERROR_CTORS.get(tag);
			} else if (tag === 0x6d) {
				message = this.#readString();
			} else if (tag === 0x73) {
				stack = this.#readString();
			} else if (tag === 0x63) {
				// Reserve the id first: the cause may refer back to the error itself.
				hasCause = true;
				break;
			} else if (tag === 0x2e) {
				break;
			} else {
				throw this.#fail();
			}
		}
		const out = message === undefined ? new Ctor() : new Ctor(message);
		this.#remember(out);
		if (hasCause) {
			cause = this.#readObject();
			for (;;) {
				const tag = this.#byte();
				if (tag === 0x73) stack = this.#readString();
				else if (tag === 0x2e) break;
				else throw this.#fail();
			}
			Object.defineProperty(out, "cause", { value: cause, writable: true, enumerable: false, configurable: true });
		}
		Object.defineProperty(out, "stack", { value: stack, writable: true, enumerable: false, configurable: true });
		return out;
	}
}

/* -------------------------------------------------------------------- Defaults */

const DEFAULT_VIEW_TYPES = [
	"Int8Array",
	"Uint8Array",
	"Uint8ClampedArray",
	"Int16Array",
	"Uint16Array",
	"Int32Array",
	"Uint32Array",
	"Float32Array",
	"Float64Array",
	"DataView",
	null, // 10: Buffer
	"BigInt64Array",
	"BigUint64Array",
	"Float16Array",
];

function arrayBufferViewTypeToIndex(view) {
	const type = toStr.call(view).slice(8, -1);
	const index = DEFAULT_VIEW_TYPES.indexOf(type);
	return index === -1 || (type === "Float16Array" && typeof Float16Array !== "function") ? -1 : index;
}

function arrayBufferViewIndexToType(index) {
	if (index === 10) return Buffer;
	const name = DEFAULT_VIEW_TYPES[index];
	return name ? globalThis[name] : undefined;
}

class DefaultSerializer extends Serializer {
	constructor() {
		super();
		this._setTreatArrayBufferViewsAsHostObjects(true);
	}

	_writeHostObject(view) {
		// Buffers and views are written as bare bytes so a pooled Buffer does not drag its whole
		// backing ArrayBuffer into the output.
		let index = 10;
		if (view.constructor !== Buffer) {
			index = arrayBufferViewTypeToIndex(view);
			if (index === -1) throw new this._getDataCloneError(`Unserializable host object: ${inspect(view)}`);
		}
		this.writeUint32(index);
		this.writeUint32(view.byteLength);
		this.writeRawBytes(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
	}
}

class DefaultDeserializer extends Deserializer {
	_readHostObject() {
		const typeIndex = this.readUint32();
		const Ctor = arrayBufferViewIndexToType(typeIndex);
		const byteLength = this.readUint32();
		const byteOffset = this._readRawBytes(byteLength);
		const size = Ctor.BYTES_PER_ELEMENT || 1;
		const make = (arrayBuffer, offset) =>
			Ctor === Buffer ? Buffer.from(arrayBuffer, offset, byteLength) : new Ctor(arrayBuffer, offset, byteLength / size);
		const offset = this.buffer.byteOffset + byteOffset;
		if (offset % size === 0) return make(this.buffer.buffer, offset);
		// Copy to an aligned buffer first.
		const copy = Buffer.allocUnsafe(byteLength);
		copy.set(new Uint8Array(this.buffer.buffer, offset, byteLength));
		return make(copy.buffer, copy.byteOffset);
	}
}

function serialize(value) {
	const serializer = new DefaultSerializer();
	serializer.writeHeader();
	serializer.writeValue(value);
	return serializer.releaseBuffer();
}

function deserialize(buffer) {
	const deserializer = new DefaultDeserializer(buffer);
	deserializer.readHeader();
	return deserializer.readValue();
}

export { DefaultDeserializer, DefaultSerializer, Deserializer, Serializer, deserialize, serialize };
