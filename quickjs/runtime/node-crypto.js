/*
 * Node's `crypto`, over the native host's mbedTLS: hashing and HMAC (md5, sha1, sha224/256/384/512, ripemd160),
 * secure randomness, PBKDF2, HKDF, scrypt, AES (ECB, CBC, CTR, GCM) and ChaCha20-Poly1305, RSA and ECDSA signing and
 * verification from PEM keys, and the parts of Web Crypto (`crypto.subtle`, `globalThis.crypto`) programs use most.
 *
 * Streaming ciphers buffer what they are given and transform it when final() is called: the concatenation of
 * update() and final() outputs is exactly what Node produces, but an update() call alone returns nothing yet.
 * The asymmetric half (key objects, key generation, RSA-PSS/OAEP, ECDH, Diffie-Hellman, X509Certificate) is in
 * node-crypto2.js. What is not provided says so when used.
 */

import { createAsymmetric } from "./node-crypto2.js";
import { createArgon2, received } from "./node-argon2.js";
import { Blake2Hmac, blake2Hkdf, blake2Name, blake2Pbkdf2, newBlake2 } from "./node-blake2.js";
import { createSubtle } from "./node-subtle.js";
import { Ocb } from "./node-ocb.js";
import { keccakKmacDigest } from "./node-keccak.js";

const HASHES = ["md5", "sha1", "sha224", "sha256", "sha384", "sha512", "ripemd160", "sha3-224", "sha3-256", "sha3-384", "sha3-512", "shake128", "shake256", "blake2b512", "blake2s256", "keccak-kmac-128", "keccak-kmac-256"];
const HASH_SIZES = { md5: 16, sha1: 20, sha224: 28, sha256: 32, sha384: 48, sha512: 64, ripemd160: 20, "sha3-224": 28, "sha3-256": 32, "sha3-384": 48, "sha3-512": 64, blake2b512: 64, blake2s256: 32 };

const ALIASES = { "keccak-kmac128": "keccak-kmac-128", "keccak-kmac256": "keccak-kmac-256", rmd160: "ripemd160", "rsa-sha3-256": "sha3-256", "rsa-sha3-384": "sha3-384", "rsa-sha3-512": "sha3-512", "rsa-sha3-224": "sha3-224", "rsa-sha256": "sha256", "rsa-sha1": "sha1", "rsa-sha384": "sha384", "rsa-sha512": "sha512", "rsa-md5": "md5", sha256withrsaencryption: "sha256", sha1withrsaencryption: "sha1", sha512withrsaencryption: "sha512", "sha-1": "sha1", "sha-256": "sha256", "sha-384": "sha384", "sha-512": "sha512", sha2: "sha256" };

function createCrypto({ native, Buffer, stream, toBytes: plainBytes, StringDecoder }) {
	// The shared helper knows hex and UTF-8 only; `update(data, "base64")` and the rest go through Buffer.
	const toBytes = (value, encoding) =>
		typeof value === "string" && encoding && encoding !== "utf8" && encoding !== "utf-8" && encoding !== "buffer" && encoding !== "hex" ? new Uint8Array(Buffer.from(value, encoding)) : plainBytes(value, encoding);
	const buf = (bytes) => Buffer.from(bytes);
	const bytesOf = (value, encoding) => {
		if (value && typeof value === "object" && value._keyData) return value._keyData;
		return toBytes(value, encoding);
	};
	const out = (bytes, encoding) => {
		const b = buf(bytes);
		return encoding && encoding !== "buffer" ? b.toString(encoding) : b;
	};
	const concat = (chunks) => {
		let total = 0;
		for (const chunk of chunks) total += chunk.length;
		const joined = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			joined.set(chunk, offset);
			offset += chunk.length;
		}
		return joined;
	};
	const hashName = (algorithm) => {
		const key = String(algorithm).toLowerCase();
		const name = blake2Name(key) ?? ALIASES[key] ?? key;
		if (!HASHES.includes(name)) {
			throw new Error("Digest method not supported");
		}
		return name;
	};
	/* Node's "Received ..." wording for a wrongly typed argument. */
	const receivedType = (name, expected, value) => {
		let shown;
		if (value === undefined || value === null) shown = String(value);
		else if (typeof value === "function") shown = `function ${value.name}`;
		else if (typeof value === "object") shown = value.constructor?.name ? `an instance of ${value.constructor.name}` : "[Object: null prototype]";
		else {
			let text = String(value);
			if (typeof value === "string") text = `'${text.length > 28 ? `${text.slice(0, 25)}...` : text}'`;
			shown = `type ${typeof value} (${text})`;
		}
		return Object.assign(new TypeError(`The "${name}" argument must be ${expected}. Received ${shown}`), { code: "ERR_INVALID_ARG_TYPE" });
	};
	const invalidArg = (name, expected, value) =>
		Object.assign(new TypeError(`The "${name}" argument must be ${expected}. Received ${received(value)}`), { code: "ERR_INVALID_ARG_TYPE" });

	/* ---------------------------------------------------------------- hash and hmac */

	class Hash extends stream.Transform {
		constructor(algorithm, options) {
			super(options);
			this.algorithm = hashName(algorithm);
			this._outputLength = options?.outputLength;
			if (this._outputLength !== undefined && typeof this._outputLength !== "number") {
				throw Object.assign(new TypeError(`The "options.outputLength" property must be of type number. Received ${received(this._outputLength)}`), { code: "ERR_INVALID_ARG_TYPE" });
			}
			if (this._outputLength !== undefined && !Number.isInteger(this._outputLength)) {
				throw Object.assign(new RangeError(`The value of "options.outputLength" is out of range. It must be an integer. Received ${this._outputLength}`), { code: "ERR_OUT_OF_RANGE" });
			}
			if (this._outputLength !== undefined && !this.algorithm.startsWith("shake") && !this.algorithm.startsWith("keccak-kmac") && this._outputLength !== HASH_SIZES[this.algorithm]) {
				throw Object.assign(new Error("error:030000B2:digital envelope routines::not XOF or invalid length"), { code: "ERR_OSSL_EVP_NOT_XOF_OR_INVALID_LENGTH" });
			}
			this._chunks = [];
			this._blake2 = blake2Name(this.algorithm) ? newBlake2(this.algorithm) : null;
			this._done = false;
		}
		update(data, encoding) {
			if (this._done) throw Object.assign(new Error("Digest already called"), { code: "ERR_CRYPTO_HASH_FINALIZED" });
			if (typeof data !== "string" && !ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer)) {
				throw invalidArg("data", "of type string or an instance of Buffer, TypedArray, or DataView", data);
			}
			if (this._blake2) this._blake2.update(toBytes(data, encoding));
			else this._chunks.push(toBytes(data, encoding));
			return this;
		}
		digest(encoding) {
			if (this._done) throw Object.assign(new Error("Digest already called"), { code: "ERR_CRYPTO_HASH_FINALIZED" });
			this._done = true;
			if (this._blake2) return out(this._blake2.digest(), encoding);
			if (this.algorithm.startsWith("shake")) {
				const bits = this.algorithm === "shake128" ? 128 : 256;
				return out(native.keccak(bits, concat(this._chunks), this._outputLength ?? bits / 8), encoding);
			}
			if (this.algorithm.startsWith("keccak-kmac")) {
				const strength = this.algorithm.endsWith("128") ? 128 : 256;
				return out(keccakKmacDigest(strength, concat(this._chunks), this._outputLength ?? strength / 4), encoding);
			}
			return out(native.hash(this.algorithm, concat(this._chunks)), encoding);
		}
		copy(options) {
			if (this._done) throw Object.assign(new Error("Digest already called"), { code: "ERR_CRYPTO_HASH_FINALIZED" });
			const clone = new Hash(this.algorithm, options);
			clone._chunks = [...this._chunks];
			if (this._blake2) clone._blake2 = this._blake2.copy();
			return clone;
		}
		_transform(chunk, encoding, callback) {
			this.update(chunk, encoding === "buffer" ? undefined : encoding);
			callback();
		}
		_flush(callback) {
			this.push(this.digest());
			callback();
		}
	}

	class Hmac extends stream.Transform {
		constructor(algorithm, key, options) {
			super(options);
			this.algorithm = hashName(algorithm);
			this._key = bytesOf(key);
			this._chunks = [];
			this._blake2 = blake2Name(this.algorithm) ? new Blake2Hmac(this.algorithm, this._key) : null;
			this._done = false;
		}
		update(data, encoding) {
			if (this._done) throw Object.assign(new Error("Digest already called"), { code: "ERR_CRYPTO_HASH_FINALIZED" });
			if (this._blake2) this._blake2.update(toBytes(data, encoding));
			else this._chunks.push(toBytes(data, encoding));
			return this;
		}
		digest(encoding) {
			this._done = true;
			if (this._blake2) return out(this._blake2.digest(), encoding);
			return out(native.hmac(this.algorithm, this._key, concat(this._chunks)), encoding);
		}
		_transform(chunk, encoding, callback) {
			this.update(chunk, encoding === "buffer" ? undefined : encoding);
			callback();
		}
		_flush(callback) {
			this.push(this.digest());
			callback();
		}
	}

	/* --------------------------------------------------------------------- random */

	const randomFillSync = (target, offset = 0, size) => {
		const view = target instanceof ArrayBuffer ? new Uint8Array(target) : new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
		const length = size ?? view.length - offset;
		if (offset < 0 || offset + length > view.length) {
			throw Object.assign(new RangeError('The value of "size + offset" is out of range.'), { code: "ERR_OUT_OF_RANGE" });
		}
		// The host draws at most a bounded amount per call.
		for (let done = 0; done < length; ) {
			const n = Math.min(length - done, 65536);
			view.set(native.randomBytes(n), offset + done);
			done += n;
		}
		return target;
	};

	function randomInt(min, max, callback) {
		if (typeof max === "function" || max === undefined) {
			callback = max;
			max = min;
			min = 0;
		}
		if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) throw invalidArg("min", "a safe integer", min);
		const range = max - min;
		if (range <= 0 || range > 2 ** 48 - 1) {
			throw Object.assign(new RangeError('The value of "max" is out of range. It must be greater than the value of "min"'), { code: "ERR_OUT_OF_RANGE" });
		}
		// Rejection sampling: a plain modulus of random bytes would favour the low values.
		const limit = 2 ** 48 - (2 ** 48 % range);
		let value;
		do {
			value = 0;
			for (const byte of native.randomBytes(6)) value = value * 256 + byte;
		} while (value >= limit);
		const result = min + (value % range);
		if (callback) {
			queueMicrotask(() => callback(null, result));
			return undefined;
		}
		return result;
	}

	const randomUUID = () => {
		const bytes = native.randomBytes(16);
		bytes[6] = (bytes[6] & 0x0f) | 0x40;
		bytes[8] = (bytes[8] & 0x3f) | 0x80;
		const hex = buf(bytes).toString("hex");
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	};

	const getRandomValues = (view) => {
		if (!ArrayBuffer.isView(view) || view instanceof Float32Array || view instanceof Float64Array || view instanceof DataView) {
			throw globalThis.DOMException ? new globalThis.DOMException("The data argument must be an integer-type TypedArray", "TypeMismatchError") : Object.assign(new TypeError("The data argument must be an integer-type TypedArray"), { name: "TypeMismatchError", code: 17 });
		}
		if (view.byteLength > 65536) {
			throw globalThis.DOMException ? new globalThis.DOMException("The ArrayBufferView's byte length exceeds the number of bytes of entropy available via this API (65536)", "QuotaExceededError") : Object.assign(new Error("The ArrayBufferView's byte length exceeds the number of bytes of entropy available via this API (65536)"), { name: "QuotaExceededError", code: 22 });
		}
		return randomFillSync(view);
	};

	/* ------------------------------------------------------------- key derivation */

	const digestOf = (digest) => {
		if (typeof digest !== "string") throw invalidArg("digest", "of type string", digest);
		return hashName(digest);
	};

	const pbkdf2Sync = (password, salt, iterations, keylen, digest) => {
		if (!Number.isInteger(iterations) || iterations < 1) throw Object.assign(new RangeError('The value of "iterations" is out of range.'), { code: "ERR_OUT_OF_RANGE" });
		const name = digestOf(digest);
		if (blake2Name(name)) return buf(blake2Pbkdf2(name, bytesOf(password), bytesOf(salt), iterations, keylen));
		return buf(native.pbkdf2(name, bytesOf(password), bytesOf(salt), iterations, keylen));
	};
	const pbkdf2 = (password, salt, iterations, keylen, digest, callback) => {
		let result;
		let error = null;
		try {
			result = pbkdf2Sync(password, salt, iterations, keylen, digest);
		} catch (err) {
			error = err;
		}
		queueMicrotask(() => (error ? callback(error) : callback(null, result)));
	};

	const hkdfSync = (digest, ikm, salt, info, keylen) => {
		const name = digestOf(digest);
		const derived = blake2Name(name) ? blake2Hkdf(name, bytesOf(ikm), bytesOf(salt), bytesOf(info), keylen) : native.hkdf(name, bytesOf(ikm), bytesOf(salt), bytesOf(info), keylen);
		return derived.buffer.slice(derived.byteOffset, derived.byteOffset + derived.byteLength);
	};
	const hkdf = (digest, ikm, salt, info, keylen, callback) => {
		let result;
		let error = null;
		try {
			result = hkdfSync(digest, ikm, salt, info, keylen);
		} catch (err) {
			error = err;
		}
		queueMicrotask(() => (error ? callback(error) : callback(null, result)));
	};

	/* scrypt (RFC 7914) over the host's PBKDF2. */
	function scryptSync(password, salt, keylen, options = {}) {
		const N = options.N ?? options.cost ?? 16384;
		const r = options.r ?? options.blockSize ?? 8;
		const p = options.p ?? options.parallelization ?? 1;
		if (N < 2 || (N & (N - 1)) !== 0) throw Object.assign(new RangeError("Invalid scrypt param"), { code: "ERR_CRYPTO_INVALID_SCRYPT_PARAMS" });
		const maxmem = options.maxmem ?? 32 * 1024 * 1024;
		if (128 * N * r > maxmem) throw Object.assign(new RangeError("Invalid scrypt params: memory limit exceeded"), { code: "ERR_CRYPTO_INVALID_SCRYPT_PARAMS" });
		const B = new Uint8Array(native.pbkdf2("sha256", bytesOf(password), bytesOf(salt), 1, p * 128 * r));
		const rot = (a, b) => (a << b) | (a >>> (32 - b));
		const salsa = (block) => {
			const x = new Uint32Array(16);
			x.set(block);
			for (let i = 0; i < 4; i++) {
				x[4] ^= rot(x[0] + x[12], 7); x[8] ^= rot(x[4] + x[0], 9); x[12] ^= rot(x[8] + x[4], 13); x[0] ^= rot(x[12] + x[8], 18);
				x[9] ^= rot(x[5] + x[1], 7); x[13] ^= rot(x[9] + x[5], 9); x[1] ^= rot(x[13] + x[9], 13); x[5] ^= rot(x[1] + x[13], 18);
				x[14] ^= rot(x[10] + x[6], 7); x[2] ^= rot(x[14] + x[10], 9); x[6] ^= rot(x[2] + x[14], 13); x[10] ^= rot(x[6] + x[2], 18);
				x[3] ^= rot(x[15] + x[11], 7); x[7] ^= rot(x[3] + x[15], 9); x[11] ^= rot(x[7] + x[3], 13); x[15] ^= rot(x[11] + x[7], 18);
				x[1] ^= rot(x[0] + x[3], 7); x[2] ^= rot(x[1] + x[0], 9); x[3] ^= rot(x[2] + x[1], 13); x[0] ^= rot(x[3] + x[2], 18);
				x[6] ^= rot(x[5] + x[4], 7); x[7] ^= rot(x[6] + x[5], 9); x[4] ^= rot(x[7] + x[6], 13); x[5] ^= rot(x[4] + x[7], 18);
				x[11] ^= rot(x[10] + x[9], 7); x[8] ^= rot(x[11] + x[10], 9); x[9] ^= rot(x[8] + x[11], 13); x[10] ^= rot(x[9] + x[8], 18);
				x[12] ^= rot(x[15] + x[14], 7); x[13] ^= rot(x[12] + x[15], 9); x[14] ^= rot(x[13] + x[12], 13); x[15] ^= rot(x[14] + x[13], 18);
			}
			for (let i = 0; i < 16; i++) block[i] = (block[i] + x[i]) | 0;
		};
		const blockMix = (input, output) => {
			const words = 16 * r * 2;
			let X = input.slice(words - 16, words);
			for (let i = 0; i < 2 * r; i++) {
				for (let j = 0; j < 16; j++) X[j] ^= input[i * 16 + j];
				salsa(X);
				output.set(X, ((i & 1) === 0 ? i / 2 : r + (i - 1) / 2) * 16);
			}
		};
		const view = new Uint32Array(B.buffer);
		const words = 32 * r;
		const V = new Uint32Array(words * N);
		const X = new Uint32Array(words);
		const Y = new Uint32Array(words);
		for (let i = 0; i < p; i++) {
			X.set(view.subarray(i * words, (i + 1) * words));
			for (let j = 0; j < N; j++) {
				V.set(X, j * words);
				blockMix(X, Y);
				X.set(Y);
			}
			for (let j = 0; j < N; j++) {
				const k = X[(2 * r - 1) * 16] & (N - 1);
				for (let w = 0; w < words; w++) X[w] ^= V[k * words + w];
				blockMix(X, Y);
				X.set(Y);
			}
			view.set(X, i * words);
		}
		return buf(native.pbkdf2("sha256", bytesOf(password), B, 1, keylen));
	}
	const scrypt = (password, salt, keylen, options, callback) => {
		if (typeof options === "function") {
			callback = options;
			options = {};
		}
		let result;
		let error = null;
		try {
			result = scryptSync(password, salt, keylen, options);
		} catch (err) {
			error = err;
		}
		queueMicrotask(() => (error ? callback(error) : callback(null, result)));
	};

	/* ------------------------------------------------------------------- ciphers */

	/* Node's cipher names -> what the host's library calls them, with the shape of each: key bytes, IV bytes, block size, mode. */
	const CIPHER_TABLE = new Map();
	const addCipher = (name, mbed, keyLength, ivLength, blockSize, mode, extra = {}) => CIPHER_TABLE.set(name, { name, mbed, keyLength, ivLength, blockSize, mode, ...extra });
	for (const bits of [128, 192, 256]) {
		const key = bits / 8;
		addCipher(`aes-${bits}-cbc`, `AES-${bits}-CBC`, key, 16, 16, "cbc");
		addCipher(`aes-${bits}-ecb`, `AES-${bits}-ECB`, key, 0, 16, "ecb");
		addCipher(`aes-${bits}-ctr`, `AES-${bits}-CTR`, key, 16, 1, "ctr");
		addCipher(`aes-${bits}-cfb`, `AES-${bits}-CFB128`, key, 16, 1, "cfb");
		addCipher(`aes-${bits}-ofb`, `AES-${bits}-OFB`, key, 16, 1, "ofb");
		addCipher(`aes-${bits}-gcm`, `AES-${bits}-GCM`, key, 12, 1, "gcm", { aead: true });
		addCipher(`aes-${bits}-ccm`, `AES-${bits}-CCM`, key, 12, 1, "ccm", { aead: true, buffered: true });
		addCipher(`aes-${bits}-ocb`, `AES-${bits}-ECB`, key, 12, 16, "ocb", { aead: true, ocb: true });
		addCipher(`id-aes${bits}-wrap`, null, key, 8, 8, "wrap", { wrap: "kw" });
		addCipher(`id-aes${bits}-wrap-pad`, null, key, 4, 8, "wrap", { wrap: "kwp" });
	}
	addCipher("chacha20-poly1305", "CHACHA20-POLY1305", 32, 12, 1, "stream", { aead: true, buffered: true });
	addCipher("des-ede3-cbc", "DES-EDE3-CBC", 24, 8, 8, "cbc");
	addCipher("des-ede3", "DES-EDE3-ECB", 24, 0, 8, "ecb");
	const CIPHER_ALIASES = { aes128: "aes-128-cbc", aes192: "aes-192-cbc", aes256: "aes-256-cbc", des3: "des-ede3-cbc", "des-ede3-ecb": "des-ede3", "aes-128-wrap": "id-aes128-wrap", "aes128-wrap": "id-aes128-wrap", "aes192-wrap": "id-aes192-wrap", "aes256-wrap": "id-aes256-wrap", "id-aes128-wrap-pad": "id-aes128-wrap-pad" };
	const CIPHER_NAMES = () => [...CIPHER_TABLE.keys()];
	const unknownCipher = () => Object.assign(new Error("Unknown cipher"), { code: "ERR_CRYPTO_UNKNOWN_CIPHER" });
	const cipherSpec = (algorithm, key, iv, options) => {
		let name = String(algorithm).toLowerCase();
		name = CIPHER_ALIASES[name] ?? name;
		const info = CIPHER_TABLE.get(name);
		if (!info) throw unknownCipher();
		const keyBytes = bytesOf(key);
		const ivBytes = iv === null || iv === undefined ? new Uint8Array(0) : bytesOf(iv);
		if (keyBytes.length !== info.keyLength) throw Object.assign(new RangeError("Invalid key length"), { code: "ERR_CRYPTO_INVALID_KEYLEN" });
		let ivOk;
		if (info.mode === "ecb") ivOk = ivBytes.length === 0;
		else if (info.mode === "gcm") ivOk = ivBytes.length >= 1;
		else if (info.mode === "ccm") ivOk = ivBytes.length >= 7 && ivBytes.length <= 13;
		else if (info.mode === "ocb") ivOk = ivBytes.length >= 1 && ivBytes.length <= 15;
		else ivOk = ivBytes.length === info.ivLength;
		if (!ivOk) throw Object.assign(new TypeError("Invalid initialization vector"), { code: "ERR_CRYPTO_INVALID_IV" });
		let tagLength = options?.authTagLength;
		if (info.ocb) {
			if (tagLength === undefined || tagLength === null) throw Object.assign(new TypeError(`authTagLength required for ${name}`), { code: "ERR_CRYPTO_INVALID_AUTH_TAG" });
			if (!Number.isInteger(tagLength) || tagLength < 0 || tagLength > 0xffffffff) {
				const shown = typeof tagLength === "string" ? `'${tagLength}'` : typeof tagLength === "object" ? "{}" : String(tagLength);
				throw Object.assign(new TypeError(`The property 'options.authTagLength' is invalid. Received ${shown}`), { code: "ERR_INVALID_ARG_VALUE" });
			}
			if (tagLength > 16) throw Object.assign(new TypeError(`Invalid authentication tag length: ${tagLength}`), { code: "ERR_CRYPTO_INVALID_AUTH_TAG" });
		} else if (info.aead) {
			if (tagLength === undefined) {
				if (info.mode === "ccm" || name === "chacha20-poly1305") {
					throw Object.assign(new TypeError(`authTagLength required for ${name}`), { code: "ERR_CRYPTO_INVALID_AUTH_TAG" });
				}
				tagLength = 16;
			}
			const okLengths = info.mode === "gcm" ? [4, 8, 12, 13, 14, 15, 16] : info.mode === "ccm" ? [4, 6, 8, 10, 12, 14, 16] : [16];
			if (!okLengths.includes(tagLength)) throw Object.assign(new TypeError(`Invalid authentication tag length: ${tagLength}`), { code: "ERR_CRYPTO_INVALID_AUTH_TAG" });
		}
		return { name, info, keyBytes, ivBytes, tagLength };
	};
	const authFailure = () => new Error("Unsupported state or unable to authenticate data");
	const wrapCipherError = (err) => {
		if (err && err.message === "Unsupported state or unable to authenticate data") return authFailure();
		return err;
	};

	class CipherBase extends stream.Transform {
		constructor(algorithm, key, iv, options, decrypt) {
			super(options);
			this._spec = cipherSpec(algorithm, key, iv, options);
			this._decrypt = decrypt;
			this._aad = null;
			this._tag = null;
			this._padding = true;
			this._finalized = false;
			this._handle = null;
			this._chunks = [];
			this._started = false;
			const { info } = this._spec;
			this._ocb = info.ocb ? new Ocb(native, this._spec.keyBytes, this._spec.ivBytes, this._spec.tagLength, decrypt) : null;
			if (info.wrap) {
				const defaultIv = info.wrap === "kw" ? [0xa6, 0xa6, 0xa6, 0xa6, 0xa6, 0xa6, 0xa6, 0xa6] : [0xa6, 0x59, 0x59, 0xa6];
				if (!this._spec.ivBytes.every((b, i) => b === defaultIv[i])) {
					throw Object.assign(new Error("AES key wrap with a custom IV is not available in the Graak native host"), { code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" });
				}
			}
		}
		_open() {
			if (this._handle !== null || this._spec.info.buffered || this._spec.info.wrap) return;
			const { info, keyBytes, ivBytes, tagLength } = this._spec;
			try {
				this._handle = native.cipherOpen(!this._decrypt, info.mbed, keyBytes, ivBytes, this._padding, tagLength ?? 16);
			} catch (err) {
				throw err;
			}
			if (this._aad) native.cipherAad(this._handle, this._aad);
			if (this._tag && this._decrypt) native.cipherTag(this._handle, this._tag);
		}
		setAAD(aad, options) {
			if (this._ocb) {
				if (typeof aad !== "string" && !ArrayBuffer.isView(aad) && !(aad instanceof ArrayBuffer)) throw receivedType("aadbuf", "of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView", aad);
				if (this._finalized) throw Object.assign(new Error("Invalid state for operation setAAD"), { code: "ERR_CRYPTO_INVALID_STATE" });
				this._ocb.addAad(bytesOf(aad));
				return this;
			}
			if (this._started && !this._spec.info.buffered) throw Object.assign(new Error("Unsupported state"), { code: "ERR_CRYPTO_INVALID_STATE" });
			if (!this._spec.info.aead) throw Object.assign(new Error("Unsupported state"), { code: "ERR_CRYPTO_INVALID_STATE" });
			this._aad = bytesOf(aad);
			this._plaintextLength = options?.plaintextLength;
			return this;
		}
		setAutoPadding(value = true) {
			this._padding = Boolean(value);
			return this;
		}
		getAuthTag() {
			if (!this._tag || this._decrypt || !this._finalized) throw Object.assign(new Error("Invalid state for operation getAuthTag"), { code: "ERR_CRYPTO_INVALID_STATE" });
			return buf(this._tag);
		}
		setAuthTag(tag) {
			if (this._ocb) {
				if (typeof tag !== "string" && !ArrayBuffer.isView(tag) && !(tag instanceof ArrayBuffer)) throw receivedType("buffer", "of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView", tag);
				if (!this._decrypt || this._finalized || this._tag) throw Object.assign(new Error("Invalid state for operation setAuthTag"), { code: "ERR_CRYPTO_INVALID_STATE" });
				const bytes = bytesOf(tag);
				if (bytes.length !== this._spec.tagLength) throw Object.assign(new TypeError(`Invalid authentication tag length: ${bytes.length}`), { code: "ERR_CRYPTO_INVALID_AUTH_TAG" });
				this._tag = bytes;
				return this;
			}
			if (!this._decrypt || !this._spec.info.aead || this._finalized) throw Object.assign(new Error("Unsupported state"), { code: "ERR_CRYPTO_INVALID_STATE" });
			this._tag = bytesOf(tag);
			if (this._handle !== null) native.cipherTag(this._handle, this._tag);
			return this;
		}
		/* Text output goes through a decoder, as in Node, so a character or base64 group split between calls is joined. */
		_emit(bytes, encoding, last) {
			if (!encoding || encoding === "buffer") return buf(bytes);
			this._decoder ??= new StringDecoder(encoding);
			return last ? this._decoder.end(buf(bytes)) : this._decoder.write(buf(bytes));
		}
		update(data, inputEncoding, outputEncoding) {
			if (this._ocb) {
				if (typeof data !== "string" && !ArrayBuffer.isView(data)) throw receivedType("data", "of type string or an instance of Buffer, TypedArray, or DataView", data);
				if (this._finalized || this._spec.tagLength === 0) throw new Error("Trying to add data in unsupported state");
				return this._emit(this._ocb.update(toBytes(data, inputEncoding)), outputEncoding, false);
			}
			if (this._finalized) throw Object.assign(new Error("Unsupported state"), { code: "ERR_CRYPTO_INVALID_STATE" });
			if (typeof data !== "string" && !ArrayBuffer.isView(data)) throw invalidArg("data", "of type string or an instance of Buffer, TypedArray, or DataView", data);
			const bytes = toBytes(data, inputEncoding);
			this._started = true;
			if (this._spec.info.buffered || this._spec.info.wrap) {
				this._chunks.push(bytes);
				return this._emit(new Uint8Array(0), outputEncoding, false);
			}
			this._open();
			return this._emit(native.cipherUpdate(this._handle, bytes), outputEncoding, false);
		}
		final(outputEncoding) {
			if (this._ocb) {
				if (this._finalized) throw Object.assign(new Error("Invalid state"), { code: "ERR_CRYPTO_INVALID_STATE" });
				this._finalized = true;
				if (this._spec.tagLength === 0) throw new Error("Trying to add data in unsupported state");
				if (this._decrypt && !this._tag) throw authFailure();
				const { tail, tag } = this._ocb.finish();
				if (!this._decrypt) {
					this._tag = tag;
					return this._emit(tail, outputEncoding, true);
				}
				let diff = 0;
				for (let i = 0; i < tag.length; i++) diff |= tag[i] ^ this._tag[i];
				if (diff !== 0) throw authFailure();
				return this._emit(tail, outputEncoding, true);
			}
			if (this._finalized) throw Object.assign(new Error("Unsupported state"), { code: "ERR_CRYPTO_INVALID_STATE" });
			const { name, info, keyBytes, ivBytes, tagLength } = this._spec;
			if (info.wrap) {
				this._finalized = true;
				const message = concat(this._chunks);
				const padded = info.wrap === "kwp";
				try {
					return this._emit(this._decrypt ? native.kwUnwrap(keyBytes, message, padded) : native.kwWrap(keyBytes, message, padded), outputEncoding, true);
				} catch (err) {
					throw err;
				}
			}
			if (info.buffered) {
				this._finalized = true;
				const message = concat(this._chunks);
				try {
					if (!this._decrypt) {
						const sealed = native.cipher(true, info.mbed, keyBytes, ivBytes, message, this._aad, tagLength, true);
						this._tag = sealed.slice(sealed.length - tagLength);
						return this._emit(sealed.slice(0, sealed.length - tagLength), outputEncoding, true);
					}
					if (!this._tag) throw authFailure();
					return this._emit(native.cipher(false, info.mbed, keyBytes, ivBytes, concat([message, this._tag]), this._aad, tagLength, true), outputEncoding, true);
				} catch (err) {
					throw wrapCipherError(err);
				}
			}
			this._open();
			this._finalized = true;
			try {
				const result = native.cipherFinal(this._handle);
				if (info.aead && !this._decrypt) {
					this._tag = result.tag;
					return this._emit(result.data, outputEncoding, true);
				}
				return this._emit(result, outputEncoding, true);
			} catch (err) {
				throw wrapCipherError(err);
			} finally {
				native.cipherClose(this._handle);
				this._handle = null;
			}
		}
		_transform(chunk, encoding, callback) {
			try {
				const produced = this.update(chunk, encoding === "buffer" ? undefined : encoding);
				if (produced.length) this.push(produced);
				callback();
			} catch (err) {
				callback(err);
			}
		}
		_flush(callback) {
			try {
				const last = this.final();
				if (last.length) this.push(last);
				callback();
			} catch (err) {
				callback(err);
			}
		}
		_destroy(err, callback) {
			if (this._handle !== null) {
				native.cipherClose(this._handle);
				this._handle = null;
			}
			callback(err);
		}
	}
	/* What Node reports for each cipher (OpenSSL's names and NIDs). */
	const CIPHER_INFO = {"aes-128-cbc": {"mode": "cbc", "name": "aes-128-cbc", "nid": 419, "keyLength": 16, "blockSize": 16, "ivLength": 16}, "aes-128-ecb": {"mode": "ecb", "name": "aes-128-ecb", "nid": 418, "keyLength": 16, "blockSize": 16}, "aes-128-ctr": {"mode": "ctr", "name": "aes-128-ctr", "nid": 904, "keyLength": 16, "blockSize": 1, "ivLength": 16}, "aes-128-cfb": {"mode": "cfb", "name": "aes-128-cfb", "nid": 421, "keyLength": 16, "blockSize": 1, "ivLength": 16}, "aes-128-ofb": {"mode": "ofb", "name": "aes-128-ofb", "nid": 420, "keyLength": 16, "blockSize": 1, "ivLength": 16}, "aes-128-gcm": {"mode": "gcm", "name": "id-aes128-gcm", "nid": 895, "keyLength": 16, "blockSize": 1, "ivLength": 12}, "aes-128-ccm": {"mode": "ccm", "name": "id-aes128-ccm", "nid": 896, "keyLength": 16, "blockSize": 1, "ivLength": 12}, "id-aes128-wrap": {"mode": "wrap", "name": "id-aes128-wrap", "nid": 788, "keyLength": 16, "blockSize": 8, "ivLength": 8}, "id-aes128-wrap-pad": {"mode": "wrap", "name": "id-aes128-wrap-pad", "nid": 897, "keyLength": 16, "blockSize": 8, "ivLength": 4}, "aes-192-cbc": {"mode": "cbc", "name": "aes-192-cbc", "nid": 423, "keyLength": 24, "blockSize": 16, "ivLength": 16}, "aes-192-ecb": {"mode": "ecb", "name": "aes-192-ecb", "nid": 422, "keyLength": 24, "blockSize": 16}, "aes-192-ctr": {"mode": "ctr", "name": "aes-192-ctr", "nid": 905, "keyLength": 24, "blockSize": 1, "ivLength": 16}, "aes-192-cfb": {"mode": "cfb", "name": "aes-192-cfb", "nid": 425, "keyLength": 24, "blockSize": 1, "ivLength": 16}, "aes-192-ofb": {"mode": "ofb", "name": "aes-192-ofb", "nid": 424, "keyLength": 24, "blockSize": 1, "ivLength": 16}, "aes-192-gcm": {"mode": "gcm", "name": "id-aes192-gcm", "nid": 898, "keyLength": 24, "blockSize": 1, "ivLength": 12}, "aes-192-ccm": {"mode": "ccm", "name": "id-aes192-ccm", "nid": 899, "keyLength": 24, "blockSize": 1, "ivLength": 12}, "id-aes192-wrap": {"mode": "wrap", "name": "id-aes192-wrap", "nid": 789, "keyLength": 24, "blockSize": 8, "ivLength": 8}, "id-aes192-wrap-pad": {"mode": "wrap", "name": "id-aes192-wrap-pad", "nid": 900, "keyLength": 24, "blockSize": 8, "ivLength": 4}, "aes-256-cbc": {"mode": "cbc", "name": "aes-256-cbc", "nid": 427, "keyLength": 32, "blockSize": 16, "ivLength": 16}, "aes-256-ecb": {"mode": "ecb", "name": "aes-256-ecb", "nid": 426, "keyLength": 32, "blockSize": 16}, "aes-256-ctr": {"mode": "ctr", "name": "aes-256-ctr", "nid": 906, "keyLength": 32, "blockSize": 1, "ivLength": 16}, "aes-256-cfb": {"mode": "cfb", "name": "aes-256-cfb", "nid": 429, "keyLength": 32, "blockSize": 1, "ivLength": 16}, "aes-256-ofb": {"mode": "ofb", "name": "aes-256-ofb", "nid": 428, "keyLength": 32, "blockSize": 1, "ivLength": 16}, "aes-256-gcm": {"mode": "gcm", "name": "id-aes256-gcm", "nid": 901, "keyLength": 32, "blockSize": 1, "ivLength": 12}, "aes-256-ccm": {"mode": "ccm", "name": "id-aes256-ccm", "nid": 902, "keyLength": 32, "blockSize": 1, "ivLength": 12}, "id-aes256-wrap": {"mode": "wrap", "name": "id-aes256-wrap", "nid": 790, "keyLength": 32, "blockSize": 8, "ivLength": 8}, "id-aes256-wrap-pad": {"mode": "wrap", "name": "id-aes256-wrap-pad", "nid": 903, "keyLength": 32, "blockSize": 8, "ivLength": 4}, "aes-128-ocb": {"mode": "ocb", "name": "aes-128-ocb", "nid": 958, "keyLength": 16, "blockSize": 16, "ivLength": 12}, "aes-192-ocb": {"mode": "ocb", "name": "aes-192-ocb", "nid": 959, "keyLength": 24, "blockSize": 16, "ivLength": 12}, "aes-256-ocb": {"mode": "ocb", "name": "aes-256-ocb", "nid": 960, "keyLength": 32, "blockSize": 16, "ivLength": 12}, "chacha20-poly1305": {"mode": "stream", "name": "chacha20-poly1305", "nid": 1018, "keyLength": 32, "ivLength": 12}, "des-ede3-cbc": {"mode": "cbc", "name": "des-ede3-cbc", "nid": 44, "keyLength": 24, "blockSize": 8, "ivLength": 8}, "des-ede3": {"mode": "ecb", "name": "des-ede3", "nid": 33, "keyLength": 24, "blockSize": 8}};
	const getCipherInfo = (nameOrNid, options) => {
		if (typeof nameOrNid !== "string" && typeof nameOrNid !== "number") throw invalidArg("nameOrNid", "of type string or number", nameOrNid);
		let found;
		if (typeof nameOrNid === "number") found = Object.values(CIPHER_INFO).find((info) => info.nid === nameOrNid);
		else {
			const name = CIPHER_ALIASES[nameOrNid.toLowerCase()] ?? nameOrNid.toLowerCase();
			found = CIPHER_INFO[name];
		}
		if (!found) return undefined;
		const table = CIPHER_TABLE.get(Object.keys(CIPHER_INFO).find((k) => CIPHER_INFO[k] === found));
		if (options?.keyLength !== undefined && options.keyLength !== found.keyLength) return undefined;
		if (options?.ivLength !== undefined) {
			const fixed = table.mode !== "gcm" && table.mode !== "ccm" && table.mode !== "ocb";
			if (fixed ? options.ivLength !== (found.ivLength ?? 0) : options.ivLength < 1 || (table.mode === "ocb" && options.ivLength > 15)) return undefined;
		}
		const result = { ...found };
		if (options?.ivLength !== undefined && (table.mode === "gcm" || table.mode === "ccm" || table.mode === "ocb")) result.ivLength = options.ivLength;
		return result;
	};
	/* Node's Cipheriv has no setAuthTag and its Decipheriv no getAuthTag. */
	class Cipheriv extends CipherBase {
		constructor(algorithm, key, iv, options) {
			super(algorithm, key, iv, options, false);
		}
	}
	class Decipheriv extends CipherBase {
		constructor(algorithm, key, iv, options) {
			super(algorithm, key, iv, options, true);
		}
	}
	Object.defineProperty(Cipheriv.prototype, "setAuthTag", { value: undefined, writable: true, configurable: true });
	Object.defineProperty(Decipheriv.prototype, "getAuthTag", { value: undefined, writable: true, configurable: true });
	const createCipheriv = (algorithm, key, iv, options) => new Cipheriv(algorithm, key, iv, options);
	const createDecipheriv = (algorithm, key, iv, options) => new Decipheriv(algorithm, key, iv, options);

	/* ---------------------------------------------------------- sign and verify */

	/* ------------------------------------------------------------------ key objects */

	class KeyObject {
		constructor(type, data, asym) {
			this.type = type;
			if (data) this._keyData = data;
			// Asymmetric keys hold their DER and what the host says about them (see node-crypto2.js).
			if (asym) Object.defineProperty(this, "_asym", { value: asym });
		}
		get symmetricKeySize() {
			return this._keyData ? this._keyData.length : undefined;
		}
	}

	/* Web Crypto is assembled below, once the module object it works through exists. */
	let webcrypto;
	let subtle;


	/* ------------------------------------------------------------------- the module */

	const asym = createAsymmetric({ native, Buffer, stream, toBytes, hashName, out, concat, KeyObject });
	const { argon2, argon2Sync } = createArgon2({ Buffer });
	const crypto = {
		argon2,
		argon2Sync,
		createHash: (algorithm, options) => new Hash(algorithm, options),
		createHmac: (algorithm, key, options) => new Hmac(algorithm, key, options),
		hash: (algorithm, data, outputEncoding = "hex") => new Hash(algorithm).update(data).digest(outputEncoding),
		randomBytes(size, callback) {
			if (!Number.isInteger(size) || size < 0) throw Object.assign(new RangeError(`The value of "size" is out of range. It must be >= 0 && <= 2147483647. Received ${size}`), { code: "ERR_OUT_OF_RANGE" });
			const bytes = buf(randomFillSync(new Uint8Array(size)));
			if (callback) {
				queueMicrotask(() => callback(null, bytes));
				return undefined;
			}
			return bytes;
		},
		randomFillSync,
		randomFill(target, offset, size, callback) {
			if (typeof offset === "function") {
				callback = offset;
				offset = 0;
				size = undefined;
			} else if (typeof size === "function") {
				callback = size;
				size = undefined;
			}
			randomFillSync(target, offset, size);
			queueMicrotask(() => callback(null, target));
		},
		randomUUID,
		randomInt,
		getRandomValues,
		pseudoRandomBytes: (size, callback) => crypto.randomBytes(size, callback),
		timingSafeEqual(a, b) {
			const left = toBytes(a);
			const right = toBytes(b);
			if (left.length !== right.length) throw Object.assign(new RangeError("Input buffers must have the same byte length"), { code: "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH" });
			let diff = 0;
			for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
			return diff === 0;
		},
		pbkdf2,
		pbkdf2Sync,
		hkdf,
		hkdfSync,
		scrypt,
		scryptSync,
		createCipheriv,
		createDecipheriv,
		createSecretKey: (key, encoding) => new KeyObject("secret", bytesOf(key, encoding)),
		KeyObject,
		getHashes: () => [...HASHES, "keccak-kmac128", "keccak-kmac256"],
		getCiphers: () => CIPHER_NAMES().sort(),
		getCipherInfo,
		getFips: () => 0,
		setFips: () => {},
		constants: { RSA_PKCS1_PADDING: 1, RSA_NO_PADDING: 3, RSA_PKCS1_OAEP_PADDING: 4, RSA_PKCS1_PSS_PADDING: 6, POINT_CONVERSION_COMPRESSED: 2, POINT_CONVERSION_UNCOMPRESSED: 4, POINT_CONVERSION_HYBRID: 6, ...asym.constants },
		Hash,
		Hmac,
		Cipheriv,
		Decipheriv,
		webcrypto,
		subtle,
	};
	const {
		Sign, Verify, sign, verify, createPrivateKey, createPublicKey, generateKeyPair, generateKeyPairSync, generateKeySync, generateKey,
		publicEncrypt, privateDecrypt, privateEncrypt, publicDecrypt, ECDH, createECDH, diffieHellman, DiffieHellman, DiffieHellmanGroup,
		createDiffieHellman, createDiffieHellmanGroup, getDiffieHellman, generatePrime, generatePrimeSync, checkPrime, checkPrimeSync,
		X509Certificate, getCurves, encapsulate, decapsulate,
	} = asym;
	Object.assign(crypto, {
		Sign, Verify, sign, verify, createSign: (algorithm) => new Sign(algorithm), createVerify: (algorithm) => new Verify(algorithm),
		createPrivateKey, createPublicKey, generateKeyPair, generateKeyPairSync, generateKeySync, generateKey,
		publicEncrypt, privateDecrypt, privateEncrypt, publicDecrypt, ECDH, createECDH, diffieHellman, DiffieHellman, DiffieHellmanGroup,
		createDiffieHellman, createDiffieHellmanGroup, getDiffieHellman, generatePrime, generatePrimeSync, checkPrime, checkPrimeSync,
		X509Certificate, getCurves, encapsulate, decapsulate,
	});
	Object.defineProperty(crypto, "tools", { value: asym.tools });
	const web = createSubtle({ native, Buffer, toBytes, crypto, hashName });
	// encapsulate() and decapsulate() take a CryptoKey too; KeyObject.from() unwraps one.
	asym.setKeyUnwrapper((key) => web.keyObjectOf(key) ?? key);
	if (!KeyObject.from) {
		KeyObject.from = (key) => {
			const keyObject = web.keyObjectOf(key);
			if (!keyObject) throw invalidArg("key", "an instance of CryptoKey", key);
			return keyObject;
		};
	}
	class Crypto {
		get subtle() {
			if (!(this instanceof Crypto)) throw Object.assign(new TypeError('Value of "this" must be of type Crypto'), { code: "ERR_INVALID_THIS" });
			return web.subtle;
		}
		getRandomValues(view) {
			if (!(this instanceof Crypto)) throw Object.assign(new TypeError('Value of "this" must be of type Crypto'), { code: "ERR_INVALID_THIS" });
			return getRandomValues(view);
		}
		randomUUID() {
			if (!(this instanceof Crypto)) throw Object.assign(new TypeError('Value of "this" must be of type Crypto'), { code: "ERR_INVALID_THIS" });
			return randomUUID();
		}
		get [Symbol.toStringTag]() {
			return "Crypto";
		}
	}
	webcrypto = new Crypto();
	subtle = web.subtle;
	crypto.webcrypto = webcrypto;
	crypto.subtle = subtle;
	Object.defineProperty(crypto, "webClasses", { value: { Crypto, SubtleCrypto: web.SubtleCrypto, CryptoKey: web.CryptoKey } });
	return crypto;
}

export { createCrypto };
