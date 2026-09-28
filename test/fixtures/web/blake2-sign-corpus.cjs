/* Differential corpus: createSign/createVerify/crypto.sign/crypto.verify with a BLAKE2 digest (blake2b512,
   blake2s256). Node's OpenSSL provider refuses BLAKE2 as the digest for RSA and classic DSA in both the streaming
   Sign/Verify classes and the one-shot functions, with ERR_OSSL_DIGEST_NOT_ALLOWED, except that the streaming
   Verify.verify() swallows the error and returns false instead of throwing (as it does for any other bad digest).
   ECDSA is not restricted the same way: Node signs and verifies with a BLAKE2 digest like any other, DER-encoded or
   IEEE P1363 raw. Only signature lengths, booleans and error codes are printed, since ECDSA and DSA signing are
   randomized; a DER-encoded ECDSA signature also varies in length between runs (the sign path only reports that a
   buffer came back), while IEEE P1363's fixed width is safe to print. */
const crypto = require("crypto");

function report(label, fn) {
	try {
		const r = fn();
		console.log(label, "ok", typeof r === "boolean" ? r : r && r.length !== undefined ? r.length : r);
	} catch (e) {
		console.log(label, "err", e.code, "|", e.message);
	}
}

const { privateKey: rsaPriv, publicKey: rsaPub } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: dsaPriv, publicKey: dsaPub } = crypto.generateKeyPairSync("dsa", { modulusLength: 2048 });
const { privateKey: ecPriv, publicKey: ecPub } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });

for (const digest of ["blake2b512", "blake2s256"]) {
	report(`rsa stream sign ${digest}`, () => {
		const s = crypto.createSign(digest);
		s.update("hello");
		return s.sign(rsaPriv);
	});
	report(`rsa stream verify ${digest}`, () => {
		const v = crypto.createVerify(digest);
		v.update("hello");
		return v.verify(rsaPub, Buffer.alloc(256));
	});
	report(`rsa oneshot sign ${digest}`, () => crypto.sign(digest, Buffer.from("hello"), rsaPriv));
	report(`rsa oneshot verify ${digest}`, () => crypto.verify(digest, Buffer.from("hello"), rsaPub, Buffer.alloc(256)));

	report(`dsa stream sign ${digest}`, () => {
		const s = crypto.createSign(digest);
		s.update("hello");
		return s.sign(dsaPriv);
	});
	report(`dsa stream verify ${digest}`, () => {
		const v = crypto.createVerify(digest);
		v.update("hello");
		return v.verify(dsaPub, Buffer.alloc(40));
	});
	report(`dsa oneshot sign ${digest}`, () => crypto.sign(digest, Buffer.from("hello"), dsaPriv));
	report(`dsa oneshot verify ${digest}`, () => crypto.verify(digest, Buffer.from("hello"), dsaPub, Buffer.alloc(40)));

	// ECDSA is not restricted like RSA and DSA above: Node signs and verifies with BLAKE2 like any other digest.
	// DER-encoded ECDSA signatures vary in length from run to run (the leading zero byte of an INTEGER whose high
	// bit is set), so only the roundtrip outcome is printed here, not the raw DER bytes or their length.
	report(`ec stream sign ${digest} produces a buffer`, () => {
		const s = crypto.createSign(digest);
		s.update("hello");
		return Buffer.isBuffer(s.sign(ecPriv));
	});
	report(`ec stream verify ${digest} roundtrip`, () => {
		const s = crypto.createSign(digest);
		s.update("hello");
		const sig = s.sign(ecPriv);
		const v = crypto.createVerify(digest);
		v.update("hello");
		return v.verify(ecPub, sig);
	});
	report(`ec stream verify ${digest} garbage`, () => {
		const v = crypto.createVerify(digest);
		v.update("hello");
		return v.verify(ecPub, Buffer.alloc(70));
	});
	report(`ec oneshot sign ${digest} produces a buffer`, () => Buffer.isBuffer(crypto.sign(digest, Buffer.from("hello"), ecPriv)));
	report(`ec oneshot verify ${digest} roundtrip`, () => {
		const sig = crypto.sign(digest, Buffer.from("hello"), ecPriv);
		return crypto.verify(digest, Buffer.from("hello"), ecPub, sig);
	});
	report(`ec oneshot verify ${digest} wrong data`, () => {
		const sig = crypto.sign(digest, Buffer.from("hello"), ecPriv);
		return crypto.verify(digest, Buffer.from("goodbye"), ecPub, sig);
	});
	report(`ec oneshot sign ${digest} p1363`, () => crypto.sign(digest, Buffer.from("hello"), { key: ecPriv, dsaEncoding: "ieee-p1363" }));
	report(`ec oneshot verify ${digest} p1363 roundtrip`, () => {
		const sig = crypto.sign(digest, Buffer.from("hello"), { key: ecPriv, dsaEncoding: "ieee-p1363" });
		return crypto.verify(digest, Buffer.from("hello"), { key: ecPub, dsaEncoding: "ieee-p1363" }, sig);
	});
}

// Regression guard: ordinary digests are unaffected by the BLAKE2 special-casing.
report("rsa stream sign sha256", () => {
	const s = crypto.createSign("sha256");
	s.update("hello");
	return s.sign(rsaPriv);
});
report("dsa oneshot verify sha256 roundtrip", () => {
	const sig = crypto.sign("sha256", Buffer.from("hello"), dsaPriv);
	return crypto.verify("sha256", Buffer.from("hello"), dsaPub, sig);
});
report("ec oneshot verify sha256 roundtrip", () => {
	const sig = crypto.sign("sha256", Buffer.from("hello"), ecPriv);
	return crypto.verify("sha256", Buffer.from("hello"), ecPub, sig);
});
