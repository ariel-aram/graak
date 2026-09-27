/* Differential corpus: createSign/createVerify/crypto.sign/crypto.verify with a BLAKE2 digest (blake2b512,
   blake2s256). Node's OpenSSL provider refuses BLAKE2 as the digest for RSA and classic DSA in both the streaming
   Sign/Verify classes and the one-shot functions, with ERR_OSSL_DIGEST_NOT_ALLOWED, except that the streaming
   Verify.verify() swallows the error and returns false instead of throwing (as it does for any other bad digest).
   Only signature lengths, booleans and error codes are printed, since ECDSA and DSA signing are randomized. */
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
