/*
 * node:wasi: the WASI class, with wasi_snapshot_preview1 written in JavaScript on top of the runtime's fs.
 *
 * Node runs uvwasi underneath; this follows it where it can be seen from outside: rights are checked the way uvwasi
 * checks them (a directory's inheriting rights bound what a file opened through it may ask for), a path may not leave
 * the directory descriptor it is resolved against (ENOTCAPABLE), descriptors are handed out lowest first, and
 * poll_oneoff on a regular file fails with EPERM. Where the runtime's fs has no primitive the call degrades:
 *   - fd_fdstat_get reports the WASI fdflags (uvwasi on Linux hands back the raw open(2) flags),
 *   - path_link copies the file when the host has no link(2),
 *   - poll_oneoff treats a pipe or terminal as always ready.
 */

const E = {
	SUCCESS: 0,
	BADF: 8,
	EXIST: 20,
	INVAL: 28,
	IO: 29,
	ISDIR: 31,
	LOOP: 32,
	NOBUFS: 42,
	NOENT: 44,
	NOSYS: 52,
	NOTDIR: 54,
	NOTEMPTY: 55,
	NOTSUP: 58,
	OVERFLOW: 61,
	PERM: 63,
	SPIPE: 70,
	NOTCAPABLE: 76,
};

const ERRNO_BY_CODE = {
	E2BIG: 1,
	EACCES: 2,
	EADDRINUSE: 3,
	EADDRNOTAVAIL: 4,
	EAGAIN: 6,
	EALREADY: 7,
	EBADF: 8,
	EBUSY: 10,
	ECANCELED: 11,
	ECONNABORTED: 13,
	ECONNREFUSED: 14,
	ECONNRESET: 15,
	EDEADLK: 16,
	EDQUOT: 19,
	EEXIST: 20,
	EFAULT: 21,
	EFBIG: 22,
	EINTR: 27,
	EINVAL: 28,
	EIO: 29,
	EISDIR: 31,
	ELOOP: 32,
	EMFILE: 33,
	EMLINK: 34,
	ENAMETOOLONG: 37,
	ENFILE: 41,
	ENOBUFS: 42,
	ENODEV: 43,
	ENOENT: 44,
	ENOMEM: 48,
	ENOSPC: 51,
	ENOSYS: 52,
	ENOTDIR: 54,
	ENOTEMPTY: 55,
	ENOTSUP: 58,
	ENOTTY: 59,
	ENXIO: 60,
	EOVERFLOW: 61,
	EPERM: 63,
	EPIPE: 64,
	ERANGE: 68,
	EROFS: 69,
	ESPIPE: 70,
	ESRCH: 71,
	ETXTBSY: 74,
	EXDEV: 75,
};

// Rights, by bit.
const R = {};
[
	"FD_DATASYNC",
	"FD_READ",
	"FD_SEEK",
	"FD_FDSTAT_SET_FLAGS",
	"FD_SYNC",
	"FD_TELL",
	"FD_WRITE",
	"FD_ADVISE",
	"FD_ALLOCATE",
	"PATH_CREATE_DIRECTORY",
	"PATH_CREATE_FILE",
	"PATH_LINK_SOURCE",
	"PATH_LINK_TARGET",
	"PATH_OPEN",
	"FD_READDIR",
	"PATH_READLINK",
	"PATH_RENAME_SOURCE",
	"PATH_RENAME_TARGET",
	"PATH_FILESTAT_GET",
	"PATH_FILESTAT_SET_SIZE",
	"PATH_FILESTAT_SET_TIMES",
	"FD_FILESTAT_GET",
	"FD_FILESTAT_SET_SIZE",
	"FD_FILESTAT_SET_TIMES",
	"PATH_SYMLINK",
	"PATH_REMOVE_DIRECTORY",
	"PATH_UNLINK_FILE",
	"POLL_FD_READWRITE",
	"SOCK_SHUTDOWN",
].forEach((name, bit) => {
	R[name] = 1n << BigInt(bit);
});
const or = (...names) => names.reduce((acc, name) => acc | R[name], 0n);
const RIGHTS_ALL = (1n << 29n) - 1n;
const REGULAR_BASE = or(
	"FD_DATASYNC",
	"FD_READ",
	"FD_SEEK",
	"FD_FDSTAT_SET_FLAGS",
	"FD_SYNC",
	"FD_TELL",
	"FD_WRITE",
	"FD_ADVISE",
	"FD_ALLOCATE",
	"FD_FILESTAT_GET",
	"FD_FILESTAT_SET_SIZE",
	"FD_FILESTAT_SET_TIMES",
	"POLL_FD_READWRITE"
);
const DIRECTORY_BASE = or(
	"FD_FDSTAT_SET_FLAGS",
	"FD_SYNC",
	"FD_ADVISE",
	"PATH_CREATE_DIRECTORY",
	"PATH_CREATE_FILE",
	"PATH_LINK_SOURCE",
	"PATH_LINK_TARGET",
	"PATH_OPEN",
	"FD_READDIR",
	"PATH_READLINK",
	"PATH_RENAME_SOURCE",
	"PATH_RENAME_TARGET",
	"PATH_FILESTAT_GET",
	"PATH_FILESTAT_SET_SIZE",
	"PATH_FILESTAT_SET_TIMES",
	"FD_FILESTAT_GET",
	"FD_FILESTAT_SET_TIMES",
	"PATH_SYMLINK",
	"PATH_REMOVE_DIRECTORY",
	"PATH_UNLINK_FILE",
	"POLL_FD_READWRITE"
);
const DIRECTORY_INHERITING = DIRECTORY_BASE | REGULAR_BASE;
const PREOPEN_INHERITING = RIGHTS_ALL & ~R.SOCK_SHUTDOWN;
const WRITE_RIGHTS = R.FD_WRITE | R.FD_ALLOCATE | R.FD_FILESTAT_SET_SIZE;
const READ_RIGHTS = R.FD_READ | R.FD_READDIR;

const FT = { UNKNOWN: 0, BLOCK: 1, CHAR: 2, DIR: 3, REG: 4, SOCK_DGRAM: 5, SOCK_STREAM: 6, LINK: 7 };

// Signatures: i = i32, I = i64. Only used to give every import its declared arity.
const ARITY = {
	args_get: 2,
	args_sizes_get: 2,
	clock_res_get: 2,
	clock_time_get: 3,
	environ_get: 2,
	environ_sizes_get: 2,
	fd_advise: 4,
	fd_allocate: 3,
	fd_close: 1,
	fd_datasync: 1,
	fd_fdstat_get: 2,
	fd_fdstat_set_flags: 2,
	fd_fdstat_set_rights: 3,
	fd_filestat_get: 2,
	fd_filestat_set_size: 2,
	fd_filestat_set_times: 4,
	fd_pread: 5,
	fd_prestat_get: 2,
	fd_prestat_dir_name: 3,
	fd_pwrite: 5,
	fd_read: 4,
	fd_readdir: 5,
	fd_renumber: 2,
	fd_seek: 4,
	fd_sync: 1,
	fd_tell: 2,
	fd_write: 4,
	path_create_directory: 3,
	path_filestat_get: 5,
	path_filestat_set_times: 7,
	path_link: 7,
	path_open: 9,
	path_readlink: 6,
	path_remove_directory: 3,
	path_rename: 6,
	path_symlink: 5,
	path_unlink_file: 3,
	poll_oneoff: 4,
	proc_exit: 1,
	proc_raise: 1,
	random_get: 2,
	sched_yield: 0,
	sock_accept: 3,
	sock_recv: 6,
	sock_send: 5,
	sock_shutdown: 2,
};

class Errno extends Error {
	constructor(errno) {
		super(`WASI errno ${errno}`);
		this.errno = errno;
	}
}
const fail = (errno) => {
	throw new Errno(errno);
};
const kExit = Symbol("kExitCode");

function describe(value) {
	if (value == null) return ` Received ${value}`;
	if (typeof value === "function") return ` Received function ${value.name}`;
	if (typeof value === "object") {
		const name = value.constructor?.name;
		return name ? ` Received an instance of ${name}` : " Received [Object: null prototype] {}";
	}
	let shown = typeof value === "string" ? value : String(value);
	if (typeof value === "string") shown = `'${shown.length > 28 ? `${shown.slice(0, 25)}...` : shown}'`;
	if (typeof value === "bigint") shown += "n";
	return ` Received type ${typeof value} (${shown})`;
}

const coded = (Class, code, message) => Object.assign(new Class(message), { code });
const what = (name) => (name.includes(".") ? "property" : "argument");
const typeError = (name, expected, value) =>
	coded(TypeError, "ERR_INVALID_ARG_TYPE", `The "${name}" ${what(name)} must be ${expected}.${describe(value)}`);

const validateObject = (value, name) => {
	if (value === null || Array.isArray(value) || typeof value !== "object")
		throw typeError(name, "of type object", value);
};
const validateString = (value, name) => {
	if (typeof value !== "string") throw typeError(name, "of type string", value);
};
const validateFunction = (value, name) => {
	if (typeof value !== "function") throw typeError(name, "of type function", value);
};
const validateFd = (value, name) => {
	if (typeof value !== "number") throw typeError(name, "of type number", value);
	if (!Number.isInteger(value))
		throw coded(
			RangeError,
			"ERR_OUT_OF_RANGE",
			`The value of "${name}" is out of range. It must be an integer. Received ${value}`
		);
	if (value < 0 || value > 2147483647)
		throw coded(
			RangeError,
			"ERR_OUT_OF_RANGE",
			`The value of "${name}" is out of range. It must be >= 0 && <= 2147483647. Received ${value}`
		);
};

const state = new WeakMap();
let warned = false;

export function createWasi({ fs, path, process, Buffer, os }) {
	const u32 = (x) => x >>> 0;
	const big = (x) => (typeof x === "bigint" ? BigInt.asUintN(64, x) : BigInt(Math.trunc(x)));
	const errnoOf = (error) => {
		if (error instanceof Errno) return error.errno;
		if (error && typeof error.code === "string" && error.code in ERRNO_BY_CODE) return ERRNO_BY_CODE[error.code];
		if (error && typeof error.errno === "number" && error.errno < 0 && -error.errno < 80)
			return -error.errno === 2 ? 44 : E.IO;
		return null;
	};
	const nsOf = (ms) => BigInt(Math.trunc(ms)) * 1000000n + BigInt(Math.round((ms % 1) * 1e6));
	const fsFlags = fs.constants;

	function createBindings(options) {
		const { args, envPairs, preopens, returnOnExit, stdio } = options;
		let memory = null;
		let exitCode = 0;
		let started = false;

		// ------------------------------------------------------------ descriptors
		const table = new Map();
		const stdioEntry = (host) => {
			const tty = os?.isatty?.(host) ?? false;
			const filetype = tty ? FT.CHAR : FT.REG;
			return {
				type: "stdio",
				host,
				filetype,
				base: tty ? RIGHTS_ALL : REGULAR_BASE,
				inh: tty ? RIGHTS_ALL : 0n,
				append: false,
				nonblock: false,
				owned: host > 2,
			};
		};
		stdio.forEach((host, index) => table.set(index, stdioEntry(host)));
		let nextPreopen = 3;
		for (const [virtual, real] of preopens) {
			table.set(nextPreopen++, {
				type: "dir",
				host: -1,
				real,
				root: real,
				virtual,
				preopen: true,
				filetype: FT.DIR,
				base: DIRECTORY_BASE,
				inh: PREOPEN_INHERITING,
			});
		}
		const allocate = (entry) => {
			let fd = 0;
			while (table.has(fd)) fd++;
			table.set(fd, entry);
			return fd;
		};
		const lookup = (fd) => table.get(u32(fd)) ?? fail(E.BADF);
		const need = (entry, rights) => {
			if ((entry.base & rights) !== rights) fail(E.NOTCAPABLE);
			return entry;
		};
		const get = (fd, rights = 0n) => need(lookup(fd), rights);

		// ----------------------------------------------------------------- memory
		const view = () => {
			const buffer = memory.buffer;
			return { buffer, dv: new DataView(buffer), u8: new Uint8Array(buffer), size: buffer.byteLength };
		};
		const within = (m, ptr, len) => {
			if (ptr + len > m.size) fail(E.OVERFLOW);
		};
		const put32 = (ptr, value) => {
			const m = view();
			within(m, u32(ptr), 4);
			m.dv.setUint32(u32(ptr), value, true);
		};
		const put64 = (ptr, value) => {
			const m = view();
			within(m, u32(ptr), 8);
			m.dv.setBigUint64(u32(ptr), BigInt.asUintN(64, value), true);
		};
		const readString = (ptr, len) => {
			const m = view();
			ptr = u32(ptr);
			len = u32(len);
			within(m, ptr, len);
			return Buffer.from(m.u8.subarray(ptr, ptr + len)).toString("utf8");
		};
		const iovecs = (ptr, count) => {
			const m = view();
			ptr = u32(ptr);
			count = u32(count);
			within(m, ptr, count * 8);
			const list = [];
			for (let i = 0; i < count; i++) {
				const at = m.dv.getUint32(ptr + i * 8, true);
				const len = m.dv.getUint32(ptr + i * 8 + 4, true);
				within(m, at, len);
				list.push([at, len]);
			}
			return list;
		};

		// ------------------------------------------------------------------ paths
		const inside = (root, target) =>
			target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
		function resolve(entry, text, follow = true) {
			if (entry.type !== "dir") fail(E.NOTDIR);
			if (text.startsWith("/") || (path.sep === "\\" && /^([a-zA-Z]:|\\)/.test(text))) fail(E.NOTCAPABLE);
			const target = path.resolve(entry.real, text);
			if (!inside(entry.real, target)) fail(E.NOTCAPABLE);
			// A link inside the directory must not lead out of it.
			try {
				const base = fs.realpathSync(entry.real);
				let probe = target;
				if (!follow && target !== entry.real) probe = path.dirname(target);
				for (let i = 0; i < 64; i++) {
					try {
						const real = fs.realpathSync(probe);
						if (!inside(base, real)) fail(E.NOTCAPABLE);
						break;
					} catch (error) {
						if (error instanceof Errno) throw error;
						const parent = path.dirname(probe);
						if (parent === probe) break;
						probe = parent;
					}
				}
			} catch (error) {
				if (error instanceof Errno) throw error;
			}
			return target;
		}
		const filetypeOfMode = (stats) =>
			stats.isFile()
				? FT.REG
				: stats.isDirectory()
					? FT.DIR
					: stats.isSymbolicLink()
						? FT.LINK
						: stats.isCharacterDevice()
							? FT.CHAR
							: stats.isBlockDevice()
								? FT.BLOCK
								: stats.isSocket()
									? FT.SOCK_STREAM
									: FT.UNKNOWN;
		const filetypeOfDirent = (dirent) =>
			dirent.isFile()
				? FT.REG
				: dirent.isDirectory()
					? FT.DIR
					: dirent.isSymbolicLink()
						? FT.LINK
						: dirent.isCharacterDevice()
							? FT.CHAR
							: dirent.isBlockDevice()
								? FT.BLOCK
								: dirent.isSocket()
									? FT.SOCK_STREAM
									: FT.UNKNOWN;

		function writeFilestat(ptr, stats) {
			const m = view();
			ptr = u32(ptr);
			within(m, ptr, 64);
			const { dv } = m;
			dv.setBigUint64(ptr, BigInt(stats.dev ?? 0), true);
			dv.setBigUint64(ptr + 8, BigInt(stats.ino ?? 0), true);
			dv.setUint8(ptr + 16, filetypeOfMode(stats));
			dv.setBigUint64(ptr + 24, BigInt(stats.nlink ?? 1), true);
			dv.setBigUint64(ptr + 32, BigInt(stats.size), true);
			dv.setBigUint64(ptr + 40, nsOf(stats.atimeMs), true);
			dv.setBigUint64(ptr + 48, nsOf(stats.mtimeMs), true);
			dv.setBigUint64(ptr + 56, nsOf(stats.ctimeMs), true);
		}
		function statOf(entry) {
			if (entry.real !== undefined && entry.type !== "stdio") {
				try {
					return fs.statSync(entry.real);
				} catch (error) {
					if (entry.host < 0) throw error;
				}
			}
			return fs.fstatSync(entry.host);
		}
		function applyTimes(target, stats, atim, mtim, flags) {
			if (flags & ~15 || (flags & 1 && flags & 2) || (flags & 4 && flags & 8)) fail(E.INVAL);
			const now = Date.now();
			const seconds = (ns, present, useNow, current) =>
				useNow ? now / 1000 : present ? Number(ns) / 1e9 : current / 1000;
			const a = seconds(atim, flags & 1, flags & 2, stats.atimeMs);
			const m = seconds(mtim, flags & 4, flags & 8, stats.mtimeMs);
			fs.utimesSync(target, a, m);
		}

		// ---------------------------------------------------------------- output
		function writeAll(entry, bytes, position) {
			if (entry.host === 1 && entry.type === "stdio") {
				process.stdout.write(Buffer.from(bytes));
				return bytes.length;
			}
			if (entry.host === 2 && entry.type === "stdio") {
				process.stderr.write(Buffer.from(bytes));
				return bytes.length;
			}
			if (position === null && entry.append && entry.filetype === FT.REG) os.seek(entry.host, 0, 2);
			return fs.writeSync(entry.host, bytes, 0, bytes.length, position);
		}

		const exports = {
			args_get(argvPtr, bufPtr) {
				const m = view();
				let argv = u32(argvPtr);
				let buf = u32(bufPtr);
				for (const arg of args) {
					const bytes = Buffer.from(`${arg}\0`);
					within(m, buf, bytes.length);
					within(m, argv, 4);
					m.dv.setUint32(argv, buf, true);
					m.u8.set(bytes, buf);
					argv += 4;
					buf += bytes.length;
				}
				return E.SUCCESS;
			},
			args_sizes_get(countPtr, sizePtr) {
				put32(countPtr, args.length);
				put32(
					sizePtr,
					args.reduce((sum, arg) => sum + Buffer.byteLength(arg) + 1, 0)
				);
				return E.SUCCESS;
			},
			environ_get(envPtr, bufPtr) {
				const m = view();
				let at = u32(envPtr);
				let buf = u32(bufPtr);
				for (const pair of envPairs) {
					const bytes = Buffer.from(`${pair}\0`);
					within(m, buf, bytes.length);
					within(m, at, 4);
					m.dv.setUint32(at, buf, true);
					m.u8.set(bytes, buf);
					at += 4;
					buf += bytes.length;
				}
				return E.SUCCESS;
			},
			environ_sizes_get(countPtr, sizePtr) {
				put32(countPtr, envPairs.length);
				put32(
					sizePtr,
					envPairs.reduce((sum, pair) => sum + Buffer.byteLength(pair) + 1, 0)
				);
				return E.SUCCESS;
			},
			clock_res_get(id, ptr) {
				id = u32(id);
				if (id > 3) fail(E.INVAL);
				put64(ptr, id === 0 ? 1000n : 1n);
				return E.SUCCESS;
			},
			clock_time_get(id, _precision, ptr) {
				put64(ptr, clockNow(u32(id)));
				return E.SUCCESS;
			},
			fd_advise(fd, _offset, _length, advice) {
				get(fd, R.FD_ADVISE);
				if (u32(advice) > 5) fail(E.INVAL);
				return E.SUCCESS;
			},
			fd_allocate(fd, offset, length) {
				const entry = get(fd, R.FD_ALLOCATE);
				if (entry.type === "dir") fail(E.BADF);
				const end = Number(big(offset)) + Number(big(length));
				if (fs.fstatSync(entry.host).size < end) fs.ftruncateSync(entry.host, end);
				return E.SUCCESS;
			},
			fd_close(fd) {
				const entry = lookup(fd);
				table.delete(u32(fd));
				if (entry.host >= 0) fs.closeSync(entry.host);
				return E.SUCCESS;
			},
			fd_datasync(fd) {
				const entry = get(fd, R.FD_DATASYNC);
				if (entry.host >= 0) fs.fsyncSync(entry.host);
				return E.SUCCESS;
			},
			fd_fdstat_get(fd, ptr) {
				const entry = lookup(fd);
				const m = view();
				ptr = u32(ptr);
				within(m, ptr, 24);
				m.u8.fill(0, ptr, ptr + 24);
				m.dv.setUint8(ptr, entry.filetype);
				m.dv.setUint16(ptr + 2, (entry.append ? 1 : 0) | (entry.nonblock ? 4 : 0), true);
				m.dv.setBigUint64(ptr + 8, entry.base, true);
				m.dv.setBigUint64(ptr + 16, entry.inh, true);
				return E.SUCCESS;
			},
			fd_fdstat_set_flags(fd, flags) {
				const entry = get(fd, R.FD_FDSTAT_SET_FLAGS);
				flags = u32(flags);
				entry.append = Boolean(flags & 1);
				entry.nonblock = Boolean(flags & 4);
				return E.SUCCESS;
			},
			fd_fdstat_set_rights(fd, base, inh) {
				const entry = lookup(fd);
				base = big(base);
				inh = big(inh);
				if ((base & ~entry.base) !== 0n || (inh & ~entry.inh) !== 0n) fail(E.NOTCAPABLE);
				entry.base = base;
				entry.inh = inh;
				return E.SUCCESS;
			},
			fd_filestat_get(fd, ptr) {
				const entry = get(fd, R.FD_FILESTAT_GET);
				writeFilestat(ptr, statOf(entry));
				return E.SUCCESS;
			},
			fd_filestat_set_size(fd, size) {
				const entry = get(fd, R.FD_FILESTAT_SET_SIZE);
				if (entry.type === "dir") fail(E.ISDIR);
				fs.ftruncateSync(entry.host, Number(big(size)));
				return E.SUCCESS;
			},
			fd_filestat_set_times(fd, atim, mtim, flags) {
				const entry = get(fd, R.FD_FILESTAT_SET_TIMES);
				flags = u32(flags);
				if (flags & ~15 || (flags & 1 && flags & 2) || (flags & 4 && flags & 8)) fail(E.INVAL);
				if (entry.real === undefined) fail(E.NOTSUP);
				applyTimes(entry.real, statOf(entry), atim, mtim, flags);
				return E.SUCCESS;
			},
			fd_pread(fd, iovs, count, offset, nreadPtr) {
				const entry = get(fd, R.FD_READ | R.FD_SEEK);
				if (entry.type === "dir") fail(E.ISDIR);
				const list = iovecs(iovs, count);
				const m = view();
				let position = Number(big(offset));
				let total = 0;
				for (const [at, len] of list) {
					if (len === 0) continue;
					const n = fs.readSync(entry.host, new Uint8Array(m.buffer, at, len), 0, len, position);
					total += n;
					position += n;
					if (n < len) break;
				}
				put32(nreadPtr, total);
				return E.SUCCESS;
			},
			fd_prestat_get(fd, ptr) {
				const entry = lookup(fd);
				if (!entry.preopen) fail(E.INVAL);
				const m = view();
				ptr = u32(ptr);
				within(m, ptr, 8);
				m.dv.setUint8(ptr, 0);
				m.dv.setUint32(ptr + 4, Buffer.byteLength(entry.virtual), true);
				return E.SUCCESS;
			},
			fd_prestat_dir_name(fd, ptr, len) {
				const entry = lookup(fd);
				if (!entry.preopen) fail(E.INVAL);
				const bytes = Buffer.from(entry.virtual);
				if (u32(len) < bytes.length) fail(E.NOBUFS);
				const m = view();
				within(m, u32(ptr), bytes.length);
				m.u8.set(bytes, u32(ptr));
				return E.SUCCESS;
			},
			fd_pwrite(fd, iovs, count, offset, nwrittenPtr) {
				const entry = get(fd, R.FD_WRITE | R.FD_SEEK);
				if (entry.type === "dir") fail(E.ISDIR);
				const list = iovecs(iovs, count);
				const m = view();
				let position = Number(big(offset));
				let total = 0;
				for (const [at, len] of list) {
					if (len === 0) continue;
					const n = writeAll(entry, m.u8.subarray(at, at + len), position);
					total += n;
					position += n;
				}
				put32(nwrittenPtr, total);
				return E.SUCCESS;
			},
			fd_read(fd, iovs, count, nreadPtr) {
				const entry = get(fd, R.FD_READ);
				if (entry.type === "dir") fail(E.ISDIR);
				const list = iovecs(iovs, count);
				const m = view();
				let total = 0;
				for (const [at, len] of list) {
					if (len === 0) continue;
					const n = fs.readSync(entry.host, new Uint8Array(m.buffer, at, len), 0, len, null);
					total += n;
					if (n < len) break;
				}
				put32(nreadPtr, total);
				return E.SUCCESS;
			},
			fd_readdir(fd, bufPtr, bufLen, cookie, usedPtr) {
				const entry = get(fd, R.FD_READDIR);
				if (entry.type !== "dir") fail(E.NOTDIR);
				const names = fs.readdirSync(entry.real, { withFileTypes: true });
				names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
				const m = view();
				bufPtr = u32(bufPtr);
				bufLen = u32(bufLen);
				within(m, bufPtr, bufLen);
				let used = 0;
				for (let i = Number(big(cookie)); i < names.length && used < bufLen; i++) {
					const dirent = names[i];
					const name = Buffer.from(dirent.name);
					const record = Buffer.alloc(24 + name.length);
					let ino = 0n;
					try {
						ino = BigInt(fs.lstatSync(path.join(entry.real, dirent.name)).ino ?? 0);
					} catch {}
					record.writeBigUInt64LE(BigInt(i + 1), 0);
					record.writeBigUInt64LE(ino, 8);
					record.writeUInt32LE(name.length, 16);
					record.writeUInt8(filetypeOfDirent(dirent), 20);
					name.copy(record, 24);
					const room = Math.min(record.length, bufLen - used);
					m.u8.set(record.subarray(0, room), bufPtr + used);
					used += room;
				}
				put32(usedPtr, used);
				return E.SUCCESS;
			},
			fd_renumber(from, to) {
				const source = lookup(from);
				const target = lookup(to);
				from = u32(from);
				to = u32(to);
				if (from === to) return E.SUCCESS;
				if (target.host >= 0 && (target.owned ?? target.type === "file")) fs.closeSync(target.host);
				table.set(to, source);
				table.delete(from);
				return E.SUCCESS;
			},
			fd_seek(fd, offset, whence, ptr) {
				whence = u32(whence);
				const entry = get(fd, whence === 1 && big(offset) === 0n ? R.FD_TELL : R.FD_SEEK);
				if (whence > 2) fail(E.INVAL);
				if (entry.type === "dir") fail(E.BADF);
				const position = os.seek(entry.host, Number(BigInt.asIntN(64, big(offset))), whence);
				if (position < 0) fail(-position === 29 ? E.SPIPE : E.INVAL);
				put64(ptr, BigInt(position));
				return E.SUCCESS;
			},
			fd_sync(fd) {
				const entry = get(fd, R.FD_SYNC);
				if (entry.host >= 0) fs.fsyncSync(entry.host);
				return E.SUCCESS;
			},
			fd_tell(fd, ptr) {
				const entry = get(fd, R.FD_TELL);
				if (entry.type === "dir") fail(E.BADF);
				const position = os.seek(entry.host, 0, 1);
				if (position < 0) fail(E.SPIPE);
				put64(ptr, BigInt(position));
				return E.SUCCESS;
			},
			fd_write(fd, iovs, count, nwrittenPtr) {
				const entry = get(fd, R.FD_WRITE);
				if (entry.type === "dir") fail(E.ISDIR);
				const list = iovecs(iovs, count);
				const m = view();
				let total = 0;
				for (const [at, len] of list) {
					if (len === 0) continue;
					total += writeAll(entry, m.u8.subarray(at, at + len), null);
				}
				put32(nwrittenPtr, total);
				return E.SUCCESS;
			},
			path_create_directory(fd, ptr, len) {
				const entry = get(fd, R.PATH_CREATE_DIRECTORY);
				fs.mkdirSync(resolve(entry, readString(ptr, len), false));
				return E.SUCCESS;
			},
			path_filestat_get(fd, flags, ptr, len, out) {
				const entry = get(fd, R.PATH_FILESTAT_GET);
				const follow = Boolean(u32(flags) & 1);
				const target = resolve(entry, readString(ptr, len), follow);
				writeFilestat(out, follow ? fs.statSync(target) : fs.lstatSync(target));
				return E.SUCCESS;
			},
			path_filestat_set_times(fd, flags, ptr, len, atim, mtim, fstFlags) {
				const entry = get(fd, R.PATH_FILESTAT_SET_TIMES);
				const follow = Boolean(u32(flags) & 1);
				const target = resolve(entry, readString(ptr, len), follow);
				const stats = follow ? fs.statSync(target) : fs.lstatSync(target);
				applyTimes(target, stats, atim, mtim, u32(fstFlags));
				return E.SUCCESS;
			},
			path_link(oldFd, oldFlags, oldPtr, oldLen, newFd, newPtr, newLen) {
				const source = get(oldFd, R.PATH_LINK_SOURCE);
				const dest = get(newFd, R.PATH_LINK_TARGET);
				const from = resolve(source, readString(oldPtr, oldLen), Boolean(u32(oldFlags) & 1));
				const to = resolve(dest, readString(newPtr, newLen), false);
				fs.linkSync(from, to);
				return E.SUCCESS;
			},
			path_open(dirFd, dirFlags, ptr, len, oflags, rightsBase, rightsInh, fdflags, outPtr) {
				const dir = get(dirFd, R.PATH_OPEN);
				oflags = u32(oflags);
				fdflags = u32(fdflags);
				const follow = Boolean(u32(dirFlags) & 1);
				if (oflags & 1) need(dir, R.PATH_CREATE_FILE);
				if (oflags & 8) need(dir, R.PATH_FILESTAT_SET_SIZE);
				rightsBase = big(rightsBase);
				rightsInh = big(rightsInh);
				if ((rightsBase & ~dir.inh) !== 0n || (rightsInh & ~dir.inh) !== 0n) fail(E.NOTCAPABLE);
				const target = resolve(dir, readString(ptr, len), follow);
				let stats = null;
				try {
					stats = follow ? fs.statSync(target) : fs.lstatSync(target);
				} catch (error) {
					if (errnoOf(error) !== E.NOENT) throw error;
				}
				if (stats && oflags & 1 && oflags & 4) fail(E.EXIST);
				if (!stats && !(oflags & 1)) fail(E.NOENT);
				if (stats && !follow && stats.isSymbolicLink()) fail(E.LOOP);
				const write = (rightsBase & WRITE_RIGHTS) !== 0n;
				const read = (rightsBase & READ_RIGHTS) !== 0n;
				if (stats?.isDirectory() || (oflags & 2 && stats)) {
					if (!stats.isDirectory()) fail(E.NOTDIR);
					if (write || oflags & 8) fail(E.ISDIR);
					const fd = allocate({
						type: "dir",
						host: -1,
						real: target,
						root: dir.root,
						filetype: FT.DIR,
						base: rightsBase & DIRECTORY_BASE,
						inh: rightsInh & DIRECTORY_INHERITING,
					});
					put32(outPtr, fd);
					return E.SUCCESS;
				}
				if (!stats && oflags & 2) fail(E.NOENT);
				let flags = write ? (read ? fsFlags.O_RDWR : fsFlags.O_WRONLY) : fsFlags.O_RDONLY;
				if (oflags & 1) flags |= fsFlags.O_CREAT;
				if (oflags & 4) flags |= fsFlags.O_EXCL;
				if (oflags & 8) flags |= fsFlags.O_TRUNC;
				if (fdflags & 1) flags |= fsFlags.O_APPEND;
				const host = fs.openSync(target, flags, 0o666);
				const type = filetypeOfMode(stats ?? fs.statSync(target));
				const fd = allocate({
					type: "file",
					host,
					real: target,
					root: dir.root,
					filetype: type,
					base: type === FT.REG ? rightsBase & REGULAR_BASE : rightsBase,
					inh: type === FT.REG ? 0n : rightsInh,
					append: Boolean(fdflags & 1),
					nonblock: Boolean(fdflags & 4),
				});
				put32(outPtr, fd);
				return E.SUCCESS;
			},
			path_readlink(fd, ptr, len, bufPtr, bufLen, usedPtr) {
				const entry = get(fd, R.PATH_READLINK);
				const target = resolve(entry, readString(ptr, len), false);
				const link = Buffer.from(fs.readlinkSync(target));
				put32(usedPtr, link.length);
				if (link.length > u32(bufLen)) fail(E.NOBUFS);
				const m = view();
				within(m, u32(bufPtr), link.length);
				m.u8.set(link, u32(bufPtr));
				return E.SUCCESS;
			},
			path_remove_directory(fd, ptr, len) {
				const entry = get(fd, R.PATH_REMOVE_DIRECTORY);
				const target = resolve(entry, readString(ptr, len), false);
				if (!fs.lstatSync(target).isDirectory()) fail(E.NOTDIR);
				fs.rmdirSync(target);
				return E.SUCCESS;
			},
			path_rename(oldFd, oldPtr, oldLen, newFd, newPtr, newLen) {
				const source = get(oldFd, R.PATH_RENAME_SOURCE);
				const dest = get(newFd, R.PATH_RENAME_TARGET);
				fs.renameSync(
					resolve(source, readString(oldPtr, oldLen), false),
					resolve(dest, readString(newPtr, newLen), false)
				);
				return E.SUCCESS;
			},
			path_symlink(oldPtr, oldLen, fd, newPtr, newLen) {
				const entry = get(fd, R.PATH_SYMLINK);
				const linkTarget = readString(oldPtr, oldLen);
				const link = resolve(entry, readString(newPtr, newLen), false);
				if (linkTarget.startsWith("/")) fail(E.NOTCAPABLE);
				if (!inside(entry.real, path.resolve(path.dirname(link), linkTarget))) fail(E.NOTCAPABLE);
				fs.symlinkSync(linkTarget, link);
				return E.SUCCESS;
			},
			path_unlink_file(fd, ptr, len) {
				const entry = get(fd, R.PATH_UNLINK_FILE);
				const target = resolve(entry, readString(ptr, len), false);
				if (fs.lstatSync(target).isDirectory()) fail(E.ISDIR);
				fs.unlinkSync(target);
				return E.SUCCESS;
			},
			poll_oneoff(inPtr, outPtr, count, neventsPtr) {
				count = u32(count);
				if (count === 0) fail(E.INVAL);
				const m = view();
				inPtr = u32(inPtr);
				outPtr = u32(outPtr);
				within(m, inPtr, count * 48);
				within(m, outPtr, count * 32);
				const clocks = [];
				const fdEvents = [];
				for (let i = 0; i < count; i++) {
					const at = inPtr + i * 48;
					const userdata = m.dv.getBigUint64(at, true);
					const tag = m.dv.getUint8(at + 8);
					if (tag === 0) {
						const id = m.dv.getUint32(at + 16, true);
						if (id > 1) fail(E.INVAL);
						const timeout = m.dv.getBigUint64(at + 24, true);
						const absolute = (m.dv.getUint16(at + 40, true) & 1) !== 0;
						const wait = absolute ? timeout - clockNow(id) : timeout;
						clocks.push({ userdata, wait: wait < 0n ? 0n : wait });
					} else if (tag === 1 || tag === 2) {
						const fd = m.dv.getUint32(at + 16, true);
						const entry = table.get(fd);
						if (!entry) {
							fdEvents.push({ userdata, tag, error: E.BADF });
							continue;
						}
						if (entry.type !== "stdio" || entry.filetype === FT.REG) fail(E.PERM);
						fdEvents.push({ userdata, tag, error: 0 });
					} else fail(E.INVAL);
				}
				const events = [...fdEvents];
				if (events.length === 0) {
					let least = clocks[0].wait;
					for (const clock of clocks) if (clock.wait < least) least = clock.wait;
					if (least > 0n) os.sleep(Number((least + 999999n) / 1000000n));
					for (const clock of clocks)
						if (clock.wait <= least) events.push({ userdata: clock.userdata, tag: 0, error: 0 });
				}
				const out = view();
				events.forEach((event, i) => {
					const at = outPtr + i * 32;
					out.u8.fill(0, at, at + 32);
					out.dv.setBigUint64(at, event.userdata, true);
					out.dv.setUint16(at + 8, event.error, true);
					out.dv.setUint8(at + 10, event.tag);
				});
				put32(neventsPtr, events.length);
				return E.SUCCESS;
			},
			proc_exit(code) {
				if (!returnOnExit) {
					process.exit(u32(code));
					return E.SUCCESS;
				}
				exitCode = u32(code);
				throw kExit;
			},
			proc_raise() {
				return E.NOSYS;
			},
			random_get(ptr, len) {
				const m = view();
				ptr = u32(ptr);
				len = u32(len);
				within(m, ptr, len);
				const random = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto);
				for (let done = 0; done < len; ) {
					const n = Math.min(65536, len - done);
					const chunk = new Uint8Array(m.buffer, ptr + done, n);
					if (random) random(chunk);
					else for (let i = 0; i < n; i++) chunk[i] = Math.floor(Math.random() * 256);
					done += n;
				}
				return E.SUCCESS;
			},
			sched_yield() {
				return E.SUCCESS;
			},
			sock_accept(fd) {
				get(fd, R.SOCK_SHUTDOWN);
				return E.NOSYS;
			},
			sock_recv(fd, _data, dataLen) {
				if (u32(dataLen) === 0) fail(E.INVAL);
				get(fd, R.SOCK_SHUTDOWN);
				return E.NOSYS;
			},
			sock_send(fd, _data, dataLen) {
				if (u32(dataLen) === 0) fail(E.INVAL);
				get(fd, R.SOCK_SHUTDOWN);
				return E.NOSYS;
			},
			sock_shutdown(fd, how) {
				if (u32(how) > 2) fail(E.NOTSUP);
				get(fd, R.SOCK_SHUTDOWN);
				return E.NOSYS;
			},
		};

		const origin = process.hrtime.bigint();
		function clockNow(id) {
			if (id === 0) return BigInt(Date.now()) * 1000000n;
			if (id === 1) return process.hrtime.bigint();
			if (id === 2 || id === 3) return process.hrtime.bigint() - origin;
			fail(E.INVAL);
		}

		const imports = {};
		for (const [name, impl] of Object.entries(exports)) {
			const wrapper = function (...callArgs) {
				if (!started) throw coded(Error, "ERR_WASI_NOT_STARTED", "wasi.start() has not been called");
				try {
					return impl(...callArgs);
				} catch (error) {
					if (error === kExit) throw error;
					const errno = errnoOf(error);
					if (errno === null) throw error;
					return errno;
				}
			};
			Object.defineProperty(wrapper, "length", { value: ARITY[name] });
			Object.defineProperty(wrapper, "name", { value: name });
			imports[name] = wrapper;
		}
		return {
			imports,
			bind(mem) {
				memory = mem;
				started = true;
			},
			exitCode: () => exitCode,
		};
	}

	class WASI {
		constructor(options = {}) {
			if (!warned) {
				warned = true;
				process.emitWarning("WASI is an experimental feature and might change at any time", "ExperimentalWarning");
			}
			validateObject(options, "options");
			validateString(options.version, "options.version");
			if (options.version !== "unstable" && options.version !== "preview1")
				throw coded(
					TypeError,
					"ERR_INVALID_ARG_VALUE",
					`The property 'options.version' unsupported WASI version. Received '${options.version}'`
				);
			let args = [];
			if (options.args !== undefined) {
				if (!Array.isArray(options.args)) throw typeError("options.args", "an instance of Array", options.args);
				args = options.args.map(String);
			}
			const envPairs = [];
			if (options.env !== undefined) {
				validateObject(options.env, "options.env");
				for (const key of Object.keys(options.env)) {
					const value = options.env[key];
					if (value !== undefined) envPairs.push(`${key}=${value}`);
				}
			}
			const preopens = [];
			if (options.preopens !== undefined) {
				validateObject(options.preopens, "options.preopens");
				for (const key of Object.keys(options.preopens)) {
					const real = path.resolve(String(options.preopens[key]));
					let ok = false;
					try {
						ok = fs.statSync(real).isDirectory();
					} catch {}
					if (!ok) throw coded(Error, "UVWASI_ENOENT", "UVWASI_ENOENT, uvwasi_init");
					preopens.push([key, real]);
				}
			}
			const stdio = [0, 1, 2];
			["stdin", "stdout", "stderr"].forEach((name, index) => {
				if (options[name] !== undefined) {
					validateFd(options[name], `options.${name}`);
					stdio[index] = options[name];
				}
			});
			if (options.returnOnExit !== undefined && typeof options.returnOnExit !== "boolean")
				throw typeError("options.returnOnExit", "of type boolean", options.returnOnExit);
			const bindings = createBindings({
				args,
				envPairs,
				preopens,
				returnOnExit: options.returnOnExit !== false,
				stdio,
			});
			state.set(this, {
				bindings,
				started: false,
				namespace: options.version === "unstable" ? "wasi_unstable" : "wasi_snapshot_preview1",
			});
			this.wasiImport = bindings.imports;
		}

		finalizeBindings(instance, options = {}) {
			const own = state.get(this);
			if (own.started) throw coded(Error, "ERR_WASI_ALREADY_STARTED", "WASI instance has already started");
			validateObject(instance, "instance");
			validateObject(instance.exports, "instance.exports");
			const memory = options?.memory ?? instance.exports.memory;
			if (!(memory instanceof globalThis.WebAssembly.Memory))
				throw coded(
					TypeError,
					"ERR_INVALID_ARG_TYPE",
					'"instance.exports.memory" property must be a WebAssembly.Memory object'
				);
			own.started = true;
			own.bindings.bind(memory);
			return instance.exports;
		}

		start(instance) {
			const exports = this.finalizeBindings(instance);
			const { _start, _initialize } = exports;
			validateFunction(_start, "instance.exports._start");
			if (_initialize !== undefined) throw typeError("instance.exports._initialize", "undefined", _initialize);
			try {
				_start();
			} catch (error) {
				if (error !== kExit) throw error;
			}
			return state.get(this).bindings.exitCode();
		}

		initialize(instance) {
			const exports = this.finalizeBindings(instance);
			const { _start, _initialize } = exports;
			if (_start !== undefined) throw typeError("instance.exports._start", "undefined", _start);
			if (_initialize !== undefined) validateFunction(_initialize, "instance.exports._initialize");
			if (_initialize !== undefined) _initialize();
		}

		getImportObject() {
			return { [state.get(this).namespace]: this.wasiImport };
		}
	}

	return { WASI };
}
