/*
 * SQLite for the native host: the public-domain amalgamation, compiled into the binary, and the handful of
 * functions JavaScript needs to drive it. `node:sqlite`, `bun:sqlite` and Deno KV are built on this in JavaScript
 * (quickjs/runtime/node-sqlite.js), so a program that stores its data in SQLite runs on every target, Windows XP
 * included, with nothing to install and no native addon to load.
 *
 * Databases and statements are integer ids into fixed tables, like sockets: JavaScript never holds a pointer, and an
 * id that was closed (or never opened) is rejected instead of dereferenced. SQLite is built single-threaded
 * (SQLITE_THREADSAFE=0): every call happens on the JavaScript thread.
 *
 * Values cross the boundary as JavaScript values: null, number (an integer that fits 53 bits, or a real), bigint (any
 * other integer), string (UTF-8) and Uint8Array (a blob).
 */

#include "quickjs.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "sqlite3.h"

#define FG_MAX_DBS 64
#define FG_MAX_STMTS 4096
#define FG_MAX_BACKUPS 16

static sqlite3 *fg_dbs[FG_MAX_DBS];
static sqlite3_stmt *fg_stmts[FG_MAX_STMTS];
static int fg_stmt_db[FG_MAX_STMTS];

/* sqlite3_backup* handles for node:sqlite's backup(), keyed the same way as fg_dbs/fg_stmts. fg_backup_dest is the
   destination connection sqlite3_backup_init() opened, closed alongside it when the backup ends. */
static sqlite3_backup *fg_backups[FG_MAX_BACKUPS];
static sqlite3 *fg_backup_dest[FG_MAX_BACKUPS];

static JSValue fg_sqlite_throw(JSContext *ctx, sqlite3 *db, int code, const char *fallback)
{
    JSValue err = JS_NewError(ctx);
    const char *message = db ? sqlite3_errmsg(db) : fallback;
    JS_SetPropertyStr(ctx, err, "message", JS_NewString(ctx, message ? message : "SQLite error"));
    JS_SetPropertyStr(ctx, err, "errcode", JS_NewInt32(ctx, db ? sqlite3_extended_errcode(db) : code));
    JS_SetPropertyStr(ctx, err, "errstr", JS_NewString(ctx, sqlite3_errstr(code)));
    JS_SetPropertyStr(ctx, err, "code", JS_NewString(ctx, "ERR_SQLITE_ERROR"));
    return JS_Throw(ctx, err);
}

static sqlite3 *fg_db_get(JSContext *ctx, JSValueConst v)
{
    int32_t id;
    if (JS_ToInt32(ctx, &id, v)) {
        return NULL;
    }
    if (id < 0 || id >= FG_MAX_DBS || !fg_dbs[id]) {
        JS_ThrowInternalError(ctx, "database is not open");
        return NULL;
    }
    return fg_dbs[id];
}

static sqlite3_stmt *fg_stmt_get(JSContext *ctx, JSValueConst v)
{
    int32_t id;
    if (JS_ToInt32(ctx, &id, v)) {
        return NULL;
    }
    if (id < 0 || id >= FG_MAX_STMTS || !fg_stmts[id]) {
        JS_ThrowInternalError(ctx, "statement has been finalized");
        return NULL;
    }
    return fg_stmts[id];
}

/* sqliteOpen(path, flags) -> db id. flags is SQLITE_OPEN_*; 0 means read-write, create. */
static JSValue fg_sqlite_open(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    const char *path;
    int32_t flags = 0;
    int id, rc;
    sqlite3 *db = NULL;

    path = JS_ToCString(ctx, argv[0]);
    if (!path) {
        return JS_EXCEPTION;
    }
    if (argc > 1) {
        JS_ToInt32(ctx, &flags, argv[1]);
    }
    if (flags == 0) {
        flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE;
    }
    flags |= SQLITE_OPEN_URI;
    for (id = 0; id < FG_MAX_DBS; id++) {
        if (!fg_dbs[id]) {
            break;
        }
    }
    if (id == FG_MAX_DBS) {
        JS_FreeCString(ctx, path);
        return JS_ThrowInternalError(ctx, "too many open databases (limit is %d)", FG_MAX_DBS);
    }
    rc = sqlite3_open_v2(path, &db, flags, NULL);
    JS_FreeCString(ctx, path);
    if (rc != SQLITE_OK) {
        JSValue err = fg_sqlite_throw(ctx, db, rc, "unable to open database file");
        if (db) {
            sqlite3_close(db);
        }
        return err;
    }
    sqlite3_busy_timeout(db, 5000);
    fg_dbs[id] = db;
    return JS_NewInt32(ctx, id);
}

static JSValue fg_sqlite_close(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t id;
    int rc;

    if (JS_ToInt32(ctx, &id, argv[0])) {
        return JS_EXCEPTION;
    }
    if (id < 0 || id >= FG_MAX_DBS || !fg_dbs[id]) {
        return JS_UNDEFINED;
    }
    /* Statements still open would make close fail with SQLITE_BUSY: they die with the connection. */
    for (int i = 0; i < FG_MAX_STMTS; i++) {
        if (fg_stmts[i] && fg_stmt_db[i] == id) {
            sqlite3_finalize(fg_stmts[i]);
            fg_stmts[i] = NULL;
        }
    }
    rc = sqlite3_close(fg_dbs[id]);
    if (rc != SQLITE_OK) {
        return fg_sqlite_throw(ctx, fg_dbs[id], rc, "unable to close database");
    }
    fg_dbs[id] = NULL;
    return JS_UNDEFINED;
}

/* sqliteExec(db, sql): runs every statement in the text, discarding rows. */
static JSValue fg_sqlite_exec(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    sqlite3 *db = fg_db_get(ctx, argv[0]);
    const char *sql;
    int rc;

    if (!db) {
        return JS_EXCEPTION;
    }
    sql = JS_ToCString(ctx, argv[1]);
    if (!sql) {
        return JS_EXCEPTION;
    }
    rc = sqlite3_exec(db, sql, NULL, NULL, NULL);
    JS_FreeCString(ctx, sql);
    if (rc != SQLITE_OK) {
        return fg_sqlite_throw(ctx, db, rc, NULL);
    }
    return JS_UNDEFINED;
}

/* sqlitePrepare(db, sql) -> [statement id, tail offset] so a caller can run a script one statement at a time. */
static JSValue fg_sqlite_prepare(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    sqlite3 *db = fg_db_get(ctx, argv[0]);
    size_t len;
    const char *sql, *tail = NULL;
    sqlite3_stmt *stmt = NULL;
    int rc, id;
    int32_t dbid;
    JSValue arr;

    if (!db) {
        return JS_EXCEPTION;
    }
    JS_ToInt32(ctx, &dbid, argv[0]);
    sql = JS_ToCStringLen(ctx, &len, argv[1]);
    if (!sql) {
        return JS_EXCEPTION;
    }
    for (id = 0; id < FG_MAX_STMTS; id++) {
        if (!fg_stmts[id]) {
            break;
        }
    }
    if (id == FG_MAX_STMTS) {
        JS_FreeCString(ctx, sql);
        return JS_ThrowInternalError(ctx, "too many prepared statements (limit is %d)", FG_MAX_STMTS);
    }
    rc = sqlite3_prepare_v2(db, sql, (int) len, &stmt, &tail);
    if (rc != SQLITE_OK) {
        JS_FreeCString(ctx, sql);
        return fg_sqlite_throw(ctx, db, rc, NULL);
    }
    arr = JS_NewArray(ctx);
    if (stmt) {
        fg_stmts[id] = stmt;
        fg_stmt_db[id] = dbid;
        JS_SetPropertyUint32(ctx, arr, 0, JS_NewInt32(ctx, id));
    } else {
        JS_SetPropertyUint32(ctx, arr, 0, JS_NULL); /* only whitespace or a comment */
    }
    JS_SetPropertyUint32(ctx, arr, 1, JS_NewInt64(ctx, (int64_t) (tail - sql)));
    JS_FreeCString(ctx, sql);
    return arr;
}

static JSValue fg_sqlite_finalize(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t id;

    if (JS_ToInt32(ctx, &id, argv[0])) {
        return JS_EXCEPTION;
    }
    if (id >= 0 && id < FG_MAX_STMTS && fg_stmts[id]) {
        sqlite3_finalize(fg_stmts[id]);
        fg_stmts[id] = NULL;
    }
    return JS_UNDEFINED;
}

/* sqliteBind(stmt, index, value): index is 1-based, as in SQLite. */
static JSValue fg_sqlite_bind(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    sqlite3_stmt *stmt = fg_stmt_get(ctx, argv[0]);
    int32_t index;
    int rc;
    JSValueConst v = argv[2];

    if (!stmt || JS_ToInt32(ctx, &index, argv[1])) {
        return JS_EXCEPTION;
    }
    if (JS_IsNull(v) || JS_IsUndefined(v)) {
        rc = sqlite3_bind_null(stmt, index);
    } else if (JS_IsBool(v)) {
        rc = sqlite3_bind_int(stmt, index, JS_ToBool(ctx, v));
    } else if (JS_IsBigInt(v)) {
        int64_t n;
        if (JS_ToBigInt64(ctx, &n, v)) {
            return JS_EXCEPTION;
        }
        rc = sqlite3_bind_int64(stmt, index, n);
    } else if (JS_IsNumber(v)) {
        double d;
        if (JS_ToFloat64(ctx, &d, v)) {
            return JS_EXCEPTION;
        }
        if (d == (double) (int64_t) d && d >= -9007199254740992.0 && d <= 9007199254740992.0 && !(d == 0 && 1 / d < 0)) {
            rc = sqlite3_bind_int64(stmt, index, (int64_t) d);
        } else {
            rc = sqlite3_bind_double(stmt, index, d);
        }
    } else if (JS_IsString(v)) {
        size_t len;
        const char *s = JS_ToCStringLen(ctx, &len, v);
        if (!s) {
            return JS_EXCEPTION;
        }
        rc = sqlite3_bind_text64(stmt, index, s, (sqlite3_uint64) len, SQLITE_TRANSIENT, SQLITE_UTF8);
        JS_FreeCString(ctx, s);
    } else {
        size_t size, offset, elem;
        JSValue buffer = JS_GetTypedArrayBuffer(ctx, v, &offset, &size, &elem);
        uint8_t *data;
        size_t total;
        if (JS_IsException(buffer)) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            data = JS_GetArrayBuffer(ctx, &total, v);
            if (!data) {
                return JS_ThrowTypeError(ctx, "cannot bind a value of this type");
            }
            rc = sqlite3_bind_blob64(stmt, index, data, (sqlite3_uint64) total, SQLITE_TRANSIENT);
        } else {
            data = JS_GetArrayBuffer(ctx, &total, buffer);
            rc = sqlite3_bind_blob64(stmt, index, data ? data + offset : (const uint8_t *) "", (sqlite3_uint64) size,
                                     SQLITE_TRANSIENT);
            JS_FreeValue(ctx, buffer);
        }
    }
    if (rc != SQLITE_OK) {
        return fg_sqlite_throw(ctx, sqlite3_db_handle(stmt), rc, NULL);
    }
    return JS_UNDEFINED;
}

static JSValue fg_sqlite_bind_index(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    sqlite3_stmt *stmt = fg_stmt_get(ctx, argv[0]);
    const char *name;
    int index;

    if (!stmt) {
        return JS_EXCEPTION;
    }
    name = JS_ToCString(ctx, argv[1]);
    if (!name) {
        return JS_EXCEPTION;
    }
    index = sqlite3_bind_parameter_index(stmt, name);
    JS_FreeCString(ctx, name);
    return JS_NewInt32(ctx, index);
}

/* sqliteStep(stmt) -> true when a row is ready, false when the statement is done. */
static JSValue fg_sqlite_step(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    sqlite3_stmt *stmt = fg_stmt_get(ctx, argv[0]);
    int rc;

    if (!stmt) {
        return JS_EXCEPTION;
    }
    rc = sqlite3_step(stmt);
    if (rc == SQLITE_ROW) {
        return JS_TRUE;
    }
    if (rc == SQLITE_DONE) {
        return JS_FALSE;
    }
    {
        sqlite3 *db = sqlite3_db_handle(stmt);
        JSValue err = fg_sqlite_throw(ctx, db, rc, NULL);
        sqlite3_reset(stmt);
        return err;
    }
}

static JSValue fg_sqlite_reset(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    sqlite3_stmt *stmt = fg_stmt_get(ctx, argv[0]);

    if (!stmt) {
        return JS_EXCEPTION;
    }
    sqlite3_reset(stmt);
    if (argc > 1 && JS_ToBool(ctx, argv[1])) {
        sqlite3_clear_bindings(stmt);
    }
    return JS_UNDEFINED;
}

static JSValue fg_sqlite_columns(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    sqlite3_stmt *stmt = fg_stmt_get(ctx, argv[0]);
    JSValue arr;
    int n;

    if (!stmt) {
        return JS_EXCEPTION;
    }
    n = sqlite3_column_count(stmt);
    arr = JS_NewArray(ctx);
    for (int i = 0; i < n; i++) {
        const char *name = sqlite3_column_name(stmt, i);
        JS_SetPropertyUint32(ctx, arr, (uint32_t) i, JS_NewString(ctx, name ? name : ""));
    }
    return arr;
}

/* sqliteRow(stmt, bigints) -> the current row as an array. An integer outside 53 bits is a bigint, or an error
   when `bigints` is false, as in node:sqlite: a silently rounded id is worse than a failure. */
static JSValue fg_sqlite_row(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    sqlite3_stmt *stmt = fg_stmt_get(ctx, argv[0]);
    int bigints = argc > 1 && JS_ToBool(ctx, argv[1]);
    JSValue arr;
    int n;

    if (!stmt) {
        return JS_EXCEPTION;
    }
    n = sqlite3_column_count(stmt);
    arr = JS_NewArray(ctx);
    for (int i = 0; i < n; i++) {
        JSValue v;
        switch (sqlite3_column_type(stmt, i)) {
        case SQLITE_INTEGER: {
            int64_t x = sqlite3_column_int64(stmt, i);
            if (bigints) {
                v = JS_NewBigInt64(ctx, x);
            } else if (x > 9007199254740991LL || x < -9007199254740991LL) {
                JSValue error;
                JS_FreeValue(ctx, arr);
                JS_ThrowRangeError(ctx,
                    "The value of column %d is too large to be represented as a JavaScript number: %lld", i,
                    (long long) x);
                error = JS_GetException(ctx);
                JS_SetPropertyStr(ctx, error, "code", JS_NewString(ctx, "ERR_OUT_OF_RANGE"));
                return JS_Throw(ctx, error);
            } else {
                v = JS_NewInt64(ctx, x);
            }
            break;
        }
        case SQLITE_FLOAT:
            v = JS_NewFloat64(ctx, sqlite3_column_double(stmt, i));
            break;
        case SQLITE_TEXT:
            v = JS_NewStringLen(ctx, (const char *) sqlite3_column_text(stmt, i), (size_t) sqlite3_column_bytes(stmt, i));
            break;
        case SQLITE_BLOB: {
            int size = sqlite3_column_bytes(stmt, i);
            const void *data = sqlite3_column_blob(stmt, i);
            JSValue buf = JS_NewArrayBufferCopy(ctx, data ? (const uint8_t *) data : (const uint8_t *) "", (size_t) size);
            JSValue global = JS_GetGlobalObject(ctx);
            JSValue ctor = JS_GetPropertyStr(ctx, global, "Uint8Array");
            v = JS_CallConstructor(ctx, ctor, 1, (JSValueConst[]) {buf});
            JS_FreeValue(ctx, ctor);
            JS_FreeValue(ctx, global);
            JS_FreeValue(ctx, buf);
            break;
        }
        default:
            v = JS_NULL;
        }
        JS_SetPropertyUint32(ctx, arr, (uint32_t) i, v);
    }
    return arr;
}

/* sqliteInfo(db) -> [changes, last insert rowid (bigint), in a transaction] */
static JSValue fg_sqlite_info(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    sqlite3 *db = fg_db_get(ctx, argv[0]);
    JSValue arr;

    if (!db) {
        return JS_EXCEPTION;
    }
    arr = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, arr, 0, JS_NewInt64(ctx, sqlite3_changes64(db)));
    JS_SetPropertyUint32(ctx, arr, 1, JS_NewBigInt64(ctx, sqlite3_last_insert_rowid(db)));
    JS_SetPropertyUint32(ctx, arr, 2, JS_NewBool(ctx, !sqlite3_get_autocommit(db)));
    return arr;
}

static JSValue fg_sqlite_sql(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    sqlite3_stmt *stmt = fg_stmt_get(ctx, argv[0]);
    JSValue v;
    char *text;

    if (!stmt) {
        return JS_EXCEPTION;
    }
    if (argc > 1 && JS_ToBool(ctx, argv[1])) {
        text = sqlite3_expanded_sql(stmt);
        v = JS_NewString(ctx, text ? text : "");
        sqlite3_free(text);
        return v;
    }
    return JS_NewString(ctx, sqlite3_sql(stmt));
}

static JSValue fg_sqlite_version(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    return JS_NewString(ctx, sqlite3_libversion());
}

/* Closes and forgets backup slot `id`, the way node:sqlite's BackupJob::Cleanup() does: finish the backup, then
   close the destination connection it opened. Safe to call on an id that is already closed. */
static void fg_backup_cleanup(int id)
{
    if (id < 0 || id >= FG_MAX_BACKUPS || !fg_backups[id]) {
        return;
    }
    sqlite3_backup_finish(fg_backups[id]);
    fg_backups[id] = NULL;
    sqlite3_close_v2(fg_backup_dest[id]);
    fg_backup_dest[id] = NULL;
}

/* sqliteBackupInit(srcDb, srcName, destPath, destName) -> backup id. Opens destPath as a fresh connection (created if
   missing, like node:sqlite's backup()) and starts a backup into it from srcDb's srcName schema. */
static JSValue fg_sqlite_backup_init(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    sqlite3 *src = fg_db_get(ctx, argv[0]);
    const char *src_name, *dest_path, *dest_name;
    sqlite3 *dest = NULL;
    sqlite3_backup *b;
    int rc, id;

    if (!src) {
        return JS_EXCEPTION;
    }
    src_name = JS_ToCString(ctx, argv[1]);
    dest_path = JS_ToCString(ctx, argv[2]);
    dest_name = JS_ToCString(ctx, argv[3]);
    if (!src_name || !dest_path || !dest_name) {
        JS_FreeCString(ctx, src_name);
        JS_FreeCString(ctx, dest_path);
        JS_FreeCString(ctx, dest_name);
        return JS_EXCEPTION;
    }
    for (id = 0; id < FG_MAX_BACKUPS; id++) {
        if (!fg_backups[id]) {
            break;
        }
    }
    if (id == FG_MAX_BACKUPS) {
        JS_FreeCString(ctx, src_name);
        JS_FreeCString(ctx, dest_path);
        JS_FreeCString(ctx, dest_name);
        return JS_ThrowInternalError(ctx, "too many open backups (limit is %d)", FG_MAX_BACKUPS);
    }
    rc = sqlite3_open_v2(dest_path, &dest, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, NULL);
    JS_FreeCString(ctx, dest_path);
    if (rc != SQLITE_OK) {
        JSValue err = dest ? fg_sqlite_throw(ctx, dest, sqlite3_extended_errcode(dest), NULL)
                            : fg_sqlite_throw(ctx, NULL, rc, sqlite3_errstr(rc));
        if (dest) {
            sqlite3_close_v2(dest);
        }
        JS_FreeCString(ctx, src_name);
        JS_FreeCString(ctx, dest_name);
        return err;
    }
    b = sqlite3_backup_init(dest, dest_name, src, src_name);
    JS_FreeCString(ctx, src_name);
    JS_FreeCString(ctx, dest_name);
    if (!b) {
        JSValue err = fg_sqlite_throw(ctx, dest, sqlite3_extended_errcode(dest), NULL);
        sqlite3_close_v2(dest);
        return err;
    }
    fg_backups[id] = b;
    fg_backup_dest[id] = dest;
    return JS_NewInt32(ctx, id);
}

/* sqliteBackupStep(id, nPages) -> [done, totalPages, remainingPages]. Mirrors node:sqlite's BackupJob step-and-check:
   an error other than OK/DONE/BUSY/LOCKED throws and closes the backup; reaching zero remaining pages with SQLITE_DONE
   closes it and reports done; otherwise it reports progress and stays open for the next step. */
static JSValue fg_sqlite_backup_step(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t id, pages;
    sqlite3_backup *b;
    int rc, total, remaining;
    JSValue arr;

    if (JS_ToInt32(ctx, &id, argv[0]) || JS_ToInt32(ctx, &pages, argv[1])) {
        return JS_EXCEPTION;
    }
    if (id < 0 || id >= FG_MAX_BACKUPS || !fg_backups[id]) {
        return JS_ThrowInternalError(ctx, "backup is not open");
    }
    b = fg_backups[id];
    rc = sqlite3_backup_step(b, pages);
    if (!(rc == SQLITE_OK || rc == SQLITE_DONE || rc == SQLITE_BUSY || rc == SQLITE_LOCKED)) {
        JSValue err = fg_sqlite_throw(ctx, NULL, rc, sqlite3_errstr(rc));
        fg_backup_cleanup(id);
        return err;
    }
    total = sqlite3_backup_pagecount(b);
    remaining = sqlite3_backup_remaining(b);
    if (remaining != 0) {
        arr = JS_NewArray(ctx);
        JS_SetPropertyUint32(ctx, arr, 0, JS_FALSE);
        JS_SetPropertyUint32(ctx, arr, 1, JS_NewInt32(ctx, total));
        JS_SetPropertyUint32(ctx, arr, 2, JS_NewInt32(ctx, remaining));
        return arr;
    }
    if (rc != SQLITE_DONE) {
        JSValue err = fg_sqlite_throw(ctx, fg_backup_dest[id], sqlite3_extended_errcode(fg_backup_dest[id]), NULL);
        fg_backup_cleanup(id);
        return err;
    }
    fg_backup_cleanup(id);
    arr = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, arr, 0, JS_TRUE);
    JS_SetPropertyUint32(ctx, arr, 1, JS_NewInt32(ctx, total));
    JS_SetPropertyUint32(ctx, arr, 2, JS_NewInt32(ctx, 0));
    return arr;
}

/* sqliteBackupFinish(id): closes a backup that will not be stepped to completion, e.g. because a `progress` callback
   threw. A no-op on an id already closed by sqliteBackupStep finishing or failing. */
static JSValue fg_sqlite_backup_finish(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int32_t id;

    if (JS_ToInt32(ctx, &id, argv[0])) {
        return JS_EXCEPTION;
    }
    fg_backup_cleanup(id);
    return JS_UNDEFINED;
}

const JSCFunctionListEntry graak_sqlite_funcs[] = {
    JS_CFUNC_DEF("sqliteOpen", 2, fg_sqlite_open),
    JS_CFUNC_DEF("sqliteClose", 1, fg_sqlite_close),
    JS_CFUNC_DEF("sqliteExec", 2, fg_sqlite_exec),
    JS_CFUNC_DEF("sqlitePrepare", 2, fg_sqlite_prepare),
    JS_CFUNC_DEF("sqliteFinalize", 1, fg_sqlite_finalize),
    JS_CFUNC_DEF("sqliteBind", 3, fg_sqlite_bind),
    JS_CFUNC_DEF("sqliteBindIndex", 2, fg_sqlite_bind_index),
    JS_CFUNC_DEF("sqliteStep", 1, fg_sqlite_step),
    JS_CFUNC_DEF("sqliteReset", 2, fg_sqlite_reset),
    JS_CFUNC_DEF("sqliteColumns", 1, fg_sqlite_columns),
    JS_CFUNC_DEF("sqliteRow", 2, fg_sqlite_row),
    JS_CFUNC_DEF("sqliteInfo", 1, fg_sqlite_info),
    JS_CFUNC_DEF("sqliteSql", 2, fg_sqlite_sql),
    JS_CFUNC_DEF("sqliteVersion", 0, fg_sqlite_version),
    JS_CFUNC_DEF("sqliteBackupInit", 4, fg_sqlite_backup_init),
    JS_CFUNC_DEF("sqliteBackupStep", 2, fg_sqlite_backup_step),
    JS_CFUNC_DEF("sqliteBackupFinish", 1, fg_sqlite_backup_finish),
};
const size_t graak_sqlite_funcs_count = sizeof(graak_sqlite_funcs) / sizeof(graak_sqlite_funcs[0]);
