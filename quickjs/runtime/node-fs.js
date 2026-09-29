/*
 * Node's `fs`: synchronous, callback and promise forms of the file API, file descriptors, Stats and Dirent,
 * read and write streams, copy/remove/mkdtemp, polling watchers -- over the engine's `os` primitives (open, read,
 * write, seek, stat, readdir, mkdir, remove, rename, realpath, symlink, utimes) plus the few the host adds
 * (chmod, ftruncate, fsync).
 *
 * Errors carry what Node's do: `code` (ENOENT, EEXIST, ...), `errno`, `syscall` and `path`, and the message
 * "ENOENT: no such file or directory, open 'x'", because programs branch on exactly those.
 */

const ERRNO = {
	linux: { 1: "EPERM", 2: "ENOENT", 5: "EIO", 9: "EBADF", 11: "EAGAIN", 12: "ENOMEM", 13: "EACCES", 16: "EBUSY", 17: "EEXIST", 18: "EXDEV", 20: "ENOTDIR", 21: "EISDIR", 22: "EINVAL", 23: "ENFILE", 24: "EMFILE", 26: "ETXTBSY", 27: "EFBIG", 28: "ENOSPC", 29: "ESPIPE", 30: "EROFS", 31: "EMLINK", 32: "EPIPE", 36: "ENAMETOOLONG", 39: "ENOTEMPTY", 40: "ELOOP" },
	win32: { 1: "EPERM", 2: "ENOENT", 5: "EIO", 9: "EBADF", 11: "EAGAIN", 12: "ENOMEM", 13: "EACCES", 16: "EBUSY", 17: "EEXIST", 18: "EXDEV", 20: "ENOTDIR", 21: "EISDIR", 22: "EINVAL", 23: "ENFILE", 24: "EMFILE", 27: "EFBIG", 28: "ENOSPC", 29: "ESPIPE", 30: "EROFS", 31: "EMLINK", 32: "EPIPE", 38: "ENAMETOOLONG", 41: "ENOTEMPTY" },
};
const MESSAGES = {
	EPERM: "operation not permitted", ENOENT: "no such file or directory", EIO: "i/o error", EBADF: "bad file descriptor",
	EAGAIN: "resource temporarily unavailable", ENOMEM: "not enough memory", EACCES: "permission denied", EBUSY: "resource busy or locked",
	EEXIST: "file already exists", EXDEV: "cross-device link not permitted", ENOTDIR: "not a directory", EISDIR: "illegal operation on a directory",
	EINVAL: "invalid argument", ENFILE: "file table overflow", EMFILE: "too many open files", ETXTBSY: "text file is busy", EFBIG: "file too large",
	ENOSPC: "no space left on device", ESPIPE: "invalid seek", EROFS: "read-only file system", EMLINK: "too many links", EPIPE: "broken pipe",
	ENAMETOOLONG: "name too long", ENOTEMPTY: "directory not empty", ELOOP: "too many symbolic links encountered",
};

// POSIX whence values; the engine's os module does not export them, and an undefined whence means SEEK_SET.
const SEEK_SET = 0;
const SEEK_CUR = 1;
const SEEK_END = 2;

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFBLK = 0o060000;
const S_IFCHR = 0o020000;
const S_IFIFO = 0o010000;
const S_IFSOCK = 0o140000;

const constants = {
	F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
	O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 0o100, O_EXCL: 0o200, O_TRUNC: 0o1000, O_APPEND: 0o2000, O_SYNC: 0o4010000,
	S_IFMT, S_IFREG, S_IFDIR, S_IFLNK, S_IFBLK, S_IFCHR, S_IFIFO, S_IFSOCK,
	COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4,
	UV_FS_COPYFILE_EXCL: 1, UV_FS_COPYFILE_FICLONE: 2, UV_FS_COPYFILE_FICLONE_FORCE: 4,
	UV_DIRENT_UNKNOWN: 0, UV_DIRENT_FILE: 1, UV_DIRENT_DIR: 2, UV_DIRENT_LINK: 3, UV_DIRENT_FIFO: 4, UV_DIRENT_SOCKET: 5, UV_DIRENT_CHAR: 6, UV_DIRENT_BLOCK: 7,
};

function createFs({ os, std, Buffer, path, stream, EventEmitter, native, platform }) {
	const table = ERRNO[platform === "win32" ? "win32" : "linux"];

	function fsError(errno, syscall, target, dest) {
		errno = Math.abs(errno);
		const code = table[errno] ?? `E${errno}`;
		let message = `${code}: ${MESSAGES[code] ?? std.strerror(errno).toLowerCase()}, ${syscall}`;
		if (target !== undefined) message += ` '${target}'`;
		if (dest !== undefined) message += ` -> '${dest}'`;
		const err = new Error(message);
		err.errno = -errno;
		err.code = code;
		err.syscall = syscall;
		if (target !== undefined) err.path = target;
		if (dest !== undefined) err.dest = dest;
		return err;
	}

	function invalidArg(name, expected, value) {
		return Object.assign(
			new TypeError(`The "${name}" argument must be ${expected}. Received ${value === null ? "null" : typeof value === "object" ? "an instance of " + (value.constructor?.name ?? "Object") : `type ${typeof value} (${String(value)})`}`),
			{ code: "ERR_INVALID_ARG_TYPE" }
		);
	}

	/* A path argument: string, Buffer, or file: URL. */
	function toPath(value, name = "path") {
		if (typeof value === "string") {
			if (value.includes("\0")) throw Object.assign(new TypeError(`The argument '${name}' must be a string, Uint8Array, or URL without null bytes.`), { code: "ERR_INVALID_ARG_VALUE" });
			return value;
		}
		if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
		if (value && typeof value === "object" && value.protocol === "file:") {
			return decodeURIComponent(platform === "win32" ? value.pathname.replace(/^\/([A-Za-z]:)/, "$1") : value.pathname);
		}
		throw invalidArg(name, "of type string or an instance of Buffer or URL", value);
	}

	function resolvePackageJsonFallback(target) {
		if (typeof target !== "string") return target;
		// Only the working directory's package.json, the one a program reads for its own name and version. A
		// package.json anywhere else is a real lookup (the module resolver walks up directories for one) that has to fail.
		if (
			target === "package.json" ||
			target === "./package.json" ||
			target === ".\\package.json" ||
			((target.endsWith("/package.json") || target.endsWith("\\package.json")) &&
				path.resolve(path.dirname(target)) === path.resolve("."))
		) {
			const [, err] = os.stat(target);
			if (err !== 0) {
				const appDir = globalThis.process?.env?.GRAAK_APP_DIR;
				const rootDir = globalThis.process?.env?.GRAAK_ROOT_DIR;
				if (appDir) {
					const appPkg = path.join(appDir, "package.json");
					if (os.stat(appPkg)[1] === 0) return appPkg;
				}
				if (rootDir) {
					const rootPkg = path.join(rootDir, "package.json");
					if (os.stat(rootPkg)[1] === 0) return rootPkg;
				}
			}
		}
		return target;
	}

	function encodingOf(options, fallback = null) {
		if (typeof options === "string") return options;
		return options?.encoding ?? fallback;
	}

	/* ------------------------------------------------------------- stats and dirents */

	class Stats {
		constructor(info) {
			this.dev = info.dev ?? 0;
			this.mode = info.mode;
			this.nlink = info.nlink ?? 1;
			this.uid = info.uid ?? 0;
			this.gid = info.gid ?? 0;
			this.rdev = info.rdev ?? 0;
			this.blksize = info.blksize ?? 4096;
			this.ino = info.ino ?? 0;
			this.size = info.size;
			this.blocks = info.blocks ?? Math.ceil(info.size / 512);
			this.atimeMs = info.atime;
			this.mtimeMs = info.mtime;
			this.ctimeMs = info.ctime;
			this.birthtimeMs = info.ctime;
			this.atime = new Date(this.atimeMs);
			this.mtime = new Date(this.mtimeMs);
			this.ctime = new Date(this.ctimeMs);
			this.birthtime = new Date(this.birthtimeMs);
		}
		isFile() {
			return (this.mode & S_IFMT) === S_IFREG;
		}
		isDirectory() {
			return (this.mode & S_IFMT) === S_IFDIR;
		}
		isSymbolicLink() {
			return (this.mode & S_IFMT) === S_IFLNK;
		}
		isBlockDevice() {
			return (this.mode & S_IFMT) === S_IFBLK;
		}
		isCharacterDevice() {
			return (this.mode & S_IFMT) === S_IFCHR;
		}
		isFIFO() {
			return (this.mode & S_IFMT) === S_IFIFO;
		}
		isSocket() {
			return (this.mode & S_IFMT) === S_IFSOCK;
		}
	}

	class Dirent {
		constructor(name, parent, mode) {
			this.name = name;
			this.parentPath = parent;
			this.path = parent;
			this._mode = mode;
		}
		isFile() {
			return (this._mode & S_IFMT) === S_IFREG;
		}
		isDirectory() {
			return (this._mode & S_IFMT) === S_IFDIR;
		}
		isSymbolicLink() {
			return (this._mode & S_IFMT) === S_IFLNK;
		}
		isBlockDevice() {
			return (this._mode & S_IFMT) === S_IFBLK;
		}
		isCharacterDevice() {
			return (this._mode & S_IFMT) === S_IFCHR;
		}
		isFIFO() {
			return (this._mode & S_IFMT) === S_IFIFO;
		}
		isSocket() {
			return (this._mode & S_IFMT) === S_IFSOCK;
		}
	}

	/* ---------------------------------------------------------------- primitives */

	function statCall(fn, syscall, file, options) {
		const target = resolvePackageJsonFallback(toPath(file));
		const [info, errno] = fn(target);
		if (errno !== 0) {
			if (options?.throwIfNoEntry === false && errno === 2) return undefined;
			throw fsError(errno, syscall, target);
		}
		return new Stats(info);
	}

	const statSync = (file, options) => statCall((p) => os.stat(p), "stat", file, options);
	const lstatSync = (file, options) => statCall((p) => (os.lstat ?? os.stat)(p), "lstat", file, options);

	const FLAGS = {
		r: constants.O_RDONLY, "r+": constants.O_RDWR, rs: constants.O_RDONLY, "rs+": constants.O_RDWR,
		w: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, wx: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_EXCL,
		"w+": constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC, "wx+": constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_EXCL,
		a: constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, ax: constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_EXCL,
		"a+": constants.O_RDWR | constants.O_CREAT | constants.O_APPEND, "ax+": constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_EXCL,
	};

	/* Node's flag values are Linux's; the engine's os.O_* are the platform's own (Windows differs). */
	function osFlags(flags) {
		let value = typeof flags === "number" ? flags : FLAGS[flags ?? "r"];
		if (value === undefined) throw Object.assign(new TypeError(`The argument 'flags' is invalid. Received '${flags}'`), { code: "ERR_INVALID_ARG_VALUE" });
		let out = 0;
		const map = [
			[constants.O_WRONLY, os.O_WRONLY], [constants.O_RDWR, os.O_RDWR], [constants.O_CREAT, os.O_CREAT],
			[constants.O_EXCL, os.O_EXCL], [constants.O_TRUNC, os.O_TRUNC], [constants.O_APPEND, os.O_APPEND],
		];
		for (const [node, engine] of map) if (value & node) out |= engine;
		if (os.O_BINARY) out |= os.O_BINARY;
		return out;
	}

	function openSync(file, flags = "r", mode = 0o666) {
		let target = toPath(file);
		const f = osFlags(flags);
		if (!(f & (os.O_WRONLY | os.O_CREAT | os.O_TRUNC))) {
			target = resolvePackageJsonFallback(target);
		}
		const fd = os.open(target, f, typeof mode === "string" ? Number.parseInt(mode, 8) : mode);
		if (fd < 0) throw fsError(fd, "open", target);
		return fd;
	}

	function closeSync(fd) {
		const rc = os.close(fd);
		if (rc < 0) throw fsError(rc, "close");
	}

	/* read(fd, buffer, offset, length, position) -> bytesRead */
	function readSync(fd, buffer, offsetOrOptions, length, position) {
		let offset = offsetOrOptions;
		if (offsetOrOptions !== null && typeof offsetOrOptions === "object") {
			({ offset = 0, length = buffer.byteLength - offset, position = null } = offsetOrOptions);
		}
		offset ??= 0;
		length ??= buffer.byteLength - offset;
		if (length === 0) return 0;
		let saved = null;
		if (typeof position === "number" || typeof position === "bigint") {
			saved = os.seek(fd, 0, SEEK_CUR);
			os.seek(fd, Number(position), SEEK_SET);
		}
		const view = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
		const start = (buffer instanceof ArrayBuffer ? 0 : buffer.byteOffset) + offset;
		const n = os.read(fd, view, start, length);
		if (saved !== null) os.seek(fd, saved, SEEK_SET);
		if (n < 0) throw fsError(n, "read");
		return n;
	}

	function writeSync(fd, data, offsetOrPosition, lengthOrEncoding, position) {
		let bytes;
		let pos = null;
		if (typeof data === "string") {
			bytes = Buffer.from(data, typeof lengthOrEncoding === "string" ? lengthOrEncoding : "utf8");
			pos = typeof offsetOrPosition === "number" ? offsetOrPosition : null;
		} else {
			const offset = offsetOrPosition ?? 0;
			const length = typeof lengthOrEncoding === "number" ? lengthOrEncoding : data.byteLength - offset;
			bytes = new Uint8Array(data.buffer, data.byteOffset + offset, length);
			pos = typeof position === "number" ? position : null;
		}
		let saved = null;
		if (pos !== null) {
			saved = os.seek(fd, 0, SEEK_CUR);
			os.seek(fd, pos, SEEK_SET);
		}
		let written = 0;
		while (written < bytes.length) {
			const n = os.write(fd, bytes.buffer, bytes.byteOffset + written, bytes.length - written);
			if (n < 0) throw fsError(n, "write");
			written += n;
		}
		if (saved !== null) os.seek(fd, saved, SEEK_SET);
		return written;
	}

	function fstatSync(fd) {
		const here = os.seek(fd, 0, SEEK_CUR);
		const size = os.seek(fd, 0, SEEK_END);
		os.seek(fd, here, SEEK_SET);
		const now = Date.now();
		return new Stats({ mode: S_IFREG | 0o644, size: Math.max(0, size), atime: now, mtime: now, ctime: now });
	}

	function ftruncateSync(fd, length = 0) {
		if (typeof native?.ftruncate !== "function") throw Object.assign(new Error("ftruncate is not available on this host"), { code: "ENOSYS" });
		const rc = native.ftruncate(fd, length);
		if (rc < 0) throw fsError(rc, "ftruncate");
	}

	function fsyncSync(fd) {
		if (typeof native?.fsync === "function") native.fsync(fd);
	}

	/* ------------------------------------------------------------- whole files */

	function readAll(fd, hint) {
		const chunks = [];
		let total = 0;
		const size = hint > 0 ? hint : 65536;
		for (;;) {
			const chunk = Buffer.alloc(Math.min(size, 1 << 20) || 65536);
			const n = readSync(fd, chunk, 0, chunk.length, null);
			if (n === 0) break;
			chunks.push(n === chunk.length ? chunk : chunk.subarray(0, n));
			total += n;
		}
		return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total);
	}

	function readFileSync(file, options) {
		const encoding = encodingOf(options);
		const flag = typeof options === "object" && options?.flag ? options.flag : "r";
		const resolved = typeof file === "number" ? file : resolvePackageJsonFallback(toPath(file));
		const fd = typeof resolved === "number" ? resolved : openSync(resolved, flag);
		try {
			const [info, errno] = typeof resolved === "number" ? [null, 1] : os.stat(toPath(resolved));
			if (errno === 0 && (info.mode & S_IFMT) === S_IFDIR) throw fsError(21, "read");
			const data = readAll(fd, errno === 0 ? info.size : 0);
			return encoding && encoding !== "buffer" ? data.toString(encoding) : data;
		} finally {
			if (typeof resolved !== "number") os.close(fd);
		}
	}

	function writeFileSync(file, data, options) {
		const encoding = encodingOf(options, "utf8");
		const flag = typeof options === "object" && options?.flag ? options.flag : "w";
		const mode = typeof options === "object" && options?.mode !== undefined ? options.mode : 0o666;
		const bytes = typeof data === "string" ? Buffer.from(data, encoding) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(String(data), encoding);
		if (typeof data !== "string" && !ArrayBuffer.isView(data) && data !== undefined && typeof data?.toString !== "function") throw invalidArg("data", "of type string or an instance of Buffer, TypedArray, or DataView", data);
		const fd = typeof file === "number" ? file : openSync(file, flag, mode);
		try {
			writeSync(fd, bytes, 0, bytes.length, null);
		} finally {
			if (typeof file !== "number") os.close(fd);
		}
	}

	const appendFileSync = (file, data, options) => {
		const opts = typeof options === "string" ? { encoding: options } : { ...(options ?? {}) };
		opts.flag ??= "a";
		writeFileSync(file, data, opts);
	};

	const existsSync = (file) => {
		try {
			return os.stat(resolvePackageJsonFallback(toPath(file)))[1] === 0;
		} catch {
			return false;
		}
	};

	function accessSync(file, mode = constants.F_OK) {
		const target = resolvePackageJsonFallback(toPath(file));
		const [info, errno] = os.stat(target);
		if (errno !== 0) throw fsError(errno, "access", target);
		// Without a permission probe, the mode bits stand in: writable means any write bit is set.
		if (mode & constants.W_OK && !(info.mode & 0o222)) throw fsError(13, "access", target);
		if (mode & constants.X_OK && !(info.mode & 0o111) && platform !== "win32") throw fsError(13, "access", target);
	}

	/* ------------------------------------------------------------- directories */

	function readdirSync(dir, options) {
		const target = toPath(dir);
		const recursive = typeof options === "object" && options?.recursive;
		const withTypes = typeof options === "object" && options?.withFileTypes;
		const [names, errno] = os.readdir(target);
		if (errno !== 0) throw fsError(errno, "scandir", target);
		const out = [];
		const subdirs = [];
		for (const name of names.filter((n) => n !== "." && n !== "..").sort()) {
			const full = path.join(target, name);
			let mode = S_IFREG;
			if (withTypes || recursive) {
				const [info, e] = (os.lstat ?? os.stat)(full);
				if (e === 0) mode = info.mode;
			}
			out.push(withTypes ? new Dirent(name, target, mode) : name);
			if (recursive && (mode & S_IFMT) === S_IFDIR) subdirs.push([name, full]);
		}
		// Node lists a directory's own entries first, then each subdirectory's contents in turn.
		for (const [name, full] of subdirs) {
			for (const inner of readdirSync(full, { recursive: true, withFileTypes: withTypes })) {
				out.push(withTypes ? inner : path.join(name, inner));
			}
		}
		return out;
	}

	function mkdirSync(dir, options) {
		const target = toPath(dir);
		const recursive = typeof options === "object" && options?.recursive;
		const mode = typeof options === "number" ? options : (options?.mode ?? 0o777);
		if (!recursive) {
			const rc = os.mkdir(target, mode);
			if (rc < 0) throw fsError(rc, "mkdir", target);
			return undefined;
		}
		const full = path.resolve(target);
		const root = path.parse(full).root;
		let current = root;
		let first;
		for (const part of full.slice(root.length).split(/[\\/]/)) {
			if (!part) continue;
			current = !current || current.endsWith(path.sep) ? current + part : current + path.sep + part;
			const [info, errno] = os.stat(current);
			if (errno === 0) {
				if ((info.mode & S_IFMT) !== S_IFDIR) throw fsError(20, "mkdir", target);
				continue;
			}
			const rc = os.mkdir(current, mode);
			if (rc < 0 && rc !== -17) throw fsError(rc, "mkdir", target);
			first ??= current;
		}
		return first;
	}

	function rmdirSync(dir, options) {
		const target = toPath(dir);
		if (options?.recursive) return rmSync(target, { recursive: true, force: false });
		const [info, errno] = os.stat(target);
		if (errno !== 0) throw fsError(errno, "rmdir", target);
		if ((info.mode & S_IFMT) !== S_IFDIR) throw fsError(20, "rmdir", target);
		const rc = os.remove(target);
		if (rc < 0) throw fsError(rc, "rmdir", target);
	}

	function unlinkSync(file) {
		const target = toPath(file);
		const [info, errno] = (os.lstat ?? os.stat)(target);
		if (errno !== 0) throw fsError(errno, "unlink", target);
		if ((info.mode & S_IFMT) === S_IFDIR) throw fsError(21, "unlink", target);
		const rc = os.remove(target);
		if (rc < 0) throw fsError(rc, "unlink", target);
	}

	function rmSync(target, options = {}) {
		const p = toPath(target);
		const [info, errno] = (os.lstat ?? os.stat)(p);
		if (errno !== 0) {
			if (options.force && errno === 2) return;
			throw fsError(errno, "rm", p);
		}
		if ((info.mode & S_IFMT) === S_IFDIR) {
			if (!options.recursive) {
				throw Object.assign(new Error(`Path is a directory: rm returned EISDIR (is a directory) ${p}`), { code: "ERR_FS_EISDIR", errno: 21, syscall: "rm", path: p });
			}
			for (const name of os.readdir(p)[0].filter((n) => n !== "." && n !== "..")) rmSync(path.join(p, name), options);
		}
		const rc = os.remove(p);
		if (rc < 0) throw fsError(rc, "rm", p);
	}

	function renameSync(from, to) {
		const a = toPath(from, "oldPath");
		const b = toPath(to, "newPath");
		const rc = os.rename(a, b);
		if (rc < 0) throw fsError(rc, "rename", a, b);
	}

	function copyFileSync(from, to, mode = 0) {
		const src = toPath(from, "src");
		const dest = toPath(to, "dest");
		if (mode & constants.COPYFILE_EXCL && existsSync(dest)) throw fsError(17, "copyfile", src, dest);
		const [info, errno] = os.stat(src);
		if (errno !== 0) throw fsError(errno, "copyfile", src, dest);
		if ((info.mode & S_IFMT) === S_IFDIR) throw fsError(21, "copyfile", src, dest);
		const data = readFileSync(src);
		writeFileSync(dest, data, { mode: info.mode & 0o777 });
		chmodSync(dest, info.mode & 0o777);
	}

	function cpSync(from, to, options = {}) {
		const src = toPath(from, "src");
		const dest = toPath(to, "dest");
		const [info, errno] = os.stat(src);
		if (errno !== 0) throw fsError(errno, "cp", src);
		if (options.filter && !options.filter(src, dest)) return;
		if ((info.mode & S_IFMT) === S_IFDIR) {
			if (!options.recursive) {
				throw Object.assign(new Error(`Recursive option is not enabled, cannot copy a directory: ${src}`), { code: "ERR_FS_EISDIR" });
			}
			mkdirSync(dest, { recursive: true });
			for (const name of os.readdir(src)[0].filter((n) => n !== "." && n !== "..")) cpSync(path.join(src, name), path.join(dest, name), options);
			return;
		}
		if (options.force === false && existsSync(dest)) {
			if (options.errorOnExist) throw fsError(17, "cp", dest);
			return;
		}
		copyFileSync(src, dest);
	}

	function realpathSync(file) {
		const target = toPath(file);
		const [resolved, errno] = os.realpath(target);
		if (errno !== 0) throw fsError(errno, "realpath", target);
		return resolved;
	}
	realpathSync.native = realpathSync;

	function chmodSync(file, mode) {
		const target = toPath(file);
		if (typeof native?.chmod === "function") {
			const rc = native.chmod(target, typeof mode === "string" ? Number.parseInt(mode, 8) : mode);
			if (rc < 0) throw fsError(rc, "chmod", target);
		}
	}

	function truncateSync(file, length = 0) {
		const fd = openSync(file, "r+");
		try {
			ftruncateSync(fd, length);
		} finally {
			os.close(fd);
		}
	}

	function utimesSync(file, atime, mtime) {
		const target = toPath(file);
		const ms = (value) => (value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : value * 1000);
		const rc = os.utimes(target, ms(atime), ms(mtime));
		if (rc < 0) throw fsError(rc, "utime", target);
	}

	function symlinkSync(target, file) {
		const rc = os.symlink(toPath(target, "target"), toPath(file));
		if (rc < 0) throw fsError(rc, "symlink", toPath(target, "target"), toPath(file));
	}
	function readlinkSync(file) {
		const target = toPath(file);
		const [link, errno] = os.readlink(target);
		if (errno !== 0) throw fsError(errno, "readlink", target);
		return link;
	}
	function linkSync(existing, file) {
		if (typeof native?.link !== "function") throw Object.assign(new Error("link is not available on this host"), { code: "ENOSYS" });
		const target = toPath(existing, "existing"), dest = toPath(file, "newPath");
		const rc = native.link(target, dest);
		if (rc !== 0) throw fsError(rc, "link", target, dest);
	}

	function mkdtempSync(prefix) {
		const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
		for (let attempt = 0; attempt < 100; attempt++) {
			let suffix = "";
			for (let i = 0; i < 6; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
			const candidate = prefix + suffix;
			const rc = os.mkdir(candidate, 0o700);
			if (rc === 0) return candidate;
			if (rc !== -17) throw fsError(rc, "mkdtemp", `${prefix}XXXXXX`);
		}
		throw fsError(17, "mkdtemp", `${prefix}XXXXXX`);
	}

	/* opendir: a Dir over the entries, read eagerly. */
	class Dir {
		constructor(dir) {
			this.path = dir;
			this._entries = readdirSync(dir, { withFileTypes: true });
			this._index = 0;
		}
		readSync() {
			return this._entries[this._index++] ?? null;
		}
		async read() {
			return this.readSync();
		}
		closeSync() {}
		async close() {}
		async *[Symbol.asyncIterator]() {
			let entry;
			while ((entry = this.readSync()) !== null) yield entry;
		}
	}
	const opendirSync = (dir) => new Dir(toPath(dir));

	/* ------------------------------------------------------------------- streams */

	class ReadStream extends stream.Readable {
		constructor(file, options = {}) {
			if (typeof options === "string") options = { encoding: options };
			super({ highWaterMark: options.highWaterMark ?? 65536, encoding: options.encoding, emitClose: options.emitClose !== false, autoDestroy: options.autoClose !== false });
			this.path = file === undefined || options.fd !== undefined ? undefined : toPath(file);
			this.fd = options.fd ?? null;
			this.flags = options.flags ?? "r";
			this.start = options.start;
			this.end = options.end ?? Number.POSITIVE_INFINITY;
			this.pos = this.start;
			this.bytesRead = 0;
			this._own = options.fd === undefined;
			if (this.start !== undefined && this.end < this.start) throw Object.assign(new RangeError('The value of "start" is out of range. It must be <= "end".'), { code: "ERR_OUT_OF_RANGE" });
			if (this.fd === null) {
				try {
					this.fd = openSync(this.path, this.flags, options.mode ?? 0o666);
				} catch (err) {
					queueMicrotask(() => this.destroy(err));
					return;
				}
				queueMicrotask(() => this.emit("open", this.fd));
			}
			queueMicrotask(() => this.emit("ready"));
		}
		_read(size) {
			if (this.fd === null) return;
			let toRead = size;
			if (this.pos !== undefined) toRead = Math.min(this.end - this.pos + 1, size);
			else if (this.end !== Number.POSITIVE_INFINITY) toRead = Math.min(this.end - this.bytesRead + 1, size);
			if (toRead <= 0) {
				this.push(null);
				return;
			}
			const buffer = Buffer.alloc(toRead);
			let n;
			try {
				n = readSync(this.fd, buffer, 0, toRead, this.pos ?? null);
			} catch (err) {
				this.destroy(err);
				return;
			}
			if (this.pos !== undefined) this.pos += n;
			this.bytesRead += n;
			this.push(n === 0 ? null : n === buffer.length ? buffer : buffer.subarray(0, n));
		}
		_destroy(err, callback) {
			if (this.fd !== null && this._own) {
				os.close(this.fd);
				this.fd = null;
			}
			callback(err);
		}
		close(callback) {
			if (callback) this.once("close", callback);
			this.destroy();
		}
	}

	class WriteStream extends stream.Writable {
		constructor(file, options = {}) {
			if (typeof options === "string") options = { encoding: options };
			super({ highWaterMark: options.highWaterMark ?? 16384, decodeStrings: true, defaultEncoding: options.encoding ?? "utf8", emitClose: options.emitClose !== false, autoDestroy: options.autoClose !== false });
			this.path = options.fd !== undefined ? undefined : toPath(file);
			this.fd = options.fd ?? null;
			this.flags = options.flags ?? "w";
			this.start = options.start;
			this.pos = this.start;
			this.bytesWritten = 0;
			this._own = options.fd === undefined;
			if (this.fd === null) {
				try {
					this.fd = openSync(this.path, this.flags, options.mode ?? 0o666);
				} catch (err) {
					queueMicrotask(() => this.destroy(err));
					return;
				}
				queueMicrotask(() => this.emit("open", this.fd));
			}
			queueMicrotask(() => this.emit("ready"));
		}
		_write(chunk, encoding, callback) {
			try {
				const n = writeSync(this.fd, chunk, 0, chunk.length, this.pos ?? null);
				if (this.pos !== undefined) this.pos += n;
				this.bytesWritten += n;
			} catch (err) {
				callback(err);
				return;
			}
			callback();
		}
		_destroy(err, callback) {
			if (this.fd !== null && this._own) {
				os.close(this.fd);
				this.fd = null;
			}
			callback(err);
		}
		close(callback) {
			if (callback) this.once("close", callback);
			this.end();
		}
		get pending() {
			return this.fd === null;
		}
	}

	const createReadStream = (file, options) => new ReadStream(file, options);
	const createWriteStream = (file, options) => new WriteStream(file, options);

	/* -------------------------------------------------------------------- watching */

	/* Files have no change notifications here; watching polls the mtime and size. */
	function watchFile(file, options, listener) {
		if (typeof options === "function") {
			listener = options;
			options = {};
		}
		const target = toPath(file);
		const interval = options?.interval ?? 5007;
		const read = () => {
			const [info, errno] = os.stat(target);
			return errno === 0 ? new Stats(info) : new Stats({ mode: 0, size: 0, atime: 0, mtime: 0, ctime: 0 });
		};
		let previous = read();
		const timer = globalThis.setInterval(() => {
			const current = read();
			if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) {
				listener(current, previous);
				previous = current;
			}
		}, interval);
		watchers.set(target, [...(watchers.get(target) ?? []), { timer, listener }]);
		return { ref() {}, unref() {} };
	}
	const watchers = new Map();
	function unwatchFile(file, listener) {
		const target = toPath(file);
		const entries = watchers.get(target) ?? [];
		for (const entry of entries) {
			if (!listener || entry.listener === listener) globalThis.clearInterval(entry.timer);
		}
		watchers.set(target, listener ? entries.filter((entry) => entry.listener !== listener) : []);
	}
	/**
	 * `fs.watch` on a file or a directory, recursive or not. The engine has no change notifications, so the watched
	 * tree is compared with a snapshot of itself: a name that appears or disappears is a 'rename' and one whose size
	 * or modification time changed a 'change', the two events Node reports. The interval grows with the cost of
	 * a snapshot, so watching a large tree cannot starve the program of its own time.
	 */
	function watch(file, options, listener) {
		if (typeof options === "function") {
			listener = options;
			options = {};
		}
		options = options ?? {};
		const target = toPath(file);
		const emitter = new EventEmitter();
		if (listener) emitter.on("change", listener);
		const first = statSync(target, { throwIfNoEntry: false });
		if (!first) throw fsError(-2, "watch", target);
		const isDir = first.isDirectory();
		const recursive = isDir && options.recursive === true;

		const take = () => {
			const found = new Map();
			const visit = (dir, prefix) => {
				let names;
				try {
					names = readdirSync(dir);
				} catch {
					return;
				}
				for (const name of names) {
					const full = `${dir}/${name}`;
					const info = statSync(full, { throwIfNoEntry: false });
					if (!info) continue;
					const key = prefix ? `${prefix}/${name}` : name;
					found.set(key, `${info.size}:${info.mtimeMs}:${info.isDirectory() ? "d" : "f"}`);
					if (recursive && info.isDirectory()) visit(full, key);
				}
			};
			if (isDir) visit(target, "");
			else {
				const info = statSync(target, { throwIfNoEntry: false });
				if (info) found.set(path.basename(target), `${info.size}:${info.mtimeMs}:f`);
			}
			return found;
		};

		let previous = take();
		let closed = false;
		let interval = 100;
		let timer = null;
		const tick = () => {
			if (closed) return;
			const started = Date.now();
			const current = take();
			for (const [name, signature] of current) {
				if (!previous.has(name)) emitter.emit("change", "rename", name);
				else if (previous.get(name) !== signature) emitter.emit("change", "change", name);
			}
			for (const name of previous.keys()) if (!current.has(name)) emitter.emit("change", "rename", name);
			previous = current;
			interval = Math.max(100, (Date.now() - started) * 4);
			timer = globalThis.setTimeout(tick, interval);
		};
		timer = globalThis.setTimeout(tick, interval);
		emitter.close = () => {
			if (closed) return;
			closed = true;
			globalThis.clearTimeout(timer);
			emitter.emit("close");
		};
		emitter.ref = () => {
			timer?.ref?.();
			return emitter;
		};
		emitter.unref = () => {
			timer?.unref?.();
			return emitter;
		};
		if (options.signal) {
			if (options.signal.aborted) emitter.close();
			else options.signal.addEventListener("abort", () => emitter.close(), { once: true });
		}
		return emitter;
	}

	/* ------------------------------------------- callback and promise forms of it all */

	const sync = {
		access: accessSync, appendFile: appendFileSync, chmod: chmodSync, chown: () => {}, close: closeSync, copyFile: copyFileSync,
		cp: cpSync, fchmod: () => {}, fchown: () => {}, fstat: fstatSync, fsync: fsyncSync, fdatasync: fsyncSync, ftruncate: ftruncateSync,
		futimes: () => {}, lchown: () => {}, link: linkSync, lstat: lstatSync, lutimes: utimesSync, mkdir: mkdirSync, mkdtemp: mkdtempSync,
		open: openSync, opendir: opendirSync, readdir: readdirSync, readFile: readFileSync, readlink: readlinkSync, realpath: realpathSync,
		rename: renameSync, rm: rmSync, rmdir: rmdirSync, stat: statSync, symlink: symlinkSync, truncate: truncateSync, unlink: unlinkSync,
		utimes: utimesSync, writeFile: writeFileSync,
	};

	const fs = {
		constants,
		Stats,
		Dirent,
		Dir,
		ReadStream,
		WriteStream,
		FileReadStream: ReadStream,
		FileWriteStream: WriteStream,
		F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
		createReadStream,
		createWriteStream,
		watch,
		watchFile,
		unwatchFile,
		existsSync,
		statSync,
		lstatSync,
		readSync,
		writeSync,
		fstatSync,
		exists(file, callback) {
			const found = existsSync(file);
			queueMicrotask(() => callback(found));
		},
		read(fd, buffer, offset, length, position, callback) {
			if (typeof buffer === "function") {
				callback = buffer;
				buffer = Buffer.alloc(16384);
				offset = 0;
				length = buffer.length;
			} else if (typeof offset === "function") {
				callback = offset;
				offset = 0;
				length = buffer.length;
				position = null;
			}
			let result;
			let error = null;
			try {
				result = readSync(fd, buffer, offset, length, position);
			} catch (err) {
				error = err;
			}
			queueMicrotask(() => (error ? callback(error) : callback(null, result, buffer)));
		},
		write(fd, data, ...rest) {
			const callback = rest.pop();
			let result;
			let error = null;
			try {
				result = writeSync(fd, data, ...rest);
			} catch (err) {
				error = err;
			}
			queueMicrotask(() => (error ? callback(error) : callback(null, result, data)));
		},
	};
	for (const [name, fn] of Object.entries(sync)) fs[`${name}Sync`] = fn;
	fs.realpathSync = realpathSync;
	for (const [name, fn] of Object.entries(sync)) {
		if (name === "opendir") continue;
		fs[name] = (...args) => {
			const callback = args.pop();
			if (typeof callback !== "function") {
				throw Object.assign(new TypeError('The "cb" argument must be of type function. Received ' + typeof callback), { code: "ERR_INVALID_ARG_TYPE" });
			}
			let result;
			let error = null;
			try {
				result = fn(...args);
			} catch (err) {
				error = err;
			}
			queueMicrotask(() => (error ? callback(error) : callback(null, result)));
		};
	}
	fs.realpath.native = fs.realpath;
	fs.opendir = (dir, options, callback) => {
		callback = typeof options === "function" ? options : callback;
		let handle;
		let error = null;
		try {
			handle = opendirSync(dir);
		} catch (err) {
			error = err;
		}
		queueMicrotask(() => (error ? callback(error) : callback(null, handle)));
	};
	fs.exists[Symbol.for("nodejs.util.promisify.custom")] = (file) => Promise.resolve(existsSync(file));

	/* --------------------------------------------------------------------- promises */

	class FileHandle extends EventEmitter {
		constructor(fd) {
			super();
			this.fd = fd;
		}
		async readFile(options) {
			return readFileSync(this.fd, options);
		}
		async writeFile(data, options) {
			return writeFileSync(this.fd, data, options);
		}
		async appendFile(data, options) {
			return writeFileSync(this.fd, data, options);
		}
		async read(buffer, offset, length, position) {
			if (buffer === undefined || (typeof buffer === "object" && !ArrayBuffer.isView(buffer))) {
				const opts = buffer ?? {};
				buffer = opts.buffer ?? Buffer.alloc(16384);
				offset = opts.offset ?? 0;
				length = opts.length ?? buffer.byteLength - offset;
				position = opts.position ?? null;
			}
			const bytesRead = readSync(this.fd, buffer, offset ?? 0, length ?? buffer.byteLength - (offset ?? 0), position ?? null);
			return { bytesRead, buffer };
		}
		async write(data, ...rest) {
			const bytesWritten = writeSync(this.fd, data, ...rest);
			return { bytesWritten, buffer: data };
		}
		async stat() {
			return fstatSync(this.fd);
		}
		async truncate(length) {
			ftruncateSync(this.fd, length);
		}
		async sync() {
			fsyncSync(this.fd);
		}
		async datasync() {
			fsyncSync(this.fd);
		}
		async chmod() {}
		async chown() {}
		async utimes() {}
		createReadStream(options) {
			return new ReadStream(undefined, { ...options, fd: this.fd, autoClose: false });
		}
		createWriteStream(options) {
			return new WriteStream(undefined, { ...options, fd: this.fd, autoClose: false });
		}
		async close() {
			if (this.fd === -1) return;
			closeSync(this.fd);
			this.fd = -1;
			this.emit("close");
		}
		async [Symbol.asyncDispose]() {
			await this.close();
		}
	}

	const promises = { constants };
	for (const [name, fn] of Object.entries(sync)) {
		if (name === "open" || name === "opendir") continue;
		promises[name] = async (...args) => fn(...args);
	}
	promises.open = async (file, flags, mode) => new FileHandle(openSync(file, flags, mode));
	promises.opendir = async (dir) => opendirSync(dir);
	promises.watch = async function* (file, options) {
		const watcher = watch(file, options);
		const queue = [];
		let wake = null;
		watcher.on("change", (eventType, filename) => {
			queue.push({ eventType, filename });
			wake?.();
		});
		try {
			for (;;) {
				if (!queue.length) await new Promise((resolve) => (wake = resolve));
				while (queue.length) yield queue.shift();
			}
		} finally {
			watcher.close();
		}
	};
	fs.promises = promises;
	fs.FileHandle = FileHandle;
	return fs;
}

export { createFs, constants as fsConstants };
