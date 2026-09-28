# Graak: rules for coding agents

Graak (github.com/ariel-aram/graak) packages a JavaScript or TypeScript program (server, site, CLI, bot) into one standalone
executable for every device, legacy Windows and 32-bit systems included, with no Node.js on the device. It does that on its own
engine (quickjs-ng plus a C host with mbedTLS, miniz, wasm3, SQLite and libffi, and a Node-shaped JavaScript layer), or on a
Node.js runtime where one exists for the target. Bun and Deno projects are built with Graak as the sidekick. The ForgeScript
adapter under `src/forgescript` is optional; nothing else depends on it.

This file is the shared rulebook. `CLAUDE.md` and `GEMINI.md` import it and add only what is specific to that tool.
OpenCode reads this file directly.

## What matters most

1. **The legacy Windows path** (Windows XP, Vista, 7, 32-bit builds) is the priority. The goal is that no device is excluded
   from running a Graak binary. When a change helps a modern target and hurts XP/Vista/7 or 32-bit, it is wrong.
2. **"Can't" is a gap to engineer around.** Every module, addon and API should run on every target. Do not declare a limit,
   stub a feature silently, or return a plausible fake. If something truly cannot work, say so in the code path (a clear error)
   and in the README's limits, and say what was tried.
3. **Verify against the real thing.** Behaviour is checked by running the same program under real Node.js (and Deno, for the Deno
   corpora) and under the packaged host, and requiring identical output. "It runs" is not the bar; "indistinguishable" is.

## Layout

- `src/compiler`: collect the project, convert it, package it (`BinaryPackager` picks the strategy; `QuickJsPackager` is the
  Graak engine; `SeaPackager` and `PortablePackager` are the Node.js paths; `DenoBundler` and `DenoProject` handle Deno).
- `src/structures` (targets, errors), `src/runtime` (launchers and polyfills for Node.js builds), `src/integrations`
  (database driver knowledge), `src/forgescript` (optional adapter), `src/cli.ts`.
- `quickjs/native`: the C host (`graak_native.c`, `napi.c`, `fg_*.c`, `build.sh`, `win-compat/` shims for old Windows).
- `quickjs/runtime`: the host's JavaScript standard library. `node-compat.js` is the entry. Every runtime file the host needs
  must be listed in `RUNTIME_FILES` in `src/compiler/QuickJsPackager.ts`; the Intl data files are picked up by name.
- `quickjs/prebuilt`: the shipped hosts (`hosts/*.gz`) and Windows DLLs, with a manifest that hashes `quickjs/native`.
- `test/`: Node's test runner; `test/fixtures/web/*.cjs` are the differential corpora; `dist/` is committed.
- `tools/`: `build-prebuilts.js`, `engine-conformance.js`, `gen-intl-data.js`, `gen-intl-collation.js`.

## Commands

```sh
bun install
bun run typecheck && bun run build && bun run check     # tsc --noEmit, tsc (writes dist/), biome
bun run test                                      # tsc, then every test/**/*.test.ts
node --test test/webRuntime.test.ts            # one suite while iterating
bun run prebuilts                                 # rebuild the shipped hosts (about seven minutes, cross toolchains on PATH)
bunx biome check --write                  # format and fix (src, test, tools, the JSON configs)
bun run typecheck:test                    # tsc over test/*.ts
```

The repository is installed and driven with Bun (`bun.lock`). The scripts are plain `tsc` and `node` commands, so `npm run`,
`pnpm run`, `yarn` and `deno task` run the same ones from a `package.json` install of any of them; only the lockfile is
Bun's. `bun test` is Bun's own runner, not this suite: use `bun run test`.

Biome uses tabs, line width 120. `dist/` is committed: run `bun run build` before committing.

## Definition of done

Run the whole chain; a red check means fix and re-run all of it. Never call something done with a failing or skipped-when-it-should-run check.

1. `bunx biome check --write`, `bun run typecheck`, `bun run typecheck:test`, `bun run build`.
2. The suite that covers the change while iterating, then the **full** `bun run test` before reporting.
3. **Runtime changes** (`quickjs/runtime`): the matching differential corpus in `test/fixtures/web` must print exactly what Node.js
   prints. New behaviour gets a corpus line, and the corpus is added to `DIFFERENTIAL` in `test/webRuntime.test.ts`.
4. **C changes** (`quickjs/native`, `winxp-compat.patch`): `bun run prebuilts`, commit the regenerated hosts, then run the Wine tests.
   Batch all C changes for a work session into ONE prebuilt rebuild.
5. **Windows-facing changes**: the Wine and Docker tests (`fg-wine` image: the Windows hosts and single-file builds) are part
   of the bar and must actually run, not skip. Check an executable's imports (`objdump -p`) before claiming an old-Windows fix.
6. **Packaging changes**: build a real fixture and run the output, with no Node.js on the path where the target is the Graak engine.

Baselines: check corpora against **Node.js 24.21.0 (LTS)** and **26.9.0 (Current)**. Where they differ, say which one a
behaviour follows. Node 26's ICU aborts the process on some option mixes (era, numeric date and weekday in `de-CH`), so a corpus
must not contain them.

## Intl on the host

`quickjs/runtime/intl.js` (engine) and `intl-zone.js` (calendar and POSIX-TZ math) run over data generated from Node's own ICU by
`tools/gen-intl-data.js` (plus `gen-intl-collation.js`): `intl-data.js` (shared), `intl-<tag>.js` (formats), `intl-names-<tag>.js`.
Do not edit the generated files; change the generator and regenerate.

```sh
INTL_ZONE_CACHE=/tmp/zones.json node tools/gen-intl-data.js   # zone sampling from ICU is ~80 s; the cache skips it
```

Delete the cache when zone logic changes. While iterating, narrow `LOCALES` to a few tags and restore all 39 before the final run.
Verify with `intl-corpus.cjs` and `intl-fuzz.cjs` (in `DIFFERENTIAL`). Builds ship the data only when the program mentions Intl or
the locale-aware built-ins (`--intl auto|all|none`).

## Scope discipline (read before chasing a diff)

- The stopping rule for a compatibility area is **zero diff on realistic use**, not on every combination ICU or Node accepts.
  Odd option mixes, one-off quirks (a V8 `resolvedOptions()` oddity, a zone's generic name) go in the README's known gaps, not
  into hours of work.
- Prefer the smallest change that makes real packages (Express, Fastify, Hono, ws, discord.js, undici, native addons) work.
- Do not add features, options or abstractions nobody asked for. Match the surrounding code, comment density and naming.

## Git

- Commit locally after the checks are green, one milestone per commit, conventional prefixes (`feat:`, `fix:`, `docs:`, `test:`,
  `chore:`). Do not push unless the user asks. Never rewrite pushed history.
- Commit messages and docs are written in normal prose, whatever the chat style is.
- Never commit credentials, tokens or passwords, and never use one pasted in a conversation.
- Deploys, database writes, secrets and anything hard to reverse: confirm first.

## Working in parallel

Independent gaps can be worked at the same time by separate agents, each in its own git worktree or branch: TLS client options,
`dns`, Brotli, DH/ECDH, HTTP/2, `node:test`. Rules:

- Two agents never edit the same file set. `quickjs/native/*`, `quickjs/prebuilt/*`, the generated `intl-*.js` files and
  `dist/` are single-writer: one agent owns them at a time, and the C work of all agents is merged before the one prebuilt rebuild.
- Each agent finishes its own definition of done (above) before handing back, and reports what it ran and what it saw.
- The integrating agent runs the full `bun run test`, including the Wine and Docker tests, on the merged result.

## Traps already paid for

- When patching a file with a script, read that file into the variable you write back. Writing a stale variable overwrote
  `README.md` once; `git diff --stat` after every scripted edit catches it.
- Wait on a marker your own run writes after you clear it, not on a file a previous run left behind.
- `pkill -f <pattern>` kills your own shell if the pattern is in its command line.
- A generated file, a manifest hash and `dist/` all go stale silently: regenerate, rebuild, then test.
- `es-419`-style tags have a numeric region: patterns that assume two capital letters miss them.
- Windows before 10 has no AF_UNIX; UDP, sockets and libuv-shaped calls need their own emulation there. Look at
  `quickjs/native/win-compat` before assuming a POSIX call exists.

## Open work

TLS client options, Brotli/Zstd, `crypto` DH/ECDH/primes/X509, HTTP/2, `v8.Serializer`, `URLPattern`, the libuv subset on
Windows, cluster, wasi, repl and inspector are all closed; see the README's per-module rows for what each one covers and its
own small known gaps. `createSign`/`createVerify`/`crypto.sign`/`crypto.verify` with a BLAKE2 digest now match Node for RSA,
classic DSA (both reject it) and ECDSA (Node signs and verifies with it like any other digest, and so does the host: the
digest is computed in JavaScript and handed to mbedTLS as already-hashed bytes, since mbedTLS's own digest table has no
BLAKE2 entry to compute it from the name).

What is genuinely still absent, not just narrowed: `node:sqlite` user-defined functions and extensions (`backup()` is
implemented: rate-limited `sqlite3_backup_step` stepping driven from JavaScript, with `progress`, `source`/`target` and
Node's own validation and error shapes, so no C-callback-into-JS bridging was needed; `function()`, the scalar
`sqlite3_create_function_v2` binding, is implemented and differentially verified on the `sqlite-function-pending-prebuilt`
branch, not yet merged: this environment's egress policy blocks both `sqlite.org` and `musl.cc`, so no native host here
can rebuild from source once `fg_sqlite.c` changes, prebuilt or not — merge it on a machine that can reach both);
`node:test`'s `mock.module` for ESM (`import`/`import()` go through the engine's native module loader, which no
JS-only hook can intercept — CommonJS `require()` mocking is implemented, gated behind
`--experimental-test-module-mocks` exactly as Node gates it, for CommonJS as well as ESM); the inspector's `Profiler`,
`HeapProfiler` and `Debugger` domains (quickjs has no debugger protocol or profiler to back them); and native addon
loading on a static host (no dynamic loader there — the packager falls back to a dynamic host automatically). The legacy
Windows path comes first.
