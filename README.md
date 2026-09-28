<p align="center"><img src="https://raw.githubusercontent.com/ariel-aram/graak/main/assets/logo.webp" alt="Graak logo" width="256"></p>
<h1 align="center">Graak</h1><p align="center">Turn a JavaScript or TypeScript program into one standalone executable that runs on every device, legacy Windows included, with no Node.js installed on the device.</p>

<p align="center">
<a href="https://github.com/ariel-aram/graak/"><img src="https://img.shields.io/github/package-json/v/ariel-aram/graak/main?label=graak&color=3893d9" alt="graak"></a>
</p>
<h2 align="center">Contents</h2>

1. [What Graak is](#what-graak-is)
2. [Installation](#installation)
3. [Quick start](#quick-start)
4. [How a build works](#how-a-build-works)
5. [Supported targets](#supported-targets)
6. [Programs Graak runs](#programs-graak-runs)
   - [Node.js API coverage](#nodejs-api-coverage)
   - [Module formats and TypeScript](#module-formats-and-typescript)
   - [Static sites](#static-sites)
   - [One file](#one-file)
7. [The Graak engine](#the-graak-engine)
   - [Compatibility layer](#compatibility-layer)
   - [Native host](#native-host)
   - [Prebuilt hosts and build speed](#prebuilt-hosts-and-build-speed)
   - [Databases](#databases)
   - [Native addons (Node-API)](#native-addons-node-api)
   - [Addons written against V8 or NAN](#addons-written-against-v8-or-nan)
   - [Addons that ship only source (no prebuilt `.node` at all)](#addons-that-ship-only-source-no-prebuilt-node-at-all)
   - [Windows 7, Vista and XP](#windows-7-vista-and-xp)
8. [Package managers](#package-managers)
9. [The Node.js engine](#the-nodejs-engine)
10. [CLI](#cli)
11. [Programmatic API](#programmatic-api)
12. [ForgeScript extension](#forgescript-extension)
13. [Environment variables](#environment-variables)
14. [Development](#development)
<br>

## What Graak is

Graak packages a JavaScript or TypeScript project (a web server, a static website, a command line tool, a Discord bot,
anything that runs on Node.js) into an executable for a chosen target device. It has two engines:

- **The Graak engine** (default for legacy Windows, iSH, 32-bit Linux and 64-bit Linux): its own C host,
  `graak-c`, embedding [quickjs-ng](https://github.com/quickjs-ng/quickjs) and a Node.js-shaped standard library.
  **No Node.js is shipped or needed on the device.** The host is about 4.5 MB (it carries TLS, WebAssembly, SQLite and libffi) and imports only what Windows XP already
  has, so the result runs where Node.js itself cannot.
- **Node.js**: a downloaded, SHA-256 verified Node.js runtime, packaged as a Single Executable Application or a
  portable folder. Used for the targets Node.js serves well, and available everywhere as `--engine node`.

Nothing in Graak is specific to any framework. Express, Fastify, Hono, `ws`, React and Vue builds, discord.js and
ForgeScript bots all go through the same path; the [ForgeScript extension](#forgescript-extension) is an optional
adapter that exposes a few of Graak's helpers as `$functions`.

**Graak works beside Bun and Deno rather than against them.** Both have a built-in `compile` command that makes a
binary for a modern 64-bit desktop, and both need their own runtime on the device's CPU and OS. Graak takes what they
cannot: Windows XP, Vista and 7, 32-bit Windows and Linux, iSH, ARMv7 and FreeBSD, and a single file of about 5 MB with no Bun
or Deno on the device. Bun and Deno stay the place a project is written and resolved; Graak reads what they resolved
and builds it. See [Package managers](#package-managers).

<h3 align="center" id="installation">Installation</h3><hr>

```bash
npm i -g graak      # or: npx graak <command>, or add it to a project with npm i -D graak
```

Graak needs Node.js >= 20.12 on the machine that **builds**. The compiled program needs nothing on the device when it
runs on the Graak engine.

Ready-made hosts for every target ship with the package, so a build needs no compiler, no `git` and no network on any
operating system, Windows included. Only a change to the host's own C sources (see [Development](#development)) needs
`sh`, `cmake`, `git`, `mingw-w64` for Windows targets, and the `x86_64-linux-musl-cross` / `i686-linux-musl-cross`
toolchains from [musl.cc](https://musl.cc) for Linux ones. Building for a Node.js target downloads the runtime unless
`--offline` or `--node-binary` is given.

<h3 align="center" id="quick-start">Quick start</h3><hr>

```bash
graak compile dist/index.js --target win-legacy-x64                          # a program, for Windows 7 (64-bit)
graak compile src/index.ts  --target linux-modern-x64                        # TypeScript straight from source
graak compile ./dist --target win-legacy-x64 --spa --port 8080               # a built React/Vue/HTML website
graak compile dist/index.js --target win-xp-x86 --engine native --strategy sea --output app.exe   # one file
```

1. Point `compile` at the program's entry file, or at a folder of built static files.
2. Copy the output to the device and run the launcher inside it (`<name>.cmd` on Windows, `<name>` elsewhere), or the
   single executable itself. A Graak-engine build is ready to run as it is; a Node.js build extracts its archive
   beside the executable on first start.
3. `graak targets` lists every device and `graak info <target>` explains one.

<br>

---

## How a build works

1. **Collect.** The input is a program (the directory of the closest `package.json` with its production `node_modules`)
   or a folder of built static files. pnpm and Bun symlink layouts are flattened into a plain, resolvable tree, and a
   Yarn Plug'n'Play project is materialized into one. `.env`, `.npmrc`, `.git` and devDependencies stay out unless
   asked for.
2. **Convert.** For the Graak engine, ES modules (`.mjs`, `"type": "module"`, ES-module-only packages), TypeScript and
   JSX become CommonJS with esbuild. Converted files are cached on disk, so a rebuild skips them.
3. **Adapt.** Native addons are checked, V8/NAN addons are rebuilt from source for the target, and for Windows Vista and 7
   the imports those systems lack are redirected to Graak's compatibility DLLs.
4. **Trim.** For the Graak engine, only the files the program can load ship. Its own files always do; from them the
   module graph is followed file by file with the host's own resolution rules (`exports` with `require` first, `imports`,
   `main`, index files), and packages nothing reaches are left out. Type declarations, docs, source maps (unless
   `source-map-support` is loaded), tests, examples, addon build inputs (C sources, headers, `binding.gyp`) and binaries
   built for another platform go too. Nothing is bundled or minified, so `__dirname`, stack traces and module identity
   stay as they were. Where loading is decided at run time, the package ships whole instead: code that requires a
   computed name (a command loader, `require(variable)`, `createRequire`) keeps its package and every package it
   depends on; code that reads files by path (`__dirname`, `import.meta.url`), a `require.resolve()` target, or a
   package with a native addon keeps that package. A ForgeScript bot goes from 8,650 files (23.8 MB) to 2,472
   (8.6 MB); an Express, ws and better-sqlite3 server from 36.7 MB to 5.8 MB on Windows 7. The log says what was
   kept; `--no-trim` ships every collected file.
5. **Package.** Output is one of three strategies:
   - **native**: the Graak host `graak-c[.exe]`, `runtime/` (the Node.js-shaped standard library), `app/` (your program
     and its `node_modules`, as loose files) and a launcher. Files the program writes to `app/`, SQLite databases
     included, stay put across rebuilds. With `--engine native --strategy sea` it is [one file](#one-file).
   - **sea**: a [Node.js Single Executable Application](https://nodejs.org/api/single-executable-applications.html)
     injected into a target Node.js runtime (>= 20.12), extracting its archive beside itself on first start.
   - **portable**: a folder with the archive, `boot.cjs`, a launcher and the runtime when one is available.
6. `--engine node`, `--node-binary`, `--strategy sea|portable` (without `--engine native`) or a runtime registered with
   `graak runtimes add` move a Graak-engine target onto Node.js. Everything else stays on the Graak engine.

A build that takes long says where: any stage of 750 ms or more prints how long it took.

---

## Supported targets

| Target               | Platform                                | Engine                                                           |
| -------------------- | --------------------------------------- | ---------------------------------------------------------------- |
| `win-xp-x86`         | Windows XP / Server 2003 (NT 5.1/5.2)   | **Graak engine**                                                 |
| `win-vista-x86`      | Windows Vista (32-bit)                  | **Graak engine**                                                 |
| `win-vista-x64`      | Windows Vista (64-bit)                  | **Graak engine**                                                 |
| `win-legacy-x86`     | Windows 7 (32-bit)                      | **Graak engine**                                                 |
| `win-legacy-x64`     | Windows 7 (64-bit)                      | **Graak engine**                                                 |
| `ios-ish-x86`        | Alpine (musl i686) under iOS iSH        | **Graak engine**                                                 |
| `linux-x86`          | Linux 32-bit (i686)                     | **Graak engine**                                                 |
| `linux-modern-x64`   | Linux 64-bit (x86_64)                   | **Graak engine**, static musl or `--native-libc glibc`           |
| `freebsd-x86`        | FreeBSD 32-bit                          | portable Node.js, installs itself on-device (`pkg`)              |
| `win-x86`            | Windows 10 / 11 (32-bit)                | sea, official Node.js (up to Node 22)                            |
| `linux-armv7`        | Linux ARMv7 (32-bit)                    | sea, official Node.js                                            |
| `win-modern-x64`     | Windows 10 / 11 (64-bit)                | sea, official Node.js                                            |
| `linux-modern-arm64` | Linux ARM64 (AArch64)                   | sea, official Node.js                                            |
| `darwin-x64`         | macOS Intel                             | sea, official Node.js (sign with `codesign --sign -`)            |
| `darwin-arm64`       | macOS Apple Silicon                     | sea, official Node.js (sign with `codesign --sign -`)            |

The Graak engine is the default wherever Node.js itself is the obstacle: Windows 7 tops out at Node 12, Vista at
Node 5, XP has no Node.js at all, and 32-bit Linux's last build is an unofficial Node 12. Any target can still be moved
onto Node.js with `--engine node`, `--node-binary`, `--strategy sea|portable` or a registered runtime.

Every package manager and runtime (npm, pnpm, Yarn, Bun, Deno) may build every target. `deno compile` itself makes
only five of them (`linux-modern-x64`, `linux-modern-arm64`, `win-modern-x64`, `darwin-x64`, `darwin-arm64`) and
`bun build --compile` a similar set; every other target above is Graak's.

---

## Programs Graak runs

The Graak engine runs any JavaScript program that stays inside the Node.js API it provides, including programs that
**listen**: web servers, APIs, dashboards. What makes that possible is a real network stack in the host (non-blocking
sockets served from one poller, so a program can be its own client, and TLS in both directions on mbedTLS) with
JavaScript implementations of the Node.js modules on top of it.

The bar for those modules is not "works" but "prints exactly what Node.js prints": the test suite runs the same program
on Node.js and on the packaged host and compares the output byte for byte.

### Node.js API coverage

| Module | What is covered |
| --- | --- |
| `http`, `https` | Server and client. HTTP/1.1 keep-alive, chunked bodies both ways, pipelined requests, `Expect: 100-continue`, HEAD/204/304 framing, `Upgrade` (WebSocket servers such as `ws`), backpressure and `drain`, `closeAllConnections`. HTTPS servers take a PEM `key` and `cert`. |
| `net`, `tls` | `createServer`, `connect`, half-close, timeouts, `pause`/`resume`, `remoteAddress` and friends. TLS takes `ca`, `cert`/`key` (with `passphrase`), `servername`, `ALPNProtocols`, `minVersion`/`maxVersion` (TLS 1.2 and 1.3), `requestCert`, `rejectUnauthorized`, `checkServerIdentity` and `secureContext`, and sockets report `alpnProtocol`, `authorized`, `authorizationError`, `getProtocol()`, `getCipher()`, `getPeerCertificate()` and `getPeerX509Certificate()`. `tls.rootCertificates` is the CA bundle compiled into the host. `rejectUnauthorized: false` and `NODE_TLS_REJECT_UNAUTHORIZED=0` work as in Node. Not covered: `pfx`, `ciphers` (the suite list is mbedTLS's), session resumption and renegotiation. A server built on mbedTLS answers a TLS version mismatch with a handshake_failure alert where OpenSSL sends protocol_version. |
| `http2` | Server (`createServer`, `createSecureServer` with ALPN, `allowHTTP1` falling back to `http`) and client (`connect`) over cleartext prior-knowledge h2c and TLS: HPACK with Huffman coding, multiplexed streams with flow control both ways, settings, ping, `goaway`, RST_STREAM, trailers, server push, informational responses, `respondWithFile`, the core `stream` API and the compatibility `request`/`response` API, Node's error codes and messages. Verified against Node.js, curl and nghttp2 in both directions. Not covered: the HTTP/1.1 Upgrade to h2c (Node has no server side for it either), stream priority (accepted and ignored) and `origin` frames. |
| `fetch`, `Request`, `Response`, `Headers`, `FormData` | Streaming bodies, redirects (follow, manual, error), gzip/deflate, `AbortSignal`, `clone()`, multipart, `Response.json()` and `Response.redirect()`. |
| `stream` | `Readable`, `Writable`, `Duplex`, `Transform`, `PassThrough`, `pipeline`, `finished`, `Readable.from`, async iteration, `stream/promises`, and the web-stream bridges. |
| `fs`, `fs/promises` | Sync, callback and promise forms, file descriptors, `Stats`/`Dirent`, streams, `cp`, `rm`, `mkdtemp`, recursive `readdir`, and Node's error codes and messages. |
| `crypto` | Hash and HMAC (md5, sha1, sha224/256/384/512, ripemd160), random values, PBKDF2, HKDF, scrypt, AES (ECB, CBC, CTR, GCM), ChaCha20-Poly1305, RSA (PKCS#1 v1.5, PSS) and ECDSA (DER or IEEE P1363) sign/verify, `publicEncrypt`/`privateDecrypt` with PKCS#1 v1.5 and OAEP, key objects (`createPrivateKey`, `createPublicKey`, PEM, DER and JWK in and out, `equals`, `asymmetricKeyDetails`), `generateKeyPair` and `generateKeySync` for RSA, EC, Ed25519, Ed448, X25519, X448 and DSA, the post-quantum key types in pure JavaScript over the host's SHAKE and SHA-2 (ML-KEM-512/768/1024 with `crypto.encapsulate`/`decapsulate`, ML-DSA-44/65/87 and the twelve SLH-DSA sets with `sign`/`verify` and the `context` option, keys in PEM, DER, JWK and `raw-public`/`raw-seed`/`raw-private`), `pfx` and passphrase-protected key export, streaming ciphers, AES key wrap, SHA-3/SHAKE, `createECDH` and `crypto.diffieHellman`, `createDiffieHellman` and the MODP groups, `generatePrime` and `checkPrime`, `X509Certificate`, `timingSafeEqual`, and Web Crypto (`subtle`) for digest, HMAC, AES, RSA, ECDSA, ECDH, EdDSA, ML-KEM (`encapsulateBits`, `encapsulateKey`, `decapsulateBits`, `decapsulateKey`), ML-DSA, key wrap and key derivation, and `SubtleCrypto.supports`, on the same key objects. Output is byte-identical to Node's. Zstd is in `zlib`; `URL` follows the WHATWG URL Standard with full IDNA and `URLPattern` is global, both checked against Node 24 and 26. |
| `Buffer`, `events`, `zlib`, `string_decoder` | Complete `Buffer`, an `EventEmitter` that tolerates being mixed into plain objects, gzip/deflate/raw and Brotli (`brotliCompress`, `brotliDecompress`, `params`, `maxOutputLength`, Node's error codes) in sync, callback and stream forms. |
| `os`, `process`, `vm`, `module`, `url`, `worker_threads`, `readline`, `punycode` | Provided. `process` has real standard streams, `exitCode`, `beforeExit`/`exit` and signals; `vm` contexts are sandbox objects in one realm, not a security boundary. |
| `child_process` | `spawnSync`, `execSync`, `execFileSync`, `exec` and `execFile` (each runs the child to completion), with byte-exact output, `input`, `ENOENT` for a missing program, and `signal` for a killed one. `spawn` is live: stdout and stderr arrive as 'data' while the child runs, stdin can be written and ended at any time, `stdio` takes `pipe`, `inherit`, `ignore` or a descriptor, `kill()` sends real signals (on Windows every signal terminates, and is reported as the one asked for, as libuv does), and 'exit' precedes 'close'. `fork` has an IPC channel with JSON messages, `process.send`, `'message'` and `'disconnect'`, `execArgv`, `silent` and `stdio`, and forking the packaged program itself works in a single-file build. Known gaps: `serialization: 'advanced'` and sending handles over the channel throw a clear error; stdio entries beyond the three standard ones (other than `ipc`) are not supported; a child that is `unref()`ed is no longer polled, so its events stop; on Windows before 10 the channel is a pair of anonymous pipes, so it links Graak programs to each other but not to a Node.js parent or child. |
| `dgram`, `net` over a path | UDP sockets (`createSocket('udp4'/'udp6')`, `bind`, `send`, `message`, broadcast, TTL, multicast membership) and unix-domain sockets (`listen(path)`, `connect(path)`). Windows before 10 has no AF_UNIX, so there a socket path is a file that names a loopback TCP port: programs built with Graak reach each other that way, but a program that is not one of them cannot connect. |
| `dns`, `dns/promises` | `Resolver`, `getServers`, `setServers`, `lookup`, `lookupService`, and `resolve`, `resolve4`, `resolve6`, `resolveCname`, `resolveMx`, `resolveNs`, `resolveTxt`, `resolveSrv`, `resolvePtr`, `resolveSoa`, `resolveCaa`, `resolveNaptr`, `resolveTlsa`, `resolveAny`, `reverse` over UDP with TCP fallback, with Node's record shapes, `ttl`, error codes and messages, argument checks, retries and server rotation (`timeout`, `tries`, `maxTimeout`), `cancel()` and `setLocalAddress()`. `lookup` reads the hosts file, then the system servers. System resolver discovery: /etc/resolv.conf (with `timeout`/`attempts`) on POSIX; on Windows XP and later the output of `ipconfig /all` in any display language, then `nslookup`. |
| `node:sqlite`, `bun:sqlite` | SQLite compiled into the host: `DatabaseSync` and `StatementSync` as Node documents them (null-prototype rows, named parameters with or without their prefix, `readBigInts`, `changes` and `lastInsertRowid`, error codes) and Bun's `Database`, `query`, `prepare`, `transaction`. Same database file format on every target. User-defined functions, extensions and `backup()` are not available. |
| `WebSocket`, `MessageEvent`, `CloseEvent` | The browser's client on RFC 6455 framing over the host's own HTTP upgrade (Node 22 has one; the host and older Node.js did not). Messages, `binaryType`, ping/pong, close codes and the events arrive as they do in Node's. |
| `fs.watch` | A file or a directory, recursive or not: an appearing or disappearing name is a `rename`, a changed one a `change`. The engine has no change notifications, so the tree is compared with a snapshot at an interval that grows with its size. |
| `WebAssembly` | [wasm3](https://github.com/wasm3/wasm3), compiled into the host, behind the standard API (`Module`, `Instance`, `Memory`, `Global`, `Table`, `instantiate`, `compile`, `validate`, `i64` as `BigInt`). It interprets, so there is no SIMD, threads or exception handling, and a module that *imports* a memory, table or global is refused with a `LinkError`. This is what lets undici (Node's `fetch` and the HTTP client of discord.js) load. |
| `assert` | Complete: the loose and strict families, deep equality by Node's rules (Map, Set, Date, RegExp, typed arrays, errors, boxed primitives, circular references, prototypes), `throws`/`rejects` with every form of `expected`, `match`, `ifError`, `partialDeepStrictEqual`, and the message and `AssertionError` fields Node builds. |
| Web streams | [web-streams-polyfill](https://github.com/MattiasBuelens/web-streams-polyfill) 3.3.3, which follows the WHATWG spec and passes its web-platform-tests: backpressure, byte streams and BYOB readers, `pipeTo`/`pipeThrough`, `tee`, `ReadableStream.from`, and `TextEncoderStream`, `TextDecoderStream`, `CompressionStream`, `DecompressionStream`. |
| `structuredClone`, `MessageChannel`, `BroadcastChannel`, `events`, timers, `util`, `path.matchesGlob`, `fs.glob` | The statics and members programs and packages reach for, each checked against Node's own output. `structuredClone` handles cycles, `Map`/`Set`, `Date`, `RegExp`, errors, typed arrays and `transfer`. |
| `Intl` | `NumberFormat` (decimal, percent, currency, unit; compact, scientific and engineering notation; every rounding mode, increment and priority), `DateTimeFormat` (every component combination, `dateStyle`/`timeStyle`, hour cycles, day periods, eras, zone names, `formatRange`), `PluralRules`, `RelativeTimeFormat`, `ListFormat`, `Collator` (Unicode collation with locale tailoring: Swedish å ä ö, Spanish ñ, Turkish dotted i, Russian and Chinese script order, pinyin Han), `DisplayNames`, `DurationFormat`, `Locale`, and `toLocaleString`, `toLocaleDateString`, `toLocaleTimeString`, `localeCompare` and `toLocale{Upper,Lower}Case` on the built-ins. **39 locales** (see below) with every IANA time zone and its history since 1700. Output is compared with Node's ICU across some 30,000 cases. |
| `Intl.Segmenter` | Grapheme and word granularity per UAX #29, passing Unicode's own conformance files in full. Sentence granularity throws rather than guessing a locale. |
| `node:test`, `node:test/reporters` | Reachable only under the `node:` scheme, as in Node. `test`/`it`, `describe`/`suite`, the four hooks, subtests, `skip`/`todo`/`only`/`expectFailure`, `t.plan`, `t.assert`, `t.diagnostic`, `t.signal`, `t.waitFor`, timeouts, callback tests, `mock` (`fn`, `method`, `getter`, `setter`, `property`, `timers`, `module`), `run()`, the default report and exit code, and the spec, TAP, dot, JUnit and lcov reporters, checked against Node.js 24 and 26. A test after an `await` must be started with `t.test()` (the engine has no async context to find its parent by); `run()` runs files in-process (`isolation: 'none'`); coverage, snapshots and watch mode throw rather than pretend. `mock.module` exists only under `--experimental-test-module-mocks`, exactly as in Node (checked against Node.js 24.21.0 and 26.9.0 — the flag gates CommonJS `require()` mocking too, not only ESM); once enabled it covers `require()`, including builtins, with `cache`, `exports`/`namedExports`/`defaultExport`, and restore/reset. ESM's `import`/`import()` go through the quickjs engine's own native module loader, which no JS-only hook can intercept, so mocking an ES module stays unavailable regardless of the flag. |
| `wasi` | `WASI` (`preview1` and `unstable`) with `getImportObject`, `start`, `initialize`, `finalizeBindings`, preopens, args, env and `returnOnExit`, over every `wasi_snapshot_preview1` call, in JavaScript on the runtime's fs. Sockets return the codes Node returns. Known gaps: `path_link` copies the file, `poll_oneoff` treats pipes and terminals as always ready, and `fd_close` never closes the default stdio. |
| `cluster` | Primary and workers on `fork()`: `fork`, `setupPrimary`, `workers`, `Worker` and their events, `disconnect`, and workers that `listen` on one port (the primary owns the socket and hands connections to workers round-robin). Limits are listed below the table. |
| `v8` | `serialize`, `deserialize`, `Serializer`, `Deserializer` and the `Default*` classes in V8's wire format (version 15), byte-identical to Node's for the values structured clone accepts. Known gaps: V8's packed-elements kind is invisible to JavaScript, so `new Array(3).fill(0)` is written densely; proxies are not detected. |
| `repl` | `repl.start()` and `REPLServer` over any pair of streams, or the process's own: `_` and `_error`, `.help .break .clear .exit .save .load` (and `.editor` on a terminal) and `defineCommand`, multi-line input, top-level `await`, `let`/`const`/`class` that persist with a real script scope's redeclaration and const-assignment errors, `context`, `useGlobal`, `writer`, `eval`, `replMode`, `ignoreUndefined`, `completer` and Node's own tab completion (members, globals, `require('...')`, commands), history with `setupHistory`, and the `exit` and `reset` events; `repl.builtinModules`, `REPL_MODE_*`, `Recoverable`, `isValidSyntax`. It is checked against Node 24 and 26 transcript for transcript. A terminal gets a plain line editor (arrows, history, Tab, Ctrl+A/E/K/U/W/L/C/D); Ctrl+C is caught as a signal while it runs. Known gaps: a `context` is a sandbox object in the one realm (`Object` inside it is the program's `Object`), syntax errors carry the engine's wording and no source echo with a caret, `Uncaught` errors show no frames of functions defined in the session, `var` next to another statement ends the input's value as `undefined` (V8 keeps the earlier statement's), a `typeof` on a missing name is rewritten to a guarded read, and a terminal has no inline result preview, reverse search or multi-line editing. `breakEvalOnSigint` cannot interrupt a running script. |
| `inspector`, `inspector/promises` | `Session` (`connect`, `post`, `disconnect`, `inspectorNotification` and per-method events) answering the parts of the Runtime domain a program can use from inside itself with V8's shapes: `evaluate` (`returnByValue`, `awaitPromise`, `generatePreview`, `objectGroup`), `getProperties`, `callFunctionOn`, `releaseObject(Group)`, `enable` with `executionContextCreated` and `consoleAPICalled`, `globalLexicalScopeNames` and the small ones, plus `url()` (undefined), `console`, `close()` and `waitForDebugger()` (Inspector is not active). quickjs has no debugger protocol, sampling profiler or heap profiler: `Profiler`, `HeapProfiler`, `Debugger` and the other domains that need them, a few Runtime methods (`compileScript`, `runScript`, ...) and `inspector.open()` throw an `ERR_INSPECTOR_NOT_AVAILABLE` error that says so. Error descriptions carry this engine's stack. |

#### Intl locales and limits

quickjs-ng has no ICU, so `Intl` here is built from data read out of one: `tools/gen-intl-data.js` formats sample values with
Node's ICU and stores what it printed (patterns, names, weights, zone transitions), and `quickjs/runtime/intl.js` assembles
them. The locales are `en` (US, GB, AU, CA, IN, NZ, IE, ZA, SG), `de` (DE, AT, CH), `fr` (FR, CA, BE, CH), `es` (ES, MX, AR, CO,
CL, US, 419), `it` (IT, CH), `pt` (BR, PT), `nl` (NL, BE), `sv` (SE, FI), `pl`, `ru`, `tr`, `ja`, `zh` (CN, TW, HK) and `ko`;
another region of one of those languages uses the nearest of them and reports the locale that was asked for. A language
outside the list formats as `en-US`, which is also what `supportedLocalesOf` leaves out. Data is loaded a locale at a time, on
first use, and a build ships it only when the program or a package it bundles mentions `Intl`, `toLocale*String` or
`localeCompare` (`--intl all` or `--intl none` overrides; about 7 MB, 1.5 MB compressed), so a program that never touches
`Intl` pays nothing for it. Not covered: calendars other than Gregorian, numbering systems other than Latin, ICU's interval
patterns (`formatRange` joins two full dates with the locale's range separator instead of merging the shared fields), unit
compositions beyond `X-per-Y`, and ICU's generic zone names in a few zones (Egypt's disambiguating "(Egypt)").

Verified against real packages, with no Node.js anywhere in the output: **Express 4**, **Fastify** and **Hono**, each
served from a packaged `linux-modern-x64` build; **`ws`** as a WebSocket server and client exchanging text and 70 KB
binary frames; **discord.js 14** with **ForgeScript**, whose REST client makes a real request to Discord; and native
addons such as **@napi-rs/canvas**, **sharp** and **better-sqlite3**.

Limits of the `crypto` additions: AES-OCB (`createCipheriv`), cSHAKE, TurboSHAKE, KT128/KT256 and KMAC (Web Crypto; KMAC keys import and export as JWK only, as in Node) run in JavaScript over the host's AES and Keccak. BLAKE2b512 and BLAKE2s256 (hash, HMAC, PBKDF2, HKDF) and Argon2 (`crypto.argon2`, `argon2Sync`, and Web Crypto Argon2d/i/id) are JavaScript around C compression functions the host provides (BLAKE2b, BLAKE2s, the Argon2 block function and Keccak-f), so the per-block work runs at native speed; a host built without them falls back to JavaScript for the same output, about ten times slower. `createSign`/`createVerify` and `crypto.sign`/`crypto.verify` with a BLAKE2 digest match Node for RSA and classic DSA keys:
both reject it with `ERR_OSSL_DIGEST_NOT_ALLOWED` (the streaming `Verify.verify()` returns `false` instead, as it does for
any other bad digest there). ECDSA is the one case Node itself does not restrict this way — it signs and verifies with a
BLAKE2 digest like any other — but that needs the native host's signer to compute BLAKE2 as part of signing, which its
mbedTLS-backed digest table does not, so ECDSA with a BLAKE2 digest still throws instead of producing a signature. ML-KEM, ML-DSA and SLH-DSA (`generateKeyPair`, sign and verify, `encapsulate`/`decapsulate`, and Web Crypto ML-KEM and ML-DSA with `SubtleCrypto.supports`) are provided. On the native host the secret-key work is C: ML-KEM and ML-DSA are the PQ Code Package's mlkem-native and mldsa-native and SLH-DSA is its slhdsa-c, fetched at pinned commits by `build.sh`. They have no secret-dependent branches or table lookups, and the JavaScript layer only formats keys. ML-KEM and ML-DSA take microseconds to milliseconds and SLH-DSA signing takes well under a second for the `f` sets. A host built without them (a stale prebuilt) falls back to a JavaScript implementation with the same output, which is neither fast (SLH-DSA `s` signing takes 10 to 25 seconds) nor constant-time. Where Node.js 24 and 26 differ (PKCS#8 export of ML-KEM and ML-DSA keys, expanded-only keys, some error texts), the host follows 24: PKCS#8 carries the seed and the expanded key, and both forms, the seed alone and the expanded key alone, are read. Like Node, SLH-DSA is not in Web Crypto; signing is hedged (random), as OpenSSL's default. Importing an expanded-only ML-DSA key decodes and checks it in JavaScript, which is not constant-time, and an expanded-only ML-KEM key is checked for canonical encoding and its stored hash, not for the consistency of its two halves. `cluster` runs on `fork()`: workers, their events and messages, and several workers listening on one port.
The host cannot pass a socket descriptor, so the primary owns the listening socket and proxies each connection to a worker
in round-robin order (workers bind a private 127.0.0.1 port), sending the real remote address alongside over the existing
IPC channel so a proxied connection's `socket.remoteAddress`/`remotePort` match the client's, not the proxy hop's own;
sending a handle to a worker (`worker.send(msg, handle)`) throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`, and `listen` on a unix
path or with `exclusive: true` binds in the worker alone. An
exception nothing catches is handled as Node handles it: `process.on("uncaughtException")` gets it, otherwise it is
printed and the process exits with status 1. A server binds IPv4 unless told otherwise (`listen(port)` is `0.0.0.0`).

### Module formats and TypeScript

The host loads CommonJS, so the build converts the rest. ES modules (chalk 5, nanoid 5, node-fetch 3, `.mjs` files, a
`"type": "module"` project), TypeScript (`.ts`, `.mts`, `.cts`) and JSX (`.tsx`, `.jsx`, automatic runtime) become
CommonJS while the project is collected; plain CommonJS is left alone without being parsed. `import()`,
`import.meta.url` and `import.meta.dirname` keep working, `package.json` `exports` (conditions in the order the package
lists them) and `imports` (`#name`) resolve as in Node, and an import written as `./x.ts` finds the converted file. So a
TypeScript program compiles directly:

```sh
graak compile src/index.ts --target win-legacy-x64
```

Not converted: top-level `await` (CommonJS cannot express it), `tsconfig` path aliases (a bundler's job) and decorators
that need `experimentalDecorators`. A TypeScript entry for a Node.js build must be compiled first.

### Static sites

Point `graak compile` at a folder of built files instead of a program:

```sh
graak compile ./dist --target win-legacy-x64 --spa --port 8080
graak compile ./build --target linux-modern-x64 --engine native --strategy sea
```

A directory, or an `.html` file, is treated as a site (`--static` forces it). Graak generates a small web server and
packages it with the files; the result runs on every target that runs a program, legacy Windows included. It behaves
like a static host: MIME types, `ETag` and `Last-Modified` with `304` replies, byte ranges (video seeking), gzip for
text, an index file for directories with the redirect to the trailing-slash form, a custom `404.html`,
`Cache-Control: immutable` for content-hashed file names, and no path that leaves the folder.

| Option | Effect |
| --- | --- |
| `--spa` | Answer unknown page routes with `index.html`, so client-side routing (React Router, Vue Router) works. A missing file such as `/missing.png` is still a `404`. |
| `--port <n>` | Default port, `8080`. At run time `PORT` in the environment or `--port` on the command line overrides it, and `--port 0` picks a free one. |
| `--host <addr>` | Interface to listen on. Default `0.0.0.0`. |
| `--index <file>` | Entry page. Default `index.html`. |

Server-rendered frameworks are programs, not sites: package their server entry file like any other program.

### One file

`--engine native --strategy sea` writes **one executable** instead of a folder. The application (the compatibility layer,
your program and its `node_modules`) is appended to a copy of the host in Brotli-compressed blocks of about 2 MB, and the
host runs it **from inside itself**: modules and every `fs` read of the program's own files are served from the payload,
decompressed on demand, under a directory `<name>.graak` that exists only there. Nothing is unpacked. Files that must be
real are extracted one at a time, beside the executable in `<name>.graak` (or in the temp directory when that folder is
read-only): a native addon and the shared libraries the payload carries, a program started with `child_process`, an
SQLite database or FFI library opened from the payload. The host is about 4.5 MB, so a small program or a static site is
a **single file of about 5 MB**; a discord.js bot with its dependencies is about 7.5 MB.

The payload is read-only, like the files of an installed program. Writing to one of its paths writes a real file there
(creating the directories it needs), and that process reads the real file from then on; the next start sees the
payload's copy again. A native addon that creates files beside itself without going through `fs` finds no such
directory unless something created it first.

```sh
graak compile dist/index.js --target win-legacy-x64 --engine native --strategy sea --output app.exe
```

---

## The Graak engine

### Compatibility layer

`quickjs/runtime/` is the part of Node.js's surface that can be written in JavaScript, on top of the engine's own
`qjs:os` and `qjs:std` primitives: `node-compat.js` (core, `require` with `node_modules` resolution, `process`, `util`,
`events`, `path`, `os`), `node-buffer.js`, `node-stream.js`, `node-fs.js`, `node-http.js`, `node-fetch.js`,
`node-web.js` (web streams, `Blob`), `node-url.js`, `node-inspect.js` (a console that prints like Node's),
`node-system.js`, `node-wasm.js`, `node-crypto.js`, and `native-modules.js`, which gives the host's native sockets, TLS,
crypto and zlib their Node.js shapes.

`quickjs/runtime/selftest.js` runs **unmodified on both Node.js and the engine** and is the check that matters: a layer
that merely loads proves nothing. `tools/engine-conformance.js` measures any engine against what real programs need:

| | language | builtins | host APIs | node modules | total |
| --- | --- | --- | --- | --- | --- |
| Node.js 26 | 10/10 | 10/10 | 8/8 | 30/30 | **58/58** |
| Node.js 12.22.12 (the Windows 7 pin) | 5/10 | 1/10 | 1/8 | 29/30 | **36/58** |
| quickjs-ng, bare engine | 10/10 | 10/10 | 0/8 | 0/30 | **20/58** |
| quickjs-ng + JavaScript layer | 10/10 | 10/10 | 8/8 | 21/30 | **49/58** |
| quickjs-ng + JavaScript layer + native host | 10/10 | 10/10 | 8/8 | 30/30 | **58/58** |

There is no gap in the 58 that is left as a stub.

### Native host

`quickjs/native/` is a single C binary, `graak-c`, that embeds quickjs-ng and supplies what needs native code, using
only Winsock 2 and CryptoAPI on Windows, both present since the 1990s:

- **TCP and TLS** (mbedTLS). Sockets stay on the native side and reach JavaScript as integer ids, so a JavaScript bug
  cannot produce a use-after-free. Certificates verify against a CA bundle compiled into the binary, not the OS store,
  which is what lets an old machine reach modern HTTPS hosts at all.
- **Hashing, HMAC, secure randomness** (mbedTLS), **compression** (miniz), **WebAssembly** (wasm3), **SQLite** (the amalgamation),
  **foreign function calls** (libffi), **UDP and unix-domain sockets**, **timers, filesystem and process**.
- **Node-API** for native addons (plus the part of libuv's ABI that addons such as rocksdb-native call), and
  **single files that run in place** (a Brotli decoder reads the payload).

One source tree serves every target; only the cross-compiler differs.

```sh
quickjs/native/build.sh win-xp-x86       # 32-bit Windows, XP-compatible
quickjs/native/build.sh win-x86          # 32-bit Windows, Vista and later
quickjs/native/build.sh win-x64          # 64-bit Windows, Vista and later
quickjs/native/build.sh linux-x86        # 32-bit Linux, static musl (also serves iSH)
quickjs/native/build.sh linux-x64        # 64-bit Linux, static musl (the linux-modern-x64 default)
quickjs/native/build.sh linux-x64-glibc  # 64-bit Linux, dynamic glibc (--native-libc glibc)
quickjs/native/build.sh native           # the build machine's own platform, for local iteration
```

Linux hosts are static musl so one binary runs on glibc and musl systems (Alpine included) unmodified. The XP build
applies `winxp-compat.patch` to the engine's four Vista-era threading calls and `patch-mbedtls-xp.py` to swap
`BCryptGenRandom` for `CryptGenRandom`, then **verifies the result imports nothing newer than XP and fails if it does**.
Result: a self-contained Windows executable of about 4.5 MB importing only `KERNEL32`, `msvcrt`, `ADVAPI32` and `WS2_32`.

`native-selftest.js` (crypto vectors, deflate, a live TLS request) passes on the native Linux build and on the Windows
hosts under Wine. Not yet run on real Windows XP, Vista or 7 hardware: Wine implements the newer Windows APIs itself, so
it cannot reproduce a load failure that only exists there.

### Prebuilt hosts and build speed

Compiling a host takes minutes and needs a POSIX shell and cross-compilers, which an ordinary Windows machine does not
have. So every host ships prebuilt and gzipped in `quickjs/prebuilt/hosts/`, together with the Windows 7 compatibility
DLLs in `quickjs/prebuilt/win-compat/`. A build takes the host from the cache, else from the prebuilt copy, else
compiles it.

A prebuilt host is trusted only while the sources it was built from are the sources on disk: its manifest carries a digest
of `quickjs/native/`, computed with line endings ignored so a CRLF checkout still matches. A changed source falls back to
compiling, and `test/prebuilt.test.ts` fails until the prebuilts are regenerated with `bun run prebuilts`.

Other things that keep repeat builds fast: converted ES modules and TypeScript files are cached by content, work is
limited to a bounded number of files at once, and patched Windows 7 addons are cached by digest.

### Databases

Embedded databases come in three kinds, and all three run:

- **SQLite is built in.** `node:sqlite`, `bun:sqlite` and Deno KV work on every target with nothing to install, XP included
  (see the table above). The amalgamation is compiled into the host, single-threaded.
- **Databases that are Node-API addons** load on the dynamically linked host, like any addon. Verified by running the same
  program under Node.js and on the Graak engine and comparing what it prints: **LevelDB** (`classic-level`), **LMDB**
  (`lmdb`), **RocksDB** (`rocksdb-native`) and **SurrealDB**, embedded (`surrealdb` with `@surrealdb/node`, the Rust engine),
  on its in-memory, **RocksDB** (`rocksdb://`) and **SurrealKV** (`surrealkv://`) storage engines.
- **Databases you connect to** (Postgres, MySQL, MongoDB, Redis, a SurrealDB server) are clients over `net`, `tls`, `crypto` and, for
  SurrealDB's remote protocol, the global `WebSocket`.

`rocksdb-native` and its relatives call libuv directly, next to Node-API. The host therefore exports the part of libuv's ABI they
use, laid out by libuv's own headers: `uv_queue_work`, `uv_fs_open/close/read/write/mkdir/req_cleanup`, `uv_buf_init`,
`uv_err_name`, `uv_strerror`. Work runs on OS threads and completes on the JavaScript thread. Another addon that needs more of libuv
(handles, timers, sockets) fails to bind, naming what it lacks. This subset exists on Linux; a Windows host does not export it yet.

### Native addons (Node-API)

A `.node` file is a shared library that imports `napi_*` functions from the process that loads it. Nothing in that
contract needs Node.js, so the host implements it: `quickjs/native/napi.c` exports the whole Node-API surface on top of
the QuickJS C API and loads the library with `dlopen` / `LoadLibrary`. Addons built on Node-API run unmodified, on the
architecture they were built for.

Verified for real: **@napi-rs/canvas** (Skia; the PNG is byte-identical to Node's), **sharp** (libvips),
**better-sqlite3** and **@gifsx/gifsx**, `bufferutil`, `utf-8-validate`, and a purpose-built fixture addon covering
values, strings, objects, buffers, callbacks, exceptions, wrapped classes, references, BigInt, async work and
thread-safe functions, whose output is identical to Node's.

- **A static host cannot load addons** (a static executable has no dynamic loader). When a program needs one,
  `linux-modern-x64` gets the dynamically linked host automatically (glibc, or musl when the addon is musl-linked), and
  the build says so. Addons that are only accelerators (`msgpackr-extract`, `zlib-sync`, `mediaplex`, ...) do not
  trigger this: their libraries fall back to JavaScript, so the portable static host is kept.
- **Windows hosts export the Node-API functions** and the addon's delay-load hook binds to them.
- **The addon still has to run on the target's OS.** It is a native binary built for some Windows or glibc; on an older
  target loading fails with the system's own message, and the build warns for legacy targets.
- **Alpine and iSH** have dynamic musl hosts (`linux-x64-musl-dyn`, `linux-x86-musl-dyn`), chosen automatically.

### Addons written against V8 or NAN

A prebuilt V8 addon (an older `better-sqlite3`, `erlpack`, `zlib-sync`, anything on NAN) cannot be loaded by anything
but Node.js, but its *source* is C++ against a documented API. So Graak ships an implementation of that API on top of
Node-API (`quickjs/native/v8/`) and `graak compile` rebuilds such a package from source against it, with the **target's**
cross toolchain:

1. A `.node` file is recognised as a V8 binary by the symbols it imports.
2. The package's `binding.gyp` is read (targets, sources, include_dirs, defines, flags, libraries, dependent static
   libraries, conditions on OS and arch) and compiled.
3. The result imports only `napi_*` functions and replaces the prebuilt binary in the output.

Verified with **erlpack** (Discord's NAN addon), **zlib-sync** built from its unmodified source, **NAN 2.29** itself and a
raw-V8 fixture, each compared against Node.js running the same source.

Said plainly: a V8 binary with no findable source stops the build naming the package; the gyp reader is a subset
(`actions` and unusual expansions stop the build); it is the API addons use, not all of V8, so a gap is an ordinary
compile error; property interceptors are modelled with a JavaScript Proxy; and a static host cannot `dlopen`, so this
applies wherever a dynamic host exists.

### Addons that ship only source (no prebuilt `.node` at all)

A dependency that installs straight from git, or one nobody has run `npm install` against on this machine, is just a
`binding.gyp` and `.c`/`.cpp` files: no `build/Release/*.node` anywhere, for any platform. `graak compile` notices this
during project collection (a package with a `binding.gyp`, or `"gypfile": true`, and no matching prebuilt) and compiles
it before packaging, with `NativeAddonCompiler` (`src/compiler/NativeAddonCompiler.ts`):

1. When the target is the machine's own OS and architecture and `node-gyp` plus Python are on `PATH`, that is tried
   first (`node-gyp rebuild`), because it is what the package's own install step would have run.
2. Otherwise -- a cross build (a different target, or a musl host), or node-gyp/Python missing -- the same `binding.gyp`
   reader V8AddonBuilder uses reads the target settings, and the target's own `cc`/`c++` compiles the sources directly
   against the vendored Node-API headers (`quickjs/native/include/`), the same headers and flags
   `test/fixtures/napi/addon.c` is hand-compiled with in the test suite. No V8 shim is involved here: the source is
   already Node-API, only unbuilt, so it needs nothing else. The result is a `.node` that imports plain `napi_*`
   functions, placed exactly where the package's own `index.js` expects it.

Verified with a from-source fixture addon (the same one used to verify the Node-API host itself) shipped as a
dependency with a `binding.gyp` and no prebuilt anything: `graak compile` compiles it and the packaged output produces
output identical to Node.js running the same source, with no Node.js on the target.

Limits: Linux (glibc and musl, native and cross via mingw's counterpart toolchains) is verified end to end; Windows
cross-compilation of a plain from-source addon reuses V8AddonBuilder's import-library trick (an addon's `napi_*` imports
are bound to the running `graak-c.exe`) but was not run under Wine in this session -- do that before relying on it for a
Windows target. `binding.gyp` support is the same subset as V8AddonBuilder's (see above): dependent static libraries and
`OS`/`target_arch` conditions work; `actions` and unusual gyp expansions stop the build naming what, rather than
guessing. A package with genuinely no toolchain wired up for the target (see `TOOLCHAINS`/`MUSL_TOOLCHAINS` in
`V8AddonBuilder.ts`) is reported as such.

### Windows 7, Vista and XP

- **Windows XP**: the host imports nothing newer than XP (see above).
- **Windows 7 and Vista** and prebuilt addons: an addon is a DLL whose imports the OS binds at load. Measured on the real
  prebuilds of lmdb, better-sqlite3, msgpackr-extract, @napi-rs/canvas, davey, mediaplex and sharp, the whole gap is five
  functions: `WaitOnAddress`, `WakeByAddressSingle/All` (Windows 8), `ProcessPrng` (Windows 10) and
  `GetSystemTimePreciseAsFileTime` (Windows 8). So `graak compile` patches those addons in place
  (`src/compiler/Win7Compat.ts`, layout unchanged): the API-set DLL and `bcryptprimitives.dll` imports are renamed to
  Graak's own `fgsynch.dll` / `fgprng.dll`, shipped beside the addon where Windows looks first, and
  `GetSystemTimePreciseAsFileTime` is renamed to the signature-identical `GetSystemTimeAsFileTime`. Verified under Wine on
  the real Skia addon: with the shim present it loads and renders, with it removed it fails to bind.
- **The Universal C Runtime** (`api-ms-win-crt-*`, linked by libvips/sharp) is a Windows update on 7 (KB2999226).
  `--ucrt-dir <Redist\ucrt\DLLs\arch>` from a Windows SDK ships it app-local, which Microsoft permits.
- The patcher only touches imports it knows how to satisfy; anything else fails with the system's own message.

---

## Package managers

npm, pnpm, Yarn, Bun and Deno all build every target. The manager is detected from `packageManager` in `package.json`,
then the lockfile (`deno.lock` and `bun.lock` included), then a bare `deno.json`, then the invoking environment, and can
be forced with `--pm`.

**Deno projects.** A directory with a `deno.json`, `deno.jsonc` or `deno.lock` is a Deno project (`--pm deno` forces
it), and it needs no `package.json`. Deno resolves imports in ways neither engine does (an import map, `jsr:`, `npm:`
and `https:` specifiers, redirects, top-level `await`), so Graak asks Deno itself, the way it asks Yarn for a
Plug'n'Play project and Bun for TypeScript: `deno info --json` reports the module graph Deno builds for the entry
point, with every module's cached file and every npm package's directory, and Graak builds from that graph.

- The program's own code, `jsr:` packages and `https:` modules become **one bundle** (esbuild, answering every import
  from Deno's graph, so an import map, a version range or a redirect resolves as it does under Deno). Top-level
  `await` survives because the bundle runs inside an async function, `import.meta.url`, `.dirname`, `.filename`,
  `.main` and `.resolve()` are answered from where each file sits in the packaged application, and JSON imports and
  dynamic `import()` work.
- **`npm:` packages are not inlined.** They are laid out as a real `node_modules` tree beside the bundle, from Deno's
  own cache, so native addons, `__dirname` reads and dynamic requires keep working, and the rest of the build (Windows 7
  patching, V8 addon rebuilds, the ES module conversion) treats them like any other dependency.
- **`deno` 2.x must be on PATH at build time only**, never on the device. The project is not modified: no `deno.lock`
  or `node_modules` is written into it (`deno info` works on a scratch copy of the lock). `--offline` builds from
  Deno's cache alone.
- **The `Deno` namespace** (`quickjs/runtime/deno-shim.js`, inlined into the bundle, so it is the same on the Graak
  engine and on Node.js) is written over the Node.js API: `Deno.readFile`/`readTextFile`/`writeFile`/`writeTextFile`,
  `stat`, `readDir`, `mkdir`, `remove`, `rename`, `copyFile`, `symlink`, `open` and `FsFile`, `makeTempDir`/`File`,
  `Deno.env`, `args`, `cwd`, `exit`, `Deno.serve` (with TLS, `onListen`, `signal` and `shutdown`),
  `Deno.upgradeWebSocket` and a global `WebSocket` client, `Deno.listen`/`connect`/`listenTls`/`connectTls`,
  `Deno.Command` and `ChildProcess`, `Deno.permissions` (everything is granted, as with `deno compile -A`), signals,
  `Deno.errors` with Deno's classes and codes and the same message shape, and `Deno.build`/`version` matching the Deno used to build.
  Verified by running the same programs under real Deno and under Graak and comparing what they print: file system,
  environment, HTTP server and client, TCP, unix and UDP sockets, subprocesses, WebSocket, Deno KV, FFI and `Deno.test` corpora are identical, and a project with an
  import map, `jsr:`, `npm:`, a JSON import, top-level `await` and a file read beside the program runs identically on
  the Graak engine, on Node.js and as one Windows 7 `.exe` (under Wine).
- **The parts of Deno that need more than a file or a socket are provided too.** `Deno.openKv` is Deno KV on SQLite: keys in
  Deno's order (bytes, strings, bigints, numbers, booleans), values that round-trip Date, Map, Set, RegExp, typed arrays, BigInt,
  errors and cycles, `list` with prefix, range, `reverse`, `limit`, `cursor` and `batchSize`, `atomic()` with `check`, `set`,
  `delete`, `sum`, `min`, `max` and `enqueue`, `expireIn`, `KvU64`, versionstamps, `enqueue` with `delay`, `backoffSchedule` and
  `keysIfUndelivered`, `listenQueue`, `watch`. It writes an ordinary SQLite file that `node:sqlite` opens (the default location is
  `~/.graak/kv/`; a URL to a remote database is not reachable). `Deno.dlopen` is FFI on libffi: scalars, 64-bit integers as bigints,
  buffers, pointers as opaque objects, `UnsafePointer`, `UnsafePointerView`, `UnsafeFnPointer`, callbacks (`UnsafeCallback`),
  structs passed and returned by value and static data; a program that calls it gets the dynamically linked host, because a
  static one cannot load a library. `Deno.cron` runs UTC schedules in cron syntax (steps, ranges, lists, month and weekday
  names, Deno's object form) with `backoffSchedule` and `signal`. `Deno.watchFs`, `Deno.listen`/`connect` with
  `transport: "unix"`, `Deno.listenDatagram` (UDP), and `Deno.test` and `Deno.bench` complete it: the tests and benchmarks a
  program registers run after its main module and print what `deno test` and `deno bench` print (steps, `ignore`, `only`, the
  ERRORS and FAILURES sections, the summary, exit code 1 on failure), except where a failure is located, since a packaged program
  is one bundle.
- **Not the same as Deno:** FFI runs on the Graak engine only (a Node.js build gets `Deno.errors.NotSupported`, since Node.js has no
  foreign function interface); a `nonblocking` FFI symbol returns a promise but the call itself blocks the event loop while it
  runs, and a callback invoked from another thread is not delivered; `unixpacket` sockets are not available; an expired KV entry is
  hidden at once (Deno's local database hides it when its cleanup runs); `console.log` prints objects the way Node.js does
  (single-quoted strings), not the way Deno does.
- **Which targets Deno covers.** `graak info <target>` and `graak targets` say whether `deno compile` builds a target
  itself (`$canPackageOnDeno` says it from a bot). For those five, either tool works; for the others Graak is the only
  way to a Deno program on that device.
- **Go shared libraries work through the same `Deno.dlopen` path as C, unmodified.** `go build -buildmode=c-shared`
  produces an ordinary `.so`/`.dll`/`.dylib` plus a C header: cgo's `_cgo_`-prefixed runtime glue stays internal to
  the library, and each `//export`ed function is a plain C ABI symbol (extern "C", no name mangling) — the same
  shape `Deno.dlopen` already loads for a hand-written C library, so `fg_ffi.c`'s `dlopen`/`dlsym`/libffi call path
  needed no change to support it (verified in `test/goFfi.test.ts` by building a real cgo library and calling it
  under the packaged host, comparing against real Deno). Two things to build one: it needs `CGO_ENABLED=1` and a C
  compiler on the *build* machine (never on the device the Graak binary ships to), and once a program calls into it
  the Go runtime's own goroutine scheduler and GC threads start inside the process — leave the library loaded for
  the process's life rather than closing it, since Go's runtime does not support being unloaded from a process
  (`Deno.dlopen(...).close()` on a Go library is undefined). Memory ownership follows the same rule as any C FFI
  call: a pointer a Go function returns (typically from `C.CString`, which uses C's `malloc`) must be freed with
  whatever the library itself exports for that purpose (its own `C.free`-wrapping export), not with a function on
  the caller's side, since freeing across two different allocators is undefined behaviour whenever they differ. No
  legacy-Windows-specific `libgcc` caveat applies beyond the ones dynamic linking already has (see "Native addons"
  above): `-buildmode=c-shared` output links against the platform's C runtime the same way any other dynamically
  linked C library does.

```sh
graak compile main.ts --target win-legacy-x64                      # Deno program for Windows 7, no Deno on the device
graak compile main.ts --target win-xp-x86 --engine native --strategy sea --output app.exe   # one file
```

**Bun projects.** `bun build --compile` is the quick path for a modern 64-bit desktop, but its output needs Bun's runtime
on the device. Graak builds every target for Bun projects, `linux-armv7` included. TypeScript and JSX entrypoints are
transpiled automatically: on the Graak engine by Graak itself, on the Node.js engine with `bun build --target=node
--format=cjs --packages=external`, so the installed `node_modules` your lockfile pinned are what ships (`bun` is needed
at build time only). The Graak engine provides `bun:sqlite` (SQLite is built into the host) but not the rest of Bun (`Bun.*`, other `bun:` modules): use `node:` APIs. On Node.js targets `bun:sqlite` (over `node:sqlite`), `Bun.env/file/write/sleep/which/nanoseconds` and
`Bun.serve` are polyfilled; `Bun.password`, `Bun.hash`, `Bun.spawn` and FFI throw at the point of use rather than
substituting a different algorithm.

**Yarn Plug'n'Play.** A PnP project has no `node_modules` to collect. Graak asks Yarn itself for one: it copies the
project into a temporary directory and runs `YARN_NODE_LINKER=node-modules yarn install` there with the project's own
pinned `yarnPath`, so the same `yarn.lock` resolves to a real tree, the original project is never touched and Yarn's
resolver is never reimplemented. Verified against a real Yarn Berry install.

---

## The Node.js engine

Applies to builds that ship a Node.js runtime: `win-x86`, `win-modern-x64`, `linux-armv7`, `linux-modern-arm64`,
`darwin-*`, `freebsd-x86`, and any Graak-engine target moved back with `--engine node`, `--node-binary` or
`--strategy sea|portable`. The Graak engine needs none of this.

### Runtime pins for legacy targets

- **Windows 7**: Node.js **v12.22.12**, downloaded and verified automatically. Node's own tier list claims Windows 7
  support through v13, but community reports of later builds crashing on real Windows 7 make 12.22.12 the safe pin.
- **Windows Vista**: **v5.12.0**, the last release that runs there. It is pre-ES6, below what code lowering can reach,
  so the code ships unchanged and the build says so. See `graak info win-vista-x86`.
- **iSH and FreeBSD**: `apk` / `pkg` already have a current Node.js; the executable runs that install command itself on
  first launch.
- **Windows XP and 32-bit Linux** have no automatable Node.js path (XP's last release predates ES6 and modern TLS;
  32-bit Linux's last build is Node 12.16.3). Use the Graak engine, `--node-binary`, or `graak runtimes add`.

### Running modern code on old Node.js

When the target runtime is older than Node.js 20, Graak rewrites the program so it can run there:

- **Syntax.** Every bundled JavaScript file is re-emitted for the target's exact language level with esbuild. ES modules
  become CommonJS and `"type": "module"` is dropped. Your `node_modules` on disk is never touched.
- **APIs.** The missing platform surface is filled in at startup: Web Streams, `EventTarget`, `AbortController`,
  `Blob`/`File`/`FormData`, `DOMException`, `structuredClone`, `WeakRef`, the `node:` prefix, `crypto.randomUUID` and the
  newer `Array`/`String`/`Promise` statics, measured against a real Node 12.22.12.
- **Code generated at runtime.** esbuild's WebAssembly build ships with the bundle (~3.6 MiB compressed) and lowers
  source a program builds while running (ForgeScript does, via `new Function`), memoised per template.

Deliberately not done: `Intl.Segmenter` sentence granularity throws instead of being approximated; `WeakRef`/`FinalizationRegistry` hold
strong references and never finalize; a dependency's `engines.node` floor is overridden and the build says so; below
Node.js 6 nothing is rewritten.

### Legacy behaviour

Old and 32-bit targets get two adjustments, derived from the target metadata: undici's SIMD parser is disabled
(`UNDICI_NO_WASM_SIMD=1`), and a native addon shim answers `ERR_DLOPEN_FAILED` only where a correct replacement exists:

| Package | On a legacy target |
| --- | --- |
| `bufferutil`, `utf-8-validate` | Replaced by pure JS with identical behaviour. |
| `sqlite3`, `better-sqlite3` | Backed by built-in `node:sqlite` (Node >= 22.5). Rows go to the real database file. |
| `zlib-sync`, `msgpackr-extract`, `pg-native`, `mediaplex`, opus | Error passed through, so the library takes its own pure-JS path. |
| `lmdb`, `canvas`, `@gifsx/gifsx`, `sodium-native`, `@snazzah/davey`, `bcrypt`, `argon2` | Load fails with an explanation. |

The last row is deliberate: a stub that returns blank images, drops database writes or hashes with a weaker algorithm
leaves a program that looks healthy while losing data or its security guarantees.

---

## CLI

```sh
# The entrypoint is JavaScript or TypeScript (a Node.js build needs it compiled first), or a folder of built files.
graak compile dist/index.js --target linux-modern-x64      # Graak engine, no Node.js in the output
graak compile dist/index.js --target ios-ish-x86           # Graak engine, static musl
graak compile dist/index.js --target win-legacy-x64        # Graak engine, Windows 7 patches applied
graak compile dist/index.js --target win-legacy-x64 --engine native --strategy sea   # one .exe of about 5 MB
graak compile ./dist --target linux-modern-x64 --spa --port 8080                     # a built website
graak compile dist/index.js --target win-modern-x64        # sea, official Node.js
graak compile dist/index.js --target win-vista-x86 --node-binary ./node-5.12.0/node.exe

graak compile main.ts --target win-legacy-x64              # a Deno project (deno.json), for Windows 7
graak targets [--pm <package manager>]
graak info win-legacy-x64 [--db sqlite]     # engine, architecture, format, Node.js fallback, warnings
graak extensions                            # ForgeScript extensions a project uses, with legacy compatibility
graak inspect ./graak-out/app-linux-modern-x64
graak runtimes list [--target <target>]
graak runtimes add linux-x86 12.16.3 https://example.com/node-linux-x86.tar.gz --sha256 <hex>
graak runtimes remove linux-x86 12.16.3
graak version
```

| Option | Effect |
| --- | --- |
| `-t, --target <name>` | Target device (see `graak targets`) |
| `-o, --output <path>` | Output file (a single-file build, or a Node.js SEA) or directory (a folder build) |
| `-e, --engine auto\|native\|node` | Which engine runs the program. `auto` follows the target. `native` forces the Graak engine (and refuses a target without one); with it, `--strategy sea` is [one file](#one-file). `node` forces a Node.js build |
| `-s, --strategy auto\|sea\|portable` | `auto` picks the target's default. Without `--engine`, `sea` or `portable` also moves a Graak-engine target onto Node.js |
| `--static`, `--spa`, `--port <n>`, `--host <addr>`, `--index <file>` | [Static sites](#static-sites) |
| `--pm <name>` | Package manager or runtime override (`bun`, `deno`, `pnpm`, `npm`, `yarn`) |
| `--node-binary <path>` | Use this Node.js runtime instead of the target's default. Also moves a Graak-engine target onto Node.js |
| `--node-version <ver>` | Official Node.js version to download (`22` or `22.11.0`) |
| `--native-libc musl\|musl-dynamic\|glibc` | Libc of the Graak host. `musl` (static) is the default and runs on glibc and musl systems; it cannot load addons, so a program that needs one gets a dynamic host automatically |
| `--ucrt-dir <dir>` | `Redist\ucrt\DLLs\<arch>` from a Windows SDK, shipped app-local for addons that need the Universal C Runtime on Windows 7 |
| `--offline` | Never download runtimes or fetch addon sources |
| `--include-dev` | Bundle devDependencies too |
| `--include-env` | Bundle `.env` files (they usually contain secrets) |
| `--allow-native-mismatch` | Build even when native addons are built for another platform (a trimmed Graak-engine build leaves those binaries out; `--no-trim` keeps them) |
| `--no-trim` | Graak engine: ship every collected file instead of only the ones the program can load ([Trim](#how-a-build-works)) |

---

## Programmatic API

Everything the CLI does is available from Node.js, and importing Graak does not load ForgeScript:

```js
const { BinaryPackager } = require("graak");

const result = await BinaryPackager.compile({
    entrypoint: "dist/index.js",
    target: "win-legacy-x64",
    engine: "native",
    strategy: "sea",
    output: "graak-out/app.exe",
    onLog: console.log,
});
console.log(result.outputPath, result.sizeBytes, result.warnings);
```

`graak` also exports `TargetDevice`, `TARGET_METADATA_MAP`, `PolicyEnforcer`, `QuickJsPackager`, `StaticSite`,
`LegacyTranspiler`, `Win7Compat`, `BinaryInspector`, `RuntimeRegistry` and `GraakError`, with type declarations.

---

## ForgeScript extension

For projects built on [ForgeScript](https://github.com/tryforge/ForgeScript), Graak is also a ForgeScript extension, kept
in its own entry point so that the rest of the package does not depend on it:

```js
const { ForgeClient } = require("@tryforge/forgescript");
const { Graak } = require("graak/forgescript");

const client = new ForgeClient({
    // ...your options
    extensions: [
        new Graak({
            allowCompile: false, // set true to enable $compileBinary
            root: process.cwd(),  // file arguments are confined to this directory
        }),
    ],
});
```

`$compileBinary` stays disabled unless `allowCompile: true`. The function reference lives in `metadata/functions.json`
(regenerate with `bun run docgen`).

| Group | Functions |
| --- | --- |
| Build | `$compileBinary`, `$dbDriverCompat`, `$suggestDbDriver`, `$graakVersion` |
| Binary | `$binarySize`, `$sha256Binary`, `$verifyBinaryHeader`, `$generateSeaConfig` |
| Policy | `$isTargetSupported`, `$supportedTargets`, `$packageManager`, `$packagerType`, `$canPackageOnBun`, `$canPackageOnDeno` |
| Target | `$listPlatforms`, `$targetName`, `$targetDescription`, `$targetPlatform`, `$targetBits`, `$binaryArchitecture`, `$binaryExtension`, `$binaryFormat`, `$is32BitTarget`, `$is64BitTarget`, `$is32BitOrLegacy`, `$isArmTarget`, `$isIsh`, `$isLegacyWindows` |

`$packagerType` returns `native` for a target on the Graak engine and `sea` or `portable` for the Node.js targets.

---

## Environment variables

| Variable | Effect |
| --- | --- |
| `GRAAK_CACHE` | Cache directory (hosts, Node.js runtimes, converted modules, toolchains). Defaults to `%LOCALAPPDATA%\graak\cache` on Windows and `~/.cache/graak` elsewhere |
| `GRAAK_UCRT_DIR` | Same as `--ucrt-dir` |
| `GRAAK_C` | Path of a built `graak-c`, for the test suite's native self-test |
| `GRAAK_QJS` | Path of a `qjs` binary, for the test suite's engine comparison |
| `GRAAK_NAN_DIR` | NAN sources, for the V8 addon tests |
| `GRAAK_HOME` | Where a Node.js build extracts its archive (default: beside the executable) |
| `GRAAK_NODE`, `GRAAK_DIR` | Read by the generated portable launchers to find their Node.js runtime |
| `GRAAK_APP_DIR`, `GRAAK_EXECUTABLE`, `GRAAK_JS_TARGET` | Set for a Node.js build's program by its launcher: the unpacked application directory, the executable, and the language level code was lowered to |

---

## Development

```sh
bun install
bun run typecheck && bun run typecheck:test && bun run build && bun run test && bun run check
```

The repository is installed and driven with Bun (`bun.lock`). Its scripts are plain `tsc` and `node` commands, so npm, pnpm, Yarn
and Deno (`deno task`) run the same ones; only the lockfile is Bun's. `bun test` is Bun's own runner, not this suite: use
`bun run test`.

`bun run test` compiles first and runs everything under `test/` with Node's test runner. Checks that need something extra
skip themselves when it is missing: a built host (`GRAAK_C`), `qjs` (`GRAAK_QJS`), the musl.cc toolchains on `PATH`, NAN
sources (`GRAAK_NAN_DIR`), `deno` (the Deno corpora and project compare against real Deno; the project needs the jsr and npm packages reachable or cached) and the `fg-wine` Docker image, which runs the Windows host (build it with `docker build -t fg-wine -f test/docker/fg-wine.Dockerfile test/docker`). `dist/` is committed, so run
`bun run build` before committing.

Layout: `src/compiler` (collect, convert, package), `src/structures` (targets, errors), `src/runtime` (launchers and
polyfills for Node.js builds), `src/integrations` (database driver knowledge), `src/forgescript` (the optional
ForgeScript adapter), `quickjs/native` (the C host), `quickjs/runtime` (its JavaScript standard library) and
`quickjs/prebuilt` (shipped hosts and DLLs).

After **any** change under `quickjs/native/` or `quickjs/winxp-compat.patch`, rebuild the shipped hosts (about seven
minutes, with the cross toolchains on `PATH`) and commit them:

```sh
bun run prebuilts
```

<h3 align="center">Credits</h3><hr>

- [quickjs-ng](https://github.com/quickjs-ng/quickjs), [mbedTLS](https://github.com/Mbed-TLS/mbedtls),
  [miniz](https://github.com/richgel999/miniz) and [wasm3](https://github.com/wasm3/wasm3) power the Graak host.
- [esbuild](https://esbuild.github.io) converts and lowers code, and [postject](https://github.com/nodejs/postject)
  injects Node.js single executables.
- [ForgeScript](https://github.com/tryforge/ForgeScript) by the BotForge team, for the optional extension.

Licensed under GPL-3.0-or-later (see `LICENSE`).
