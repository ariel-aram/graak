// node:v8 serialization: the bytes must be V8's wire format, byte for byte, and read back the same.
const v8 = require("v8");

const hex = (b) => Buffer.from(b.buffer ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : b).toString("hex");
const attempt = (fn) => {
	try {
		const r = fn();
		return r;
	} catch (e) {
		return `ERR ${e.constructor.name}${e.code ? ` ${e.code}` : ""}: ${e.message}`;
	}
};

// A canonical description of a deserialized value (cycles by index), independent of the inspector.
function show(v, seen = new Map()) {
	if (v === null || v === undefined) return String(v);
	if (typeof v === "number") return Object.is(v, -0) ? "-0" : String(v);
	if (typeof v === "bigint") return `${v}n`;
	if (typeof v === "string") return JSON.stringify(v);
	if (typeof v !== "object") return typeof v;
	if (seen.has(v)) return `<ref ${seen.get(v)}>`;
	seen.set(v, seen.size);
	const tag = Object.prototype.toString.call(v).slice(8, -1);
	const props = (o) =>
		Object.keys(o)
			.map((k) => `${k}:${show(o[k], seen)}`)
			.join(",");
	if (Array.isArray(v)) {
		const items = [];
		for (let i = 0; i < v.length; i++) items.push(i in v ? show(v[i], seen) : "<hole>");
		const extra = Object.keys(v).filter((k) => !/^\d+$/.test(k));
		return `[${items.join(",")}${extra.length ? `|${extra.map((k) => `${k}:${show(v[k], seen)}`).join(",")}` : ""}]`;
	}
	if (v instanceof Date) return `Date(${v.getTime()})`;
	if (v instanceof RegExp) return `RegExp(${v.source} ${v.flags})`;
	if (v instanceof Map) return `Map{${[...v].map(([k, x]) => `${show(k, seen)}=>${show(x, seen)}`).join(",")}}`;
	if (v instanceof Set) return `Set{${[...v].map((x) => show(x, seen)).join(",")}}`;
	if (v instanceof ArrayBuffer) return `ArrayBuffer(${hex(v)})`;
	if (ArrayBuffer.isView(v)) {
		return `${v.constructor === Buffer ? "Buffer" : tag}(${v.byteOffset % 8 === 0 ? "" : ""}${hex(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))})`;
	}
	if (v instanceof Error) {
		return `${v.constructor.name}(${JSON.stringify(v.name)},${JSON.stringify(v.message)},${"cause" in v ? show(v.cause, seen) : "-"},${typeof v.stack === "string" ? JSON.stringify(v.stack) : String(v.stack)})`;
	}
	if (tag === "Number" || tag === "String" || tag === "Boolean" || tag === "BigInt") return `${tag}Object(${show(v.valueOf(), seen)})`;
	return `{${props(v)}}`;
}

function bytesOf(v, Class = v8.Serializer) {
	const s = new Class();
	s.writeHeader();
	s.writeValue(v);
	return hex(s.releaseBuffer());
}
const fromHex = (h) => Buffer.from(h, "hex");
function rt(v) {
	return show(v8.deserialize(v8.serialize(v)));
}

const err = (E, message, extra) => {
	const e = new E(message, extra);
	Object.defineProperty(e, "stack", { value: `${E.name}: ${message}\n    at test`, configurable: true, writable: true });
	return e;
};
const circular = {};
circular.self = circular;
circular.list = [circular, { back: circular }];
const shared = { k: 1 };
const noStack = new Error("no stack");
Object.defineProperty(noStack, "stack", { value: undefined, configurable: true, writable: true });
const emptyMessage = new Error("");
emptyMessage.stack = "s";
const bare = new Error();
bare.stack = "s";
const numericMessage = new Error("x");
numericMessage.message = 5;
numericMessage.stack = "s";
const ab = new ArrayBuffer(8);
new Uint8Array(ab).set([1, 2, 3, 4, 5, 6, 7, 8]);
const getterObj = { get x() { return 5; }, y: 1, [Symbol("s")]: 2 };
Object.defineProperty(getterObj, "hidden", { value: 1, enumerable: false });
class Point {
	constructor() {
		this.x = 1;
		this.y = 2;
	}
	get sum() {
		return 3;
	}
}
const withProps = Object.assign([1, 2], { name: "n", 5: "five" });
const dense = Object.assign([1, 2, 3], { extra: true });
const holes = [1, , 3];
const sparse = [];
sparse[50] = "far";
class CustomError extends Error {}
const custom = new CustomError("custom");
custom.stack = "s";
const named = new Error("named");
named.name = "TypeError";
named.stack = "s";
const withCause = new Error("outer", { cause: { inner: [1, 2] } });
withCause.stack = "s";
const causeUndefined = new Error("a", { cause: undefined });
causeUndefined.stack = "s";

const CASES = {
	undefined: undefined,
	null: null,
	true: true,
	false: false,
	int: 5,
	negInt: -5,
	zero: 0,
	int32Max: 2147483647,
	int32Min: -2147483648,
	over: 2147483648,
	double: 1.5,
	negZero: -0,
	nan: NaN,
	inf: Infinity,
	pow32: 2 ** 32,
	maxSafe: Number.MAX_SAFE_INTEGER,
	empty: "",
	latin: "ab",
	latin1: "éÿ",
	euro: "a€",
	euroOnly: "€",
	astral: "\u{1f600}",
	lone: "\ud800",
	long: "x".repeat(200),
	longWide: "€".repeat(70000),
	bigSmall: 10n,
	bigZero: 0n,
	bigNeg: -(2n ** 70n),
	bigLarge: 2n ** 200n + 12345n,
	bigMax64: 2n ** 64n - 1n,
	bigOver64: 2n ** 64n,
	date: new Date(5),
	dateInvalid: new Date(NaN),
	regexp: /a\/b/gi,
	regexpFlags: new RegExp("/", "yusd"),
	regexpEmpty: new RegExp(""),
	regexpV: new RegExp("a", "v"),
	map: new Map([[1, 2], ["a", { b: 1 }]]),
	mapEmpty: new Map(),
	set: new Set([1, "a", 1.5]),
	dense: [1, 2, 3],
	denseMixed: [1, "a", null, undefined, true],
	denseDoubles: [1.5, 2],
	denseNaN: [NaN, 1],
	denseMixedDouble: [1.5, "a", 2],
	denseProps: dense,
	arrayProps: withProps,
	holes,
	sparse,
	emptyArray: [],
	object: { a: 1, b: "c", d: [1, { e: null }] },
	objectNumeric: { 1: "one", a: 2, "-1": 3, 2: "two" },
	objectBigIndex: { 4294967294: 1, 4294967295: 2, 2147483648: 3 },
	objectEmpty: {},
	objectGetters: getterObj,
	instance: new Point(),
	nullProto: Object.assign(Object.create(null), { z: 1 }),
	inherited: Object.create({ p: 1 }),
	circular,
	sharedRefs: [shared, shared, { s: shared }],
	numberObject: new Number(3),
	stringObject: new String("ab"),
	stringObjectWide: new String("€"),
	trueObject: new Boolean(true),
	falseObject: new Boolean(false),
	bigintObject: Object(3n),
	arrayBuffer: ab,
	arrayBufferEmpty: new ArrayBuffer(0),
	uint8: new Uint8Array([1, 2]),
	uint8Offset: new Uint8Array(ab, 2, 3),
	int8: new Int8Array([-1, 2]),
	clamped: new Uint8ClampedArray([1, 300]),
	int16: new Int16Array([1, -2]),
	uint16: new Uint16Array([1, 2]),
	int32: new Int32Array([1, -2]),
	uint32: new Uint32Array([1, 2]),
	float32: new Float32Array([1.5, 2.5]),
	float64: new Float64Array([1.5]),
	bigInt64: new BigInt64Array([1n, -1n]),
	bigUint64: new BigUint64Array([1n, 2n ** 64n - 1n]),
	dataView: new DataView(new ArrayBuffer(4), 1, 2),
	buffer: Buffer.from("ab"),
	bufferAlloc: Buffer.alloc(3, 7),
	sameBufferTwice: (() => {
		const u = new Uint8Array(ab, 0, 4);
		return [u, new Uint16Array(ab, 2, 1), ab];
	})(),
	errorPlain: err(Error, "m"),
	errorRange: err(RangeError, "r"),
	errorEval: err(EvalError, "e"),
	errorRef: err(ReferenceError, "f"),
	errorSyntax: err(SyntaxError, "s"),
	errorType: err(TypeError, "t"),
	errorUri: err(URIError, "u"),
	errorCustom: custom,
	errorNamed: named,
	errorNoStack: noStack,
	errorEmptyMessage: emptyMessage,
	errorBare: bare,
	errorNumericMessage: numericMessage,
	errorCause: withCause,
	errorCauseUndefined: causeUndefined,
	nested: { a: { b: [1, { c: new Map([[{}, new Set()]]) }] } },
	mixed: [new Date(1), /x/g, 1n, "s", new Map([[1, new Set([2])]])],
};

for (const [name, value] of Object.entries(CASES)) {
	const viaDefault = attempt(() => hex(v8.serialize(value)));
	const viaPlain = attempt(() => bytesOf(value));
	const shorten = (s) => (s.length > 120 ? `${s.slice(0, 60)}...${s.slice(-60)}(${s.length / 2})` : s);
	console.log(`${name} default ${shorten(viaDefault)}`);
	if (viaPlain !== viaDefault && !name.startsWith("buffer")) console.log(`${name} plain ${shorten(viaPlain)}`);
	console.log(`${name} back ${attempt(() => rt(value))}`);
}

// Values that cannot be cloned.
const revokedProxy = (() => {
	const r = Proxy.revocable({}, {});
	r.revoke();
	return r.proxy;
})();
for (const [name, value] of Object.entries({
	fn: () => 1,
	symbol: Symbol("a"),
	promise: Promise.resolve(),
	weakMap: new WeakMap(),
	weakSet: new WeakSet(),
	symbolObject: Object(Symbol()),
	nestedFn: { a: () => 1 },
	sab: new SharedArrayBuffer(2),
	proxyObject: new Proxy({}, {}),
	proxyArray: new Proxy([1, 2, 3], {}),
	proxyMap: new Proxy(new Map(), {}),
	proxySet: new Proxy(new Set(), {}),
	proxyDate: new Proxy(new Date(), {}),
	proxyRegExp: new Proxy(/x/, {}),
	// A proxy wrapping a callable is not covered here: V8 always throws with the real target's own
	// `Function.prototype.toString` output (peeked at through state JavaScript cannot see), which no
	// engine can reproduce for a proxy without that same peek, so its message is not comparable.
	proxyOfProxy: new Proxy(new Proxy({}, {}), {}),
	proxyRevoked: revokedProxy,
	proxyNestedInObject: { a: new Proxy({}, {}) },
	proxyNestedInArray: [1, new Proxy({}, {})],
	proxyNestedInMapKey: new Map([[new Proxy({}, {}), 1]]),
	proxyNestedInMapValue: new Map([[1, new Proxy({}, {})]]),
	proxyNestedInSet: new Set([new Proxy({}, {})]),
})) {
	console.log(`${name} ${attempt(() => hex(v8.serialize(value)))}`);
}

// Padding of two-byte strings depends on the offset they start at.
console.log("pad", bytesOf(["€"]), bytesOf(["a", "€"]), bytesOf(["ab", "€"]), bytesOf({ a: "€" }));

// Round trips of values V8 writes and reads.
for (const v of [circular, sharedRefs()]) console.log("rt", rt(v));
function sharedRefs() {
	const o = { n: 1 };
	return { a: o, b: [o, new Map([[o, o]])] };
}
{
	const back = v8.deserialize(v8.serialize(circular));
	console.log("circular identity", back.self === back, back.list[0] === back, back.list[1].back === back);
	const twice = v8.deserialize(v8.serialize([shared, shared]));
	console.log("shared identity", twice[0] === twice[1]);
	const bufs = v8.deserialize(v8.serialize([Buffer.from("hi"), new Uint16Array([1, 2]), new DataView(new ArrayBuffer(3))]));
	console.log("view types", Buffer.isBuffer(bufs[0]), bufs[1].constructor.name, bufs[2].constructor.name);
	const nativeBack = (() => {
		const s = new v8.Serializer();
		s.writeHeader();
		s.writeValue(CASES.sameBufferTwice);
		const r = new v8.Deserializer(s.releaseBuffer());
		r.readHeader();
		const out = r.readValue();
		return [out[0].buffer === out[1].buffer, out[2] === out[0].buffer, out[1].byteOffset, out[1].length];
	})();
	console.log("native views", nativeBack);
}

// Plain Serializer subclass with views written natively and a custom host object.
class Host extends v8.Serializer {
	constructor() {
		super();
		this._setTreatArrayBufferViewsAsHostObjects(true);
	}
	_writeHostObject(o) {
		this.writeUint32(o.length);
		this.writeDouble(1.5);
		this.writeUint64(1, 2);
		this.writeRawBytes(Buffer.from("hi"));
	}
}
class HostReader extends v8.Deserializer {
	_readHostObject() {
		const length = this.readUint32();
		const d = this.readDouble();
		const u = this.readUint64();
		const raw = this.readRawBytes(2);
		return { length, d, u, raw: raw.toString(), rawIsBuffer: Buffer.isBuffer(raw) };
	}
}
{
	const s = new Host();
	s.writeHeader();
	s.writeValue([new Uint8Array(3), { k: new Uint8Array(1) }]);
	const out = s.releaseBuffer();
	console.log("host", hex(out));
	const r = new HostReader(out);
	console.log(r.readHeader(), r.getWireFormatVersion(), show(r.readValue()));
	const missing = new v8.Serializer();
	missing._setTreatArrayBufferViewsAsHostObjects(true);
	console.log("host missing", attempt(() => missing.writeValue(new Uint8Array(1))));
	const noReader = new v8.Deserializer(out);
	noReader.readHeader();
	console.log("reader missing", attempt(() => noReader.readValue()));
	class BadReader extends v8.Deserializer {
		_readHostObject() {
			return 5;
		}
	}
	const bad = new BadReader(out);
	bad.readHeader();
	console.log("reader non-object", attempt(() => bad.readValue()));
}

// Raw writers and readers.
{
	const s = new v8.Serializer();
	for (const n of [0, 1, 127, 128, 300, 16384, 2 ** 31, 2 ** 32 - 1, -1, 1.5, "a", 2 ** 32, NaN]) s.writeUint32(n);
	for (const [hi, lo] of [[0, 0], [0, 1], [1, 2], [0x12345, 0x87654321], [4294967295, 4294967295], [2 ** 32, 1], [-1, -1]]) s.writeUint64(hi, lo);
	for (const d of [0, 1.5, -0, NaN, Infinity, 5e-324]) s.writeDouble(d);
	s.writeRawBytes(new Uint8Array([9, 8]));
	s.writeRawBytes(new Uint16Array([1, 2]));
	s.writeRawBytes(new DataView(new ArrayBuffer(2)));
	console.log("writeArgs", attempt(() => s.writeRawBytes(1)), attempt(() => s.writeRawBytes(new ArrayBuffer(1))), attempt(() => s.writeRawBytes()));
	const out = s.releaseBuffer();
	console.log("raw", hex(out), Buffer.isBuffer(out), hex(s.releaseBuffer()));
	const r = new v8.Deserializer(out);
	const got = [];
	for (let i = 0; i < 13; i++) got.push(r.readUint32());
	for (let i = 0; i < 7; i++) got.push(r.readUint64().join("/"));
	for (let i = 0; i < 6; i++) got.push(Object.is(r.readDouble(), -0) ? "-0" : r.readDouble === undefined ? "" : String(0));
	console.log("read", got.join(" "));
}
{
	const s = new v8.Serializer();
	s.writeDouble(1.5);
	s.writeDouble(-0);
	s.writeDouble(NaN);
	const r = new v8.Deserializer(s.releaseBuffer());
	console.log("doubles", r.readDouble(), Object.is(r.readDouble(), -0), r.readDouble());
	const raw = new v8.Deserializer(Buffer.from([1, 2, 3, 4, 5]));
	console.log("rawbytes", raw._readRawBytes(2), hex(raw.readRawBytes(2)), attempt(() => raw._readRawBytes(9)), attempt(() => raw.readDouble()), attempt(() => raw.readRawBytes(3)));
	console.log("readFailures", attempt(() => new v8.Deserializer(Buffer.from([0x80])).readUint32()), attempt(() => new v8.Deserializer(Buffer.alloc(0)).readUint64()));
	const twoHeaders = new v8.Serializer();
	twoHeaders.writeHeader();
	twoHeaders.writeHeader();
	console.log("twoHeaders", hex(twoHeaders.releaseBuffer()));
}

// Headers and malformed input.
for (const [name, bytes] of Object.entries({
	ok15: "ff0f490a",
	ok14: "ff0e490a",
	ok13: "ff0d490a",
	tooNew: "ff10490a",
	noHeader: "490a",
	headerOnly: "ff0f",
	empty: "",
	trailing: "ff0f490a49",
	padded: "ff0f0000490a",
	verifyCount: "ff0f3f01490a",
	uint32: "ff0f5505",
	utf8: "ff0f5302c3a9",
	twoByte: "ff0f630200d8",
	oddTwoByte: "ff0f630161",
	unknownTag: "ff0f2a",
	truncatedString: "ff0f220561",
	badRef: "ff0f5e05",
	truncatedDouble: "ff0f4e0000",
	badBigInt: "ff0f5a0801",
	wrongCount: "ff0f6f22016149027b05",
	badKey: "ff0f6f5f49027b01",
	denseHole: "ff0f4103490224492c2400" + "03",
	denseHoleOk: "ff0f41032d4902 2d 24 0003".replace(/ /g, ""),
	sparseOk: "ff0f6103490249024001 03".replace(/ /g, ""),
	hugeArray: "ff0f41ffffffff0f",
	badMapCount: "ff0f3b490249043a03",
	setOk: "ff0f27490249043c",
	protoKey: "ff0f6f22095f5f70726f746f5f5f49027b01",
	viewNoBuffer: "ff0f56420001" + "00",
	viewBadRange: "ff0f4201005642000900",
	viewMisaligned: "ff0f420400000000565701 02 00".replace(/ /g, ""),
	badRegExp: "ff0f5222012800",
	errorBadTag: "ff0f7278",
	errorNoStack: "ff0f726d2201782e",
	errorTagged: "ff0f72546d2201782e",
	errorCauseFirst: "ff0f726d2201786349022e",
	transferMissing: "ff0f7400",
	sabMissing: "ff0f7500",
	rabBuffer: "ff0f7e02080100" + "00",
	hostDefault: "ff0f5c0102" + "0102",
})) {
	const result = attempt(() => show(v8.deserialize(fromHex(bytes))));
	// The text of an engine's own SyntaxError differs, its class does not.
	console.log(name, name === "badRegExp" ? result.split(":")[0] : result);
}
console.log("deserializeArgs", attempt(() => v8.deserialize("x")), attempt(() => v8.deserialize()), attempt(() => v8.deserialize(new ArrayBuffer(3))), attempt(() => new v8.Deserializer(1)));
console.log("newSerializer", Object.keys(new v8.Serializer()).length, Object.keys(new v8.Deserializer(Buffer.alloc(1))).join());
console.log("version before header", new v8.Deserializer(fromHex("ff0f")).getWireFormatVersion());
{
	const d = new v8.Deserializer(fromHex("ff0e5f"));
	console.log("header", d.readHeader(), d.getWireFormatVersion(), d.readValue());
	const shifted = Buffer.from("00ff0f490a", "hex").subarray(1);
	console.log("subarray input", show(v8.deserialize(shifted)));
	const u8 = new Uint8Array(fromHex("ff0f490a"));
	console.log("uint8array input", show(v8.deserialize(u8)));
}

// transferArrayBuffer on both sides.
{
	const transfer = new ArrayBuffer(3);
	const s = new v8.Serializer();
	s.transferArrayBuffer(5, transfer);
	s.writeHeader();
	s.writeValue([transfer, transfer, new Uint8Array(transfer)]);
	const out = s.releaseBuffer();
	console.log("transfer bytes", hex(out), transfer.byteLength);
	const target = new ArrayBuffer(3);
	const d = new v8.Deserializer(out);
	d.transferArrayBuffer(5, target);
	d.readHeader();
	const back = d.readValue();
	console.log("transfer back", back[0] === target, back[1] === target, back[2].buffer === target, back.length);
	console.log("transfer args", attempt(() => s.transferArrayBuffer(1, {})), attempt(() => s.transferArrayBuffer(1, new SharedArrayBuffer(1))), attempt(() => d.transferArrayBuffer(1, {})), attempt(() => d.transferArrayBuffer(1, new ArrayBuffer(1))), attempt(() => s.transferArrayBuffer("a", new ArrayBuffer(1))));
	const missing = new v8.Deserializer(out);
	missing.readHeader();
	console.log("transfer missing", attempt(() => missing.readValue()));

	class Sab extends v8.Serializer {
		_getSharedArrayBufferId() {
			return 7;
		}
	}
	const sabSer = new Sab();
	sabSer.writeHeader();
	const sab = new SharedArrayBuffer(4);
	sabSer.writeValue([sab, sab]);
	const sabBytes = sabSer.releaseBuffer();
	console.log("sab", hex(sabBytes));
	const sabDe = new v8.Deserializer(sabBytes);
	sabDe.transferArrayBuffer(7, new SharedArrayBuffer(4));
	sabDe.readHeader();
	console.log("sab back", attempt(() => sabDe.readValue()));
}

// Custom DataCloneError and subclass hooks.
{
	class Loud extends v8.Serializer {
		get _getDataCloneError() {
			return class DataCloneError extends Error {};
		}
	}
	const l = new Loud();
	l.writeHeader();
	console.log("customError", attempt(() => l.writeValue(() => 1)).split(":")[0], (() => {
		try {
			l.writeValue(Symbol("z"));
		} catch (e) {
			return e.constructor.name;
		}
	})());
	console.log("defaultErrorClass", v8.Serializer.prototype._getDataCloneError === Error);
}

// Resizable ArrayBuffers.
{
	const rab = new ArrayBuffer(2, { maxByteLength: 8 });
	new Uint8Array(rab).set([1, 2]);
	const out = bytesOf(rab);
	console.log("rab", out);
	const rabFull = new ArrayBuffer(2, { maxByteLength: 2 });
	console.log("rab tracking", bytesOf(new Uint8Array(rab)), bytesOf(new Uint8Array(rab, 1)), bytesOf(new Uint8Array(rab, 1, 1)), bytesOf(new Uint8Array(rabFull)), bytesOf(new Uint8Array(rabFull, 0, 2)), hex(rab));
	const back = v8.deserialize(v8.serialize(rab));
	console.log("rab back", back.resizable, back.maxByteLength, back.byteLength, hex(back));
	console.log("rab view", bytesOf(new Uint8Array(rab, 0, 2)));
	{
		const ser = new v8.Serializer();
		ser.writeHeader();
		ser.writeValue([new Uint8Array(rab), new Uint8Array(rab, 1, 1)]);
		const de = new v8.Deserializer(ser.releaseBuffer());
		de.readHeader();
		const [tracking, fixed] = de.readValue();
		tracking.buffer.resize(5);
		console.log("rab views back", tracking.length, fixed.length, tracking.buffer === fixed.buffer);
	}
}

// A cause that points back at its error keeps the reference.
{
	const outer = new Error("loop");
	outer.cause = { holder: [outer] };
	Object.defineProperty(outer, "stack", { value: "s", configurable: true, writable: true });
	const back = v8.deserialize(v8.serialize(outer));
	console.log("error loop", back.cause.holder[0] === back, back.message);
}

// Detached buffers cannot be cloned.
{
	const d = new ArrayBuffer(2);
	if (typeof d.transfer === "function") {
		d.transfer();
		console.log("detached", attempt(() => v8.serialize(d)), attempt(() => bytesOf(d)));
	}
}

// The module surface.
console.log(
	"surface",
	["Serializer", "Deserializer", "DefaultSerializer", "DefaultDeserializer", "serialize", "deserialize"].map((k) => `${k}:${typeof v8[k]}`).join(" "),
	Buffer.isBuffer(v8.serialize(1)),
	Object.getPrototypeOf(v8.DefaultSerializer) === v8.Serializer,
	Object.getPrototypeOf(v8.DefaultDeserializer) === v8.Deserializer,
);
console.log(
	"methods",
	Object.getOwnPropertyNames(v8.Serializer.prototype).sort().join(),
	Object.getOwnPropertyNames(v8.Deserializer.prototype).sort().join(),
);
