/*
 * Single-file executables for the Graak native host.
 *
 * `graak compile --strategy sea` appends the application (the compatibility layer plus the program and its
 * node_modules) to a copy of this executable, followed by a fixed-size trailer that says where it starts. On
 * launch the host looks at its own file, reads the payload's index and runs the program straight from it: the
 * module loader here and the fs layer in quickjs/runtime/node-sea.js read files out of the payload, decompressing
 * them on demand, so nothing is unpacked to disk. Only what must be a real file (a native addon for LoadLibrary or
 * dlopen, a program to start as a child process, an SQLite database) is extracted, one file at a time, beside the
 * executable (<exe>.graak) or in the temp directory when that folder is read-only.
 *
 * Payload layout (version 2), written by src/compiler/SeaPayload.ts; all integers little-endian:
 *
 *     u32 indexLength, then indexLength bytes of index:
 *         u32 blockCount, u32 entryCount, u16 mainLength, main (UTF-8: the program's entry file)
 *         per block: u64 offset (from the payload's start), u32 storedSize, u32 rawSize,
 *                    u8 method (0 = stored, 1 = raw deflate, 2 = Brotli)
 *         per entry, sorted by the bytes of its path:
 *                    u16 pathLength, path (UTF-8, forward slashes), u32 mode, u32 block, u32 offsetInBlock, u32 size
 *     then the blocks. Files are packed together into blocks of about two megabytes, so small modules compress
 *     against each other; reading one decompresses its block, which stays cached for the files beside it.
 *
 * Trailer (88 bytes, the last thing in the file):
 *
 *     "FGSEA\0\0\2", u64 payloadOffset, u64 payloadLength, 64 hex characters (the payload's SHA-256)
 *
 * The last byte of the magic is the format version. Version 1 (every file unpacked on first start) is refused with
 * a message saying to rebuild; a host never meets another version's payload unless one was grafted onto it.
 */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs-libc.h"
#include "quickjs.h"

#include "miniz.h"
#include <brotli/decode.h>

#ifdef _WIN32
#include <windows.h>
#else
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

#define FG_SEA_TRAILER 88
#define FG_SEA_MAGIC "FGSEA\0\0\2"
#define FG_SEA_MAGIC_V1 "FGSEA\0\0\1"
/*
 * Decompressed blocks are cached. A program's start-up reads modules from all over its tree in no useful order, so until
 * the entry module has run the cache may hold FG_SEA_START_BUDGET bytes, enough for every block a large program touches;
 * after that (release()) it keeps FG_SEA_BUDGET, a few blocks for modules required later.
 */
#define FG_SEA_CACHE 64
#define FG_SEA_START_BUDGET ((size_t) 64 << 20)
#define FG_SEA_BUDGET ((size_t) 4 << 20)

/* The packer looks for this in a host before appending a payload, so an older host is refused at build time. */
__attribute__((used)) static const char fg_sea_format[] = "graak-sea-format:2";

typedef struct {
    uint64_t offset;
    uint32_t stored, raw;
    unsigned method;
} fg_sea_block;

typedef struct {
    const char *path;
    size_t len;
    uint32_t mode, block, offset, size;
} fg_sea_entry;

static struct {
    int active;
#ifdef _WIN32
    HANDLE file;
#else
    int fd;
#endif
    uint64_t base, length;
    unsigned char *index;
    fg_sea_block *blocks;
    uint32_t nblocks;
    fg_sea_entry *entries;
    uint32_t nentries;
    char root[4096];
    size_t root_len;
    char sha[65];
    /* Where files that must be real are extracted to: decided on the first extraction. */
    char out[4096];
    int out_ready, stale;
    struct {
        int64_t block;
        unsigned char *data;
        unsigned used;
    } cache[FG_SEA_CACHE];
    unsigned tick;
    size_t cached, budget;
} sea;

/*
 * `node:test`'s `mock.module()` for ESM: a JS callback registered once from node-compat.js (native.setEsmMockHook),
 * called synchronously from fg_sea_module_loader with the specifier the engine is about to load. It returns either
 * `undefined` (no mock; load the real module) or a fully-formed ES module source string, which is compiled and
 * installed exactly like a payload file below. The callback owns all matching logic (Node's specifier-resolution
 * semantics, building the export list); this file only calls it and compiles what it hands back.
 *
 * The hook is tracked with a plain flag rather than a `JSValue` initialized to `JS_UNDEFINED`: a static JSValue
 * initializer is not a constant expression on every target's compiler (the NaN-boxed and split-union JSValue
 * layouts differ in whether that counts as a compound literal), so `fg_sea_mock_hook` starts uninitialized and
 * `fg_sea_mock_hook_set` says whether it holds a live value yet.
 */
static JSContext *fg_sea_mock_ctx = NULL;
static JSValue fg_sea_mock_hook;
static int fg_sea_mock_hook_set = 0;

static JSValue fg_sea_js_set_esm_mock_hook(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void) this_val;
    if (fg_sea_mock_hook_set) {
        JS_FreeValue(fg_sea_mock_ctx, fg_sea_mock_hook);
    }
    if (argc > 0 && JS_IsFunction(ctx, argv[0])) {
        fg_sea_mock_hook = JS_DupValue(ctx, argv[0]);
        fg_sea_mock_hook_set = 1;
    } else {
        fg_sea_mock_hook_set = 0;
    }
    fg_sea_mock_ctx = ctx;
    return JS_UNDEFINED;
}

/* Compiles an already-loaded module source into a JSModuleDef, the same way for a payload file and a synthesized mock. */
static JSModuleDef *fg_sea_compile_module(JSContext *ctx, const char *src, size_t len, const char *name)
{
    JSValue val = JS_Eval(ctx, src, len, name, JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    JSModuleDef *m;
    if (JS_IsException(val)) {
        return NULL;
    }
    if (js_module_set_import_meta(ctx, val, false, false) < 0) {
        JS_FreeValue(ctx, val);
        return NULL;
    }
    m = (JSModuleDef *) JS_VALUE_GET_PTR(val);
    JS_FreeValue(ctx, val);
    return m;
}

static uint64_t fg_le64(const unsigned char *p)
{
    uint64_t v = 0;
    int i;
    for (i = 7; i >= 0; i--) {
        v = (v << 8) | p[i];
    }
    return v;
}

static uint32_t fg_le32(const unsigned char *p)
{
    return (uint32_t) p[0] | ((uint32_t) p[1] << 8) | ((uint32_t) p[2] << 16) | ((uint32_t) p[3] << 24);
}

static int fg_self_path(char *out, size_t cap, const char *argv0)
{
#ifdef _WIN32
    DWORD n = GetModuleFileNameA(NULL, out, (DWORD) cap);
    (void) argv0;
    return n > 0 && n < cap ? 0 : -1;
#else
    ssize_t n = readlink("/proc/self/exe", out, cap - 1);
    if (n > 0) {
        out[n] = '\0';
        return 0;
    }
    if (argv0 && strlen(argv0) < cap) {
        strcpy(out, argv0);
        return 0;
    }
    return -1;
#endif
}

/* Reads `len` bytes at `off` of this executable. */
static int fg_sea_pread(void *buf, size_t len, uint64_t off)
{
    unsigned char *p = (unsigned char *) buf;
#ifdef _WIN32
    LONG high = (LONG) (off >> 32);
    if (SetFilePointer(sea.file, (LONG) (off & 0xffffffffu), &high, FILE_BEGIN) == INVALID_SET_FILE_POINTER &&
        GetLastError() != NO_ERROR) {
        return -1;
    }
    while (len) {
        DWORD got = 0, chunk = len > 0x40000000u ? 0x40000000u : (DWORD) len;
        if (!ReadFile(sea.file, p, chunk, &got, NULL) || got == 0) {
            return -1;
        }
        p += got;
        len -= got;
    }
#else
    while (len) {
        ssize_t got = pread(sea.fd, p, len, (off_t) off);
        if (got < 0 && errno == EINTR) continue;
        if (got <= 0) {
            return -1;
        }
        p += got;
        off += (uint64_t) got;
        len -= (size_t) got;
    }
#endif
    return 0;
}

static int fg_make_dir(const char *path)
{
#ifdef _WIN32
    if (CreateDirectoryA(path, NULL)) {
        return 0;
    }
    return GetLastError() == ERROR_ALREADY_EXISTS ? 0 : -1;
#else
    if (mkdir(path, 0755) == 0) {
        return 0;
    }
    return errno == EEXIST ? 0 : -1;
#endif
}

/* mkdir -p for everything above the last separator of `file`. */
static int fg_make_parents(char *file)
{
    char *p;
    for (p = file + 1; *p; p++) {
        if (*p == '/') {
            *p = '\0';
            /* A Windows drive ("C:") is not a directory to create. */
            if (!(p - file == 2 && file[1] == ':') && fg_make_dir(file) != 0) {
                *p = '/';
                return -1;
            }
            *p = '/';
        }
    }
    return 0;
}

/* Entries come from our own build, but a hand-edited file must still not write outside the directory. */
static int fg_safe_path(const char *path, size_t len)
{
    size_t i;
    if (len == 0 || path[0] == '/' || (len > 1 && path[1] == ':')) {
        return 0;
    }
    for (i = 0; i < len; i++) {
        if (path[i] == '\\' || path[i] == '\0') {
            return 0;
        }
        if (path[i] == '.' && i + 1 < len && path[i + 1] == '.' && (i == 0 || path[i - 1] == '/') &&
            (i + 2 >= len || path[i + 2] == '/')) {
            return 0;
        }
    }
    return 1;
}

static int fg_write_file(const char *path, const unsigned char *data, size_t len, uint32_t mode)
{
    FILE *f = fopen(path, "wb");
    if (!f) {
        return -1;
    }
    if (len && fwrite(data, 1, len, f) != len) {
        fclose(f);
        return -1;
    }
    if (fclose(f) != 0) {
        return -1;
    }
#ifndef _WIN32
    if (mode & 0111) {
        chmod(path, (mode_t) (mode & 0777));
    }
#else
    (void) mode;
#endif
    return 0;
}

static int fg_read_small(const char *path, char *out, size_t cap)
{
    FILE *f = fopen(path, "rb");
    size_t n;
    if (!f) {
        return -1;
    }
    n = fread(out, 1, cap - 1, f);
    fclose(f);
    out[n] = '\0';
    return 0;
}

/* Size of a regular file, or -1 when there is none. */
static int64_t fg_file_size(const char *path)
{
#ifdef _WIN32
    WIN32_FILE_ATTRIBUTE_DATA info;
    if (!GetFileAttributesExA(path, GetFileExInfoStandard, &info) || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) {
        return -1;
    }
    return ((int64_t) info.nFileSizeHigh << 32) | info.nFileSizeLow;
#else
    struct stat st;
    if (stat(path, &st) != 0 || !S_ISREG(st.st_mode)) {
        return -1;
    }
    return (int64_t) st.st_size;
#endif
}

/* ------------------------------------------------------------------------------------------ index */

static int fg_sea_cmp(const char *a, size_t alen, const char *b, size_t blen)
{
    int c = memcmp(a, b, alen < blen ? alen : blen);
    if (c) return c;
    return alen < blen ? -1 : alen > blen ? 1 : 0;
}

/* Index of the first entry whose path is >= `p`. */
static uint32_t fg_sea_lower(const char *p, size_t len)
{
    uint32_t lo = 0, hi = sea.nentries;
    while (lo < hi) {
        uint32_t mid = lo + (hi - lo) / 2;
        if (fg_sea_cmp(sea.entries[mid].path, sea.entries[mid].len, p, len) < 0) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

static fg_sea_entry *fg_sea_find(const char *p, size_t len)
{
    uint32_t i = fg_sea_lower(p, len);
    if (i < sea.nentries && sea.entries[i].len == len && memcmp(sea.entries[i].path, p, len) == 0) {
        return &sea.entries[i];
    }
    return NULL;
}

/* First entry inside directory `p` ("" is the root), or nentries when it is not a directory in the payload. */
static uint32_t fg_sea_dir_start(const char *p, size_t len)
{
    char prefix[4096];
    uint32_t i;
    if (len == 0) {
        return 0;
    }
    if (len + 1 >= sizeof(prefix)) {
        return sea.nentries;
    }
    memcpy(prefix, p, len);
    prefix[len] = '/';
    i = fg_sea_lower(prefix, len + 1);
    if (i < sea.nentries && sea.entries[i].len > len + 1 && memcmp(sea.entries[i].path, prefix, len + 1) == 0) {
        return i;
    }
    return sea.nentries;
}

/*
 * Turns an absolute path into one relative to the payload's root, resolving "." and "..". Returns 1 when the path is
 * inside the root. Windows compares the root without regard to case or slash direction, as its file system does.
 */
static int fg_sea_relative(const char *abs, size_t abs_len, char *rel, size_t cap, size_t *rel_len)
{
    size_t i, n = 0;
    if (!sea.active || abs_len < sea.root_len) {
        return 0;
    }
    for (i = 0; i < sea.root_len; i++) {
        char a = abs[i], b = sea.root[i];
#ifdef _WIN32
        if (a == '\\') a = '/';
        if (a >= 'A' && a <= 'Z') a = (char) (a - 'A' + 'a');
        if (b >= 'A' && b <= 'Z') b = (char) (b - 'A' + 'a');
#endif
        if (a != b) {
            return 0;
        }
    }
    if (abs_len > sea.root_len && abs[i] != '/' && abs[i] != '\\') {
        return 0;
    }
    while (i < abs_len) {
        size_t start, seg;
        while (i < abs_len && (abs[i] == '/' || abs[i] == '\\')) i++;
        start = i;
        while (i < abs_len && abs[i] != '/' && abs[i] != '\\') i++;
        seg = i - start;
        if (seg == 0 || (seg == 1 && abs[start] == '.')) {
            continue;
        }
        if (seg == 2 && abs[start] == '.' && abs[start + 1] == '.') {
            if (n == 0) {
                return 0; /* above the root */
            }
            while (n > 0 && rel[n - 1] != '/') n--;
            if (n > 0) n--;
            continue;
        }
        if (n + (n ? 1 : 0) + seg >= cap) {
            return 0;
        }
        if (n) rel[n++] = '/';
        memcpy(rel + n, abs + start, seg);
        n += seg;
    }
    rel[n] = '\0';
    *rel_len = n;
    return 1;
}

/* Drops least recently used blocks until the cache holds at most `budget` bytes (the newest block always stays). */
static void fg_sea_trim(size_t budget)
{
    while (sea.cached > budget) {
        int i, oldest = -1;
        for (i = 0; i < FG_SEA_CACHE; i++) {
            if (sea.cache[i].data && sea.cache[i].used != sea.tick && (oldest < 0 || sea.cache[i].used < sea.cache[oldest].used)) {
                oldest = i;
            }
        }
        if (oldest < 0) {
            return;
        }
        sea.cached -= sea.blocks[sea.cache[oldest].block].raw;
        free(sea.cache[oldest].data);
        sea.cache[oldest].data = NULL;
        sea.cache[oldest].block = -1;
    }
}

/* The decompressed bytes of block `b`, from the cache when it is there. */
static const unsigned char *fg_sea_block_data(uint32_t b)
{
    fg_sea_block *blk = &sea.blocks[b];
    unsigned char *raw, *stored = NULL;
    int i, slot = -1, ok = 0;

    for (i = 0; i < FG_SEA_CACHE; i++) {
        if (sea.cache[i].data && sea.cache[i].block == (int64_t) b) {
            sea.cache[i].used = ++sea.tick;
            return sea.cache[i].data;
        }
    }
    raw = (unsigned char *) malloc(blk->raw ? blk->raw : 1);
    if (!raw) {
        return NULL;
    }
    if (blk->method == 0) {
        ok = blk->stored == blk->raw && fg_sea_pread(raw, blk->raw, sea.base + blk->offset) == 0;
    } else if ((stored = (unsigned char *) malloc(blk->stored ? blk->stored : 1)) != NULL &&
               fg_sea_pread(stored, blk->stored, sea.base + blk->offset) == 0) {
        if (blk->method == 1) {
            ok = tinfl_decompress_mem_to_mem(raw, blk->raw, stored, blk->stored, 0) == blk->raw;
        } else if (blk->method == 2) {
            size_t out = blk->raw;
            ok = BrotliDecoderDecompress(blk->stored, stored, &out, raw) == BROTLI_DECODER_RESULT_SUCCESS && out == blk->raw;
        }
    }
    free(stored);
    if (!ok) {
        free(raw);
        return NULL;
    }
    /* An empty slot, else the least recently used one. */
    for (i = 0; i < FG_SEA_CACHE; i++) {
        if (!sea.cache[i].data) {
            slot = i;
            break;
        }
        if (slot < 0 || sea.cache[i].used < sea.cache[slot].used) slot = i;
    }
    if (sea.cache[slot].data) {
        sea.cached -= sea.blocks[sea.cache[slot].block].raw;
        free(sea.cache[slot].data);
    }
    sea.cache[slot].data = raw;
    sea.cache[slot].block = b;
    sea.cache[slot].used = ++sea.tick;
    sea.cached += blk->raw;
    fg_sea_trim(sea.budget);
    return raw;
}

/* The bytes of a file in the payload, or NULL (entry not found, or the payload is damaged). */
static const unsigned char *fg_sea_file(const char *abs, size_t abs_len, fg_sea_entry **found)
{
    char rel[4096];
    size_t len;
    fg_sea_entry *e;
    const unsigned char *data;
    if (!fg_sea_relative(abs, abs_len, rel, sizeof(rel), &len) || !(e = fg_sea_find(rel, len))) {
        return NULL;
    }
    data = fg_sea_block_data(e->block);
    if (!data) {
        return NULL;
    }
    *found = e;
    return data + e->offset;
}

int fg_sea_active(void)
{
    return sea.active;
}

/* A payload file as a malloc'd, NUL-terminated buffer, or NULL when `path` is not one. For fg_main's entry script. */
char *fg_sea_read_file(const char *path, size_t *len)
{
    fg_sea_entry *e = NULL;
    const unsigned char *data = fg_sea_file(path, strlen(path), &e);
    char *out;
    if (!data || !(out = (char *) malloc((size_t) e->size + 1))) {
        return NULL;
    }
    memcpy(out, data, e->size);
    out[e->size] = '\0';
    *len = e->size;
    return out;
}

/* JSLoadFileFunc: payload files first, then the disk. */
static uint8_t *fg_sea_load_file(JSContext *ctx, size_t *len, const char *path)
{
    fg_sea_entry *e = NULL;
    const unsigned char *data = fg_sea_file(path, strlen(path), &e);
    uint8_t *out;
    if (!data) {
        return js_load_file(ctx, len, path);
    }
    out = (uint8_t *) js_malloc(ctx, (size_t) e->size + 1);
    if (!out) {
        return NULL;
    }
    memcpy(out, data, e->size);
    out[e->size] = '\0';
    *len = e->size;
    return out;
}

/*
 * The module loader: a mocked specifier (node:test's mock.module(), ESM side) is synthesized from JS-supplied
 * source; an import of a file inside the payload is compiled from memory; anything else goes to the engine's own
 * loader. import.meta.url is the payload path, which is what the program sees as its location.
 */
JSModuleDef *fg_sea_module_loader(JSContext *ctx, const char *name, void *opaque, JSValueConst attributes)
{
    fg_sea_entry *e = NULL;
    size_t name_len = strlen(name);

    if (fg_sea_mock_hook_set) {
        JSValue specifier = JS_NewString(ctx, name);
        JSValue mocked = JS_Call(ctx, fg_sea_mock_hook, JS_UNDEFINED, 1, &specifier);
        JS_FreeValue(ctx, specifier);
        if (JS_IsException(mocked)) {
            return NULL;
        }
        if (!JS_IsUndefined(mocked)) {
            size_t src_len = 0;
            const char *src = JS_ToCStringLen(ctx, &src_len, mocked);
            JSModuleDef *m;
            JS_FreeValue(ctx, mocked);
            if (!src) {
                return NULL;
            }
            m = fg_sea_compile_module(ctx, src, src_len, name);
            JS_FreeCString(ctx, src);
            return m;
        }
    }

    if (!sea.active || !fg_sea_file(name, name_len, &e)) {
        return js_module_loader(ctx, name, opaque, attributes);
    }
    /* JSON, text and bytes imports: the engine's loader handles the types, reading through the payload. */
    {
        int typed = name_len > 5 && strcmp(name + name_len - 5, ".json") == 0;
        if (JS_IsObject(attributes)) {
            JSValue type = JS_GetPropertyStr(ctx, attributes, "type");
            typed = typed || !JS_IsUndefined(type);
            JS_FreeValue(ctx, type);
        }
        if (typed) {
            return js_module_load(ctx, name, opaque, attributes, fg_sea_load_file);
        }
    }
    {
        size_t len = 0;
        uint8_t *buf = fg_sea_load_file(ctx, &len, name);
        JSModuleDef *m;
        if (!buf) {
            JS_ThrowReferenceError(ctx, "could not load module filename '%s'", name);
            return NULL;
        }
        m = fg_sea_compile_module(ctx, (const char *) buf, len, name);
        js_free(ctx, buf);
        return m;
    }
}

/* -------------------------------------------------------------------------------------- extraction */

/*
 * Picks the directory files are extracted to: beside the executable when that is writable, otherwise the temp
 * directory. The marker file says which build the files there came from; files of another build are replaced.
 */
static int fg_sea_out_dir(void)
{
    const char *tmp;
    char marker[4200], have[80];
    int attempt, i;

    if (sea.out_ready) {
        return 0;
    }
    for (attempt = 0; attempt < 2; attempt++) {
        if (attempt == 0) {
            snprintf(sea.out, sizeof(sea.out), "%s", sea.root);
        } else {
            tmp = getenv("TMPDIR");
            if (!tmp) tmp = getenv("TEMP");
            if (!tmp) tmp = getenv("TMP");
            if (!tmp) tmp = "/tmp";
            snprintf(sea.out, sizeof(sea.out), "%s/graak-%.16s", tmp, sea.sha);
            for (i = 0; sea.out[i]; i++) {
                if (sea.out[i] == '\\') sea.out[i] = '/';
            }
        }
        if (fg_make_dir(sea.out) != 0) {
            continue;
        }
        snprintf(marker, sizeof(marker), "%s/.sea", sea.out);
        if (fg_read_small(marker, have, sizeof(have)) == 0 && strncmp(have, sea.sha, 64) == 0) {
            sea.stale = 0;
            sea.out_ready = 1;
            return 0;
        }
        if (fg_write_file(marker, (const unsigned char *) sea.sha, 64, 0) == 0) {
            sea.stale = 1;
            sea.out_ready = 1;
            return 0;
        }
    }
    sea.out[0] = '\0';
    return -1;
}

/* Writes one payload file to the extraction directory (once per build) and returns its real path in `real`. */
static int fg_sea_extract(const char *abs, size_t abs_len, char *real, size_t cap)
{
    char rel[4096], part[4200];
    size_t len;
    fg_sea_entry *e;
    const unsigned char *data;

    if (!fg_sea_relative(abs, abs_len, rel, sizeof(rel), &len) || !(e = fg_sea_find(rel, len))) {
        return -2;
    }
    if (fg_sea_out_dir() != 0 || strlen(sea.out) + 1 + len + 1 > cap) {
        return -1;
    }
    snprintf(real, cap, "%s/%s", sea.out, rel);
    if (!sea.stale && fg_file_size(real) == (int64_t) e->size) {
        return 0;
    }
    data = fg_sea_block_data(e->block);
    if (!data || fg_make_parents(real) != 0) {
        return -1;
    }
    /* Written beside and renamed over, so another copy of the program never loads half a file. */
#ifdef _WIN32
    snprintf(part, sizeof(part), "%s.%lu.part", real, (unsigned long) GetCurrentProcessId());
#else
    snprintf(part, sizeof(part), "%s.%ld.part", real, (long) getpid());
#endif
    if (fg_write_file(part, data + e->offset, e->size, e->mode) != 0) {
        remove(part);
        return -1;
    }
#ifdef _WIN32
    if (!MoveFileExA(part, real, MOVEFILE_REPLACE_EXISTING)) {
#else
    if (rename(part, real) != 0) {
#endif
        remove(part);
        /* Another running copy holds the file open (Windows will not replace a loaded DLL): that one is current. */
        return fg_file_size(real) == (int64_t) e->size ? 0 : -1;
    }
    return 0;
}

/* ------------------------------------------------------------------------------- JavaScript bindings */

static int fg_sea_arg(JSContext *ctx, JSValueConst v, char *rel, size_t cap, size_t *len)
{
    size_t n;
    const char *s = JS_ToCStringLen(ctx, &n, v);
    int ok;
    if (!s) {
        return -1;
    }
    ok = fg_sea_relative(s, n, rel, cap, len);
    JS_FreeCString(ctx, s);
    return ok ? 1 : 0;
}

/* stat(path) -> [kind (1 file, 2 directory), size, mode], or undefined when the payload has no such path. */
static JSValue fg_sea_js_stat(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    char rel[4096];
    size_t len;
    fg_sea_entry *e;
    JSValue out;
    int kind, rc = fg_sea_arg(ctx, argv[0], rel, sizeof(rel), &len);
    uint32_t size = 0, mode = 0755;
    (void) this_val;
    (void) argc;
    if (rc < 0) return JS_EXCEPTION;
    if (rc == 0) return JS_UNDEFINED;
    if ((e = fg_sea_find(rel, len)) != NULL) {
        kind = 1;
        size = e->size;
        mode = e->mode;
    } else if (fg_sea_dir_start(rel, len) < sea.nentries) {
        kind = 2;
    } else {
        return JS_UNDEFINED;
    }
    out = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, out, 0, JS_NewInt32(ctx, kind));
    JS_SetPropertyUint32(ctx, out, 1, JS_NewUint32(ctx, size));
    JS_SetPropertyUint32(ctx, out, 2, JS_NewUint32(ctx, mode));
    return out;
}

/* readdir(path) -> the names directly inside a payload directory, or undefined when it is not one. */
static JSValue fg_sea_js_readdir(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    char rel[4096];
    size_t len, skip;
    uint32_t i, n = 0;
    const char *last = NULL;
    size_t last_len = 0;
    JSValue out;
    int rc = fg_sea_arg(ctx, argv[0], rel, sizeof(rel), &len);
    (void) this_val;
    (void) argc;
    if (rc < 0) return JS_EXCEPTION;
    if (rc == 0) return JS_UNDEFINED;
    i = fg_sea_dir_start(rel, len);
    if (i >= sea.nentries) return JS_UNDEFINED;
    skip = len ? len + 1 : 0;
    out = JS_NewArray(ctx);
    for (; i < sea.nentries; i++) {
        fg_sea_entry *e = &sea.entries[i];
        const char *name, *slash;
        size_t name_len;
        if (skip && (e->len <= skip || memcmp(e->path, rel, len) != 0 || e->path[len] != '/')) break;
        name = e->path + skip;
        slash = (const char *) memchr(name, '/', e->len - skip);
        name_len = slash ? (size_t) (slash - name) : e->len - skip;
        /* A subdirectory's entries are contiguous, so a repeated name is always the previous one. */
        if (last && last_len == name_len && memcmp(last, name, name_len) == 0) continue;
        last = name;
        last_len = name_len;
        JS_SetPropertyUint32(ctx, out, n++, JS_NewStringLen(ctx, name, name_len));
    }
    return out;
}

/* read(path) -> ArrayBuffer with the file's bytes, or undefined when the payload has no such file. */
static JSValue fg_sea_js_read(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    size_t n;
    fg_sea_entry *e = NULL;
    const unsigned char *data;
    const char *s = JS_ToCStringLen(ctx, &n, argv[0]);
    (void) this_val;
    (void) argc;
    if (!s) return JS_EXCEPTION;
    data = fg_sea_file(s, n, &e);
    JS_FreeCString(ctx, s);
    if (!data) {
        return e ? JS_ThrowInternalError(ctx, "the embedded application is damaged") : JS_UNDEFINED;
    }
    return JS_NewArrayBufferCopy(ctx, data, e->size);
}

/* extract(path) -> the real path of a payload file, written to disk for code that needs a real file. */
static JSValue fg_sea_js_extract(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    size_t n;
    char real[4200];
    int rc;
    const char *s = JS_ToCStringLen(ctx, &n, argv[0]);
    (void) this_val;
    (void) argc;
    if (!s) return JS_EXCEPTION;
    rc = fg_sea_extract(s, n, real, sizeof(real));
    if (rc != 0) {
        JSValue err = rc == -2 ? JS_ThrowReferenceError(ctx, "'%s' is not in the embedded application", s)
                               : JS_ThrowInternalError(ctx, "cannot extract '%s' from the embedded application (to %s or the temp directory)", s, sea.root);
        JS_FreeCString(ctx, s);
        return err;
    }
    JS_FreeCString(ctx, s);
    return JS_NewString(ctx, real);
}

/* paths() -> every file path in the payload, relative to the root. */
static JSValue fg_sea_js_paths(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    JSValue out = JS_NewArray(ctx);
    uint32_t i;
    (void) this_val;
    (void) argc;
    (void) argv;
    for (i = 0; i < sea.nentries; i++) {
        JS_SetPropertyUint32(ctx, out, i, JS_NewStringLen(ctx, sea.entries[i].path, sea.entries[i].len));
    }
    return out;
}

/* release() shrinks the block cache to its steady size: start-up is over and those blocks are just memory now. */
static JSValue fg_sea_js_release(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    (void) ctx;
    (void) this_val;
    (void) argc;
    (void) argv;
    sea.budget = FG_SEA_BUDGET;
    fg_sea_trim(sea.budget);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry fg_sea_funcs[] = {
    JS_CFUNC_DEF("stat", 1, fg_sea_js_stat),
    JS_CFUNC_DEF("readdir", 1, fg_sea_js_readdir),
    JS_CFUNC_DEF("read", 1, fg_sea_js_read),
    JS_CFUNC_DEF("extract", 1, fg_sea_js_extract),
    JS_CFUNC_DEF("paths", 0, fg_sea_js_paths),
    JS_CFUNC_DEF("release", 0, fg_sea_js_release),
};

static const JSCFunctionListEntry fg_sea_mock_funcs[] = {
    JS_CFUNC_DEF("setEsmMockHook", 1, fg_sea_js_set_esm_mock_hook),
};

/* Adds `sea` to the native layer when this executable runs its own payload; `setEsmMockHook` runs in every build,
   SEA or not, since fg_sea_module_loader is the only module loader installed (see fg_main.c). */
void fg_sea_install(JSContext *ctx, JSValueConst native)
{
    JSValue obj;
    JS_SetPropertyFunctionList(ctx, native, fg_sea_mock_funcs, sizeof(fg_sea_mock_funcs) / sizeof(fg_sea_mock_funcs[0]));
    if (!sea.active) {
        return;
    }
    obj = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, obj, fg_sea_funcs, sizeof(fg_sea_funcs) / sizeof(fg_sea_funcs[0]));
    JS_SetPropertyStr(ctx, obj, "root", JS_NewString(ctx, sea.root));
    JS_SetPropertyStr(ctx, obj, "sha", JS_NewString(ctx, sea.sha));
    JS_SetPropertyStr(ctx, native, "sea", obj);
}

/* ---------------------------------------------------------------------------------------- start-up */

/* Reads and checks the index. Returns 0, or -1 when the payload is damaged. `main` receives the entry file. */
static int fg_sea_load_index(char *main, size_t main_cap)
{
    unsigned char head[4];
    uint32_t index_len, i;
    size_t pos, mlen;
    unsigned char *ix;

    if (sea.length < 4 || fg_sea_pread(head, 4, sea.base) != 0) {
        return -1;
    }
    index_len = fg_le32(head);
    if (index_len < 10 || (uint64_t) index_len + 4 > sea.length) {
        return -1;
    }
    ix = sea.index = (unsigned char *) malloc(index_len);
    if (!ix || fg_sea_pread(ix, index_len, sea.base + 4) != 0) {
        return -1;
    }
    sea.nblocks = fg_le32(ix);
    sea.nentries = fg_le32(ix + 4);
    mlen = (size_t) ix[8] | ((size_t) ix[9] << 8);
    pos = 10;
    if (mlen == 0 || mlen + 1 > main_cap || pos + mlen > index_len || (uint64_t) sea.nblocks * 21 > index_len - pos - mlen) {
        return -1;
    }
    memcpy(main, ix + pos, mlen);
    main[mlen] = '\0';
    pos += mlen;

    sea.blocks = (fg_sea_block *) calloc(sea.nblocks ? sea.nblocks : 1, sizeof(fg_sea_block));
    sea.entries = (fg_sea_entry *) calloc(sea.nentries ? sea.nentries : 1, sizeof(fg_sea_entry));
    if (!sea.blocks || !sea.entries) {
        return -1;
    }
    for (i = 0; i < sea.nblocks; i++) {
        fg_sea_block *b = &sea.blocks[i];
        b->offset = fg_le64(ix + pos);
        b->stored = fg_le32(ix + pos + 8);
        b->raw = fg_le32(ix + pos + 12);
        b->method = ix[pos + 20];
        pos += 21;
        if (b->method > 2 || b->offset < (uint64_t) index_len + 4 || b->offset + b->stored > sea.length) {
            return -1;
        }
    }
    for (i = 0; i < sea.nentries; i++) {
        fg_sea_entry *e = &sea.entries[i];
        if (pos + 2 > index_len) return -1;
        e->len = (size_t) ix[pos] | ((size_t) ix[pos + 1] << 8);
        pos += 2;
        if (pos + e->len + 16 > index_len || !fg_safe_path((const char *) ix + pos, e->len)) return -1;
        e->path = (const char *) ix + pos;
        pos += e->len;
        e->mode = fg_le32(ix + pos);
        e->block = fg_le32(ix + pos + 4);
        e->offset = fg_le32(ix + pos + 8);
        e->size = fg_le32(ix + pos + 12);
        pos += 16;
        /* Lookups are binary searches, so the order is part of the format. */
        if (e->block >= sea.nblocks || (uint64_t) e->offset + e->size > sea.blocks[e->block].raw ||
            (i > 0 && fg_sea_cmp(sea.entries[i - 1].path, sea.entries[i - 1].len, e->path, e->len) >= 0)) {
            return -1;
        }
    }
    return 0;
}

/*
 * If this executable carries a payload, indexes it and rewrites argv so the host runs the program from it:
 * {exe, <root>/runtime/node-compat.js, <root>/<entry>, original arguments...}, where <root> is "<exe>.graak", a
 * directory that exists only in the payload. Returns 1 when it did, 0 when this is a plain host, and -1 (after
 * printing why) when the payload is there but unusable.
 */
int fg_sea_prepare(int *argc, char ***argv)
{
    char self[4096];
    unsigned char trailer[FG_SEA_TRAILER];
    char entry[1024];
    char **nargv;
    uint64_t size;
    int i;

    for (i = 0; i < FG_SEA_CACHE; i++) sea.cache[i].block = -1;
    sea.budget = FG_SEA_START_BUDGET;
    if (fg_self_path(self, sizeof(self), (*argv)[0]) != 0) {
        return 0;
    }
#ifdef _WIN32
    {
        DWORD high = 0, low;
        sea.file = CreateFileA(self, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
                               FILE_ATTRIBUTE_NORMAL, NULL);
        if (sea.file == INVALID_HANDLE_VALUE) {
            return 0;
        }
        low = GetFileSize(sea.file, &high);
        if (low == INVALID_FILE_SIZE && GetLastError() != NO_ERROR) {
            CloseHandle(sea.file);
            return 0;
        }
        size = ((uint64_t) high << 32) | low;
    }
#else
    {
        struct stat st;
        sea.fd = open(self, O_RDONLY | O_CLOEXEC);
        if (sea.fd < 0) {
            return 0;
        }
        if (fstat(sea.fd, &st) != 0) {
            close(sea.fd);
            return 0;
        }
        size = (uint64_t) st.st_size;
    }
#endif
    if (size < FG_SEA_TRAILER || fg_sea_pread(trailer, FG_SEA_TRAILER, size - FG_SEA_TRAILER) != 0 ||
        memcmp(trailer, "FGSEA\0\0", 7) != 0) {
        goto plain;
    }
    if (memcmp(trailer, FG_SEA_MAGIC_V1, 8) == 0) {
        fprintf(stderr, "graak: the embedded application uses an older single-file format; build it again with this version of Graak\n");
        return -1;
    }
    if (memcmp(trailer, FG_SEA_MAGIC, 8) != 0) {
        fprintf(stderr, "graak: the embedded application uses single-file format %d, which this host does not know; build it again\n",
                (int) trailer[7]);
        return -1;
    }
    sea.base = fg_le64(trailer + 8);
    sea.length = fg_le64(trailer + 16);
    if (sea.base + sea.length + FG_SEA_TRAILER != size || fg_sea_load_index(entry, sizeof(entry)) != 0) {
        fprintf(stderr, "graak: the embedded application is damaged\n");
        return -1;
    }
    memcpy(sea.sha, trailer + 24, 64);
    sea.sha[64] = '\0';

    snprintf(sea.root, sizeof(sea.root), "%s.graak", self);
    for (i = 0; sea.root[i]; i++) {
        if (sea.root[i] == '\\') sea.root[i] = '/';
    }
    sea.root_len = strlen(sea.root);
    sea.active = 1;

    nargv = (char **) malloc(sizeof(char *) * ((size_t) *argc + 3));
    if (!nargv) {
        return -1;
    }
    nargv[0] = (*argv)[0];
    {
        size_t n = sea.root_len + 40, m = sea.root_len + strlen(entry) + 4;
        nargv[1] = (char *) malloc(n);
        nargv[2] = (char *) malloc(m);
        if (!nargv[1] || !nargv[2]) {
            return -1;
        }
        snprintf(nargv[1], n, "%s/runtime/node-compat.js", sea.root);
        snprintf(nargv[2], m, "%s/%s", sea.root, entry);
    }
    for (i = 1; i < *argc; i++) {
        nargv[i + 2] = (*argv)[i];
    }
    nargv[*argc + 2] = NULL;
    *argv = nargv;
    *argc += 2;
    return 1;

plain:
#ifdef _WIN32
    CloseHandle(sea.file);
#else
    close(sea.fd);
#endif
    return 0;
}
