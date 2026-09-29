import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BinaryPackager, TargetDevice } from "../dist/index.js";

// The post-quantum key types (raw-seed, raw-public, encapsulate/decapsulate) are newer than the typings.
const nodeCrypto: any = crypto;

/**
 * The native host as a place to run web servers and clients, checked against Node.js itself: each fixture prints a
 * transcript, and the packaged program must print exactly what Node.js prints for the same file. That is the bar
 * for `http`, `https`, `net`, `fetch`, `stream`, `Buffer` and `zlib`: not "works", but "indistinguishable".
 */
const FIXTURES = join(process.cwd(), "test/fixtures/web");

function project(files: string[]): string {
	const root = mkdtempSync(join(tmpdir(), "graak-web-"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "web-fixture", version: "1.0.0" }));
	for (const file of files) copyFileSync(join(FIXTURES, file), join(root, file));
	return root;
}

async function packaged(root: string, entry: string): Promise<string> {
	const result = await BinaryPackager.compile({
		entrypoint: join(root, entry),
		target: TargetDevice.LinuxModernX64,
		packageManager: "npm",
		offline: true,
		output: join(root, "out"),
	});
	assert.equal(result.strategy, "quickjs");
	return result.launcherPath;
}

const CERTS = ["test-key.pem", "test-cert.pem"];
const DIFFERENTIAL: Array<[string, string[]]> = [
	["http-roundtrip.cjs", []],
	["https-roundtrip.cjs", CERTS],
	["fetch-local.cjs", []],
	["stream-corpus.cjs", []],
	["buffer-corpus.cjs", []],
	["decoder-corpus.cjs", []],
	["v8-corpus.cjs", []],
	["zlib-corpus.cjs", []],
	["fs-corpus.cjs", []],
	["wasm-corpus.cjs", []],
	["wasi-corpus.cjs", []],
	["blake2-argon2-corpus.cjs", []],
	["child-corpus.cjs", []],
	["url-fuzz.cjs", []],
	["urlpattern-corpus.cjs", []],
	["fork-corpus.cjs", []],
	["timers-corpus.cjs", []],
	["cluster-corpus.cjs", []],
	["crypto-corpus.cjs", CERTS],
	["dgram-corpus.cjs", []],
	["unix-corpus.cjs", []],
	["watch-corpus.cjs", []],
	["sqlite-corpus.cjs", []],
	["websocket-corpus.cjs", []],
	["assert-corpus.cjs", []],
	["extras-corpus.cjs", []],
	["intl-corpus.cjs", []],
	["intl-fuzz.cjs", []],
	["test-corpus.cjs", []],
	["nodetest-corpus.cjs", []],
	["nodetest-run-corpus.cjs", []],
	["dns-corpus.cjs", []],
	["crypto2-corpus.cjs", []],
	["brotli-corpus.cjs", []],
	["tls-options-corpus.cjs", []],
	["http2-corpus.cjs", []],
	["http2-extras-corpus.cjs", []],
	["zstd-corpus.cjs", []],
	["cipher-corpus.cjs", []],
	["crypto3-corpus.cjs", []],
	["webcrypto-corpus.cjs", []],
	["blake2-sign-corpus.cjs", []],
	["ocb-kmac-corpus.cjs", []],
	["pqc-corpus.cjs", []],
	["repl-corpus.cjs", []],
	["inspector-corpus.cjs", []],
	["mock-module-corpus.cjs", ["mock-module-target.cjs"]],
	[
		"mock-module-esm-corpus.mjs",
		[
			"mock-module-esm-target-named.mjs",
			"mock-module-esm-target-default.mjs",
			"mock-module-esm-target-both.mjs",
			"mock-module-esm-target-deprecated.mjs",
			"mock-module-esm-target-empty.mjs",
		],
	],
];

const MODULE_MOCK_FIXTURES = new Set(["mock-module-corpus.cjs", "mock-module-esm-corpus.mjs"]);

// The Intl corpora print dates in the machine's zone and use its default locale: pin both, for Node.js and the host alike.
const PINNED_ENV: NodeJS.ProcessEnv = {
	...process.env,
	TZ: "America/New_York",
	LANG: "en_US.UTF-8",
	LC_ALL: "en_US.UTF-8",
};
delete PINNED_ENV.NODE_TEST_CONTEXT;
delete PINNED_ENV.NODE_TEST_WORKER_ID;

// node:sqlite arrived in Node.js 22.5; the baseline for that corpus needs it.
const hasNodeSqlite = spawnSync(process.execPath, ["-e", "require('node:sqlite')"]).status === 0;

function normalizeOutput(fixture: string, text: string): string {
	if (fixture === "test-corpus.cjs") {
		return text.replace(/\(\d+(?:\.\d+)?ms\)/g, "(0ms)").replace(/duration_ms \d+(?:\.\d+)?/g, "duration_ms 0");
	}
	return text;
}

for (const [fixture, extra] of DIFFERENTIAL) {
	test(`${fixture} prints exactly what Node.js prints`, {
		timeout: 300_000,
		skip: fixture === "sqlite-corpus.cjs" && !hasNodeSqlite && "this Node.js has no node:sqlite",
	}, async () => {
		const root = project([fixture, ...extra]);
		// `mock.module()` needs Node's own flag; Node refuses it in NODE_OPTIONS, so it goes on argv for Node. The
		// engine has no such CLI flag parsing of its own and only ever reads it from NODE_OPTIONS (`execArgv` is
		// always empty there), so the host gets it that way instead.
		const nodeArgs = MODULE_MOCK_FIXTURES.has(fixture) ? ["--experimental-test-module-mocks"] : [];
		const hostEnv = MODULE_MOCK_FIXTURES.has(fixture)
			? { ...PINNED_ENV, NODE_OPTIONS: "--experimental-test-module-mocks" }
			: PINNED_ENV;
		const onNode = spawnSync(process.execPath, [...nodeArgs, join(root, fixture)], {
			encoding: "utf-8",
			timeout: 120_000,
			env: PINNED_ENV,
			maxBuffer: 64 * 1024 * 1024,
		});
		assert.equal(onNode.status, 0, `Node baseline failed:\n${onNode.stdout}${onNode.stderr}`);

		const launcher = await packaged(root, fixture);
		const onHost = spawnSync(launcher, [], {
			encoding: "utf-8",
			timeout: 240_000,
			env: hostEnv,
			maxBuffer: 64 * 1024 * 1024,
		});
		assert.equal(onHost.status, 0, `host failed:\n${onHost.stdout}${onHost.stderr}`);
		assert.equal(
			normalizeOutput(fixture, onHost.stdout),
			normalizeOutput(fixture, onNode.stdout),
			`the native host must match Node.js for ${fixture}`
		);
		assert.doesNotMatch(onHost.stdout, /FAILED/);
	});
}

test("post-quantum keys, ciphertexts and signatures made on the host are accepted by Node.js", {
	timeout: 300_000,
}, async () => {
	const root = project(["pqc-interop.cjs"]);
	const launcher = await packaged(root, "pqc-interop.cjs");
	const onHost = spawnSync(launcher, [], {
		encoding: "utf-8",
		timeout: 240_000,
		env: PINNED_ENV,
		maxBuffer: 64 * 1024 * 1024,
	});
	assert.equal(onHost.status, 0, `host failed:\n${onHost.stdout}${onHost.stderr}`);
	const made = JSON.parse(onHost.stdout);
	const message = Buffer.from("a message for Node.js to verify");
	assert.equal(made.kem.length, 3);
	for (const kem of made.kem) {
		const key = nodeCrypto.createPrivateKey(kem.privateKey);
		assert.equal(key.asymmetricKeyType, kem.name);
		assert.equal(
			nodeCrypto.decapsulate(key, Buffer.from(kem.ciphertext, "base64")).toString("base64"),
			kem.sharedKey,
			`${kem.name} ciphertext`
		);
		const fromSeed = nodeCrypto.createPrivateKey({
			key: Buffer.from(kem.seed, "base64"),
			format: "raw-seed",
			asymmetricKeyType: kem.name,
		});
		assert.equal(fromSeed.equals(key), true, `${kem.name} seed`);
		assert.equal(
			nodeCrypto.createPublicKey(key).export({ format: "raw-public" }).toString("base64"),
			kem.publicRaw,
			`${kem.name} public key`
		);
	}
	assert.equal(made.sig.length, 10);
	for (const sig of made.sig) {
		const publicKey = nodeCrypto.createPublicKey(sig.publicKey);
		assert.equal(publicKey.asymmetricKeyType, sig.name);
		assert.equal(
			nodeCrypto.verify(null, message, publicKey, Buffer.from(sig.signature, "base64")),
			true,
			`${sig.name} signature`
		);
		assert.equal(
			nodeCrypto.verify(
				null,
				message,
				{ key: publicKey, context: Buffer.from("interop") },
				Buffer.from(sig.contextSignature, "base64")
			),
			true,
			`${sig.name} signature with a context`
		);
		assert.equal(
			nodeCrypto.verify(null, message, publicKey, Buffer.from(sig.contextSignature, "base64")),
			false,
			`${sig.name} context signature without the context`
		);
		assert.equal(
			nodeCrypto.createPublicKey({ key: sig.jwk, format: "jwk" }).equals(publicKey),
			true,
			`${sig.name} jwk`
		);
		const privateKey = nodeCrypto.createPrivateKey(sig.privateKey);
		assert.equal(
			nodeCrypto.verify(null, message, publicKey, nodeCrypto.sign(null, message, privateKey)),
			true,
			`${sig.name} key signs in Node.js`
		);
	}
});

/** Starts a packaged static site and resolves the port it reports. */
function serve(launcher: string, args: string[]): Promise<{ child: ChildProcess; port: number }> {
	return new Promise((resolve, reject) => {
		const child = spawn(launcher, ["--port", "0", ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`the site did not start:\n${output}`));
		}, 20_000);
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			const match = /http:\/\/[^:]+:(\d+)/.exec(output);
			if (match) {
				clearTimeout(timer);
				resolve({ child, port: Number(match[1]) });
			}
		});
		child.on("exit", (code) => reject(new Error(`the site exited (${code}):\n${output}`)));
	});
}

function rawRequest(port: number, text: string): Promise<string> {
	return new Promise((resolve) => {
		const socket = createConnection(port, "127.0.0.1", () => socket.write(text));
		const chunks: Buffer[] = [];
		socket.on("data", (c) => chunks.push(c));
		socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
		socket.on("error", () => resolve(Buffer.concat(chunks).toString("latin1")));
	});
}

test("a folder of static files is packaged as a web server that behaves like a static host", {
	timeout: 300_000,
}, async () => {
	const out = mkdtempSync(join(tmpdir(), "graak-site-out-"));
	const result = await BinaryPackager.compile({
		entrypoint: join(FIXTURES, "site"),
		target: TargetDevice.LinuxModernX64,
		packageManager: "npm",
		offline: true,
		output: join(out, "site"),
		staticSite: { spa: true },
	});
	assert.equal(result.strategy, "quickjs", "a site runs on the native host, with no Node.js");

	const { child, port } = await serve(result.launcherPath, []);
	try {
		const base = `http://127.0.0.1:${port}`;

		let r = await fetch(`${base}/`);
		assert.equal(r.status, 200);
		assert.match(r.headers.get("content-type") ?? "", /^text\/html/);
		assert.match(await r.text(), /Graak site/);

		// hashed assets are immutable, compressed on the wire, and correct once decoded
		r = await fetch(`${base}/assets/app-1a2b3c4d5e.js`);
		assert.equal(r.status, 200);
		assert.match(r.headers.get("content-type") ?? "", /javascript/);
		assert.match(r.headers.get("cache-control") ?? "", /immutable/);
		assert.equal(r.headers.get("content-encoding"), "gzip");
		assert.match(await r.text(), /console\.log\('app'\)/);

		// validators: a matching ETag is a 304 with no body
		const etag = (await fetch(`${base}/style.css`)).headers.get("etag") ?? "";
		assert.ok(etag);
		r = await fetch(`${base}/style.css`, { headers: { "If-None-Match": etag } });
		assert.equal(r.status, 304);

		// byte ranges, for media seeking
		r = await fetch(`${base}/data.bin`, { headers: { Range: "bytes=10-19" } });
		assert.equal(r.status, 206);
		assert.equal(r.headers.get("content-range"), "bytes 10-19/1024");
		assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
		r = await fetch(`${base}/data.bin`, { headers: { Range: "bytes=-4" } });
		assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [252, 253, 254, 255]);
		r = await fetch(`${base}/data.bin`, { headers: { Range: "bytes=5000-" } });
		assert.equal(r.status, 416);

		// directories: redirect to the slash form, then the index inside
		r = await fetch(`${base}/docs`, { redirect: "manual" });
		assert.equal(r.status, 301);
		assert.equal(r.headers.get("location"), "/docs/");
		assert.equal(await (await fetch(`${base}/docs/`)).text(), "<h1>docs</h1>");

		// a client-side route falls back to the app shell; a missing file does not
		r = await fetch(`${base}/some/client/route`, { headers: { Accept: "text/html" } });
		assert.equal(r.status, 200);
		assert.match(await r.text(), /Graak site/);
		r = await fetch(`${base}/missing.png`);
		assert.equal(r.status, 404);
		assert.equal(await r.text(), "<h1>custom 404</h1>");

		// HEAD has headers and no body; other methods are refused
		r = await fetch(`${base}/style.css`, { method: "HEAD" });
		assert.equal(r.status, 200);
		assert.equal(await r.text(), "");
		r = await fetch(`${base}/style.css`, { method: "POST", body: "x" });
		assert.equal(r.status, 405);

		// nothing outside the site is reachable, however the path is spelled
		for (const path of ["/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/..%2f..%2fetc/passwd", "/%00"]) {
			const reply = await rawRequest(port, `GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
			assert.doesNotMatch(reply, /root:/, `${path} must not leak files`);
			// URL parsing resolves the dot segments, so most of these land inside the site: on the app shell
			// (single-page fallback is on here) or a 404, never on a file outside it.
			assert.match(reply, /^HTTP\/1\.1 (200|400|403|404)/, path);
			if (reply.startsWith("HTTP/1.1 200")) assert.match(reply, /Graak site/, path);
		}
	} finally {
		child.kill();
	}
});

test("a static site can be moved onto another port with --port and PORT", { timeout: 300_000 }, async () => {
	const out = mkdtempSync(join(tmpdir(), "graak-site-out-"));
	mkdirSync(join(out, "src"));
	cpSync(join(FIXTURES, "site"), join(out, "src"), { recursive: true });
	const result = await BinaryPackager.compile({
		entrypoint: join(out, "src"),
		target: TargetDevice.LinuxModernX64,
		packageManager: "npm",
		offline: true,
		output: join(out, "built"),
	});
	const { child, port } = await serve(result.launcherPath, []);
	try {
		assert.ok(port > 0);
		assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
		// without --spa, an unknown page is a real 404
		assert.equal(
			(await fetch(`http://127.0.0.1:${port}/some/route`, { headers: { Accept: "text/html" } })).status,
			404
		);
	} finally {
		child.kill();
	}
});
