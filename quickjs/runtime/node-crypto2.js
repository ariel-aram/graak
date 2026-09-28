/*
 * The asymmetric half of Node's `crypto` on the native host: key objects (PEM, DER and JWK in and out), generateKeyPair,
 * sign and verify with RSA PKCS#1 v1.5, RSA-PSS and ECDSA (DER or IEEE P1363), publicEncrypt and privateDecrypt with
 * RSA PKCS#1 v1.5 and OAEP, ECDH, Diffie-Hellman, prime generation and testing, and X509Certificate.
 *
 * mbedTLS does the mathematics (see quickjs/native/fg_crypto.c); this file is the Node-shaped surface and the little
 * DER writer that turns mbedTLS's PKCS#1 / SEC1 output into the PKCS#8 and SPKI forms Node exports.
 *
 * Ed25519, Ed448, X25519, X448 and DSA keys (mbedTLS has no scheme for them) are parsed and used here, and so are the
 * post-quantum keys ML-KEM, ML-DSA and SLH-DSA (node-pqc.js), with crypto.encapsulate and crypto.decapsulate.
 */

import { MODP_PRIMES } from "./node-crypto-dh.js";
import { newBlake2 } from "./node-blake2.js";

const OID_RSA = "1.2.840.113549.1.1.1";
const OID_EC = "1.2.840.10045.2.1";
const CURVE_OIDS = {
	secp192r1: "1.2.840.10045.3.1.1",
	secp224r1: "1.3.132.0.33",
	secp256r1: "1.2.840.10045.3.1.7",
	secp384r1: "1.3.132.0.34",
	secp521r1: "1.3.132.0.35",
	secp192k1: "1.3.132.0.31",
	secp224k1: "1.3.132.0.32",
	secp256k1: "1.3.132.0.10",
	brainpoolP256r1: "1.3.36.3.3.2.8.1.1.7",
	brainpoolP384r1: "1.3.36.3.3.2.8.1.1.11",
	brainpoolP512r1: "1.3.36.3.3.2.8.1.1.13",
};
const CURVE_ALIASES = { prime256v1: "secp256r1", "P-256": "secp256r1", "P-384": "secp384r1", "P-521": "secp521r1", prime192v1: "secp192r1" };
const JWK_CURVES = { secp256r1: "P-256", secp384r1: "P-384", secp521r1: "P-521", secp256k1: "secp256k1" };
const CURVES = ["prime192v1", "secp224r1", "prime256v1", "secp384r1", "secp521r1", "secp192k1", "secp224k1", "secp256k1", "brainpoolP256r1", "brainpoolP384r1", "brainpoolP512r1"];
const UNSUPPORTED_KEY_TYPES = ["dh"];
const OKP_OIDS = { "1.3.101.112": "ed25519", "1.3.101.113": "ed448", "1.3.101.110": "x25519", "1.3.101.111": "x448" };
const OKP_BY_TYPE = { ed25519: "1.3.101.112", ed448: "1.3.101.113", x25519: "1.3.101.110", x448: "1.3.101.111" };
const OKP_SIZE = { ed25519: 32, ed448: 57, x25519: 32, x448: 56 };
const OKP_JWK = { ed25519: "Ed25519", ed448: "Ed448", x25519: "X25519", x448: "X448" };
const OID_DSA = "1.2.840.10040.4.1";

const canonicalCurve = (name) => CURVE_ALIASES[name] ?? name;
const codeError = (Ctor, code, message) => Object.assign(new Ctor(message), { code });
const unavailable = (what, why) => codeError(Error, "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", `${what} is not available in the Graak native host: ${why}`);

import { createPkcs } from "./node-pkcs.js";
import { createPqc } from "./node-pqc.js";
import { certificateBytes, parseCertificate, SIGNATURE_HASH } from "./node-x509.js";
import {
	derBits,
	derInt,
	derNull,
	derOctets,
	derOid,
	derSeq,
	fromPem,
	join,
	oidText,
	readChildren,
	readTlv,
	tlv,
	toPem,
	unsignedBytes,
} from "./node-asn1.js";

/* ---------------------------------------------------------------------------------------------- factory */

function createAsymmetric({ native, Buffer, stream, toBytes, hashName, out, concat, KeyObject }) {
	const buf = (bytes) => Buffer.from(bytes);
	const pkcs = createPkcs({ native, Buffer });
	const pqc = createPqc({ native });
	const pem = (label, der) => toPem(label, der, Buffer);
	const b64u = (bytes) => buf(bytes).toString("base64url");
	const fromB64u = (text) => new Uint8Array(Buffer.from(String(text), "base64url"));
	const invalidArg = (name, expected, value) =>
		codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "${name}" ${name.includes(".") ? "property" : "argument"} must be ${expected}. Received ${received(value)}`);
	const noneOr = (value, encoding) => (encoding && encoding !== "buffer" ? buf(value).toString(encoding) : buf(value));

	/* ------------------------------------------------------------------------------- key objects */

	/* An asymmetric key object holds: priv (PKCS#1 or SEC1 DER, private keys only), spki (DER) and info (from the host). */
	const makeKey = (info, asPublic) => {
		if (asPublic && info.private && (info.okp || info.dsa || info.pqc)) {
			// The public half of a key this file parses itself carries none of the private material.
			info = { ...info, private: false, pkcs: undefined, okp: info.okp ? { pub: info.okp.pub } : undefined, pqc: info.pqc ? { type: info.pqc.type, pub: info.pqc.pub } : undefined, dsa: info.dsa ? { p: info.dsa.p, q: info.dsa.q, g: info.dsa.g, y: info.dsa.y } : undefined };
		}
		const key = new KeyObject(info.private && !asPublic ? "private" : "public", null, {
			priv: info.private && !asPublic ? info.pkcs : null,
			spki: info.spki,
			info,
		});
		return key;
	};

	const readKeyBytes = (input, isPrivate, formatHint) => {
		let data = input;
		if (typeof data === "string") return { data, isString: true };
		data = toBytes(data);
		const text = buf(data).toString("latin1");
		if (formatHint !== "der" && /^\s*-----BEGIN /.test(text)) return { data: buf(data).toString("utf8"), isString: true };
		return { data, isString: false };
	};

	const parseInput = (key, { wantPrivate, jwkOk = true } = {}) => {
		if (key instanceof KeyObject) {
			if (key.type === "secret") throw codeError(TypeError, "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE", "Invalid key object type secret, expected private.");
			if (wantPrivate && key.type !== "private") {
				throw codeError(TypeError, "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE", `Invalid key object type ${key.type}, expected private.`);
			}
			return { keyObject: key };
		}
		let options = {};
		let material = key;
		if (key && typeof key === "object" && !ArrayBuffer.isView(key) && !(key instanceof ArrayBuffer)) {
			options = key;
			material = key.key;
			if (material instanceof KeyObject) return { keyObject: material, options };
			if (options.format === "jwk" && jwkOk) return { jwk: material ?? options.key, options };
		}
		if (material === undefined || material === null) throw invalidArg("key", "of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey", material);
		if (typeof material === "object" && material.kty) return { jwk: material, options };
		const { data } = readKeyBytes(material, wantPrivate, options.format);
		const passphrase = options.passphrase === undefined ? undefined : typeof options.passphrase === "string" ? options.passphrase : buf(toBytes(options.passphrase)).toString("utf8");
		return { data, passphrase, options };
	};

	const infoOf = (data, passphrase, wantPrivate) => {
		const special = specialInfo(data, passphrase);
		if (special) {
			if (wantPrivate && !special.private) throw codeError(Error, "ERR_OSSL_UNSUPPORTED", "error:1E08010C:DECODER routines::unsupported");
			return special;
		}
		try {
			return native.keyInfo(data, passphrase, wantPrivate);
		} catch (err) {
			const encrypted = specialFromEncrypted(data, passphrase);
			if (encrypted) return encrypted;
			if (err.code === "ERR_OSSL_BAD_DECRYPT" || /password does not allow/.test(String(err.message))) {
				throw codeError(Error, "ERR_OSSL_BAD_DECRYPT", "error:1C800064:Provider routines::bad decrypt");
			}
			if (err.code === "ERR_MISSING_PASSPHRASE" || /password/i.test(String(err.message))) throw codeError(Error, "ERR_OSSL_CRYPTO_INTERRUPTED_OR_CANCELLED", "error:07880109:common libcrypto routines::interrupted or cancelled");
			throw err;
		}
	};
	const decodePem = (bytes) => {
		const text = buf(bytes).toString("latin1");
		const m = /-----BEGIN [A-Z0-9 ]+-----([\s\S]*?)-----END/.exec(text);
		return m ? new Uint8Array(Buffer.from(m[1].replace(/\s+/g, ""), "base64")) : bytes;
	};

	/* The material to hand to the host for `key`: private keys as DER, public ones as SPKI. */
	const nativeKey = (parsed, wantPrivate) => {
		if (parsed.keyObject) {
			const asym = parsed.keyObject._asym;
			return { data: wantPrivate ? asym.priv : asym.priv ?? asym.spki, passphrase: undefined, info: asym.info };
		}
		return { data: parsed.data, passphrase: parsed.passphrase, info: null };
	};

	/* ---- JWK in and out */
	const rsaPrivateParts = (der) => {
		const top = readTlv(der, 0);
		const kids = readChildren(der, top).map((c) => unsignedBytes(der, c));
		return { n: kids[1], e: kids[2], d: kids[3], p: kids[4], q: kids[5], dp: kids[6], dq: kids[7], qi: kids[8] };
	};
	const ecPrivateScalar = (der) => {
		const top = readTlv(der, 0);
		const kids = readChildren(der, top);
		return der.subarray(kids[1].start, kids[1].end);
	};
	const ecPointOfSpki = (spki) => {
		const top = readTlv(spki, 0);
		const kids = readChildren(spki, top);
		return spki.subarray(kids[1].start + 1, kids[1].end);
	};
	const exportJwk = (key) => {
		const { info, priv } = key._asym;
		if (info.type === "rsa") {
			const jwk = { kty: "RSA", n: b64u(info.modulus), e: b64u(info.exponent) };
			if (priv) {
				const p = rsaPrivateParts(priv);
				Object.assign(jwk, { d: b64u(p.d), p: b64u(p.p), q: b64u(p.q), dp: b64u(p.dp), dq: b64u(p.dq), qi: b64u(p.qi) });
			}
			return jwk;
		}
		if (info.pqc) {
			const { type, seed, expanded, pub } = info.pqc;
			const jwk = {};
			if (priv) {
				if (type.kind !== "slh" && !seed) throw codeError(Error, "ERR_CRYPTO_OPERATION_FAILED", "key does not have an available seed");
				jwk.priv = b64u(type.kind === "slh" ? expanded : seed);
			}
			return { ...jwk, kty: "AKP", alg: type.jwk, pub: b64u(pub) };
		}
		if (info.okp) {
			const jwk = { crv: OKP_JWK[info.type], x: b64u(info.okp.pub), kty: "OKP" };
			if (info.okp.seed) jwk.d = b64u(info.okp.seed);
			return { crv: jwk.crv, ...(jwk.d ? { d: jwk.d } : {}), x: jwk.x, kty: jwk.kty };
		}
		if (info.type === "ec") {
			const crv = JWK_CURVES[canonicalCurve(info.curve)];
			if (!crv) throw unavailable(`JWK export for curve ${info.curve}`, "it has no JWK name");
			const size = (info.bits + 7) >> 3;
			const point = info.point;
			const jwk = { kty: "EC", x: b64u(point.subarray(1, 1 + size)), y: b64u(point.subarray(1 + size)), crv };
			if (priv) jwk.d = b64u(ecPrivateScalar(priv));
			return jwk;
		}
		throw codeError(Error, "ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE", "Unsupported JWK Key Type.");
	};
	const pad = (bytes, size) => {
		if (bytes.length >= size) return bytes;
		const padded = new Uint8Array(size);
		padded.set(bytes, size - bytes.length);
		return padded;
	};
	const rsaSpki = (n, e) => derSeq(derSeq(derOid(OID_RSA), derNull()), derBits(derSeq(derInt(n), derInt(e))));
	const ecSpki = (curve, point) => derSeq(derSeq(derOid(OID_EC), derOid(CURVE_OIDS[curve])), derBits(point));
	const importJwk = (jwk, wantPrivate) => {
		if (jwk.kty === "RSA") {
			const n = fromB64u(jwk.n);
			const e = fromB64u(jwk.e);
			if (jwk.d && wantPrivate !== false) {
				const parts = ["d", "p", "q", "dp", "dq", "qi"].map((k) => {
					if (jwk[k] === undefined) throw codeError(TypeError, "ERR_CRYPTO_INVALID_JWK", "Invalid JWK RSA key");
					return derInt(fromB64u(jwk[k]));
				});
				return { data: derSeq(derInt(Uint8Array.of(0)), derInt(n), derInt(e), ...parts), isPrivate: true };
			}
			return { data: rsaSpki(n, e), isPrivate: false };
		}
		if (jwk.kty === "AKP") {
			const type = typeof jwk.alg === "string" ? pqc.byJwk[jwk.alg] : undefined;
			if (!type) throw codeError(TypeError, "ERR_CRYPTO_INVALID_JWK", 'Unsupported JWK AKP "alg"');
			const bad = () => codeError(TypeError, "ERR_CRYPTO_INVALID_JWK", "Invalid JWK AKP key");
			if (wantPrivate) {
				if (jwk.priv === undefined) throw codeError(TypeError, "ERR_CRYPTO_INVALID_JWK", "JWK does not contain private key material");
				if (typeof jwk.priv !== "string") throw bad();
				const priv = fromB64u(jwk.priv);
				if (priv.length !== (type.kind === "slh" ? type.expandedLen : type.seedLen)) throw bad();
				// A seed goes in as the [0] form; SLH-DSA has the expanded key only.
				const inner = type.kind === "slh" ? priv : tlv(0x80, priv);
				return { data: derSeq(derInt(Uint8Array.of(0)), derSeq(derOid(type.oid)), derOctets(inner)), isPrivate: true };
			}
			if (typeof jwk.pub !== "string") throw bad();
			const pub = fromB64u(jwk.pub);
			if (!pqc.publicOk(type, pub)) throw bad();
			return { data: pqcSpki(type, pub), isPrivate: false };
		}
		if (jwk.kty === "OKP") {
			const type = Object.keys(OKP_JWK).find((k) => OKP_JWK[k] === jwk.crv);
			if (!type) throw codeError(TypeError, "ERR_CRYPTO_INVALID_CURVE", `Invalid JWK OKP curve ${jwk.crv}`);
			if (jwk.d && wantPrivate !== false) {
				const seed = fromB64u(jwk.d);
				return { data: derSeq(derInt(Uint8Array.of(0)), derSeq(derOid(OKP_BY_TYPE[type])), derOctets(derOctets(seed))), isPrivate: true };
			}
			return { data: derSeq(derSeq(derOid(OKP_BY_TYPE[type])), derBits(fromB64u(jwk.x))), isPrivate: false };
		}
		if (jwk.kty === "EC") {
			const curve = Object.keys(JWK_CURVES).find((k) => JWK_CURVES[k] === jwk.crv);
			if (!curve) throw codeError(TypeError, "ERR_CRYPTO_INVALID_CURVE", `Invalid JWK EC curve ${jwk.crv}`);
			const info = native.ecdhGenerate(curve, jwk.d ? fromB64u(jwk.d) : undefined);
			const size = (info.priv.length);
			const point = jwk.d ? info.pub : join([Uint8Array.of(4), pad(fromB64u(jwk.x), size), pad(fromB64u(jwk.y), size)]);
			if (jwk.d && wantPrivate !== false) {
				const sec1 = derSeq(derInt(Uint8Array.of(1)), derOctets(pad(fromB64u(jwk.d), size)), tlv(0xa0, derOid(CURVE_OIDS[curve])), tlv(0xa1, derBits(point)));
				return { data: sec1, isPrivate: true };
			}
			return { data: ecSpki(curve, point), isPrivate: false };
		}
		throw unavailable(`JWK keys of type ${jwk.kty}`, "only RSA and EC keys are supported");
	};

	/* ---- keys mbedTLS cannot read: Ed25519, Ed448, X25519, X448 and DSA are parsed and used here */
	const readInt = (bytes, element) => unsignedBytes(bytes, element);
	const okpInfo = (type, seed, pub, spki) => {
		const pkcs8Der = seed ? derSeq(derInt(Uint8Array.of(0)), derSeq(derOid(OKP_BY_TYPE[type])), derOctets(derOctets(seed))) : undefined;
		return { private: Boolean(seed), type, bits: type.endsWith("448") ? 448 : 255, pkcs: pkcs8Der, spki: spki ?? derSeq(derSeq(derOid(OKP_BY_TYPE[type])), derBits(pub)), okp: { seed, pub } };
	};
	const dsaSpki = (dsa) => derSeq(derSeq(derOid(OID_DSA), derSeq(derInt(dsa.p), derInt(dsa.q), derInt(dsa.g))), derBits(derInt(dsa.y)));
	const dsaInfo = (dsa) => {
		const pkcs8Der = dsa.x ? derSeq(derInt(Uint8Array.of(0)), derSeq(derOid(OID_DSA), derSeq(derInt(dsa.p), derInt(dsa.q), derInt(dsa.g))), derOctets(derInt(dsa.x))) : undefined;
		const bitsOf = (bytes) => {
			let i = 0;
			while (i < bytes.length && bytes[i] === 0) i++;
			return bytes.length === i ? 0 : (bytes.length - i - 1) * 8 + (8 - Math.clz32(bytes[i]) + 24);
		};
		return { private: Boolean(dsa.x), type: "dsa", bits: bitsOf(dsa.p), divisorLength: bitsOf(dsa.q), pkcs: pkcs8Der, spki: dsaSpki(dsa), dsa };
	};
	/* ---- ML-KEM, ML-DSA and SLH-DSA keys (node-pqc.js) are parsed and used here, like the OKP and DSA ones */
	const invalidKey = () => Object.assign(codeError(Error, "ERR_OSSL_INVALID_KEY", "error:1C80009E:Provider routines::invalid key"), { pqc: true });
	const undecodable = () => Object.assign(codeError(Error, "ERR_OSSL_UNSUPPORTED", "error:1E08010C:DECODER routines::unsupported"), { pqc: true });
	const pqcSpki = (type, pub) => derSeq(derSeq(derOid(type.oid)), derBits(pub));
	/* Node 24's PKCS#8 form: the seed and the expanded key together (SLH-DSA has the expanded key alone). */
	const pqcPkcs8 = (type, key) => {
		const inner = type.kind === "slh" ? key.expanded : key.seed ? derSeq(derOctets(key.seed), derOctets(key.expanded)) : derOctets(key.expanded);
		return derSeq(derInt(Uint8Array.of(0)), derSeq(derOid(type.oid)), derOctets(inner));
	};
	const pqcInfo = (type, key, isPrivate) => ({
		private: isPrivate,
		type: type.name,
		bits: 0,
		pkcs: isPrivate ? pqcPkcs8(type, key) : undefined,
		spki: pqcSpki(type, key.pub),
		pqc: { type, seed: key.seed, expanded: isPrivate ? key.expanded : undefined, pub: key.pub },
	});
	/* The private key inside a PrivateKeyInfo: a seed ([0]), an expanded key (OCTET STRING) or both (SEQUENCE). */
	const pqcFromPkcs8 = (type, der, element) => {
		const body = der.slice(element.start, element.end);
		if (type.kind === "slh") {
			const key = body.length === type.expandedLen ? pqc.fromExpanded(type, body) : null;
			if (!key) throw invalidKey();
			return pqcInfo(type, key, true);
		}
		const first = readTlv(body, 0);
		if (first.next !== body.length) throw undecodable();
		if (body[0] === 0x80) {
			const seed = body.slice(first.start, first.end);
			if (seed.length !== type.seedLen) throw undecodable();
			return pqcInfo(type, pqc.fromSeed(type, seed), true);
		}
		if (body[0] === 0x04) {
			const key = pqc.fromExpanded(type, body.slice(first.start, first.end));
			if (!key) throw invalidKey();
			return pqcInfo(type, key, true);
		}
		if (body[0] === 0x30) {
			const [seedEl, expandedEl] = readChildren(body, first);
			if (!seedEl || !expandedEl || seedEl.tag !== 4 || expandedEl.tag !== 4) throw undecodable();
			const seed = body.slice(seedEl.start, seedEl.end);
			if (seed.length !== type.seedLen) throw undecodable();
			const key = pqc.fromSeed(type, seed);
			if (!buf(key.expanded).equals(buf(body.subarray(expandedEl.start, expandedEl.end)))) throw invalidKey();
			return pqcInfo(type, key, true);
		}
		throw undecodable();
	};
	const pqcFromSpki = (type, pub) => {
		if (!pqc.publicOk(type, pub)) throw invalidKey();
		return pqcInfo(type, { pub }, false);
	};
	/* createPublicKey and createPrivateKey with format raw-public, raw-seed or raw-private. */
	const createRawKey = (options, wantPrivate) => {
		const typeName = options.asymmetricKeyType;
		if (typeof typeName !== "string") throw invalidArg("key.asymmetricKeyType", "of type string", typeName);
		const type = pqc.types[typeName];
		if (!type) {
			if (["ec", "ed25519", "ed448", "x25519", "x448", "rsa", "rsa-pss", "dsa", "dh"].includes(typeName)) {
				throw unavailable(`raw key import for '${typeName}' keys`, "only ML-KEM, ML-DSA and SLH-DSA keys have raw forms here");
			}
			throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", `Invalid asymmetricKeyType: ${typeName}`);
		}
		const bytes = toBytes(options.key, options.encoding);
		if (options.format === "raw-public") {
			if (!pqc.publicOk(type, bytes)) throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", "Invalid key data");
			return makeKey(pqcInfo(type, { pub: Uint8Array.from(bytes) }, false), true);
		}
		if (options.format === "raw-seed" ? type.kind === "slh" : type.kind !== "slh") {
			throw codeError(Error, "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS", "The selected key encoding is incompatible with the key type");
		}
		const key = options.format === "raw-seed" ? (bytes.length === type.seedLen ? pqc.fromSeed(type, bytes) : null) : bytes.length === type.expandedLen ? pqc.fromExpanded(type, bytes) : null;
		if (!key) throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", "Invalid key data");
		return makeKey(pqcInfo(type, key, true), !wantPrivate);
	};

	/* The DER (and its PEM label) inside the bytes or text a program passes as a key. */
	const derOfKey = (data) => {
		const text = typeof data === "string" ? data : buf(data).toString("latin1");
		if (/-----BEGIN /.test(text)) return fromPem(text, Buffer);
		return { label: null, headers: {}, der: typeof data === "string" ? new Uint8Array(buf(data, "latin1")) : data };
	};
	const parseSpecialDer = (der) => {
		let top;
		let kids;
		try {
			top = readTlv(der, 0);
			if (top.tag !== 0x30 || top.next > der.length) return null;
			kids = readChildren(der, top);
		} catch {
			return null;
		}
		const algOf = (element) => {
			const parts = readChildren(der, element);
			return { oid: oidText(der, parts[0]), params: parts[1] };
		};
		try {
			// PrivateKeyInfo
			if (kids.length >= 3 && kids[0].tag === 2 && kids[1].tag === 0x30 && kids[2].tag === 4) {
				const alg = algOf(kids[1]);
				if (OKP_OIDS[alg.oid]) {
					const inner = readTlv(der, kids[2].start);
					const seed = der.slice(inner.start, inner.end);
					const type = OKP_OIDS[alg.oid];
					if (seed.length !== OKP_SIZE[type]) return null;
					return okpInfo(type, seed, okpPublic(type, seed));
				}
				if (pqc.byOid[alg.oid]) return pqcFromPkcs8(pqc.byOid[alg.oid], der, kids[2]);
				if (alg.oid === OID_DSA) {
					const [p, q, g] = readChildren(der, alg.params).map((c) => der.slice(...[c.start, c.end]));
					const strip = (b) => {
						let i = 0;
						while (i < b.length - 1 && b[i] === 0) i++;
						return b.subarray(i);
					};
					const xElement = readTlv(der, kids[2].start);
					const dsa = { p: strip(p), q: strip(q), g: strip(g), x: strip(der.slice(xElement.start, xElement.end)) };
					dsa.y = bytesOfBig(bigModPow(bigOf(dsa.g), bigOf(dsa.x), bigOf(dsa.p)));
					return dsaInfo(dsa);
				}
				return null;
			}
			// SubjectPublicKeyInfo
			if (kids.length === 2 && kids[0].tag === 0x30 && kids[1].tag === 3) {
				const alg = algOf(kids[0]);
				if (OKP_OIDS[alg.oid]) {
					const type = OKP_OIDS[alg.oid];
					const pub = der.slice(kids[1].start + 1, kids[1].end);
					if (pub.length !== OKP_SIZE[type]) return null;
					return okpInfo(type, undefined, pub, der.slice(top.pos, top.next));
				}
				if (pqc.byOid[alg.oid]) return pqcFromSpki(pqc.byOid[alg.oid], der.slice(kids[1].start + 1, kids[1].end));
				if (alg.oid === OID_DSA) {
					const [p, q, g] = readChildren(der, alg.params).map((c) => unsignedBytes(der, c));
					const yElement = readTlv(der, kids[1].start + 1);
					return dsaInfo({ p, q, g, y: unsignedBytes(der, yElement) });
				}
				return null;
			}
			// Traditional DSA private key: SEQUENCE { 0, p, q, g, y, x }
			if (kids.length === 6 && kids.every((k) => k.tag === 2)) {
				const [, p, q, g, y, x] = kids.map((k) => unsignedBytes(der, k));
				if (unsignedBytes(der, kids[0]).length === 1 && unsignedBytes(der, kids[0])[0] === 0) return dsaInfo({ p, q, g, y, x });
			}
		} catch (err) {
			if (err?.pqc) throw err;
			return null;
		}
		return null;
	};
	const specialInfo = (data) => {
		let found;
		try {
			found = derOfKey(data);
		} catch {
			return null;
		}
		if (!found || found.label === "ENCRYPTED PRIVATE KEY" || found.headers["Proc-Type"]) return null;
		if (found.label && !/PRIVATE KEY|PUBLIC KEY/.test(found.label)) return null;
		return parseSpecialDer(found.der);
	};
	/* An encrypted key of one of those types: decrypt it here, then read what is inside. */
	const specialFromEncrypted = (data, passphrase) => {
		let found;
		try {
			found = derOfKey(data);
		} catch {
			return null;
		}
		if (!found) return null;
		let der = found.der;
		try {
			if (found.label === "ENCRYPTED PRIVATE KEY") {
				if (passphrase === undefined) return null;
				der = pkcs.decryptPkcs8(der, passphrase);
			} else if (found.headers["Proc-Type"] && found.headers["DEK-Info"]) {
				if (passphrase === undefined) return null;
				const [cipherName, ivHex] = found.headers["DEK-Info"].split(",");
				const name = cipherName.toLowerCase();
				const sizes = { "aes-128-cbc": 16, "aes-192-cbc": 24, "aes-256-cbc": 32, "des-ede3-cbc": 24 };
				if (!sizes[name]) return null;
				const iv = new Uint8Array(Buffer.from(ivHex.trim(), "hex"));
				const key = pkcs.bytesToKey(passphrase, iv.subarray(0, 8), sizes[name]);
				der = new Uint8Array(native.cipher(false, name, key, iv, der, null, 0, true));
			} else {
				return null;
			}
		} catch {
			return null;
		}
		return parseSpecialDer(der);
	};
	const okpClamp = (type, priv) => {
		const c = new Uint8Array(priv);
		if (type === "x25519") {
			c[0] &= 248;
			c[31] &= 127;
			c[31] |= 64;
		} else {
			c[0] &= 252;
			c[55] |= 128;
		}
		return c;
	};
	const okpPublic = (type, seed) => (type.startsWith("ed") ? new Uint8Array(native.eddsaPublic(type, seed)) : new Uint8Array(native.ecdhGenerate(type, okpClamp(type, seed)).pub));
	const bigModPow = (base, exp, mod) => bigOf(native.modPow(bytesOfBig(base), bytesOfBig(exp), bytesOfBig(mod)));
	const bigInv = (a, m) => {
		let [oldR, r] = [a % m, m];
		let [oldS, sCoef] = [1n, 0n];
		while (r !== 0n) {
			const q = oldR / r;
			[oldR, r] = [r, oldR - q * r];
			[oldS, sCoef] = [sCoef, oldS - q * sCoef];
		}
		return ((oldS % m) + m) % m;
	};

	/* DSA (FIPS 186): signatures over the digest, truncated to the size of q. */
	const dsaDigestInt = (hash, data, q) => {
		const digest = native.hash(hash, data);
		const qBits = q.toString(2).length;
		let z = bigOf(digest);
		const excess = digest.length * 8 - qBits;
		if (excess > 0) z >>= BigInt(excess);
		return z;
	};
	const dsaSign = (dsa, hash, data, encoding) => {
		const p = bigOf(dsa.p);
		const q = bigOf(dsa.q);
		const g = bigOf(dsa.g);
		const x = bigOf(dsa.x);
		const z = dsaDigestInt(hash, data, q);
		const qBytes = (q.toString(2).length + 7) >> 3;
		for (;;) {
			const k = (bigOf(native.randomBytes(qBytes + 8)) % (q - 1n)) + 1n;
			const r = bigModPow(g, k, p) % q;
			if (r === 0n) continue;
			const sValue = (bigInv(k, q) * ((z + x * r) % q)) % q;
			if (sValue === 0n) continue;
			const rb = bytesOfBig(r);
			const sb = bytesOfBig(sValue);
			if (encoding === "ieee-p1363") return join([pad(rb, qBytes), pad(sb, qBytes)]);
			return derSeq(derInt(rb), derInt(sb));
		}
	};
	const dsaVerify = (dsa, hash, data, signature, encoding) => {
		const p = bigOf(dsa.p);
		const q = bigOf(dsa.q);
		const g = bigOf(dsa.g);
		const y = bigOf(dsa.y);
		let r;
		let sValue;
		try {
			if (encoding === "ieee-p1363") {
				const half = signature.length >> 1;
				r = bigOf(signature.subarray(0, half));
				sValue = bigOf(signature.subarray(half));
			} else {
				const kids = readChildren(signature, readTlv(signature, 0));
				r = bigOf(unsignedBytes(signature, kids[0]));
				sValue = bigOf(unsignedBytes(signature, kids[1]));
			}
		} catch {
			return false;
		}
		if (r <= 0n || r >= q || sValue <= 0n || sValue >= q) return false;
		const w = bigInv(sValue, q);
		const z = dsaDigestInt(hash, data, q);
		const u1 = (z * w) % q;
		const u2 = (r * w) % q;
		const v = ((bigModPow(g, u1, p) * bigModPow(y, u2, p)) % p) % q;
		return v === r;
	};
	const isProbablePrime = (n) => native.isPrime(bytesOfBig(n), 24);
	const SMALL_PRIMES = (() => {
		const list = [];
		const sieve = new Uint8Array(3000);
		for (let i = 2; i < sieve.length; i++) {
			if (!sieve[i]) {
				list.push(BigInt(i));
				for (let j = i * i; j < sieve.length; j += i) sieve[j] = 1;
			}
		}
		return list;
	})();
	const generateDsa = (modulusLength, divisorLength) => {
		const qBits = divisorLength;
		const q = bigOf(native.genPrime(qBits, false));
		const random = (bits) => {
			const bytes = new Uint8Array(native.randomBytes((bits + 7) >> 3));
			const top = bits % 8;
			if (top) bytes[0] &= (1 << top) - 1;
			return bigOf(bytes);
		};
		let p;
		for (;;) {
			const kBits = modulusLength - qBits;
			// p = k*q + 1 with the top bit of p set and k even so that p is odd
			let k = random(kBits) | (1n << BigInt(kBits - 1));
			k &= ~1n;
			const candidate = k * q + 1n;
			if (candidate.toString(2).length !== modulusLength) continue;
			if (SMALL_PRIMES.some((sp) => candidate % sp === 0n && candidate !== sp)) continue;
			if (isProbablePrime(candidate)) {
				p = candidate;
				break;
			}
		}
		const e = (p - 1n) / q;
		let g = 1n;
		for (let h = 2n; g === 1n; h++) g = bigModPow(h, e, p);
		const x = (random(qBits) % (q - 1n)) + 1n;
		const y = bigModPow(g, x, p);
		return { p: bytesOfBig(p), q: bytesOfBig(q), g: bytesOfBig(g), x: bytesOfBig(x), y: bytesOfBig(y) };
	};

	const createKey = (key, wantPrivate) => {
		if (key && typeof key === "object" && !(key instanceof KeyObject) && typeof key.format === "string" && key.format.startsWith("raw-")) return createRawKey(key, wantPrivate);
		const parsed = parseInput(key, { wantPrivate });
		if (parsed.keyObject) {
			if (wantPrivate) return parsed.keyObject;
			// createPublicKey(privateKeyObject): the public half
			const asym = parsed.keyObject._asym;
			if (parsed.keyObject.type === "public") return parsed.keyObject;
			return makeKey({ ...asym.info, private: true }, true);
		}
		if (parsed.jwk) {
			const imported = importJwk(parsed.jwk, wantPrivate);
			return makeKey(infoOf(imported.data, undefined, imported.isPrivate && wantPrivate), !wantPrivate);
		}
		const info = infoOf(parsed.data, parsed.passphrase, wantPrivate);
		return makeKey(info, !wantPrivate);
	};

	const rsaPkcs1Public = (info) => derSeq(derInt(info.modulus), derInt(info.exponent));
	const pkcs8 = (asym) => {
		const { info, priv } = asym;
		if (info.okp || info.dsa || info.pqc) return priv;
		if (info.type === "rsa") return derSeq(derInt(Uint8Array.of(0)), derSeq(derOid(OID_RSA), derNull()), derOctets(priv));
		// The curve is named in the algorithm identifier, so the ECPrivateKey inside leaves out its own copy.
		const sec1 = readTlv(priv, 0);
		const parts = readChildren(priv, sec1).filter((c) => c.tag !== 0xa0).map((c) => priv.subarray(c.pos, c.next));
		return derSeq(derInt(Uint8Array.of(0)), derSeq(derOid(OID_EC), derOid(CURVE_OIDS[canonicalCurve(info.curve)])), derOctets(derSeq(...parts)));
	};
	const exportRaw = (key, format) => {
		const p = key._asym.info.pqc;
		const wrongFormat = () => codeError(TypeError, "ERR_INVALID_ARG_VALUE", `The property 'options.format' is invalid. Received '${format}'`);
		if (!p) throw wrongFormat();
		if (format === "raw-public") {
			if (key.type !== "public") throw wrongFormat();
			return buf(p.pub);
		}
		if (key.type !== "private") throw wrongFormat();
		if (format === "raw-seed" ? p.type.kind === "slh" : p.type.kind !== "slh") {
			throw codeError(Error, "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS", "The selected key encoding is incompatible with the key type");
		}
		if (format === "raw-seed") {
			if (!p.seed) throw codeError(Error, "ERR_CRYPTO_OPERATION_FAILED", "Failed to get raw seed");
			return buf(p.seed);
		}
		return buf(p.expanded);
	};
	const exportKey = (key, options = {}) => {
		if (key.type === "secret") {
			if (options.format === "jwk") return { kty: "oct", k: b64u(key._keyData) };
			return buf(key._keyData);
		}
		const asym = key._asym;
		const format = options.format ?? "pem";
		if (format === "jwk") return exportJwk(key);
		if (format === "raw-public" || format === "raw-seed" || format === "raw-private") return exportRaw(key, format);
		if (format !== "pem" && format !== "der") throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", `The property 'options.format' is invalid. Received '${format}'`);
		const type = options.type;
		const protect = options.cipher !== undefined || options.passphrase !== undefined;
		if (protect && key.type === "private") {
			if (options.cipher === undefined || options.passphrase === undefined) {
				const missing = options.cipher === undefined ? "cipher" : "passphrase";
				throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", `The property 'options.${missing}' is invalid. Received undefined`);
			}
			const cipherName = String(options.cipher).toLowerCase();
			const label0 = type === "pkcs1" ? "RSA PRIVATE KEY" : type === "sec1" ? "EC PRIVATE KEY" : "PRIVATE KEY";
			if (type === "pkcs1" && asym.info.type !== "rsa") throw codeError(Error, "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS", "The selected key encoding pkcs1 can only be used for RSA keys.");
			if (type === "sec1" && asym.info.type !== "ec") throw codeError(Error, "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS", "The selected key encoding sec1 can only be used for EC keys.");
			if (type === "pkcs1" || type === "sec1") {
				if (format === "der") throw codeError(Error, "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS", `The selected key encoding ${type} does not support encryption.`);
				return pkcs.encryptLegacyPem(label0, asym.priv, options.passphrase, cipherName);
			}
			const encrypted = pkcs.encryptPkcs8(pkcs8(asym), options.passphrase, cipherName);
			return format === "der" ? buf(encrypted) : pem("ENCRYPTED PRIVATE KEY", encrypted);
		}
		let der;
		let label;
		if (key.type === "public") {
			if (type === "pkcs1") {
				if (asym.info.type !== "rsa") throw codeError(Error, "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS", "The selected key encoding pkcs1 can only be used for RSA keys.");
				der = rsaPkcs1Public(asym.info);
				label = "RSA PUBLIC KEY";
			} else if (type === "spki" || type === undefined) {
				der = asym.spki;
				label = "PUBLIC KEY";
			} else {
				throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", `The property 'options.type' is invalid. Received '${type}'`);
			}
		} else if (type === "pkcs1") {
			if (asym.info.type !== "rsa") throw codeError(Error, "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS", "The selected key encoding pkcs1 can only be used for RSA keys.");
			der = asym.priv;
			label = "RSA PRIVATE KEY";
		} else if (type === "sec1") {
			if (asym.info.type !== "ec") throw codeError(Error, "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS", "The selected key encoding sec1 can only be used for EC keys.");
			der = asym.priv;
			label = "EC PRIVATE KEY";
		} else if (type === "pkcs8" || type === undefined) {
			der = pkcs8(asym);
			label = "PRIVATE KEY";
		} else {
			throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", `The property 'options.type' is invalid. Received '${type}'`);
		}
		return format === "der" ? buf(der) : pem(label, der);
	};

	Object.defineProperties(KeyObject.prototype, {
		asymmetricKeyType: {
			get() {
				const info = this._asym?.info;
				return info ? info.type : undefined;
			},
		},
		asymmetricKeyDetails: {
			get() {
				const info = this._asym?.info;
				if (!info) return undefined;
				if (info.type === "rsa") return { modulusLength: info.bits, publicExponent: BigInt(`0x${buf(info.exponent).toString("hex")}`) };
				if (info.okp || info.pqc) return {};
				if (info.dsa) return { modulusLength: info.bits, divisorLength: info.divisorLength };
				return { namedCurve: info.curve === "secp256r1" ? "prime256v1" : info.curve };
			},
		},
	});
	KeyObject.prototype.export = function (options) {
		return exportKey(this, options);
	};
	KeyObject.prototype.equals = function (other) {
		if (!(other instanceof KeyObject) || other.type !== this.type) return false;
		if (this.type === "secret") return buf(this._keyData).equals(buf(other._keyData));
		return buf(this._asym.spki).equals(buf(other._asym.spki)) && buf(this._asym.priv ?? []).equals(buf(other._asym.priv ?? []));
	};

	/* ---------------------------------------------------------------------------- key generation */

	const generate = (type, options = {}) => {
		options ??= {};
		const kind = String(type).toLowerCase();
		if (UNSUPPORTED_KEY_TYPES.includes(kind)) throw unavailable(`generateKeyPair('${type}')`, "Diffie-Hellman key pairs are not implemented; use createDiffieHellman");
		let generated;
		if (Object.hasOwn(pqc.types, type)) {
			const info = pqcInfo(pqc.types[type], pqc.generate(pqc.types[type]), true);
			const encodePqc = (key, encoding) => (encoding ? exportKey(key, encoding) : key);
			return { publicKey: encodePqc(makeKey(info, true), options.publicKeyEncoding), privateKey: encodePqc(makeKey(info, false), options.privateKeyEncoding) };
		}
		if (OKP_BY_TYPE[kind]) {
			const seed = new Uint8Array(native.randomBytes(OKP_SIZE[kind]));
			const info = okpInfo(kind, seed, okpPublic(kind, seed));
			const encodeOkp = (key, encoding) => (encoding ? exportKey(key, encoding) : key);
			return { publicKey: encodeOkp(makeKey(info, true), options.publicKeyEncoding), privateKey: encodeOkp(makeKey(info, false), options.privateKeyEncoding) };
		}
		if (kind === "dsa") {
			const L = options.modulusLength;
			if (!Number.isInteger(L)) throw invalidArg("options.modulusLength", "of type number", L);
			const N = options.divisorLength ?? (L >= 2048 ? 256 : 160);
			if (L < 512 || N < 8 || N >= L) throw codeError(RangeError, "ERR_OUT_OF_RANGE", "The property 'options.divisorLength' is out of range.");
			const dsa = generateDsa(L, N);
			const info = dsaInfo(dsa);
			const encodeDsa = (key, encoding) => (encoding ? exportKey(key, encoding) : key);
			return { publicKey: encodeDsa(makeKey(info, true), options.publicKeyEncoding), privateKey: encodeDsa(makeKey(info, false), options.privateKeyEncoding) };
		}
		if (kind === "rsa" || kind === "rsa-pss") {
			const bits = options.modulusLength;
			if (!Number.isInteger(bits)) throw invalidArg("options.modulusLength", "of type number", bits);
			if (bits < 512) throw codeError(RangeError, "ERR_OUT_OF_RANGE", `The property 'options.modulusLength' is out of range. Received ${bits}`);
			generated = native.generateKey("rsa", bits, options.publicExponent);
		} else if (kind === "ec") {
			if (typeof options.namedCurve !== "string") throw invalidArg("options.namedCurve", "of type string", options.namedCurve);
			try {
				generated = native.generateKey("ec", options.namedCurve);
			} catch (err) {
				throw codeError(TypeError, "ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name");
			}
		} else {
			throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", `The argument 'type' must be a supported key type. Received '${type}'`);
		}
		const priv = makeKey(native.keyInfo(generated.pkcs, undefined, true), false);
		const pub = makeKey(native.keyInfo(generated.spki, undefined, false), true);
		const encode = (key, encoding) => (encoding ? exportKey(key, encoding) : key);
		return { publicKey: encode(pub, options.publicKeyEncoding), privateKey: encode(priv, options.privateKeyEncoding) };
	};
	const generateKeyPairSync = (type, options) => generate(type, options);
	const generateKeyPair = (type, options, callback) => {
		if (typeof options === "function") {
			callback = options;
			options = undefined;
		}
		if (typeof callback !== "function") throw invalidArg("callback", "of type function", callback);
		let result;
		let failure = null;
		try {
			result = generate(type, options);
		} catch (err) {
			failure = err;
		}
		queueMicrotask(() => (failure ? callback(failure) : callback(null, result.publicKey, result.privateKey)));
	};
	const generateKeySync = (type, options) => {
		if (type !== "hmac" && type !== "aes") throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", `The argument 'type' must be one of: 'hmac', 'aes'. Received '${type}'`);
		const length = options?.length;
		if (!Number.isInteger(length)) throw invalidArg("options.length", "of type number", length);
		return new KeyObject("secret", native.randomBytes(length >> 3));
	};

	/* ------------------------------------------------------------------------- sign and verify */

	const RSA_PSS = 6;
	const digestOf = (algorithm, verbose) => {
		try {
			// A null algorithm means the key type decides (Ed25519, Ed448); for the others sha256 is what Node's one-shot calls use.
			return hashName(algorithm === null || algorithm === undefined ? "sha256" : algorithm);
		} catch {
			throw codeError(TypeError, "ERR_CRYPTO_INVALID_DIGEST", verbose ? `Invalid digest: ${algorithm}` : "Invalid digest");
		}
	};
	const dsaDerToRaw = (der, size) => {
		const top = readTlv(der, 0);
		const [r, s] = readChildren(der, top).map((c) => pad(unsignedBytes(der, c), size));
		return join([r, s]);
	};
	const dsaRawToDer = (raw) => {
		const half = raw.length >> 1;
		return derSeq(derInt(raw.subarray(0, half)), derInt(raw.subarray(half)));
	};

	/* How Node words what a bad argument was: `type string ('x')`, `an instance of ArrayBuffer`, `undefined`. */
	const received = (value) => {
		if (value === null || value === undefined) return String(value);
		if (typeof value === "function") return `function ${value.name}`;
		if (typeof value === "object") return value.constructor?.name ? `an instance of ${value.constructor.name}` : "an object";
		let shown = typeof value === "string" ? value : typeof value === "bigint" ? `${value}n` : String(value);
		if (typeof value === "string") {
			if (shown.length > 25) shown = `${shown.slice(0, 25)}...`;
			shown = shown.includes("'") ? (shown.includes('"') ? `\`${shown}\`` : `"${shown}"`) : `'${shown}'`;
		}
		return `type ${typeof value} (${shown})`;
	};
	/* The `context` option of sign and verify: at most 255 bytes of a Buffer, TypedArray or DataView. */
	const contextOf = (options) => {
		const context = options?.context;
		if (context === undefined) return undefined;
		if (!ArrayBuffer.isView(context)) {
			throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "options.context" property must be an instance of Buffer, TypedArray, or DataView. Received ${received(context)}`);
		}
		if (context.byteLength > 255) throw codeError(RangeError, "ERR_OUT_OF_RANGE", "context string must be at most 255 bytes");
		return new Uint8Array(context.buffer, context.byteOffset, context.byteLength);
	};
	const noContext = () => codeError(Error, "ERR_CRYPTO_OPERATION_FAILED", "Context parameter is unsupported");
	const notForKeyType = () => codeError(Error, "ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE", "error:03000096:digital envelope routines::operation not supported for this keytype");
	const invalidDigest = () => codeError(Error, "ERR_OSSL_INVALID_DIGEST", "error:1C80007A:Provider routines::invalid digest");
	/* Node's OpenSSL provider refuses BLAKE2 as the digest for RSA and classic DSA signing, but not for ECDSA: Node
	 * signs and verifies with it like any other digest. The native host's mbedTLS-backed signer has no BLAKE2 in its
	 * digest table (fg_c_md), so for the EC case the digest is computed here in JavaScript (node-blake2.js) and
	 * handed to the host as already-hashed bytes via pkSignRawEc/pkVerifyRawEc, which sign or verify it directly
	 * instead of hashing the message themselves. */
	const isBlake2Digest = (name) => name === "blake2b512" || name === "blake2s256";
	const digestNotAllowed = () => codeError(Error, "ERR_OSSL_DIGEST_NOT_ALLOWED", "error:1C8000AE:Provider routines::digest not allowed");

	const signOptions = (key) => {
		const parsed = parseInput(key, { wantPrivate: true });
		const options = parsed.options ?? {};
		return { parsed, padding: options.padding === RSA_PSS ? 1 : 0, saltLength: options.saltLength ?? -2, dsaEncoding: options.dsaEncoding ?? "der" };
	};

	const specialOf = (parsed, wantPrivate) => {
		if (parsed.keyObject) {
			const info = parsed.keyObject._asym.info;
			return info.okp || info.dsa || info.pqc ? info : null;
		}
		if (parsed.jwk) {
			const imported = importJwk(parsed.jwk, wantPrivate);
			const info = specialInfo(imported.data);
			return info;
		}
		if (parsed.data === undefined) return null;
		const info = specialInfo(parsed.data) ?? specialFromEncrypted(parsed.data, parsed.passphrase);
		return info;
	};
	const doSign = (algorithm, data, key, oneShot) => {
		const { parsed, padding, saltLength, dsaEncoding } = signOptions(key);
		const context = contextOf(parsed.options);
		const special = specialOf(parsed, true);
		if (special) {
			if (!special.private) throw codeError(Error, "ERR_OSSL_UNSUPPORTED", "error:1E08010C:DECODER routines::unsupported");
			if (special.pqc) {
				if (!oneShot) throw codeError(Error, "ERR_CRYPTO_UNSUPPORTED_OPERATION", "Unsupported crypto operation");
				if (special.pqc.type.kind === "kem") throw context ? noContext() : notForKeyType();
				if (algorithm !== null && algorithm !== undefined) throw invalidDigest();
				return pqc.sign(special.pqc.type, special.pqc.expanded, data, context ?? new Uint8Array(0));
			}
			if (special.okp) {
				if (!special.type.startsWith("ed")) throw codeError(Error, "ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE", "error:03000096:digital envelope routines::operation not supported for this keytype");
				if (algorithm !== null && algorithm !== undefined) throw codeError(Error, "ERR_OSSL_INVALID_DIGEST", "error:1C80007A:Provider routines::invalid digest");
				return new Uint8Array(native.eddsaSign(special.type, special.okp.seed, data));
			}
			const dsaDigest = digestOf(algorithm, oneShot);
			if (isBlake2Digest(dsaDigest)) throw digestNotAllowed();
			return dsaSign(special.dsa, dsaDigest, data, dsaEncoding);
		}
		if (context) throw noContext();
		const material = nativeKey(parsed, true);
		const digest = digestOf(algorithm, oneShot);
		let signature;
		if (isBlake2Digest(digest)) {
			const keyType = (material.info ?? infoOf(material.data, material.passphrase, true)).type;
			if (keyType !== "ec") throw digestNotAllowed();
			signature = native.pkSignRawEc(material.data, material.passphrase, newBlake2(digest).update(data).digest());
		} else {
			signature = native.pkSignEx(digest, material.data, material.passphrase, data, padding, saltLength === -1 ? -1 : saltLength);
		}
		const info = material.info ?? (parsed.keyObject ? parsed.keyObject._asym.info : null);
		if (dsaEncoding === "ieee-p1363") {
			const keyInfo = info ?? infoOf(material.data, material.passphrase, true);
			if (keyInfo.type === "ec") signature = dsaDerToRaw(signature, (keyInfo.bits + 7) >> 3);
		}
		return signature;
	};
	const doVerify = (algorithm, data, key, signature, oneShot) => {
		const parsed = parseInput(key, { wantPrivate: false });
		const options = parsed.options ?? {};
		const context = contextOf(parsed.options);
		const special = specialOf(parsed, false);
		if (special) {
			if (special.pqc) {
				if (!oneShot) throw codeError(Error, "ERR_CRYPTO_UNSUPPORTED_OPERATION", "Unsupported crypto operation");
				if (special.pqc.type.kind === "kem") throw context ? noContext() : notForKeyType();
				if (algorithm !== null && algorithm !== undefined) throw invalidDigest();
				return pqc.verify(special.pqc.type, special.pqc.pub, data, toBytes(signature), context ?? new Uint8Array(0));
			}
			if (special.okp) {
				if (!special.type.startsWith("ed")) throw codeError(Error, "ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE", "error:03000096:digital envelope routines::operation not supported for this keytype");
				if (algorithm !== null && algorithm !== undefined) throw codeError(Error, "ERR_OSSL_INVALID_DIGEST", "error:1C80007A:Provider routines::invalid digest");
				return native.eddsaVerify(special.type, special.okp.pub, data, toBytes(signature));
			}
			const dsaDigest = digestOf(algorithm, oneShot);
			if (isBlake2Digest(dsaDigest)) {
				if (oneShot) throw digestNotAllowed();
				return false;
			}
			return dsaVerify(special.dsa, dsaDigest, data, toBytes(signature), options.dsaEncoding ?? "der");
		}
		if (context) throw noContext();
		const material = nativeKey(parsed, false);
		let bytes = toBytes(signature);
		const digest = digestOf(algorithm, oneShot);
		let info = material.info ?? null;
		let ecBlake2 = false;
		if (isBlake2Digest(digest)) {
			info ??= infoOf(material.data, material.passphrase, false);
			if (info.type !== "ec") {
				if (oneShot) throw digestNotAllowed();
				return false;
			}
			ecBlake2 = true;
		}
		if ((options.dsaEncoding ?? "der") === "ieee-p1363") {
			info ??= infoOf(material.data, material.passphrase, false);
			if (info.type === "ec") bytes = dsaRawToDer(bytes);
		}
		if (ecBlake2) return native.pkVerifyRawEc(material.data, newBlake2(digest).update(data).digest(), bytes);
		return native.pkVerifyEx(digest, material.data, data, bytes, options.padding === RSA_PSS ? 1 : 0, options.saltLength ?? -2);
	};

	class Sign extends stream.Writable {
		constructor(algorithm) {
			super();
			this._algorithm = algorithm;
			digestOf(algorithm, false);
			this._chunks = [];
		}
		update(data, encoding) {
			this._chunks.push(toBytes(data, encoding));
			return this;
		}
		_write(chunk, encoding, callback) {
			this._chunks.push(toBytes(chunk, encoding === "buffer" ? undefined : encoding));
			callback();
		}
		sign(privateKey, outputEncoding) {
			return out(doSign(this._algorithm, concat(this._chunks), privateKey), outputEncoding);
		}
	}
	class Verify extends stream.Writable {
		constructor(algorithm) {
			super();
			this._algorithm = algorithm;
			digestOf(algorithm, false);
			this._chunks = [];
		}
		update(data, encoding) {
			this._chunks.push(toBytes(data, encoding));
			return this;
		}
		_write(chunk, encoding, callback) {
			this._chunks.push(toBytes(chunk, encoding === "buffer" ? undefined : encoding));
			callback();
		}
		verify(publicKey, signature, signatureEncoding) {
			return doVerify(this._algorithm, concat(this._chunks), publicKey, toBytes(signature, signatureEncoding));
		}
	}
	const oneShotAlgorithm = (algorithm) => algorithm;
	const sign = (algorithm, data, key, callback) => {
		const compute = () => buf(doSign(oneShotAlgorithm(algorithm), toBytes(data), key, true));
		if (typeof callback !== "function") return compute();
		let result;
		let failure = null;
		try {
			result = compute();
		} catch (err) {
			failure = err;
		}
		queueMicrotask(() => (failure ? callback(failure) : callback(null, result)));
		return undefined;
	};
	const verify = (algorithm, data, key, signature, callback) => {
		const compute = () => doVerify(oneShotAlgorithm(algorithm), toBytes(data), key, toBytes(signature), true);
		if (typeof callback !== "function") return compute();
		let result;
		let failure = null;
		try {
			result = compute();
		} catch (err) {
			failure = err;
		}
		queueMicrotask(() => (failure ? callback(failure) : callback(null, result)));
		return undefined;
	};

	/* ------------------------------------------------------------------------- ML-KEM key encapsulation */

	let unwrapCryptoKey = (key) => key;
	const kemKey = (key, wantPrivate, failure) => {
		const parsed = parseInput(unwrapCryptoKey(key), { wantPrivate });
		const info = specialOf(parsed, wantPrivate);
		if (!info?.pqc || info.pqc.type.kind !== "kem") throw codeError(Error, "ERR_CRYPTO_OPERATION_FAILED", failure);
		return info.pqc;
	};
	const encapsulate = (key, callback) => {
		const compute = () => {
			const kem = kemKey(key, false, "Failed to perform encapsulation");
			const { sharedKey, ciphertext } = pqc.encapsulate(kem.type, kem.pub);
			return { sharedKey: buf(sharedKey), ciphertext: buf(ciphertext) };
		};
		return callback === undefined ? compute() : later(compute, callback);
	};
	const decapsulate = (key, ciphertext, callback) => {
		const compute = () => {
			const kem = kemKey(key, true, "Failed to perform decapsulation");
			if (typeof ciphertext !== "string" && !ArrayBuffer.isView(ciphertext) && !(ciphertext instanceof ArrayBuffer)) {
				throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "ciphertext" argument must be of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView. Received ${received(ciphertext)}`);
			}
			const sharedKey = pqc.decapsulate(kem.type, kem.expanded, toBytes(ciphertext));
			if (!sharedKey) throw codeError(Error, "ERR_CRYPTO_OPERATION_FAILED", "Failed to perform decapsulation");
			return buf(sharedKey);
		};
		return callback === undefined ? compute() : later(compute, callback);
	};

	/* ---------------------------------------------------------------------------- RSA encryption */

	const rsaOp = (op, key, data, defaultPadding) => {
		const parsed = parseInput(key, { wantPrivate: op === 1 || op === 2 });
		if (specialOf(parsed, op === 1 || op === 2)?.pqc) throw notForKeyType();
		const options = parsed.options ?? {};
		const padding = options.padding ?? defaultPadding;
		if (padding !== 1 && padding !== 4) {
			throw unavailable(`RSA padding ${padding}`, "only RSA_PKCS1_PADDING (1) and RSA_PKCS1_OAEP_PADDING (4) are supported");
		}
		const material = nativeKey(parsed, op === 1 || op === 2);
		const label = options.oaepLabel === undefined ? undefined : toBytes(options.oaepLabel);
		return buf(native.rsaCrypt(op, material.data, material.passphrase, toBytes(data), padding, options.oaepHash ? hashName(options.oaepHash) : "sha1", label));
	};

	/* ------------------------------------------------------------------------------------ ECDH */

	const ecdhCurve = (name) => {
		if (typeof name !== "string") throw invalidArg("curve", "of type string", name);
		return name;
	};
	const toBuf = (value, encoding) => toBytes(value, encoding);
	class ECDH {
		constructor(curve) {
			this._curve = ecdhCurve(curve);
			try {
				native.ecdhGenerate(this._curve, undefined);
			} catch (err) {
				throw codeError(TypeError, "ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name");
			}
			this._priv = null;
			this._pub = null;
		}
		generateKeys(encoding, format) {
			const keys = native.ecdhGenerate(this._curve, undefined);
			this._priv = keys.priv;
			this._pub = keys.pub;
			return this.getPublicKey(encoding, format);
		}
		computeSecret(otherPublicKey, inputEncoding, outputEncoding) {
			if (!this._priv) throw codeError(Error, "ERR_CRYPTO_OPERATION_FAILED", "Failed to get ECDH private key");
			const secret = native.ecdhCompute(this._curve, this._priv, toBuf(otherPublicKey, inputEncoding));
			return noneOr(secret, outputEncoding);
		}
		getPublicKey(encoding, format = "uncompressed") {
			if (!this._pub) throw codeError(Error, "ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY", "Failed to get ECDH public key");
			return noneOr(convertPoint(this._curve, this._pub, format), encoding);
		}
		getPrivateKey(encoding) {
			if (!this._priv) throw codeError(Error, "ERR_CRYPTO_OPERATION_FAILED", "Failed to get ECDH private key");
			return noneOr(strip(this._priv), encoding);
		}
		setPrivateKey(privateKey, encoding) {
			const keys = (() => {
				try {
					return native.ecdhGenerate(this._curve, toBuf(privateKey, encoding));
				} catch (err) {
					throw codeError(RangeError, "ERR_CRYPTO_INVALID_KEYTYPE", "Private key is not valid for specified curve.");
				}
			})();
			this._priv = keys.priv;
			this._pub = keys.pub;
		}
		setPublicKey(publicKey, encoding) {
			this._pub = native.ecdhConvert(this._curve, toBuf(publicKey, encoding), 1);
		}
		static convertKey(key, curve, inputEncoding, outputEncoding, format = "uncompressed") {
			if (typeof key !== "string" && !ArrayBuffer.isView(key)) throw invalidArg("key", "of type string or an instance of Buffer, TypedArray, or DataView", key);
			const point = toBuf(key, inputEncoding);
			const uncompressed = native.ecdhConvert(ecdhCurve(curve), point, 1);
			return noneOr(convertPoint(curve, uncompressed, format), outputEncoding);
		}
	}
	const convertPoint = (curve, point, format) => {
		if (format === "compressed") return native.ecdhConvert(curve, point, 0);
		if (format === "hybrid") {
			const size = (point.length - 1) >> 1;
			const hybrid = point.slice();
			hybrid[0] = 6 | (point[point.length - 1] & 1);
			return hybrid.subarray(0, 1 + 2 * size);
		}
		if (format !== "uncompressed") throw codeError(TypeError, "ERR_CRYPTO_ECDH_INVALID_FORMAT", `Invalid ECDH format: ${format}`);
		return native.ecdhConvert(curve, point, 1);
	};
	const createECDH = (curve) => new ECDH(curve);

	/* The scalar and point of an EC key object, for crypto.diffieHellman. */
	const diffieHellman = (options) => {
		const { privateKey, publicKey } = options ?? {};
		if (!(privateKey instanceof KeyObject) || privateKey.type !== "private") throw invalidArg("options.privateKey", "an instance of KeyObject of type private", privateKey);
		if (!(publicKey instanceof KeyObject) || publicKey.type !== "public") throw invalidArg("options.publicKey", "an instance of KeyObject of type public", publicKey);
		const a = privateKey._asym.info;
		const b = publicKey._asym.info;
		if (a.okp && b.okp) {
			if (a.type !== b.type || !a.type.startsWith("x")) throw codeError(Error, "ERR_CRYPTO_INCOMPATIBLE_KEY", "Incompatible key types for Diffie-Hellman");
			const secret = new Uint8Array(native.ecdhCompute(a.type, okpClamp(a.type, a.okp.seed), b.okp.pub));
			if (secret.every((byte) => byte === 0)) throw codeError(Error, "ERR_CRYPTO_OPERATION_FAILED", "Failed to compute ECDH key");
			return buf(secret);
		}
		if (a.pqc || b.pqc) throw codeError(Error, "ERR_CRYPTO_INCOMPATIBLE_KEY", `Incompatible key types for Diffie-Hellman: ${a.type} and ${b.type}`);
		if (a.type !== "ec" || b.type !== "ec") throw unavailable("crypto.diffieHellman for this key type", "only EC and X25519/X448 keys are supported");
		if (a.curve !== b.curve) throw codeError(Error, "ERR_CRYPTO_INCOMPATIBLE_KEY", "Incompatible key types for Diffie-Hellman: different curves");
		return buf(native.ecdhCompute(a.curve, ecPrivateScalar(privateKey._asym.priv), ecPointOfSpki(publicKey._asym.spki)));
	};

	/* ---------------------------------------------------------------------- Diffie-Hellman groups */

	const bigOf = (bytes) => {
		let hex = "";
		for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
		return BigInt(`0x${hex || "0"}`);
	};
	const bytesOfBig = (n) => {
		let hex = n.toString(16);
		if (hex.length & 1) hex = `0${hex}`;
		return new Uint8Array(Buffer.from(hex, "hex"));
	};
	const strip = (bytes) => {
		let i = 0;
		while (i < bytes.length - 1 && bytes[i] === 0) i++;
		return bytes.subarray(i);
	};
	class DiffieHellman {
		constructor(prime, primeEncoding, generator, generatorEncoding, verifyErrorOverride) {
			if (typeof prime === "number") {
				if (prime < 512) throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", "Invalid DH parameters");
				if (prime > 16384) throw codeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "sizeOrKey" is out of range. Received ${prime}`);
				this._prime = native.genPrime(prime, true);
				this._generator = Uint8Array.of(typeof primeEncoding === "number" ? primeEncoding : 2);
			} else {
				this._prime = strip(toBuf(prime, primeEncoding));
				this._generator = generator === undefined ? Uint8Array.of(2) : typeof generator === "number" ? Uint8Array.of(generator) : strip(toBuf(generator, generatorEncoding));
				if (this._generator.length === 1 && this._generator[0] < 2) throw codeError(RangeError, "ERR_OSSL_DH_BAD_GENERATOR", "bad generator");
			}
			this._verifyError = verifyErrorOverride;
			this._priv = null;
			this._pub = null;
		}
		get verifyError() {
			if (this._verifyError !== undefined) return this._verifyError;
			if (bigOf(this._prime).toString(2).length < 512) return 128; // DH_MODULUS_TOO_SMALL
			if (!native.isPrime(this._prime, 20)) return 1;
			const half = (bigOf(this._prime) - 1n) >> 1n;
			return native.isPrime(bytesOfBig(half), 20) ? 0 : 2;
		}
		generateKeys(encoding) {
			const size = this._prime.length;
			let priv;
			do {
				priv = native.randomBytes(size);
				priv[0] &= 0x7f;
				priv = strip(priv);
			} while (bigOf(priv) < 2n);
			this._priv = priv;
			this._pub = strip(native.modPow(this._generator, priv, this._prime));
			return noneOr(this._pub, encoding);
		}
		computeSecret(otherPublicKey, inputEncoding, outputEncoding) {
			if (!this._priv) throw codeError(Error, "ERR_CRYPTO_OPERATION_FAILED", "Failed to compute DH secret: no private key");
			const peer = toBuf(otherPublicKey, inputEncoding);
			const value = bigOf(peer);
			if (value <= 1n) throw codeError(RangeError, "ERR_CRYPTO_INVALID_KEYLEN", "Supplied key is too small");
			if (value >= bigOf(this._prime) - 1n) throw codeError(RangeError, "ERR_CRYPTO_INVALID_KEYLEN", "Supplied key is too large");
			const secret = native.modPow(peer, this._priv, this._prime);
			return noneOr(pad(secret, this._prime.length), outputEncoding);
		}
		getPrime(encoding) {
			return noneOr(this._prime, encoding);
		}
		getGenerator(encoding) {
			return noneOr(this._generator, encoding);
		}
		getPublicKey(encoding) {
			if (!this._pub) throw codeError(Error, "ERR_CRYPTO_INVALID_STATE", "No public key - did you forget to generate one?");
			return noneOr(this._pub, encoding);
		}
		getPrivateKey(encoding) {
			if (!this._priv) throw codeError(Error, "ERR_CRYPTO_INVALID_STATE", "No private key - did you forget to generate one?");
			return noneOr(this._priv, encoding);
		}
		setPublicKey(key, encoding) {
			this._pub = strip(toBuf(key, encoding));
		}
		setPrivateKey(key, encoding) {
			this._priv = strip(toBuf(key, encoding));
		}
	}
	const createDiffieHellman = (...args) => {
		const [first, second, third, fourth] = args;
		if (typeof first === "number") return new DiffieHellman(first, second);
		if (typeof second === "string" && typeof third !== "undefined") return new DiffieHellman(first, second, third, fourth);
		if (typeof second === "string") return new DiffieHellman(first, second);
		return new DiffieHellman(first, undefined, second, third);
	};
	const getDiffieHellman = (name) => {
		const hex = MODP_PRIMES[name];
		if (!hex) throw codeError(Error, "ERR_CRYPTO_UNKNOWN_DH_GROUP", "Unknown DH group");
		const group = new DiffieHellman(new Uint8Array(Buffer.from(hex, "hex")), undefined, 2, undefined, 0);
		// A named group has no way to set its keys.
		group.setPrivateKey = undefined;
		group.setPublicKey = undefined;
		return group;
	};

	/* --------------------------------------------------------------------------------- primes */

	const primeCandidate = (candidate) => {
		if (typeof candidate === "bigint") return bytesOfBig(candidate);
		if (candidate instanceof ArrayBuffer) return new Uint8Array(candidate);
		if (ArrayBuffer.isView(candidate)) return new Uint8Array(candidate.buffer, candidate.byteOffset, candidate.byteLength);
		throw invalidArg("candidate", "an instance of ArrayBuffer, SharedArrayBuffer, TypedArray, Buffer, DataView, or bigint", candidate);
	};
	const generatePrimeSync = (size, options = {}) => {
		if (!Number.isInteger(size) || size < 1) throw codeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "size" is out of range. It must be >= 1. Received ${size}`);
		if (options.add !== undefined || options.rem !== undefined) throw unavailable("generatePrime with add/rem", "constrained prime generation is not implemented");
		const bytes = native.genPrime(size, Boolean(options.safe));
		if (options.bigint) return bigOf(bytes);
		return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	};
	const checkPrimeSync = (candidate, options = {}) => native.isPrime(primeCandidate(candidate), options.checks ?? 0);
	const later = (compute, callback, undefinedError = false) => {
		if (typeof callback !== "function") throw invalidArg("callback", "of type function", callback);
		let result;
		let failure = null;
		try {
			result = compute();
		} catch (err) {
			failure = err;
		}
		queueMicrotask(() => (failure ? callback(failure) : callback(undefinedError ? undefined : null, result)));
	};
	const generatePrime = (size, options, callback) => {
		if (typeof options === "function") {
			callback = options;
			options = {};
		}
		later(() => generatePrimeSync(size, options), callback, true);
	};
	const checkPrime = (candidate, options, callback) => {
		if (typeof options === "function") {
			callback = options;
			options = {};
		}
		later(() => checkPrimeSync(candidate, options), callback, true);
	};

	/* ------------------------------------------------------------------------------ X509 */

	const shortMonth = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	const asnDate = (iso) => {
		const m = /^(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)Z$/.exec(iso);
		return `${shortMonth[Number(m[2]) - 1]} ${String(Number(m[3])).padStart(2, " ")} ${m[4]}:${m[5]}:${m[6]} ${m[1]} GMT`;
	};
	const colon = (bytes) => buf(bytes).toString("hex").toUpperCase().replace(/(..)(?!$)/g, "$1:");
	const fingerprint = (algorithm, raw) => colon(native.hash(algorithm, raw));
	const dnObject = (pairs) => {
		const result = { __proto__: null };
		for (const [key, value] of pairs) {
			if (key in result) result[key] = Array.isArray(result[key]) ? [...result[key], value] : [result[key], value];
			else result[key] = value;
		}
		return result;
	};
	const dnString = (pairs) => pairs.map(([k, v]) => `${k}=${v}`).join("\n");
	const altNameText = (alt) => alt.map(([kind, value]) => `${kind}:${kind === "DNS" || kind === "URI" || kind === "email" ? value : value}`).join(", ");

	/* The object tls.TLSSocket#getPeerCertificate returns. */
	const legacyCertificate = (info, forTls) => {
		const cert = { __proto__: null };
		cert.subject = dnObject(info.subject);
		cert.issuer = dnObject(info.issuer);
		if (info.altNames.length) cert.subjectaltname = altNameText(info.altNames);
		if (forTls) cert.infoAccess = undefined;
		cert.ca = info.ca;
		if (info.type === "rsa") {
			cert.modulus = buf(info.modulus).toString("hex").toUpperCase();
			cert.exponent = `0x${buf(info.exponent).toString("hex").replace(/^0+/, "")}`;
			cert.pubkey = buf(info.spki);
			cert.bits = info.bits;
		} else if (info.type === "ec") {
			cert.pubkey = buf(info.point);
			cert.bits = info.bits;
		}
		cert.valid_from = asnDate(info.validFrom);
		cert.valid_to = asnDate(info.validTo);
		cert.fingerprint = fingerprint("sha1", info.raw);
		cert.fingerprint256 = fingerprint("sha256", info.raw);
		cert.fingerprint512 = fingerprint("sha512", info.raw);
		if (info.extKeyUsage.length) cert.ext_key_usage = info.extKeyUsage;
		cert.serialNumber = info.serial;
		cert.raw = buf(info.raw);
		if (info.type === "ec") {
			cert.asn1Curve = info.curve === "secp256r1" ? "prime256v1" : info.curve;
			cert.nistCurve = JWK_CURVES[canonicalCurve(info.curve)];
		} else if (forTls) {
			cert.asn1Curve = undefined;
			cert.nistCurve = undefined;
		}
		return cert;
	};

	const hostMatches = (pattern, host) => {
		pattern = pattern.toLowerCase();
		host = host.toLowerCase();
		if (!pattern.includes("*")) return pattern === host;
		const p = pattern.split(".");
		const h = host.split(".");
		if (p.length !== h.length || p[0].indexOf("*") === -1 || p.slice(1).some((part) => part.includes("*"))) return false;
		if (p.length < 3) return false;
		const [head, tail] = p[0].split("*");
		return h[0].startsWith(head) && h[0].endsWith(tail) && h[0].length >= head.length + tail.length && p.slice(1).join(".") === h.slice(1).join(".");
	};
	const canonicalIp = (text) => {
		if (!text.includes(":")) return text;
		const [head, tail] = text.toLowerCase().split("::");
		const left = head ? head.split(":") : [];
		const right = tail === undefined ? [] : tail ? tail.split(":") : [];
		const fill = tail === undefined ? [] : Array(8 - left.length - right.length).fill("0");
		return [...left, ...fill, ...right].map((group) => group.replace(/^0+(?=.)/, "")).join(":");
	};
	/* The shortest spelling of an IPv6 address, as OpenSSL prints it in error text. */
	const compressIp = (text) => {
		if (!text.includes(":")) return text;
		const groups = canonicalIp(text).split(":");
		let best = { start: -1, length: 0 };
		for (let i = 0; i < groups.length; ) {
			if (groups[i] !== "0") {
				i++;
				continue;
			}
			let j = i;
			while (j < groups.length && groups[j] === "0") j++;
			if (j - i > best.length) best = { start: i, length: j - i };
			i = j;
		}
		if (best.length < 2) return groups.join(":");
		return `${groups.slice(0, best.start).join(":")}::${groups.slice(best.start + best.length).join(":")}`;
	};
	const isIpText = (text) => /^[0-9.]+$/.test(text) || text.includes(":");
	/* tls.checkServerIdentity: undefined when the certificate is valid for `hostname`, an Error when not. */
	const checkServerIdentity = (hostname, cert) => {
		const altnames = cert.subjectaltname ? String(cert.subjectaltname).split(", ") : [];
		const dns = altnames.filter((a) => a.startsWith("DNS:")).map((a) => a.slice(4));
		const ips = altnames.filter((a) => a.startsWith("IP Address:")).map((a) => compressIp(a.slice(11)));
		let reason;
		if (isIpText(hostname)) {
			if (!ips.includes(compressIp(hostname))) reason = `IP: ${hostname} is not in the cert's list: ${ips.join(", ")}`;
		} else if (dns.length) {
			if (!dns.some((name) => hostMatches(name, hostname))) reason = `Host: ${hostname}. is not in the cert's altnames: ${altnames.join(", ")}`;
		} else {
			const cn = cert.subject?.CN;
			const names = Array.isArray(cn) ? cn : cn ? [cn] : [];
			if (!names.some((name) => hostMatches(name, hostname))) reason = `Host: ${hostname}. is not cert's CN: ${names.join(", ")}`;
		}
		if (!reason) return undefined;
		return Object.assign(new Error(`Hostname/IP does not match certificate's altnames: ${reason}`), {
			code: "ERR_TLS_CERT_ALTNAME_INVALID",
			reason,
			host: hostname,
			cert,
		});
	};

	/* Whether `certificate` (as parsed by node-x509.js) was signed by `publicKey`. */
	const signatureVerifies = (certificate, publicKey) => {
		const info = publicKey._asym.info;
		const oid = certificate.signatureOid;
		if (oid === "1.3.101.112" || oid === "1.3.101.113") {
			const type = oid === "1.3.101.112" ? "ed25519" : "ed448";
			return Boolean(info.okp) && info.type === type && native.eddsaVerify(type, info.okp.pub, certificate.tbs, certificate.signature);
		}
		const hash = SIGNATURE_HASH[oid];
		if (!hash) return false;
		if (info.dsa) return dsaVerify(info.dsa, hash, certificate.tbs, certificate.signature, "der");
		try {
			return native.pkVerifyEx(hash, publicKey._asym.spki, certificate.tbs, certificate.signature, oid === "1.2.840.113549.1.1.10" ? 1 : 0, -2);
		} catch {
			return false;
		}
	};

	const certBytes = (value) => {
		if (typeof value === "string") return value;
		if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
			const bytes = toBytes(value);
			const text = buf(bytes).toString("latin1");
			return /^\s*-----BEGIN /.test(text) ? buf(bytes).toString("utf8") : bytes;
		}
		throw invalidArg("buffer", "of type string or an instance of Buffer, TypedArray, or DataView", value);
	};
	class X509Certificate {
		constructor(buffer) {
			const source = certBytes(buffer);
			try {
				this._info = native.x509Info(source);
			} catch (err) {
				// The host's C library does not know Ed25519, Ed448 or DSA: read those certificates here.
				try {
					this._info = parseCertificate(certificateBytes(source, Buffer), Buffer);
				} catch {
					throw codeError(Error, "ERR_OSSL_PEM_NO_START_LINE", "error:0480006C:PEM routines::no start line");
				}
			}
			this._legacy = null;
		}
		get raw() {
			return buf(this._info.raw);
		}
		get subject() {
			return dnString(this._info.subject);
		}
		get issuer() {
			return dnString(this._info.issuer);
		}
		get subjectAltName() {
			return this._info.altNames.length ? altNameText(this._info.altNames) : undefined;
		}
		get infoAccess() {
			return undefined;
		}
		get validFrom() {
			return asnDate(this._info.validFrom);
		}
		get validTo() {
			return asnDate(this._info.validTo);
		}
		get validFromDate() {
			return new Date(this._info.validFrom);
		}
		get validToDate() {
			return new Date(this._info.validTo);
		}
		get fingerprint() {
			return fingerprint("sha1", this._info.raw);
		}
		get fingerprint256() {
			return fingerprint("sha256", this._info.raw);
		}
		get fingerprint512() {
			return fingerprint("sha512", this._info.raw);
		}
		get keyUsage() {
			return this._info.extKeyUsage.length ? this._info.extKeyUsage : undefined;
		}
		get serialNumber() {
			return this._info.serial;
		}
		get ca() {
			return this._info.ca;
		}
		get publicKey() {
			return makeKey(infoOf(this._info.spki, undefined, false), true);
		}
		get issuerCertificate() {
			return undefined;
		}
		checkHost(name, options) {
			const dns = this._info.altNames.filter(([kind]) => kind === "DNS").map(([, value]) => value);
			const subject = options?.subject ?? "default";
			const common = this._info.subject.filter(([key]) => key === "CN").map(([, value]) => value);
			const candidates = subject === "always" ? [...dns, ...common] : subject === "never" || dns.length ? dns : common;
			return candidates.find((pattern) => hostMatches(pattern, String(name)));
		}
		checkEmail(email) {
			const match = this._info.altNames.some(([kind, value]) => kind === "email" && value.toLowerCase() === String(email).toLowerCase());
			return match ? email : undefined;
		}
		checkIP(ip) {
			const wanted = canonicalIp(String(ip));
			const found = this._info.altNames.find(([kind, value]) => kind === "IP Address" && canonicalIp(value) === wanted);
			return found ? String(ip) : undefined;
		}
		checkIssued(other) {
			if (!(other instanceof X509Certificate)) throw invalidArg("otherCert", "an instance of X509Certificate", other);
			try {
				return native.x509CheckIssued(this._info.raw, other._info.raw);
			} catch {
				// One of the two has a key or signature the host cannot read: compare the names and check the signature here.
				const child = parseCertificate(this._info.raw, Buffer);
				const parent = parseCertificate(other._info.raw, Buffer);
				if (dnString(child.issuer) !== dnString(parent.subject)) return false;
				return signatureVerifies(child, makeKey(infoOf(parent.spki, undefined, false), true));
			}
		}
		checkPrivateKey(privateKey) {
			if (!(privateKey instanceof KeyObject) || privateKey.type !== "private") throw invalidArg("privateKey", "an instance of KeyObject of type private", privateKey);
			return buf(this._info.spki).equals(buf(createKey(privateKey, false)._asym.spki));
		}
		verify(publicKey) {
			if (!(publicKey instanceof KeyObject) || publicKey.type !== "public") throw invalidArg("publicKey", "an instance of KeyObject of type public", publicKey);
			return signatureVerifies(parseCertificate(this._info.raw, Buffer), publicKey);
		}
		toString() {
			return pem("CERTIFICATE", this._info.raw);
		}
		toJSON() {
			return this.toString();
		}
		toLegacyObject() {
			return legacyCertificate(this._info);
		}
	}

	return {
		KeyObject,
		createPrivateKey: (key) => createKey(key, true),
		createPublicKey: (key) => createKey(key, false),
		generateKeyPair,
		generateKeyPairSync,
		encapsulate,
		decapsulate,
		setKeyUnwrapper: (fn) => {
			unwrapCryptoKey = fn;
		},
		generateKeySync,
		generateKey: (type, options, callback) => later(() => generateKeySync(type, options), callback),
		Sign,
		Verify,
		sign,
		verify,
		publicEncrypt: (key, data) => rsaOp(0, key, data, 4),
		privateDecrypt: (key, data) => rsaOp(1, key, data, 4),
		privateEncrypt: (key, data) => rsaOp(2, key, data, 1),
		publicDecrypt: (key, data) => rsaOp(3, key, data, 1),
		ECDH,
		createECDH,
		diffieHellman,
		DiffieHellman,
		DiffieHellmanGroup: DiffieHellman,
		createDiffieHellman,
		createDiffieHellmanGroup: getDiffieHellman,
		getDiffieHellman,
		generatePrime,
		generatePrimeSync,
		checkPrime,
		checkPrimeSync,
		X509Certificate,
		getCurves: () => [...CURVES].sort(),
		tools: {
			legacyCertificate,
			checkServerIdentity,
			asnDate,
			dnString,
			/* A .pfx / .p12 file (or an array of them, or { buf, passphrase }) -> PEM text for the TLS layer. */
			pfx(input, passphrase) {
				const first = Array.isArray(input) ? input[0] : input;
				let bytes = first;
				let password = passphrase;
				if (first && typeof first === "object" && !ArrayBuffer.isView(first) && first.buf !== undefined) {
					bytes = first.buf;
					password = first.passphrase ?? passphrase;
				}
				let parsed;
				try {
					parsed = pkcs.parsePkcs12(toBytes(bytes), password === undefined ? "" : password);
				} catch (err) {
					// Node reports the bare OpenSSL reason, with no code.
					if (err.code === "ERR_OSSL_PKCS12_MAC_VERIFY_FAILURE") throw new Error("mac verify failure");
					if (err.code === "ERR_OSSL_BAD_DECRYPT") throw new Error("mac verify failure");
					throw new Error("not enough data");
				}
				if (!parsed.key) throw codeError(Error, "ERR_OSSL_PKCS12_ERROR", "the PKCS#12 file holds no private key");
				return {
					key: pem("PRIVATE KEY", parsed.key),
					cert: parsed.certs.map((der) => pem("CERTIFICATE", der)).join(""),
				};
			},
		},
		constants: {
			RSA_PSS_SALTLEN_DIGEST: -1,
			RSA_PSS_SALTLEN_MAX_SIGN: -2,
			RSA_PSS_SALTLEN_AUTO: -2,
			DH_CHECK_P_NOT_SAFE_PRIME: 2,
			DH_CHECK_P_NOT_PRIME: 1,
			DH_UNABLE_TO_CHECK_GENERATOR: 4,
			DH_NOT_SUITABLE_GENERATOR: 8,
			RSA_X931_PADDING: 5,
		},
	};
}

export { createAsymmetric };
