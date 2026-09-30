// node:wasi over hand-assembled modules. A generated module forwards every wasi_snapshot_preview1 import as an export, so the
// corpus drives each call directly on linear memory. Output must equal Node's (stderr carries Node's ExperimentalWarning).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const { WASI } = require("node:wasi");

const out = [];
const log = (...a) => { out.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x, (k, v) => (typeof v === "bigint" ? v + "n" : v)))).join(" ")); if (process.env.WASI_TRACE) console.error(out[out.length - 1]); };
const leb = (n) => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return b; };
const str = (s) => [s.length, ...Buffer.from(s)];
const vec = (items) => [...leb(items.length), ...items.flat()];
const section = (id, body) => [id, ...leb(body.length), ...body];
const header = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];

const ERR = { 0: "SUCCESS", 61: "OVERFLOW", 42: "NOBUFS", 1: "2BIG", 2: "ACCES", 8: "BADF", 20: "EXIST", 21: "FAULT", 28: "INVAL", 29: "IO", 31: "ISDIR", 32: "LOOP", 44: "NOENT", 52: "NOSYS", 54: "NOTDIR", 55: "NOTEMPTY", 58: "NOTSUP", 63: "PERM", 70: "SPIPE", 76: "NOTCAPABLE" };
const en = (n) => ERR[n] ?? "E" + n;

// name -> parameter letters (i = i32, I = i64), result is always i32 unless noted
const SIGS = {
  args_get: "ii", args_sizes_get: "ii", clock_res_get: "ii", clock_time_get: "iIi", environ_get: "ii", environ_sizes_get: "ii",
  fd_advise: "iIIi", fd_allocate: "iII", fd_close: "i", fd_datasync: "i", fd_fdstat_get: "ii", fd_fdstat_set_flags: "ii",
  fd_fdstat_set_rights: "iII", fd_filestat_get: "ii", fd_filestat_set_size: "iI", fd_filestat_set_times: "iIIi", fd_pread: "iiiIi",
  fd_prestat_get: "ii", fd_prestat_dir_name: "iii", fd_pwrite: "iiiIi", fd_read: "iiii", fd_readdir: "iiiIi", fd_renumber: "ii",
  fd_seek: "iIii", fd_sync: "i", fd_tell: "ii", fd_write: "iiii", path_create_directory: "iii", path_filestat_get: "iiiii",
  path_filestat_set_times: "iiiiIIi", path_link: "iiiiiii", path_open: "iiiiiIIii", path_readlink: "iiiiii",
  path_remove_directory: "iii", path_rename: "iiiiii", path_symlink: "iiiii", path_unlink_file: "iii", poll_oneoff: "iiii",
  proc_raise: "i", random_get: "ii", sched_yield: "", sock_accept: "iii", sock_recv: "iiiiii", sock_send: "iiiii", sock_shutdown: "ii",
};
const names = Object.keys(SIGS);
const T = (l) => (l === "I" ? 0x7e : 0x7f);

function trampoline(ns) {
  const typeList = [];
  const typeOf = (sig, results) => {
    const key = sig + ">" + results;
    let i = typeList.findIndex((t) => t.key === key);
    if (i < 0) { typeList.push({ key, bytes: [0x60, ...vec([...sig].map((l) => [T(l)])), ...vec(results ? [[0x7f]] : [])] }); i = typeList.length - 1; }
    return i;
  };
  const all = [...names.map((n) => [n, SIGS[n], 1]), ["proc_exit", "i", 0]];
  const imports = all.map(([n, s, r]) => [...str(ns), ...str(n), 0, typeOf(s, r)]);
  const funcs = all.map(([, s, r]) => [typeOf(s, r)]);
  const bodies = all.map(([, s], i) => {
    const code = [];
    [...s].forEach((_, k) => code.push(0x20, k));
    code.push(0x10, i, 0x0b);
    return [...leb(code.length + 1), 0, ...code];
  });
  const exps = [[...str("memory"), 2, 0], ...all.map(([n], i) => [...str("w_" + n), 0, all.length + i])];
  return new Uint8Array([...header, ...section(1, vec(typeList.map((t) => t.bytes))), ...section(2, vec(imports)), ...section(3, vec(funcs)),
    ...section(5, vec([[0, 2]])), ...section(7, vec(exps)), ...section(10, vec(bodies))]);
}

// _start: fd_write(1, iov@0, 1, 32) then proc_exit(code); optional _initialize instead
function startModule(ns, code, { exportName = "_start", withMemory = true, writeText = true, callExit = true } = {}) {
  const types = section(1, vec([[0x60, 1, 0x7f, 0], [0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f], [0x60, 0, 0]]));
  const imports = section(2, vec([[...str(ns), ...str("proc_exit"), 0, 0], [...str(ns), ...str("fd_write"), 0, 1]]));
  const funcs = section(3, vec([[2]]));
  const mem = section(5, vec([[0, 1]]));
  const exps = section(7, vec([...(withMemory ? [[...str("memory"), 2, 0]] : []), [...str(exportName), 0, 2]]));
  const body = [0];
  if (writeText) body.push(0x41, 1, 0x41, 0, 0x41, 1, 0x41, 32, 0x10, 1, 0x1a);
  if (callExit) body.push(0x41, code, 0x10, 0);
  body.push(0x0b);
  const data = section(11, vec([[0, 0x41, 0, 0x0b, ...vec([8, 0, 0, 0, 3, 0, 0, 0, ...Buffer.from("hi\n")].map((b) => [b]))]]));
  return new Uint8Array([...header, ...types, ...imports, ...funcs, ...mem, ...exps, ...section(10, vec([[...leb(body.length), ...body]])), ...data]);
}

if (process.argv[2] === "default-stdio-child") {
  // Forked in isolation (own fd 1, piped to the parent, never console.log'd directly): closes the module's own
  // inherited stdout through WASI fd_close and reports what happened to the real OS descriptor via IPC, since fd 1
  // itself is unusable for reporting once closed.
  (async () => {
    const wasi = new WASI({ version: "preview1", args: [], env: {}, returnOnExit: true });
    const inst = (await WebAssembly.instantiate(trampoline("wasi_snapshot_preview1"), wasi.getImportObject())).instance;
    wasi.finalizeBindings(inst);
    const write = () => { try { fs.writeSync(1, "x"); return "ok"; } catch (e) { return e.code; } };
    const before = write();
    const errno = inst.exports.w_fd_close(1);
    const after = write();
    process.send({ before, errno, after });
    process.exit(0);
  })();
} else {
  const warn = process.emitWarning;
  process.emitWarning = () => {};

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wasi-corpus-"));
  const catchCode = (f) => { try { f(); return "ok"; } catch (e) { return e.code ?? e.name; } };

  (async () => {
  // ---- constructor and import object
  log("ctor", catchCode(() => new WASI({ version: "bogus" })), catchCode(() => new WASI({ version: "preview1", args: "x" })),
    catchCode(() => new WASI({ version: "preview1", env: 5 })), catchCode(() => new WASI({ version: "preview1", preopens: 5 })),
    catchCode(() => new WASI({ version: "preview1", stdin: "x" })), catchCode(() => new WASI({ version: "preview1", returnOnExit: 1 })));
  log("ctor ok", catchCode(() => new WASI({ version: "preview1" })), catchCode(() => new WASI({ version: "unstable" })), Object.prototype.toString.call(new WASI({ version: "preview1" })));
  const imp1 = new WASI({ version: "preview1" }).getImportObject();
  const imp2 = new WASI({ version: "unstable" }).getImportObject();
  log("import ns", Object.keys(imp1), Object.keys(imp2));
  const nsFns = Object.keys(imp1.wasi_snapshot_preview1).sort();
  log("import names", nsFns.length, nsFns.join(","));
  log("import types", [...new Set(Object.values(imp1.wasi_snapshot_preview1).map((f) => typeof f))]);
  log("import arity", nsFns.filter((n) => imp1.wasi_snapshot_preview1[n].length !== (n === "proc_exit" ? 1 : SIGS[n].length)));

  // ---- start / initialize / finalizeBindings lifecycle
  const stdoutFile = path.join(tmp, "stdout.txt");
  const stdoutFd = fs.openSync(stdoutFile, "w");
  {
    const wasi = new WASI({ version: "preview1", returnOnExit: true, stdout: stdoutFd });
    const inst = (await WebAssembly.instantiate(startModule("wasi_snapshot_preview1", 7), wasi.getImportObject())).instance;
    log("start exit", wasi.start(inst));
    log("start twice", catchCode(() => wasi.start(inst)));
    fs.closeSync(stdoutFd);
    log("stdout file", JSON.stringify(fs.readFileSync(stdoutFile, "utf8")));
  }
  {
    const wasi = new WASI({ version: "preview1" });
    const inst = (await WebAssembly.instantiate(startModule("wasi_snapshot_preview1", 11, { writeText: false }), wasi.getImportObject())).instance;
    log("default returnOnExit", wasi.start(inst));
  }
  {
    const wasi = new WASI({ version: "preview1", returnOnExit: true });
    const inst = (await WebAssembly.instantiate(startModule("wasi_snapshot_preview1", 0, { writeText: false, callExit: false }), wasi.getImportObject())).instance;
    log("start return", wasi.start(inst));
  }
  {
    const wasi = new WASI({ version: "preview1" });
    const inst = (await WebAssembly.instantiate(startModule("wasi_snapshot_preview1", 0, { writeText: false, callExit: false, exportName: "_initialize" }), wasi.getImportObject())).instance;
    const w0 = new WASI({ version: "preview1" });
    log("start w/o _start", catchCode(() => w0.start(inst)));
    log("initialize", wasi.initialize(inst));
    log("initialize twice", catchCode(() => wasi.initialize(inst)));
    log("start after init", catchCode(() => wasi.start(inst)));
  }
  {
    const wasi = new WASI({ version: "preview1" });
    const inst = (await WebAssembly.instantiate(startModule("wasi_snapshot_preview1", 0, { writeText: false, callExit: false, withMemory: false }), wasi.getImportObject())).instance;
    log("start w/o memory", catchCode(() => wasi.start(inst)));
    log("start bad arg", catchCode(() => wasi.start({})), catchCode(() => wasi.start()));
    log("initialize bad arg", catchCode(() => wasi.initialize({})));
  }
  {
    const wasi = new WASI({ version: "preview1", returnOnExit: true });
    const inst = (await WebAssembly.instantiate(startModule("wasi_snapshot_preview1", 3, { writeText: false }), wasi.getImportObject())).instance;
    wasi.finalizeBindings(inst);
    log("finalize twice", catchCode(() => wasi.finalizeBindings(inst)));
    log("start after finalize", catchCode(() => wasi.start(inst)));
    const w2 = new WASI({ version: "preview1", returnOnExit: true });
    const i2 = (await WebAssembly.instantiate(startModule("wasi_snapshot_preview1", 3, { writeText: false }), w2.getImportObject())).instance;
    w2.finalizeBindings(i2, { memory: i2.exports.memory });
    log("finalize memory", catchCode(() => w2.start(i2)));
    const w3 = new WASI({ version: "preview1" });
    log("finalize bad", catchCode(() => w3.finalizeBindings({})), catchCode(() => w3.finalizeBindings(i2, { memory: {} })));
  }
  {
    // the unstable namespace runs the same module under its own import name
    const wasi = new WASI({ version: "unstable", returnOnExit: true });
    const inst = (await WebAssembly.instantiate(startModule("wasi_unstable", 9, { writeText: false }), wasi.getImportObject())).instance;
    log("unstable exit", wasi.start(inst));
  }

  // ---- syscall sweep
  const sandbox = path.join(tmp, "sandbox");
  fs.mkdirSync(sandbox);
  fs.writeFileSync(path.join(sandbox, "pre.txt"), "preexisting");
  const ioFiles = ["in", "out", "err"].map((n) => fs.openSync(path.join(tmp, n + ".txt"), n === "in" ? "w+" : "w"));
  const wasi = new WASI({
    version: "preview1",
    stdin: ioFiles[0],
    stdout: ioFiles[1],
    stderr: ioFiles[2],
    args: ["prog", "alpha", "be ta"],
    env: { A: "1", B: "two" },
    preopens: { "/sandbox": sandbox },
    returnOnExit: true,
  });
  const inst = (await WebAssembly.instantiate(trampoline("wasi_snapshot_preview1"), wasi.getImportObject())).instance;
  wasi.finalizeBindings(inst);
  const mem = inst.exports.memory;
  const dv = () => new DataView(mem.buffer);
  const u8 = () => new Uint8Array(mem.buffer);
  const sys = (name, ...args) => {
    const conv = [...SIGS[name]].map((l, i) => (l === "I" ? BigInt(args[i]) : args[i]));
    return inst.exports["w_" + name](...conv);
  };
  const put = (s, ptr) => { const b = Buffer.from(s); u8().set(b, ptr); return b.length; };
  const pp = (s, ptr) => { put(s, ptr); return ptr; };
  const get = (ptr, len) => Buffer.from(u8().slice(ptr, ptr + len)).toString("latin1");
  const P = 4096; // output scratch
  const S = 8192; // strings
  const B = 16384; // data buffers
  const call = (name, ...args) => en(sys(name, ...args));
  const withPath = (name, fd, p, ...rest) => { const n = put(p, S); return sys(name, fd, S, n, ...rest); };
  const flagsPath = (name, fd, flags, p, ...rest) => { const n = put(p, S); return sys(name, fd, flags, S, n, ...rest); };
  const ALL = 0xfffffffn;
  const DIRR = 264240792n;
  const openPath = (dirfd, p, oflags = 0, fdflags = 0, dirflags = 1, rights = ALL, inh = rights) => {
    const n = put(p, S);
    const e = sys("path_open", dirfd, dirflags, S, n, oflags, rights, inh, fdflags, P);
    return [e, e === 0 ? dv().getUint32(P, true) : -1];
  };
  const iov = (ptr, bufs) => { bufs.forEach(([p, l], i) => { dv().setUint32(ptr + i * 8, p, true); dv().setUint32(ptr + i * 8 + 4, l, true); }); return bufs.length; };

  // args and environ
  log("args sizes", en(sys("args_sizes_get", P, P + 4)), dv().getUint32(P, true), dv().getUint32(P + 4, true));
  log("args", en(sys("args_get", 256, 512)), [0, 1, 2].map((i) => { let p = dv().getUint32(256 + i * 4, true); let s = ""; while (u8()[p]) s += String.fromCharCode(u8()[p++]); return s; }), dv().getUint32(256 + 12, true));
  log("environ sizes", en(sys("environ_sizes_get", P, P + 4)), dv().getUint32(P, true), dv().getUint32(P + 4, true));
  log("environ", en(sys("environ_get", 256, 512)), get(512, dv().getUint32(P + 4, true)).split("\0").slice(0, 2));

  // clocks and random
  for (const id of [0, 1, 2, 3, 4, 99]) {
    const e = sys("clock_res_get", id, P);
    log("clock_res", id, en(e), e === 0 ? dv().getBigUint64(P, true) > 0n : "-");
  }
  {
    const before = BigInt(Date.now()) * 1000000n;
    const e = sys("clock_time_get", 0, 1, P);
    const t = dv().getBigUint64(P, true);
    log("clock realtime", en(e), t >= before - 5000000000n && t <= before + 5000000000n);
    sys("clock_time_get", 1, 1, P);
    const m1 = dv().getBigUint64(P, true);
    sys("clock_time_get", 1, 1, P);
    log("clock monotonic", m1 > 0n, dv().getBigUint64(P, true) >= m1);
    log("clock cpu", call("clock_time_get", 2, 1, P), call("clock_time_get", 3, 1, P), call("clock_time_get", 77, 1, P));
  }
  {
    u8().fill(0, B, B + 32);
    log("random", call("random_get", B, 32), u8().slice(B, B + 32).some((x) => x !== 0));
    const first = get(B, 32);
    sys("random_get", B, 32);
    log("random differs", first !== get(B, 32), call("random_get", B, 0));
  }

  // prestat
  log("prestat 3", en(sys("fd_prestat_get", 3, P)), dv().getUint8(P), dv().getUint32(P + 4, true));
  log("prestat name", en(sys("fd_prestat_dir_name", 3, B, 8)), get(B, 8));
  log("prestat 4", call("fd_prestat_get", 4, P), call("fd_prestat_get", 0, P), call("fd_prestat_get", 99, P));

  // stdio fdstat
  for (const fd of [0, 1, 2]) {
    const e = sys("fd_fdstat_get", fd, P);
    log("stdio fdstat", fd, en(e), dv().getUint8(P), dv().getBigUint64(P + 8, true), dv().getBigUint64(P + 16, true));
  }
  log("dir fdstat", en(sys("fd_fdstat_get", 3, P)), dv().getUint8(P), dv().getBigUint64(P + 8, true), dv().getBigUint64(P + 16, true));

  // directories
  log("mkdir", withPath("path_create_directory", 3, "d1") === 0 ? "SUCCESS" : "fail", en(withPath("path_create_directory", 3, "d1")), en(withPath("path_create_directory", 3, "nope/d2")));
  log("mkdir escape", en(withPath("path_create_directory", 3, "../evil")), en(withPath("path_create_directory", 3, "/abs")), en(withPath("path_create_directory", 3, "d1/../../evil")));
  log("mkdir bad fd", en(withPath("path_create_directory", 77, "x")), en(withPath("path_create_directory", 1, "x")));
  log("host mkdir", fs.existsSync(path.join(sandbox, "d1")), fs.existsSync(path.join(tmp, "evil")));

  // files
  let [e, f] = openPath(3, "d1/f.txt", 1);
  log("open create", en(e), f);
  const fdA = f;
  log("open excl", en(openPath(3, "d1/f.txt", 1 | 4)[0]), en(openPath(3, "d1/none.txt", 0)[0]));
  log("open dir flag", en(openPath(3, "d1/f.txt", 2)[0]), en(openPath(3, "d1", 2, 0, 1, DIRR, 0xfffffffn)[0]));
  {
    const n = put("hello ", B), m = put("wasi world", B + 100);
    const cnt = iov(P + 64, [[B, n], [B + 100, m]]);
    log("write", en(sys("fd_write", fdA, P + 64, cnt, P)), dv().getUint32(P, true));
  }
  log("tell", en(sys("fd_tell", fdA, P)), dv().getBigUint64(P, true));
  log("seek", en(sys("fd_seek", fdA, 6, 0, P)), dv().getBigUint64(P, true), en(sys("fd_seek", fdA, -3, 2, P)), dv().getBigUint64(P, true), en(sys("fd_seek", fdA, 1, 1, P)), dv().getBigUint64(P, true));
  log("seek bad", en(sys("fd_seek", fdA, 0, 9, P)), en(sys("fd_seek", fdA, -100, 0, P)), en(sys("fd_seek", 99, 0, 0, P)));
  sys("fd_seek", fdA, 0, 0, P);
  {
    u8().fill(0, B, B + 64);
    const cnt = iov(P + 64, [[B, 4], [B + 8, 100]]);
    log("read", en(sys("fd_read", fdA, P + 64, cnt, P)), dv().getUint32(P, true), JSON.stringify(get(B, 4)), JSON.stringify(get(B + 8, 12)));
    log("read eof", en(sys("fd_read", fdA, P + 64, cnt, P)), dv().getUint32(P, true));
    log("pread", en(sys("fd_pread", fdA, P + 64, iov(P + 64, [[B + 200, 5]]), 6, P)), dv().getUint32(P, true), get(B + 200, 5));
    log("tell after pread", en(sys("fd_tell", fdA, P)), dv().getBigUint64(P, true));
    const n = put("WASI", B + 300);
    log("pwrite", en(sys("fd_pwrite", fdA, P + 64, iov(P + 64, [[B + 300, n]]), 6, P)), dv().getUint32(P, true));
    log("tell after pwrite", en(sys("fd_tell", fdA, P)), dv().getBigUint64(P, true));
    log("host content", fs.readFileSync(path.join(sandbox, "d1/f.txt"), "utf8"));
  }
  log("filestat", en(sys("fd_filestat_get", fdA, P)), dv().getUint8(P + 16), dv().getBigUint64(P + 24, true), dv().getBigUint64(P + 32, true), dv().getBigUint64(P + 48, true) > 0n);
  log("set_size", en(sys("fd_filestat_set_size", fdA, 4)), fs.statSync(path.join(sandbox, "d1/f.txt")).size);
  log("allocate", en(sys("fd_allocate", fdA, 0, 64)), fs.statSync(path.join(sandbox, "d1/f.txt")).size);
  log("sync", call("fd_sync", fdA), call("fd_datasync", fdA), call("fd_advise", fdA, 0, 4, 0), call("fd_sync", 99));
  log("fdstat file", en(sys("fd_fdstat_get", fdA, P)), dv().getUint8(P), dv().getBigUint64(P + 8, true), dv().getBigUint64(P + 16, true));
  log("set_flags", call("fd_fdstat_set_flags", fdA, 1), call("fd_fdstat_set_flags", 99, 1));
  log("set_rights", call("fd_fdstat_set_rights", fdA, 0x2, 0x2), call("fd_fdstat_set_rights", fdA, 0xfffffff, 0));
  log("filestat times", call("fd_filestat_set_times", fdA, 5000000000, 6000000000, 1 | 4));
  log("times host", fs.statSync(path.join(sandbox, "d1/f.txt")).mtimeMs, fs.statSync(path.join(sandbox, "d1/f.txt")).atimeMs);

  // renumber, rights and close
  {
    const [e2, g] = openPath(3, "pre.txt");
    const [e3, h] = openPath(3, "d1/second.txt", 1);
    log("open pre", en(e2), en(e3), g, h);
    log("renumber", call("fd_renumber", g, 40), call("fd_renumber", 41, h), call("fd_renumber", g, h), call("fd_read", g, P + 64, 1, P));
    const cnt = iov(P + 64, [[B, 20]]);
    log("read renumbered", en(sys("fd_read", h, P + 64, cnt, P)), get(B, dv().getUint32(P, true)));
    log("close", call("fd_close", h), call("fd_close", h), call("fd_close", 99));
    log("close stdio", call("fd_close", 0), call("fd_read", 0, P + 64, 1, P));
    {
      // Default (no stdin/stdout/stderr option) WASI stdio is the real process's own fd 0/1/2, so closing fd 1 for
      // real here would kill this very script's own console.log output channel. Isolate it in a forked child whose
      // fd 1 is a pipe nobody but this test reads, and report the outcome over IPC instead of stdout.
      const child = cp.fork(__filename, ["default-stdio-child"], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      const result = await new Promise((resolve) => {
        let msg = null;
        child.on("message", (m) => { msg = m; });
        child.on("exit", () => resolve(msg));
      });
      log("fd_close default stdio", result);
    }
    const [e4, r] = openPath(3, "d1/second.txt", 0, 0, 1, 0x2n);
    log("read-only open", en(e4), call("fd_write", r, P + 64, 1, P), call("fd_read", r, P + 64, cnt, P), call("fd_seek", r, 0, 0, P), call("fd_tell", r, P));
    log("rights narrow", call("fd_fdstat_set_rights", r, 0x2, 0), call("fd_fdstat_set_rights", r, 0x0, 0), call("fd_read", r, P + 64, cnt, P));
    sys("fd_close", r);
    withPath("path_unlink_file", 3, "d1/second.txt");
  }

  // path_filestat_get / set_times
  log("pfilestat", en(flagsPath("path_filestat_get", 3, 1, "d1/f.txt", P)), dv().getUint8(P + 16), dv().getBigUint64(P + 32, true));
  log("pfilestat dir", en(flagsPath("path_filestat_get", 3, 1, "d1", P)), dv().getUint8(P + 16));
  log("pfilestat none", en(flagsPath("path_filestat_get", 3, 1, "zzz", P)), en(flagsPath("path_filestat_get", 3, 1, "../x", P)), en(flagsPath("path_filestat_get", 3, 0, ".", P)), dv().getUint8(P + 16));
  log("pset_times", en(flagsPath("path_filestat_set_times", 3, 1, "d1/f.txt", 7000000000, 8000000000, 1 | 4)), fs.statSync(path.join(sandbox, "d1/f.txt")).mtimeMs);
  log("pset_times none", en(flagsPath("path_filestat_set_times", 3, 1, "zzz", 0, 0, 0)));

  // rename, symlink, readlink, link, unlink
  log("rename", en(sys("path_rename", 3, pp("d1/f.txt", S), 8, 3, pp("d1/g.txt", S + 64), 8)), fs.readdirSync(path.join(sandbox, "d1")));
  log("rename none", en(sys("path_rename", 3, pp("d1/f.txt", S), 8, 3, pp("d1/h.txt", S + 64), 8)));
  log("symlink", en(sys("path_symlink", pp("g.txt", S), 5, 3, pp("d1/lnk", S + 64), 6)), fs.readlinkSync(path.join(sandbox, "d1/lnk")));
  {
    const n = put("d1/lnk", S);
    log("readlink", en(sys("path_readlink", 3, S, n, B, 64, P)), dv().getUint32(P, true), get(B, dv().getUint32(P, true)));
    log("readlink short", en(sys("path_readlink", 3, S, n, B, 3, P)), dv().getUint32(P, true));
    log("readlink file", en(sys("path_readlink", 3, pp("d1/g.txt", S), 8, B, 64, P)), en(sys("path_readlink", 3, pp("nope", S), 4, B, 64, P)));
    log("lstat link", en(flagsPath("path_filestat_get", 3, 0, "d1/lnk", P)), dv().getUint8(P + 16), en(flagsPath("path_filestat_get", 3, 1, "d1/lnk", P)), dv().getUint8(P + 16));
    const [eo, lf] = openPath(3, "d1/lnk", 0, 0, 1);
    log("open via link", en(eo), lf > 0);
    sys("fd_close", lf);
  }
  log("link", en(sys("path_link", 3, 1, pp("d1/g.txt", S), 8, 3, pp("d1/hard.txt", S + 64), 11)), fs.readFileSync(path.join(sandbox, "d1/hard.txt"), "utf8").length);
  log("link none", en(sys("path_link", 3, 1, pp("zzz", S), 3, 3, pp("d1/x", S + 64), 4)));
  log("symlink escape", en(sys("path_symlink", pp("../../outside", S), 13, 3, pp("d1/esc", S + 64), 6)));
  {
    const [ee] = openPath(3, "d1/esc", 0, 0, 1);
    log("open escaping link", en(ee));
  }

  // readdir
  {
    const collect = (fd, size) => {
      const found = [];
      let cookie = 0n;
      for (let round = 0; round < 50; round++) {
        u8().fill(0, B, B + size);
        const e2 = sys("fd_readdir", fd, B, size, cookie, P);
        if (e2 !== 0) return en(e2);
        const used = dv().getUint32(P, true);
        let off = 0;
        let progressed = false;
        while (off + 24 <= used) {
          const namlen = dv().getUint32(B + off + 16, true);
          if (off + 24 + namlen > used) break;
          found.push(get(B + off + 24, namlen) + ":" + dv().getUint8(B + off + 20));
          cookie = dv().getBigUint64(B + off, true);
          off += 24 + namlen;
          progressed = true;
        }
        if (!progressed || used < size) break;
      }
      return found.sort();
    };
    const [ed, dfd] = openPath(3, "d1", 2, 0, 1, DIRR, 0xfffffffn);
    log("open d1", en(ed));
    log("readdir big", collect(dfd, 4096));
    log("readdir small", collect(dfd, 60));
    log("readdir file", en(sys("fd_readdir", fdA, B, 100, 0, P)));
    log("dir read", en(sys("fd_read", dfd, P + 64, 1, P)), en(sys("fd_seek", dfd, 0, 0, P)));
    log("dir filestat", en(sys("fd_filestat_get", dfd, P)), dv().getUint8(P + 16));
    log("dir fdstat", en(sys("fd_fdstat_get", dfd, P)), dv().getUint8(P));
    const [ef, ff] = openPath(dfd, "g.txt", 0, 0, 1, 0x6n);
    log("open rel dir fd", en(ef), ff > 0);
    sys("fd_close", ff);
    log("open dotdot", en(openPath(dfd, "../pre.txt", 0, 0, 1, 0x6n)[0]), en(openPath(dfd, "..", 2, 0, 1, DIRR, 0x6n)[0]), en(openPath(dfd, "../d1/g.txt", 0, 0, 1, 0x6n)[0]), en(openPath(dfd, "./g.txt", 0, 0, 1, 0x6n)[0]), en(openPath(dfd, "x/../g.txt", 0, 0, 1, 0x6n)[0]));
    log("mkdir dotdot", en(withPath("path_create_directory", dfd, "../viaparent")), en(withPath("path_remove_directory", 3, "viaparent")));
    sys("fd_close", dfd);
    log("readdir preopen", collect(3, 4096));
  }

  // unlink / rmdir
  log("rmdir nonempty", en(withPath("path_remove_directory", 3, "d1")));
  log("unlink dir", en(withPath("path_unlink_file", 3, "d1")));
  log("rmdir file", en(withPath("path_remove_directory", 3, "d1/g.txt")));
  log("unlink", en(withPath("path_unlink_file", 3, "d1/g.txt")), en(withPath("path_unlink_file", 3, "d1/g.txt")));
  for (const n of ["hard.txt", "lnk", "esc"]) withPath("path_unlink_file", 3, "d1/" + n);
  log("rmdir", en(withPath("path_remove_directory", 3, "d1")), en(withPath("path_remove_directory", 3, "d1")), fs.readdirSync(sandbox));
  sys("fd_close", fdA);

  // poll_oneoff
  {
    const sub = (ptr, userdata, tag) => { u8().fill(0, ptr, ptr + 48); dv().setBigUint64(ptr, BigInt(userdata), true); dv().setUint8(ptr + 8, tag); };
    sub(1000, 11, 0);
    dv().setUint32(1016, 1, true); dv().setBigUint64(1024, 2000000n, true); dv().setBigUint64(1032, 0n, true); dv().setUint16(1040, 0, true);
    const t0 = Date.now();
    log("poll clock", en(sys("poll_oneoff", 1000, 2000, 1, P)), dv().getUint32(P, true), dv().getBigUint64(2000, true), dv().getUint16(2008, true), dv().getUint8(2010), Date.now() - t0 >= 1);
    // two clocks: the shorter one wins, userdata identifies it
    sub(1000, 21, 0);
    dv().setUint32(1016, 1, true); dv().setBigUint64(1024, 30000000n, true);
    sub(1048, 22, 0);
    dv().setUint32(1064, 1, true); dv().setBigUint64(1072, 1000000n, true);
    log("poll two", en(sys("poll_oneoff", 1000, 2000, 2, P)), dv().getUint32(P, true), dv().getBigUint64(2000, true));
    // fd readiness on a regular file
    const [ep, pf] = openPath(3, "pre.txt");
    sub(1000, 41, 1);
    dv().setUint32(1016, pf, true);
    log("poll fd_read", en(ep), en(sys("poll_oneoff", 1000, 2000, 1, P)));
    sub(1000, 42, 2);
    dv().setUint32(1016, pf, true);
    log("poll fd_write", en(sys("poll_oneoff", 1000, 2000, 1, P)));
    sub(1000, 43, 1);
    dv().setUint32(1016, 99, true);
    log("poll bad fd", en(sys("poll_oneoff", 1000, 2000, 1, P)), dv().getUint32(P, true));
    log("poll empty", en(sys("poll_oneoff", 1000, 2000, 0, P)));
    sub(1000, 44, 9);
    log("poll bad tag", en(sys("poll_oneoff", 1000, 2000, 1, P)));
    sys("fd_close", pf);
  }

  // scheduling, sockets, signals
  log("sched_yield", call("sched_yield"));
  for (const fd of [1, 3, 99]) log("sock", fd, call("sock_accept", fd, 0, P), call("sock_recv", fd, 100, 1, 0, P, P + 4), call("sock_send", fd, 100, 1, 0, P), call("sock_shutdown", fd, 0), call("sock_recv", fd, 0, 0, 0, P, P + 4), call("sock_send", fd, 0, 0, 0, P), call("sock_shutdown", fd, 3));
  log("proc_raise", call("proc_raise", 0), call("proc_raise", 99));

  // bad pointers
  log("fault", call("args_sizes_get", 0x7fffffff, 0), call("clock_time_get", 0, 1, 0x7fffffff), call("fd_write", 1, 0x7fffffff, 1, P), call("random_get", 0x7ffffff0, 64));

  fs.rmSync(tmp, { recursive: true, force: true });
  process.emitWarning = warn;
  console.log(out.join("\n"));
  })().catch((err) => { console.log(out.join("\n")); console.log("FAILED", err && err.stack); process.exit(1); });
}
